'use strict';

const Homey = require('homey');

// Mapping from hOn machMode values to Homey thermostat modes
const HON_TO_HVAC_MODE = {
  0: 'auto',
  1: 'cool',
  2: 'dry',
  3: 'dry',
  4: 'heat',
  5: 'fan_only',
  6: 'fan_only',
};

const HVAC_MODE_TO_HON = {
  'auto': 0,
  'cool': 1,
  'heat': 4,
  'dry': 2,
  'fan_only': 6,
  '10_heating': 4, // Uses heat mode with 10degreeHeatingStatus
};

// Mapping from hOn windSpeed values to Homey fan modes
const HON_TO_FAN_MODE = {
  1: 'high',
  2: 'medium',
  3: 'low',
  4: 'auto',
  5: 'auto',
};

const FAN_MODE_TO_HON = {
  'high': 1,
  'medium': 2,
  'low': 3,
  'auto': 5,
};

// Mapping from Homey HVAC modes to hOn program names
const HVAC_MODE_TO_PROGRAM = {
  'auto': 'IOT_AUTO',
  'cool': 'IOT_COOL',
  'heat': 'IOT_HEAT',
  'dry': 'IOT_DRY',
  'fan_only': 'IOT_FAN',
  '10_heating': 'IOT_10_HEATING',
};

// Eco pilot modes
const ECO_PILOT_TO_HON = {
  'off': '0',
  'avoid': '1',
  'follow': '2',
};

const HON_TO_ECO_PILOT = {
  0: 'off',
  1: 'avoid',
  2: 'follow',
};

// Toggle capabilities mapped to their API parameter names
const TOGGLE_CAPABILITIES = {
  'hon_silent_mode': { param: 'muteStatus' },
  'hon_rapid_mode': { param: 'rapidMode' },
  'hon_sleep_mode': { param: 'silentSleepStatus' },
  'hon_screen_display': { param: 'screenDisplayStatus' },
  'hon_echo_mode': { param: 'echoStatus', inverted: true }, // 0=beep on, 1=beep off
  'hon_eco_mode': { param: 'ecoMode' },
  'hon_health_mode': { param: 'healthMode' },
};

// Default polling interval in milliseconds
const DEFAULT_POLL_INTERVAL = 5000;

class AirconDevice extends Homey.Device {

  /**
   * onInit is called when the device is initialized.
   */
  async onInit() {
    this.log('Aircon device has been initialized');

    // Get stored device data
    // Strip timestamp suffix if present (e.g., "mac-address#2024-01-01..." -> "mac-address")
    const rawId = this.getData().id || '';
    this.deviceId = rawId.split('#')[0];
    this.applianceId = this.getData().applianceId;

    this.log(`Device ID (MAC): ${this.deviceId}, Appliance ID: ${this.applianceId}`);

    // Polling timer
    this._pollTimer = null;

    // Skip polls until this timestamp (prevents stale state overwriting commands)
    this._skipPollUntil = 0;

    // Migrate capabilities from old custom to system capabilities
    await this._migrateCapabilities();

    // Register capability listeners
    this._registerCapabilityListeners();

    // Start polling for device state
    await this._startPolling();

    // Fetch command definitions for mandatory parameters
    this._fetchCommandDefinitions();
  }

  /**
   * Migrate from old custom capabilities to system capabilities
   * @private
   */
  async _migrateCapabilities() {
    const migrations = [
      { old: 'hon_hvac_mode', new: 'thermostat_mode' },
      { old: 'hon_fan_speed', new: 'fan_mode' },
      { old: 'hon_swing_mode', new: 'swing_mode' },
    ];

    for (const { old: oldCap, new: newCap } of migrations) {
      if (this.hasCapability(oldCap)) {
        this.log(`Migrating capability ${oldCap} → ${newCap}`);
        await this.removeCapability(oldCap).catch(this.error);
      }
      if (!this.hasCapability(newCap)) {
        await this.addCapability(newCap).catch(this.error);
      }
    }
  }

