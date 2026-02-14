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
   * Register flow card handlers (once per driver, not per device)
   * @private
   */
  _registerFlowCards() {
    // Condition cards
    this.homey.flow.getConditionCard('hon_hvac_mode_is')
      .registerRunListener(async (args) => {
        return args.device.getCapabilityValue('hon_hvac_mode') === args.mode;
      });

    this.homey.flow.getConditionCard('hon_fan_speed_is')
      .registerRunListener(async (args) => {
        return args.device.getCapabilityValue('hon_fan_speed') === args.speed;
      });

    this.homey.flow.getConditionCard('hon_eco_pilot_is')
      .registerRunListener(async (args) => {
        return args.device.getCapabilityValue('hon_eco_pilot') === args.mode;
      });

    // Action cards
    this.homey.flow.getActionCard('set_hon_hvac_mode')
      .registerRunListener(async (args) => {
        await args.device._setHvacMode(args.mode);
        await args.device.setCapabilityValue('hon_hvac_mode', args.mode).catch(this.error);
      });

    this.homey.flow.getActionCard('set_hon_fan_speed')
      .registerRunListener(async (args) => {
        await args.device._setFanSpeed(args.speed);
        await args.device.setCapabilityValue('hon_fan_speed', args.speed).catch(this.error);
      });

    this.homey.flow.getActionCard('set_hon_swing_mode')
      .registerRunListener(async (args) => {
        await args.device._setSwingMode(args.swing);
        await args.device.setCapabilityValue('hon_swing_mode', args.swing).catch(this.error);
      });

    this.homey.flow.getActionCard('set_hon_eco_pilot')
      .registerRunListener(async (args) => {
        const ECO_PILOT_TO_HON = { 'off': '0', 'avoid': '1', 'follow': '2' };
        await args.device._setToggle('humanSensingStatus', ECO_PILOT_TO_HON[args.mode] || '0');
        await args.device.setCapabilityValue('hon_eco_pilot', args.mode).catch(this.error);
      });

    // Boolean toggle action cards
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
   * onRepair is called when repair is started
   */
  onRepair(session, device) {
    session.setHandler('disconnect', async () => {
      this.log('Repair session disconnected');
    });

    // Handle OAuth tokens for repair
    session.setHandler('oauth_tokens', async (tokens) => {
      this.log('Received OAuth tokens for repair');

      try {
        const api = new HonApi({
          log: this.log.bind(this),
          error: this.error.bind(this),
        });

        api.setTokens(tokens.accessToken, tokens.idToken, tokens.refreshToken);
        await this.homey.app.setTokens(tokens.accessToken, tokens.idToken, tokens.refreshToken);

        // Reinitialize the device
        await device.onInit();

        this.log('Repair successful');
        return true;
      } catch (error) {
        this.error('Repair login failed:', error.message);
        throw new Error('Failed to re-authenticate with hOn');
      }
    });
  }

}

module.exports = AirconDriver;
