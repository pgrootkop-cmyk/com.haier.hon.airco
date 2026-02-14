'use strict';

const Homey = require('homey');
const HonApi = require('./lib/HonApi');

class HaierHonApp extends Homey.App {

  /**
   * onInit is called when the app is initialized.
   */
  async onInit() {
    this.log('Haier hOn app is starting...');

    // Initialize the API client (will be shared across all devices)
    this.api = null;

    // Attempt to initialize API if we have stored tokens
    await this._initializeApi();

    this.log('Haier hOn app has been initialized');
  }

  /**
   * Initialize the API client with stored tokens
   * @private
   */
  async _initializeApi() {
    const accessToken = this.homey.settings.get('accessToken');
    const idToken = this.homey.settings.get('idToken');
    const refreshToken = this.homey.settings.get('refreshToken');

    if (!accessToken || !idToken) {
      this.log('No tokens stored, waiting for pairing...');
      return;
    }

    try {
      this.api = new HonApi({
        onTokenRefresh: (newRefreshToken) => {
          this.homey.settings.set('refreshToken', newRefreshToken);
          this.log('Refresh token updated in settings');
        },
        onTokensUpdated: (accessToken, idToken) => {
          this.homey.settings.set('accessToken', accessToken);
          this.homey.settings.set('idToken', idToken);
          this.log('Access & ID tokens updated in settings');
        },
        log: this.log.bind(this),
        error: this.error.bind(this),
      });

      // Set stored tokens and initialize
      this.api.setTokens(accessToken, idToken, refreshToken);
      await this.api.initializeWithTokens();
      this.log('API authenticated successfully with stored tokens');
    } catch (error) {
      this.error('Failed to initialize API:', error.message);

      // If we have a refresh token, try to refresh
      if (refreshToken) {
        this.log('Attempting to refresh tokens...');
        try {
          this.api = new HonApi({
            refreshToken: refreshToken,
            onTokenRefresh: (newRefreshToken) => {
              this.homey.settings.set('refreshToken', newRefreshToken);
              this.log('Refresh token updated in settings');
            },
            onTokensUpdated: (accessToken, idToken) => {
              this.homey.settings.set('accessToken', accessToken);
              this.homey.settings.set('idToken', idToken);
              this.log('Access & ID tokens updated in settings');
            },
            log: this.log.bind(this),
            error: this.error.bind(this),
          });
          await this.api.authenticate();

          // Store the new tokens
          this.homey.settings.set('accessToken', this.api.accessToken);
          this.homey.settings.set('idToken', this.api.idToken);
          this.log('API authenticated successfully with refreshed tokens');
          return;
        } catch (refreshError) {
          this.error('Token refresh failed:', refreshError.message);
        }
      }

      // Clear invalid tokens
      this.homey.settings.set('accessToken', null);
      this.homey.settings.set('idToken', null);
      this.api = null;
    }
  }

  /**
   * Get the API client instance
   * @returns {HonApi|null}
   */
  getApi() {
    return this.api;
  }

  /**
   * Set tokens from OAuth flow and reinitialize the API
   * Called during pairing
   * @param {string} accessToken
   * @param {string} idToken
   * @param {string} [refreshToken]
   */
  async setTokens(accessToken, idToken, refreshToken = null) {
    this.homey.settings.set('accessToken', accessToken);
    this.homey.settings.set('idToken', idToken);
    if (refreshToken) {
      this.homey.settings.set('refreshToken', refreshToken);
    }

    await this._initializeApi();
  }

  /**
   * Check if the API is authenticated
   * @returns {boolean}
   */
  isAuthenticated() {
    return this.api !== null && this.api.isAuthenticated();
  }

}

module.exports = HaierHonApp;