  /**
   * Fetch command definitions and extract mandatory/ancillary parameters
   * @private
   */
  async _fetchCommandDefinitions() {
    try {
      const api = this._getApi();
      if (!api) return;

      // Get appliance info first
      const appliances = await api.getAppliances();
      const appliance = appliances.find(a => a.macAddress?.split('#')[0] === this.deviceId);

      if (appliance) {
        const commands = await api.getCommandDefinitions(appliance);

        // Extract applianceModel.options for API calls
        const appModel = commands.applianceModel || {};
        this._applianceOptions = appModel.options || commands.options || {};

        // Store the appliance info for API calls
        this._applianceInfo = appliance;

        // Find the settings command and extract all mandatory parameters + ancillary parameters
        const settingsCmd = commands.settings?.setParameters || {};
        const parametersSection = settingsCmd.parameters || {};
        const ancillarySection = settingsCmd.ancillaryParameters || {};

        // Extract mandatory parameters from the 'parameters' section
        const mandatoryParams = {};
        for (const [name, param] of Object.entries(parametersSection)) {
          if (param.mandatory === 1) {
            if (param.typology === 'fixed') {
              mandatoryParams[name] = param.fixedValue;
            } else if (param.defaultValue !== undefined) {
              mandatoryParams[name] = param.defaultValue;
            }
          }
        }
        // Extract ALL ancillary parameters (Python sends all, not just mandatory)
        // Exclude programRules as Python does
        const ancillaryParams = {};
        for (const [name, param] of Object.entries(ancillarySection)) {
          if (name === 'programRules') continue; // Skip programRules like Python does
          if (param.typology === 'fixed' && param.fixedValue !== undefined) {
            ancillaryParams[name] = param.fixedValue;
          } else if (param.defaultValue !== undefined) {
            ancillaryParams[name] = param.defaultValue;
          }
        }
        // Store for use in commands
        this._mandatoryParams = mandatoryParams;
        this._ancillaryParams = ancillaryParams;
      }
    } catch (error) {
      this.error('Failed to fetch command definitions:', error.message);
    }
  }

  /**
   * Register listeners for capability changes
   * @private
   */
  _registerCapabilityListeners() {
    // On/Off
    this.registerCapabilityListener('onoff', async (value) => {
      this.log(`Setting onoff to: ${value}`);
      await this._setOnOff(value);
    });

    // Target Temperature
    this.registerCapabilityListener('target_temperature', async (value) => {
      this.log(`Setting target_temperature to: ${value}`);
      await this._setTargetTemperature(value);
    });

    // Thermostat Mode (system capability, replaces hon_hvac_mode)
    if (this.hasCapability('thermostat_mode')) {
      this.registerCapabilityListener('thermostat_mode', async (value) => {
        this.log(`Setting thermostat_mode to: ${value}`);
        await this._setHvacMode(value);
      });
    }

    // Fan Mode (system capability, replaces hon_fan_speed)
    if (this.hasCapability('fan_mode')) {
      this.registerCapabilityListener('fan_mode', async (value) => {
        this.log(`Setting fan_mode to: ${value}`);
        await this._setFanSpeed(value);
      });
    }

    // Swing Mode (system capability, replaces hon_swing_mode)
    if (this.hasCapability('swing_mode')) {
      this.registerCapabilityListener('swing_mode', async (value) => {
        this.log(`Setting swing_mode to: ${value}`);
        await this._setSwingMode(value);
      });
    }

    // Eco Pilot
    if (this.hasCapability('hon_eco_pilot')) {
      this.registerCapabilityListener('hon_eco_pilot', async (value) => {
        this.log(`Setting hon_eco_pilot to: ${value}`);
        await this._setToggle('humanSensingStatus', ECO_PILOT_TO_HON[value] || '0');
      });
    }

    // Boolean toggle switches
    for (const [capability, config] of Object.entries(TOGGLE_CAPABILITIES)) {
      if (this.hasCapability(capability)) {
        this.registerCapabilityListener(capability, async (value) => {
          this.log(`Setting ${capability} to: ${value}`);
          const apiValue = config.inverted ? (!value ? '1' : '0') : (value ? '1' : '0');
          await this._setToggle(config.param, apiValue);
        });
      }
    }

  }

