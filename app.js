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

    if (!refreshToken && !accessToken) {
      this.log('No tokens stored, waiting for pairing...');
      return;
    }

    try {
      this.api = new HonApi({
        refreshToken: refreshToken,
        onTokenRefresh: (newRefreshToken) => {
          this.homey.settings.set('refreshToken', newRefreshToken);
          this.log('Refresh token updated in settings');
        },
        onTokensUpdated: (newAccessToken, newIdToken) => {
          this.homey.settings.set('accessToken', newAccessToken);
          this.homey.settings.set('idToken', newIdToken);
          this.log('Access & ID tokens updated in settings');
        },
        log: this.log.bind(this),
        error: this.error.bind(this),
      });

      if (accessToken && idToken) {
        // Try using stored access/id tokens first
        this.api.setTokens(accessToken, idToken, refreshToken);
        try {
          await this.api.initializeWithTokens();
          this.log('API authenticated with stored tokens');
        } catch (initError) {
          // Stored tokens likely expired — fall back to refresh token
          this.log('Stored tokens failed (likely expired), trying refresh...', initError.message);
          if (refreshToken) {
            await this.api._safeRefresh();
            this.log('API authenticated via refresh token (fallback)');
          } else {
            throw initError;
          }
        }
      } else if (refreshToken) {
        // Only refresh token available — use it to get fresh access/id/cognito tokens
        this.log('Only refresh token stored, refreshing...');
        await this.api._safeRefresh();
        this.log('API authenticated via refresh token');
      }
    } catch (error) {
      this.error('Failed to initialize API:', error.message);

      // Keep the API instance alive if we have a refresh token — _ensureAuthenticated()
      // in _apiRequest will retry the refresh on the next poll cycle.
      if (!refreshToken) {
        this.api = null;
      } else {
        this.log('Keeping API instance alive for refresh retry on next poll');
      }
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
   * Called during pairing and repair
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
