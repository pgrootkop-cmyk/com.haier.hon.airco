'use strict';

const Homey = require('homey');
const HonApi = require('../../lib/HonApi');

class AirconDriver extends Homey.Driver {

  /**
   * onInit is called when the driver is initialized.
   */
  async onInit() {
    this.log('Aircon driver has been initialized');
    this._registerFlowCards();
  }

  /**
   * Register flow card handlers for custom capabilities.
   * System capabilities (thermostat_mode, fan_mode, swing_mode) provide
   * their own flow cards automatically — no registration needed.
   * @private
   */
  _registerFlowCards() {
    // Condition card for Eco Pilot (custom capability)
    this.homey.flow.getConditionCard('hon_eco_pilot_is')
      .registerRunListener(async (args) => {
        return args.device.getCapabilityValue('hon_eco_pilot') === args.mode;
      });

    // Action card for Eco Pilot (custom capability)
    this.homey.flow.getActionCard('set_hon_eco_pilot')
      .registerRunListener(async (args) => {
        const ECO_PILOT_TO_HON = { 'off': '0', 'avoid': '1', 'follow': '2' };
        await args.device._setToggle('humanSensingStatus', ECO_PILOT_TO_HON[args.mode] || '0');
        await args.device.setCapabilityValue('hon_eco_pilot', args.mode).catch(this.error);
      });

    // Boolean toggle action cards (custom capabilities)
    const TOGGLE_ACTIONS = {
      'set_hon_silent_mode': { capability: 'hon_silent_mode', param: 'muteStatus' },
      'set_hon_rapid_mode': { capability: 'hon_rapid_mode', param: 'rapidMode' },
      'set_hon_sleep_mode': { capability: 'hon_sleep_mode', param: 'silentSleepStatus' },
      'set_hon_eco_mode': { capability: 'hon_eco_mode', param: 'ecoMode' },
      'set_hon_health_mode': { capability: 'hon_health_mode', param: 'healthMode' },
      'set_hon_screen_display': { capability: 'hon_screen_display', param: 'screenDisplayStatus' },
      'set_hon_echo_mode': { capability: 'hon_echo_mode', param: 'echoStatus', inverted: true },
    };

    for (const [cardId, config] of Object.entries(TOGGLE_ACTIONS)) {
      this.homey.flow.getActionCard(cardId)
        .registerRunListener(async (args) => {
          const value = args.enabled === 'true';
          const apiValue = config.inverted ? (!value ? '1' : '0') : (value ? '1' : '0');
          await args.device._setToggle(config.param, apiValue);
          await args.device.setCapabilityValue(config.capability, value).catch(this.error);
        });
    }
  }

  /**
   * onPairListDevices is called when a user is adding a device
   * and the 'list_devices' view is called.
   */
  async onPairListDevices() {
    const app = this.homey.app;
    const api = app.getApi();

    if (!api || !api.isAuthenticated()) {
      throw new Error('Not authenticated. Please login first.');
    }

    try {
      // Fetch all appliances from the hOn API
      const appliances = await api.getAppliances();

      // Filter to only Air Conditioners (AC type)
      const aircons = appliances.filter(appliance => appliance.applianceTypeName === 'AC');

      if (aircons.length === 0) {
        throw new Error('No air conditioners found in your hOn account');
      }

      // Map to Homey device format
      return aircons.map(ac => {
        // Extract just the MAC address (without timestamp after #)
        // The API returns macAddress with a timestamp suffix
        const fullMac = ac.macAddress || ac.applianceId || '';
        const macAddress = fullMac.split('#')[0];

        this.log(`AC: macAddress=${ac.macAddress}, applianceId=${ac.applianceId}, extracted=${macAddress}`);

        return {
          name: ac.nickName || ac.modelName || 'Haier AC',
          data: {
            id: macAddress, // Just the MAC address
            applianceId: ac.applianceId,
          },
          store: {
            modelName: ac.modelName,
            serialNumber: ac.serialNumber,
            brand: ac.brand || 'Haier',
          },
        };
      });
    } catch (error) {
      this.error('Failed to list devices:', error.message);
      throw error;
    }
  }

  /**
   * onPair is called when pairing is started
   */
  onPair(session) {
    // Clean up on disconnect to prevent "Another pair session is already active"
    session.setHandler('disconnect', async () => {
      this.log('Pair session disconnected');
    });

    // Provide Homey's language to the pairing view
    session.setHandler('get_language', async () => {
      return this.homey.i18n.getLanguage();
    });

    // Handle OAuth tokens from custom pairing view
    session.setHandler('oauth_tokens', async (tokens) => {
      this.log('Received OAuth tokens');

      try {
        // Create API instance with tokens
        const api = new HonApi({
          log: this.log.bind(this),
          error: this.error.bind(this),
        });

        // Set tokens directly
        api.setTokens(tokens.accessToken, tokens.idToken, tokens.refreshToken);

        // Store tokens in app settings
        await this.homey.app.setTokens(tokens.accessToken, tokens.idToken, tokens.refreshToken);

        this.log('OAuth login successful');
        return true;
      } catch (error) {
        this.error('OAuth login failed:', error.message);
        throw new Error('Failed to authenticate with hOn');
      }
    });

    // Handle list devices request
    session.setHandler('list_devices', async () => {
      return this.onPairListDevices();
    });
  }

  /**
   * onRepair is called when repair is started.
   * Auth is centralized in app.js — repairing one device fixes ALL devices
   * since they share the same hOn account/API instance.
   */
  onRepair(session, device) {
    session.setHandler('disconnect', async () => {
      this.log('Repair session disconnected');
    });

    // Provide Homey's language to the repair view
    session.setHandler('get_language', async () => {
      return this.homey.i18n.getLanguage();
    });

    // Handle OAuth tokens for repair
    session.setHandler('oauth_tokens', async (tokens) => {
      this.log('Received OAuth tokens for repair');

      try {
        // Update shared tokens in app.js (creates new HonApi instance)
        await this.homey.app.setTokens(tokens.accessToken, tokens.idToken, tokens.refreshToken);

        // Reinitialize ALL devices of this driver (they share the same account)
        const devices = this.getDevices();
        this.log(`Repair: reinitializing ${devices.length} device(s)...`);
        for (const dev of devices) {
          try {
            await dev.setAvailable();
            this.log(`Repair: ${dev.getName()} marked available`);
          } catch (e) {
            this.error(`Repair: failed to restore ${dev.getName()}:`, e.message);
          }
        }

        this.log('Repair successful — all devices restored');
        return true;
      } catch (error) {
        this.error('Repair login failed:', error.message);
        throw new Error('Failed to re-authenticate with hOn');
      }
    });
  }

}

module.exports = AirconDriver;