  /**
   * Get the API instance (always fresh from app — never cache, because repair
   * on any device replaces the shared HonApi instance in app.js)
   * @returns {HonApi|null}
   * @private
   */
  _getApi() {
    return this.homey.app.getApi();
  }

  /**
   * Start polling for device state
   * @private
   */
  async _startPolling() {
    // Initial poll
    await this._pollDeviceState();

    // Get interval from settings (seconds), fall back to default
    const intervalSec = this.getSetting('poll_interval') || (DEFAULT_POLL_INTERVAL / 1000);
    const intervalMs = Math.max(5, Math.min(3600, intervalSec)) * 1000;

    // Set up polling interval
    this._pollTimer = this.homey.setInterval(async () => {
      await this._pollDeviceState();
    }, intervalMs);

    this.log(`Polling started with ${intervalMs}ms interval`);
  }

  /**
   * Stop polling
   * @private
   */
  _stopPolling() {
    if (this._pollTimer) {
      this.homey.clearInterval(this._pollTimer);
      this._pollTimer = null;
      this.log('Polling stopped');
    }
  }

  /**
   * Poll the device state from the API
   * @private
   */
  async _pollDeviceState() {
    // Skip poll if a command was recently sent (prevents stale state overwriting UI)
    if (Date.now() < this._skipPollUntil) {
      this.log('Skipping poll (command recently sent)');
      return;
    }

    let api = this._getApi();

    if (!api) {
      // API not created yet — try re-initializing (may recover via refresh token)
      this.log('API not available, attempting re-initialization...');
      try {
        await this.homey.app._initializeApi();
        api = this._getApi();
      } catch (e) {
        this.error('Re-initialization failed:', e.message);
      }
      if (!api) {
        await this.setUnavailable('Not authenticated. Use Repair to reconnect.').catch(this.error);
        return;
      }
    }

    // Don't check isAuthenticated() here — let _apiRequest handle refresh via
    // _ensureAuthenticated(). That way expired tokens trigger a refresh attempt
    // instead of giving up immediately.

    try {
      const state = await api.getApplianceState(this.deviceId);

      if (!state) {
        this.log('No state received');
        return;
      }

      // Update capabilities from state
      await this._updateCapabilities(state);

      // Mark device as available
      if (!this.getAvailable()) {
        await this.setAvailable();
      }
    } catch (error) {
      this.error('Failed to poll device state:', error.message);

      // Mark device as unavailable after unrecoverable auth failures
      if (error.message.includes('re-authenticate') || error.message.includes('No refresh token')) {
        await this.setUnavailable('Authentication failed. Use Repair to reconnect.').catch(this.error);
      }
    }
  }

  /**
   * Extract value from API response (handles both direct values and {parNewVal, lastUpdate} objects)
   * @param {*} value
   * @returns {*}
   * @private
   */
  _extractValue(value) {
    if (value && typeof value === 'object') {
      // API returns {parNewVal: "value", lastUpdate: "timestamp"}
      if ('parNewVal' in value) {
        return value.parNewVal;
      }
      if ('parValue' in value) {
        return value.parValue;
      }
    }
    return value;
  }

