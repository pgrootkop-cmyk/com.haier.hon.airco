'use strict';

const fetch = require('node-fetch');
const crypto = require('crypto');

// API Constants (from pyhOn reverse engineering)
const AUTH_API = 'https://account2.hon-smarthome.com';
const API_URL = 'https://api-iot.he.services';
const CLIENT_ID = '3MVG9QDx8IX8nP5T2Ha8ofvlmjLZl5L_gvfbT9.HJvpHGKoAS_dcMN8LYpTSYeVFCraUnV.2Ag1Ki7m4znVO6';
const APP_VERSION = '2.0.10';
const OS_VERSION = '17.6.1';
const DEVICE_MODEL = 'iPhone16,2';

// Token expiry: Salesforce tokens last ~8 hours.
// Proactively refresh 1 hour before expiry (like pyhOn).
const TOKEN_LIFETIME_MS = 8 * 60 * 60 * 1000;
const TOKEN_EXPIRY_BUFFER = 60 * 60 * 1000;

/**
 * Haier hOn API Client
 * Based on the pyhOn library by Andre0512
 */
class HonApi {

  /**
   * Create a new HonApi instance
   * @param {Object} options
   * @param {string} [options.refreshToken] - Stored refresh token
   * @param {Function} [options.onTokenRefresh] - Callback when refresh token is updated
   * @param {Function} [options.onTokensUpdated] - Callback when access/id tokens are updated
   * @param {Function} [options.log] - Logging function
   * @param {Function} [options.error] - Error logging function
   */
  constructor(options) {
    this.refreshToken = options.refreshToken || null;
    this.onTokenRefresh = options.onTokenRefresh || (() => {});
    this.onTokensUpdated = options.onTokensUpdated || (() => {});
    this.log = options.log || console.log;
    this.error = options.error || console.error;

    // Token state
    this.accessToken = null;
    this.idToken = null;
    this.cognitoToken = null;
    this.tokenExpiresAt = null;

    // Stable mobile ID for Cognito requests (pyhOn uses a stable device reference)
    this._mobileId = crypto.randomUUID();

    // Session state
    this._authenticated = false;

    // Prevent concurrent refresh attempts
    this._refreshPromise = null;
  }

  /**
   * Build authenticated headers for API requests
   * @returns {Object}
   * @private
   */
  _buildAuthHeaders() {
    return {
      'User-Agent': `hOn/${APP_VERSION} (iPhone; iOS ${OS_VERSION}; Scale/3.00)`,
      'Accept': '*/*',
      'Accept-Language': 'en-US;q=1',
      'Content-Type': 'application/json',
      'cognito-token': this.cognitoToken,
      'id-token': this.idToken,
    };
  }

  /**
   * Check if authentication is currently valid
   * @returns {boolean}
   */
  isAuthenticated() {
    if (!this._authenticated || !this.cognitoToken || !this.idToken) {
      return false;
    }
    // Token not yet expired (accounting for buffer)
    if (this.tokenExpiresAt && Date.now() > this.tokenExpiresAt - TOKEN_EXPIRY_BUFFER) {
      return false;
    }
    return true;
  }

  /**
   * Check if tokens are expired (hard expiry, past the lifetime)
   * @returns {boolean}
   */
  isTokenExpired() {
    if (!this.tokenExpiresAt) return true;
    return Date.now() > this.tokenExpiresAt;
  }

  /**
   * Set tokens directly (from OAuth popup flow)
   * @param {string} accessToken
   * @param {string} idToken
   * @param {string} [refreshToken]
   */
  setTokens(accessToken, idToken, refreshToken = null) {
    this.accessToken = accessToken;
    this.idToken = idToken;
    if (refreshToken) {
      this.refreshToken = refreshToken;
    }
    this.tokenExpiresAt = Date.now() + TOKEN_LIFETIME_MS;
  }

  /**
   * Initialize with pre-set tokens (get Cognito token)
   * Call this after setTokens() to complete authentication
   */
  async initializeWithTokens() {
    if (!this.accessToken || !this.idToken) {
      throw new Error('Tokens not set. Call setTokens() first.');
    }

    await this._getCognitoToken();
    this._authenticated = true;
    this.log('Initialized with pre-set tokens');
  }

  /**
   * Refresh Salesforce tokens using the refresh token, then get a new Cognito token.
   * This is the two-phase refresh that pyhOn uses on every refresh cycle.
   * @private
   */
  async _refreshAccessToken() {
    if (!this.refreshToken) {
      throw new Error('No refresh token available. Please re-authenticate via Repair.');
    }

    this.log('Refreshing Salesforce tokens...');

    const params = new URLSearchParams({
      grant_type: 'refresh_token',
      client_id: CLIENT_ID,
      refresh_token: this.refreshToken,
    });

    const response = await fetch(`${AUTH_API}/services/oauth2/token`, {
      method: 'POST',
      headers: {
        'User-Agent': `hOn/${APP_VERSION} (iPhone; iOS ${OS_VERSION}; Scale/3.00)`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: params.toString(),
    });

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`Token refresh failed: ${response.status} - ${text}`);
    }