  /**
   * Update Homey capabilities from hOn state
   * @param {Object} state - Device state from API
   * @private
   */
  async _updateCapabilities(state) {
    // On/Off status
    if (state.onOffStatus !== undefined) {
      const isOn = Number(this._extractValue(state.onOffStatus)) === 1;
      await this.setCapabilityValue('onoff', isOn).catch(this.error);
    }

    // Current temperature (indoor) - update both thermostat and sensor
    if (state.tempIndoor !== undefined) {
      const temp = Number(this._extractValue(state.tempIndoor));
      if (!isNaN(temp)) {
        await this.setCapabilityValue('measure_temperature', temp).catch(this.error);
        if (this.hasCapability('measure_temperature.indoor')) {
          await this.setCapabilityValue('measure_temperature.indoor', temp).catch(this.error);
        }
      }
    }

    // Target temperature (show 10°C when anti-freeze is active)
    const is10Heating = Number(this._extractValue(state['10degreeHeatingStatus'])) === 1;
    if (is10Heating) {
      await this.setCapabilityValue('target_temperature', 10).catch(this.error);
    } else if (state.tempSel !== undefined) {
      const temp = Number(this._extractValue(state.tempSel));
      if (!isNaN(temp) && temp >= 16) {
        await this.setCapabilityValue('target_temperature', temp).catch(this.error);
      }
    }

    // Thermostat Mode (check 10-degree heating first)
    if (state.machMode !== undefined && this.hasCapability('thermostat_mode')) {
      const is10HeatingMode = Number(this._extractValue(state['10degreeHeatingStatus'])) === 1;
      let newMode;
      if (is10HeatingMode) {
        newMode = '10_heating';
      } else {
        const modeValue = Number(this._extractValue(state.machMode));
        newMode = HON_TO_HVAC_MODE[modeValue] || 'auto';
      }
      await this.setCapabilityValue('thermostat_mode', newMode).catch(this.error);
      // System capability auto-fires thermostat_mode_changed trigger
    }

    // Fan Mode
    if (state.windSpeed !== undefined && this.hasCapability('fan_mode')) {
      const speedValue = Number(this._extractValue(state.windSpeed));
      const mode = HON_TO_FAN_MODE[speedValue] || 'auto';
      await this.setCapabilityValue('fan_mode', mode).catch(this.error);
      // System capability auto-fires fan_mode_changed trigger
    }

    // Swing Mode
    if (this.hasCapability('swing_mode')) {
      const horizontal = Number(this._extractValue(state.windDirectionHorizontal));
      const vertical = Number(this._extractValue(state.windDirectionVertical));
      let swingMode = 'off';

      if (horizontal === 7 && vertical === 8) {
        swingMode = 'both';
      } else if (horizontal === 7) {
        swingMode = 'horizontal';
      } else if (vertical === 8) {
        swingMode = 'vertical';
      }

      await this.setCapabilityValue('swing_mode', swingMode).catch(this.error);
      // System capability auto-fires swing_mode_changed trigger
    }

    // Eco Pilot (humanSensingStatus)
    if (state.humanSensingStatus !== undefined && this.hasCapability('hon_eco_pilot')) {
      const prevPilot = this.getCapabilityValue('hon_eco_pilot');
      const val = Number(this._extractValue(state.humanSensingStatus));
      const mode = HON_TO_ECO_PILOT[val] || 'off';
      await this.setCapabilityValue('hon_eco_pilot', mode).catch(this.error);
      if (mode !== prevPilot) {
        this.homey.flow.getDeviceTriggerCard('hon_eco_pilot_changed')
          .trigger(this, { mode }).catch(this.error);
      }
    }

    // Boolean toggle switches
    for (const [capability, config] of Object.entries(TOGGLE_CAPABILITIES)) {
      if (state[config.param] !== undefined && this.hasCapability(capability)) {
        const val = Number(this._extractValue(state[config.param])) === 1;
        await this.setCapabilityValue(capability, config.inverted ? !val : val).catch(this.error);
      }
    }

    // Outdoor temperature (API uses tempOutdoor or tempAirOutdoor)
    if (this.hasCapability('measure_temperature.outdoor')) {
      const outdoor = state.tempOutdoor || state.tempAirOutdoor;
      if (outdoor !== undefined) {
        const temp = Number(this._extractValue(outdoor));
        if (!isNaN(temp)) {
          await this.setCapabilityValue('measure_temperature.outdoor', temp).catch(this.error);
        }
      }
    }


  }

  /**
   * Set the on/off state
   * @param {boolean} value
   * @private
   */
  async _setOnOff(value) {
    const api = this._getApi();
    if (!api) throw new Error('API not available');

    if (value) {
      // Turn ON using startProgram with current mode
      const currentMode = this.getCapabilityValue('thermostat_mode') || 'auto';
      const programName = HVAC_MODE_TO_PROGRAM[currentMode] || 'IOT_AUTO';
      const machMode = HVAC_MODE_TO_HON[currentMode] ?? 0;
      const params = { ...(this._mandatoryParams || {}) };
      params.onOffStatus = '1';
      params.machMode = String(machMode);
      this.log(`Turning ON with startProgram: ${programName}, machMode: ${machMode}`);
      await api.sendCommand(this.deviceId, 'startProgram', params, {
        programName: programName,
        ancillaryParameters: this._ancillaryParams || {},
        applianceOptions: this._applianceOptions || {},
      });
    } else {
      // Turn OFF using stopProgram - include mandatory params (API requires non-empty parameters)
      const params = { ...(this._mandatoryParams || {}) };
      params.onOffStatus = '0';
      this.log('Turning OFF with stopProgram');
      await api.sendCommand(this.deviceId, 'stopProgram', params, {
        ancillaryParameters: this._ancillaryParams || {},
        applianceOptions: this._applianceOptions || {},
      });
    }

    // Skip regular polls for 10s, then do a fresh poll
    this._skipPollUntil = Date.now() + 10000;
    this.homey.setTimeout(() => {
      this._skipPollUntil = 0;
      this._pollDeviceState().catch(this.error);
    }, 10000);
  }

  /**
   * Set the target temperature
   * @param {number} value
   * @private
   */
  async _setTargetTemperature(value) {
    const api = this._getApi();
    if (!api) throw new Error('API not available');

    // Clamp to 16-30 for normal modes (10 is only valid in anti-freeze)
    const currentMode = this.getCapabilityValue('thermostat_mode') || 'auto';
    if (currentMode === '10_heating') {
      this.log('Temperature cannot be changed in anti-freeze mode');
      throw new Error('Temperature is fixed at 10°C in anti-freeze mode');
    }
    if (value < 16) value = 16;
    if (value > 30) value = 30;

    // Get current values
    const machMode = HVAC_MODE_TO_HON[currentMode] ?? 0;
    const currentFanMode = this.getCapabilityValue('fan_mode') || 'auto';
    const windSpeed = FAN_MODE_TO_HON[currentFanMode] ?? 4;

    // Start with all mandatory parameters
    const params = { ...(this._mandatoryParams || {}) };
    params.onOffStatus = '1';
    params.tempSel = String(Math.round(value));
    params.machMode = String(machMode);
    params.windSpeed = String(windSpeed);

    await api.sendCommand(this.deviceId, 'settings', params, {
      ancillaryParameters: this._ancillaryParams || {},
      applianceOptions: this._applianceOptions || {},
    });

    // Skip regular polls for 10s, then do a fresh poll
    this._skipPollUntil = Date.now() + 10000;
    this.homey.setTimeout(() => {
      this._skipPollUntil = 0;
      this._pollDeviceState().catch(this.error);
    }, 10000);
  }