    const result = await response.json();

    this.log(`Salesforce refresh response keys: ${Object.keys(result).join(', ')}`);
    this.log(`Salesforce returned id_token: ${result.id_token ? 'yes' : 'NO'}`);
    this.log(`Salesforce returned refresh_token: ${result.refresh_token ? 'yes (rotating)' : 'no (keeping current)'}`);

    this.accessToken = result.access_token;
    this.idToken = result.id_token;

    // Salesforce may rotate refresh tokens
    if (result.refresh_token) {
      this.refreshToken = result.refresh_token;
      this.onTokenRefresh(this.refreshToken);
    }

    // Persist updated tokens
    this.onTokensUpdated(this.accessToken, this.idToken);

    // Calculate token expiry from Salesforce response
    const expiresIn = result.expires_in || 28800;
    this.tokenExpiresAt = Date.now() + (expiresIn * 1000);
    this.log(`Token expiry set to ${new Date(this.tokenExpiresAt).toISOString()} (${expiresIn}s from now)`);

    // Phase 2: Always re-obtain Cognito token with the fresh id_token (like pyhOn)
    this.log('Exchanging fresh id_token for Cognito token...');
    await this._getCognitoToken();

    this._authenticated = true;
    this.log('Token refresh complete');
  }

  /**
   * Thread-safe token refresh — prevents concurrent refresh calls
   * @private
   */
  async _safeRefresh() {
    if (this._refreshPromise) {
      return this._refreshPromise;
    }
    this._refreshPromise = this._refreshAccessToken()
      .finally(() => { this._refreshPromise = null; });
    return this._refreshPromise;
  }

  /**
   * Ensure we have valid authentication before making an API call.
   * Proactively refreshes if tokens are about to expire.
   * @private
   */
  async _ensureAuthenticated() {
    if (this.isAuthenticated()) {
      return; // Tokens still fresh
    }

    // Log why we think auth is invalid
    const reasons = [];
    if (!this._authenticated) reasons.push('not yet authenticated');
    if (!this.cognitoToken) reasons.push('no cognito token');
    if (!this.idToken) reasons.push('no id token');
    if (this.tokenExpiresAt && Date.now() > this.tokenExpiresAt - TOKEN_EXPIRY_BUFFER) {
      const minutesAgo = Math.round((Date.now() - (this.tokenExpiresAt - TOKEN_EXPIRY_BUFFER)) / 60000);
      reasons.push(`token expired/expiring (${minutesAgo}m past buffer)`);
    }
    this.log(`Auth invalid: ${reasons.join(', ')}`);

    // Tokens expired or about to expire — try refresh
    if (this.refreshToken) {
      this.log('Attempting token refresh...');
      await this._safeRefresh();
      return;
    }

    throw new Error('Not authenticated and no refresh token. Please re-authenticate via Repair.');
  }

  /**
   * Get Cognito token for API access
   * @private
   */
  async _getCognitoToken() {
    const response = await fetch(`${API_URL}/auth/v1/login`, {
      method: 'POST',
      headers: {
        'User-Agent': `hOn/${APP_VERSION} (iPhone; iOS ${OS_VERSION}; Scale/3.00)`,
        'Accept': '*/*',
        'Content-Type': 'application/json',
        'id-token': this.idToken,
      },
      body: JSON.stringify({
        appVersion: APP_VERSION,
        mobileId: this._mobileId,
        osVersion: OS_VERSION,
        os: 'ios',
        deviceModel: DEVICE_MODEL,
      }),
    });

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`Failed to get Cognito token: ${response.status} - ${text}`);
    }

    const result = await response.json();

    if (!result.cognitoUser?.Token) {
      throw new Error('No Cognito token in response');
    }

    this.cognitoToken = result.cognitoUser.Token;
    this.log('Cognito token obtained successfully');
  }

  /**
   * Make an authenticated API request with automatic retry on 401/403.
   *
   * Implements pyhOn-style intercept:
   *   Level 0: Normal request. If 401/403 → refresh tokens → retry at level 1.
   *   Level 1: After refresh. If still 401/403 → fail.
   *
   * @param {string} endpoint
   * @param {Object} [options]
   * @returns {Promise<Object>}
   * @private
   */
  async _apiRequest(endpoint, options = {}) {
    await this._ensureAuthenticated();

    const url = `${API_URL}${endpoint}`;

    const doFetch = async () => {
      return fetch(url, {
        method: options.method || 'GET',
        headers: {
          ...this._buildAuthHeaders(),
          ...options.headers,
        },
        body: options.body ? JSON.stringify(options.body) : undefined,
      });
    };

    // Level 0: normal request
    let response = await doFetch();

    if (response.status === 401 || response.status === 403) {
      // Reactive retry: refresh tokens and retry once
      this.log(`Got ${response.status} on ${endpoint}, refreshing tokens...`);
      try {
        await this._safeRefresh();
      } catch (refreshError) {
        this._authenticated = false;
        throw new Error(`Authentication failed (refresh error): ${refreshError.message}`);
      }

      // Level 1: retry with fresh tokens
      response = await doFetch();

      if (response.status === 401 || response.status === 403) {
        this._authenticated = false;
        const text = await response.text();
        throw new Error(`Authentication failed after refresh: ${response.status} - ${text}`);
      }
    }

    if (!response.ok) {
      const text = await response.text();
      const error = new Error(`API request failed: ${response.status} - ${text}`);
      error.status = response.status;
      throw error;
    }

    return response.json();
  }

  /**
   * Get list of appliances
   * @returns {Promise<Array>}
   */
  async getAppliances() {
    this.log('Fetching appliances...');

    const result = await this._apiRequest('/commands/v1/appliance');
    return result.payload?.appliances || [];
  }

  /**
   * Get command definitions for an appliance
   * @param {Object} appliance - Appliance info from getAppliances()
   * @returns {Promise<Object>}
   */
  async getCommandDefinitions(appliance) {
    this.log('Fetching command definitions for:', appliance.macAddress);

    const params = new URLSearchParams({
      applianceType: appliance.applianceTypeName || 'AC',
      applianceModelId: String(appliance.applianceModelId || ''),
      macAddress: appliance.macAddress,
      os: 'ios',
      appVersion: APP_VERSION,
      code: appliance.code || '',
    });

    if (appliance.eepromId) {
      params.set('firmwareId', appliance.eepromId);
    }
    if (appliance.fwVersion) {
      params.set('fwVersion', appliance.fwVersion);
    }
    if (appliance.series) {
      params.set('series', appliance.series);
    }

    const result = await this._apiRequest(`/commands/v1/retrieve?${params.toString()}`);
    return result.payload || result;
  }

  /**
   * Get appliance state
   * @param {string} macAddress - The MAC address (without timestamp)
   * @returns {Promise<Object>}
   */
  async getApplianceState(macAddress) {
    const result = await this._apiRequest(
      `/commands/v1/context?macAddress=${encodeURIComponent(macAddress)}&applianceType=AC&category=CYCLE`
    );

    // Extract parameters from context
    const context = result.payload;
    if (!context) {
      return null;
    }

    // Flatten the parameters
    const state = {};
    if (context.shadow?.parameters) {
      Object.assign(state, context.shadow.parameters);
    }
    if (context.lastConnEvent) {
      state.lastConnEvent = context.lastConnEvent;
    }

    return state;
  }

  /**
   * Send a command to an appliance
   * @param {string} macAddress - The MAC address (without timestamp)
   * @param {string} commandName - Command name (startProgram, stopProgram, settings)
   * @param {Object} [parameters] - Command parameters
   * @param {Object} [options] - Additional options
   * @param {Object} [options.ancillaryParameters] - Ancillary parameters
   * @param {Object} [options.applianceOptions] - Appliance options from device model
   * @param {string} [options.programName] - Program name for startProgram commands
   * @returns {Promise<Object>}
   */
  async sendCommand(macAddress, commandName, parameters = {}, options = {}) {
    this.log(`Sending command ${commandName} to ${macAddress}:`, JSON.stringify(parameters));

    const now = new Date().toISOString().slice(0, -1) + 'Z';
    const payload = {
      macAddress: macAddress,
      timestamp: now,
      commandName,
      transactionId: `${macAddress}_${now}`,
      applianceOptions: options.applianceOptions || {},
      device: {
        appVersion: APP_VERSION,
        mobileId: this._mobileId,
        mobileOs: 'ios',
        osVersion: OS_VERSION,
        deviceModel: DEVICE_MODEL,
      },
      attributes: {
        channel: 'mobileApp',
        origin: 'standardProgram',
        energyLabel: '0',
      },
      ancillaryParameters: options.ancillaryParameters || {},
      parameters: parameters || {},
      applianceType: 'AC',
    };

    if (commandName === 'startProgram') {
      const programName = (options.programName || 'iot_auto').toUpperCase();
      payload.programName = programName;
    }

    const result = await this._apiRequest('/commands/v1/send', {
      method: 'POST',
      body: payload,
    });
    return result;
  }

}

module.exports = HonApi;