  /**
   * Set the HVAC mode
   * @param {string} value
   * @private
   */
  async _setHvacMode(value) {
    const api = this._getApi();
    if (!api) throw new Error('API not available');

    // Anti-freeze mode uses startProgram with IOT_10_HEATING
    if (value === '10_heating') {
      const params = { ...(this._mandatoryParams || {}) };
      params.onOffStatus = '1';
      params.machMode = '4'; // Heat mode
      params['10degreeHeatingStatus'] = '1';

      this.log('Starting IOT_10_HEATING program');
      await api.sendCommand(this.deviceId, 'startProgram', params, {
        programName: 'IOT_10_HEATING',
        ancillaryParameters: this._ancillaryParams || {},
        applianceOptions: this._applianceOptions || {},
      });

      // Immediately update UI without waiting for poll
      await this.setCapabilityValue('target_temperature', 10).catch(this.error);
      await this.setCapabilityValue('onoff', true).catch(this.error);

      // Skip regular polls for 10s, then do a fresh poll
      this._skipPollUntil = Date.now() + 10000;
      this.homey.setTimeout(() => {
        this._skipPollUntil = 0;
        this._pollDeviceState().catch(this.error);
      }, 10000);
      return;
    }

    const machMode = HVAC_MODE_TO_HON[value];
    if (machMode === undefined) {
      throw new Error(`Unknown HVAC mode: ${value}`);
    }

    // Use startProgram to change mode (ensures 10degreeHeating is turned off)
    let currentTemp = this.getCapabilityValue('target_temperature') || 16;
    if (currentTemp < 16) currentTemp = 16; // Reset from anti-freeze display temp
    const currentFanMode = this.getCapabilityValue('fan_mode') || 'auto';
    const windSpeed = FAN_MODE_TO_HON[currentFanMode] ?? 5;
    const programName = HVAC_MODE_TO_PROGRAM[value] || 'IOT_AUTO';

    const params = { ...(this._mandatoryParams || {}) };
    params.onOffStatus = '1';
    params.machMode = String(machMode);
    params.tempSel = String(Math.round(currentTemp));
    params.windSpeed = String(windSpeed);
    params['10degreeHeatingStatus'] = '0';

    this.log(`Changing HVAC mode via startProgram: ${programName}, machMode=${machMode}`);
    await api.sendCommand(this.deviceId, 'startProgram', params, {
      programName: programName,
      ancillaryParameters: this._ancillaryParams || {},
      applianceOptions: this._applianceOptions || {},
    });

    // Immediately update UI without waiting for poll
    await this.setCapabilityValue('target_temperature', currentTemp).catch(this.error);
    await this.setCapabilityValue('onoff', true).catch(this.error);

    // Skip regular polls for 10s, then do a fresh poll
    this._skipPollUntil = Date.now() + 10000;
    this.homey.setTimeout(() => {
      this._skipPollUntil = 0;
      this._pollDeviceState().catch(this.error);
    }, 10000);
  }

  /**
   * Set the fan speed
   * @param {string} value
   * @private
   */
  async _setFanSpeed(value) {
    const api = this._getApi();
    if (!api) throw new Error('API not available');

    const windSpeed = FAN_MODE_TO_HON[value];
    if (windSpeed === undefined) {
      throw new Error(`Unknown fan mode: ${value}`);
    }

    // Get current values
    const currentTemp = this.getCapabilityValue('target_temperature') || 16;
    const currentMode = this.getCapabilityValue('thermostat_mode') || 'auto';
    const machMode = HVAC_MODE_TO_HON[currentMode] ?? 0;

    // Start with all mandatory parameters
    const params = { ...(this._mandatoryParams || {}) };
    params.onOffStatus = '1';
    params.tempSel = String(Math.round(currentTemp));
    params.machMode = String(machMode);
    params.windSpeed = String(windSpeed);
    // Preserve anti-freeze mode if active
    if (currentMode === '10_heating') {
      params['10degreeHeatingStatus'] = '1';
    }

    await api.sendCommand(this.deviceId, 'settings', params, {
      ancillaryParameters: this._ancillaryParams || {},
      applianceOptions: this._applianceOptions || {},
    });

    // Skip regular polls for 10s, then do a fresh poll
    this._skipPollUntil = Date.now() + 10000;
    this.homey.setTimeout(() => {
      this._skipPollUntil = 0;
      this._pollDeviceState().catch(this.error);
    }, 10000);
  }

  /**
   * Set the swing mode
   * @param {string} value
   * @private
   */
  async _setSwingMode(value) {
    const api = this._getApi();
    if (!api) throw new Error('API not available');

    let windDirectionHorizontal;
    let windDirectionVertical;

    switch (value) {
      case 'off':
        windDirectionHorizontal = '0';
        windDirectionVertical = '5';
        break;
      case 'vertical':
        windDirectionHorizontal = '0';
        windDirectionVertical = '8';
        break;
      case 'horizontal':
        windDirectionHorizontal = '7';
        windDirectionVertical = '5';
        break;
      case 'both':
        windDirectionHorizontal = '7';
        windDirectionVertical = '8';
        break;
      default:
        throw new Error(`Unknown swing mode: ${value}`);
    }

    // Get current values
    const currentTemp = this.getCapabilityValue('target_temperature') || 16;
    const currentMode = this.getCapabilityValue('thermostat_mode') || 'auto';
    const machMode = HVAC_MODE_TO_HON[currentMode] ?? 0;
    const currentFanMode = this.getCapabilityValue('fan_mode') || 'auto';
    const windSpeed = FAN_MODE_TO_HON[currentFanMode] ?? 4;

    // Start with all mandatory parameters
    const params = { ...(this._mandatoryParams || {}) };
    params.onOffStatus = '1';
    params.tempSel = String(Math.round(currentTemp));
    params.machMode = String(machMode);
    params.windSpeed = String(windSpeed);
    params.windDirectionHorizontal = windDirectionHorizontal;
    params.windDirectionVertical = windDirectionVertical;
    // Preserve anti-freeze mode if active
    if (currentMode === '10_heating') {
      params['10degreeHeatingStatus'] = '1';
    }

    await api.sendCommand(this.deviceId, 'settings', params, {
      ancillaryParameters: this._ancillaryParams || {},
      applianceOptions: this._applianceOptions || {},
    });

    // Skip regular polls for 10s, then do a fresh poll
    this._skipPollUntil = Date.now() + 10000;
    this.homey.setTimeout(() => {
      this._skipPollUntil = 0;
      this._pollDeviceState().catch(this.error);
    }, 10000);
  }

  /**
   * Generic toggle/setting handler - sends a settings command with one parameter changed
   * @param {string} paramName - API parameter name
   * @param {string} apiValue - Value to send ('0' or '1', or enum value)
   * @private
   */
  async _setToggle(paramName, apiValue) {
    const api = this._getApi();
    if (!api) throw new Error('API not available');

    // Build params from current state
    const currentMode = this.getCapabilityValue('thermostat_mode') || 'auto';
    const machMode = HVAC_MODE_TO_HON[currentMode] ?? 0;
    let currentTemp = this.getCapabilityValue('target_temperature') || 16;
    if (currentTemp < 16) currentTemp = 16;
    const currentFanMode = this.getCapabilityValue('fan_mode') || 'auto';
    const windSpeed = FAN_MODE_TO_HON[currentFanMode] ?? 5;

    const params = { ...(this._mandatoryParams || {}) };
    params.onOffStatus = this.getCapabilityValue('onoff') ? '1' : '0';
    params.machMode = String(machMode);
    params.tempSel = String(Math.round(currentTemp));
    params.windSpeed = String(windSpeed);
    // Preserve anti-freeze mode if active
    if (currentMode === '10_heating') {
      params['10degreeHeatingStatus'] = '1';
    }
    params[paramName] = apiValue;

    this.log(`Setting ${paramName} to ${apiValue} via settings command`);
    await api.sendCommand(this.deviceId, 'settings', params, {
      ancillaryParameters: this._ancillaryParams || {},
      applianceOptions: this._applianceOptions || {},
    });

    // Skip regular polls for 10s, then do a fresh poll
    this._skipPollUntil = Date.now() + 10000;
    this.homey.setTimeout(() => {
      this._skipPollUntil = 0;
      this._pollDeviceState().catch(this.error);
    }, 10000);
  }

  /**
   * onAdded is called when the user adds the device.
   */
  async onAdded() {
    this.log('Aircon device has been added');
  }

  /**
   * onSettings is called when the user updates the device's settings.
   */
  async onSettings({ oldSettings, newSettings, changedKeys }) {
    this.log('Aircon device settings changed:', changedKeys);

    if (changedKeys.includes('poll_interval')) {
      this.log(`Poll interval changed to ${newSettings.poll_interval}s`);
      this._stopPolling();
      await this._startPolling();
    }
  }

  /**
   * onRenamed is called when the user updates the device's name.
   */
  async onRenamed(name) {
    this.log('Aircon device was renamed to:', name);
  }

  /**
   * onDeleted is called when the user deletes the device.
   */
  async onDeleted() {
    this.log('Aircon device has been deleted');
    this._stopPolling();
  }

}

module.exports = AirconDevice;
