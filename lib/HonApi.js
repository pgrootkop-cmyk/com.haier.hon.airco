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
const REDIRECT_URI = 'hon://mobilesdk/detect/oauth/done';

// Token expiry buffer (refresh 5 minutes before expiry)
const TOKEN_EXPIRY_BUFFER = 5 * 60 * 1000;

/**
 * Haier hOn API Client
 * Based on the pyhOn library by Andre0512
 */
class HonApi {

  /**
   * Create a new HonApi instance
   * @param {Object} options
   * @param {string} options.email - hOn account email
   * @param {string} options.password - hOn account password
   * @param {string} [options.refreshToken] - Stored refresh token
   * @param {Function} [options.onTokenRefresh] - Callback when token is refreshed
   * @param {Function} [options.log] - Logging function
   * @param {Function} [options.error] - Error logging function
   */
  constructor(options) {
    this.email = options.email;
    this.password = options.password;
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

    // Session state
    this._authenticated = false;
    this._cookies = new Map();
  }

  /**
   * Generate a random string for nonce/state values
   * @param {number} length
   * @returns {string}
   * @private
   */
  _generateRandomString(length = 32) {
    return crypto.randomBytes(length).toString('hex').slice(0, length);
  }

  /**
   * Build default headers for requests
   * @returns {Object}
   * @private
   */
  _buildHeaders() {
    const headers = {
      'User-Agent': `hOn/${APP_VERSION} (iPhone; iOS ${OS_VERSION}; Scale/3.00)`,
      'Accept': '*/*',
      'Accept-Language': 'en-US;q=1',
    };

    // Add cookies if any
    if (this._cookies.size > 0) {
      headers['Cookie'] = Array.from(this._cookies.entries())
        .map(([name, value]) => `${name}=${value}`)
        .join('; ');
    }

    return headers;
  }

  /**
   * Store cookies from response
   * @param {Response} response
   * @private
   */
  _storeCookies(response) {
    const setCookie = response.headers.raw()['set-cookie'];
    if (setCookie) {
      for (const cookie of setCookie) {
        const match = cookie.match(/^([^=]+)=([^;]*)/);
        if (match) {
          this._cookies.set(match[1], match[2]);
        }
      }
    }
  }

  /**
   * Clear cookies for authentication domain
   * @private
   */
  _clearCookies() {
    this._cookies.clear();
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
   * Check if authentication is valid
   * @returns {boolean}
   */
  isAuthenticated() {
    if (!this._authenticated || !this.cognitoToken) {
      return false;
    }

    // Check if token is about to expire
    if (this.tokenExpiresAt && Date.now() > this.tokenExpiresAt - TOKEN_EXPIRY_BUFFER) {
      return false;
    }

    return true;
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
    // Default 8 hour expiry
    this.tokenExpiresAt = Date.now() + (8 * 60 * 60 * 1000);
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
   * Authenticate with the hOn API
   */
  async authenticate() {
    try {
      // Try refresh token first if available
      if (this.refreshToken) {
        try {
          await this._refreshAccessToken();
          this._authenticated = true;
          this.log('Authenticated using refresh token');
          return;
        } catch (error) {
          this.log('Refresh token failed, performing full login:', error.message);
        }
      }

      // Full OAuth login flow
      await this._performFullLogin();
      this._authenticated = true;
      this.log('Authenticated with full login');
    } catch (error) {
      this._authenticated = false;
      this.error('Authentication failed:', error.message);
      throw error;
    }
  }

  /**
   * Perform the full OAuth login flow
   * @private
   */
  async _performFullLogin() {
    // Clear cookies before starting
    this._clearCookies();

    // Step 1: Initialize OAuth and get login URL
    this.log('Step 1: Initializing OAuth flow...');
    const loginUrl = await this._initOAuthFlow();

    // Step 2: Load login page and extract context
    this.log('Step 2: Loading login page...');
    const { fwuid, loaded, startUrl } = await this._loadLoginPage(loginUrl);

    // Step 3: Submit credentials
    this.log('Step 3: Submitting credentials...');
    const redirectUrl = await this._submitCredentials(fwuid, loaded, startUrl);

    // Step 4: Follow redirects to get tokens
    this.log('Step 4: Extracting tokens...');
    await this._extractTokens(redirectUrl);

    // Step 5: Get Cognito token for API access
    this.log('Step 5: Getting Cognito token...');
    await this._getCognitoToken();
  }

  /**
   * Initialize OAuth flow and get login URL
   * @returns {Promise<string>} Login URL
   * @private
   */
  async _initOAuthFlow() {
    const nonce = this._generateRandomString();
    const state = Buffer.from(JSON.stringify({ nonce })).toString('base64');

    // Build URL manually to avoid double-encoding the + sign
    // response_type must be "token+id_token" with literal + sign
    const authUrl = `${AUTH_API}/services/oauth2/authorize/expid_Login?` +
      `response_type=token+id_token` +
      `&client_id=${encodeURIComponent(CLIENT_ID)}` +
      `&redirect_uri=${encodeURIComponent(REDIRECT_URI)}` +
      `&display=touch` +
      `&scope=${encodeURIComponent('api openid refresh_token web')}` +
      `&nonce=${nonce}` +
      `&state=${encodeURIComponent(state)}`;

    const response = await fetch(authUrl, {
      method: 'GET',
      headers: this._buildHeaders(),
      redirect: 'manual',
    });

    this._storeCookies(response);

    // Check for redirect in Location header first
    const location = response.headers.get('location');
    if (location) {
      let loginUrl = location.startsWith('/') ? AUTH_API + location : location;
      return loginUrl;
    }

    // If no redirect, check the response body
    const html = await response.text();
    const urlMatch = html.match(/(?:url|href)\s*=\s*['"]([^'"]+)['"]/i);
    if (urlMatch) {
      let loginUrl = urlMatch[1];
      if (loginUrl.startsWith('/')) {
        loginUrl = AUTH_API + loginUrl;
      }
      return loginUrl;
    }

    throw new Error('Failed to extract login URL from OAuth response');
  }

  /**
   * Load login page and extract required context
   * @param {string} loginUrl
   * @returns {Promise<{fwuid: string, loaded: object, startUrl: string}>}
   * @private
   */
  async _loadLoginPage(loginUrl) {
    // Add system parameters
    const url = new URL(loginUrl);
    url.searchParams.set('System', 'IoT_Mobile_App');
    url.searchParams.set('RegistrationSubChannel', 'hOn');

    // Follow redirects to get to actual login page
    let response = await fetch(url.toString(), {
      method: 'GET',
      headers: this._buildHeaders(),
      redirect: 'manual',
    });

    this._storeCookies(response);

    // Follow redirects until we get a 200 response
    let maxRedirects = 5;
    while (response.status >= 300 && response.status < 400 && maxRedirects > 0) {
      const location = response.headers.get('location');
      if (!location) break;

      const nextUrl = location.startsWith('/') ? AUTH_API + location : location;
      response = await fetch(nextUrl, {
        method: 'GET',
        headers: this._buildHeaders(),
        redirect: 'manual',
      });
      this._storeCookies(response);
      maxRedirects--;
    }

    let html = await response.text();

    // Check for JavaScript redirect (Salesforce pattern)
    const jsRedirectMatch = html.match(/handleRedirect\(['"]([^'"]+)['"]\)/);
    if (jsRedirectMatch) {
      const jsRedirectUrl = jsRedirectMatch[1];
      const finalUrl = jsRedirectUrl.startsWith('/') ? AUTH_API + jsRedirectUrl : jsRedirectUrl;
      response = await fetch(finalUrl, {
        method: 'GET',
        headers: this._buildHeaders(),
      });
      this._storeCookies(response);
      html = await response.text();
    }

    throw new Error('Login page structure needs different handling - not an Aura page');
  }

  /**
   * Submit login credentials
   * @param {string} fwuid
   * @param {object} loaded
   * @param {string} startUrl
   * @returns {Promise<string>} Redirect URL
   * @private
   */
  async _submitCredentials(fwuid, loaded, startUrl) {
    const message = {
      actions: [
        {
          id: '79;a',
          descriptor: 'apex://LightningLoginCustomController/ACTION$login',
          callingDescriptor: 'markup://c:loginForm',
          params: {
            username: this.email,
            password: this.password,
            startUrl,
          },
        },
      ],
    };

    const auraContext = {
      mode: 'PROD',
      fwuid,
      app: 'siteforce:loginApp2',
      loaded,
      dn: [],
      globals: {},
      uad: false,
    };

    const formData = new URLSearchParams({
      message: JSON.stringify(message),
      'aura.context': JSON.stringify(auraContext),
      'aura.pageURI': startUrl,
      'aura.token': 'null',
    });

    const response = await fetch(`${AUTH_API}/s/sfsites/aura`, {
      method: 'POST',
      headers: {
        ...this._buildHeaders(),
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: formData.toString(),
    });

    this._storeCookies(response);
    const result = await response.json();

    // Check for errors in response
    if (result.exceptionEvent) {
      throw new Error(result.exceptionMessage || 'Login failed');
    }

    // Extract redirect URL from events
    if (result.events && result.events.length > 0) {
      for (const event of result.events) {
        if (event.attributes?.values?.url) {
          return event.attributes.values.url;
        }
      }
    }

    // Try to extract from action returnValue
    if (result.actions && result.actions.length > 0) {
      const action = result.actions[0];
      if (action.state === 'ERROR') {
        const errorMsg = action.error?.[0]?.message || 'Login failed - invalid credentials';
        throw new Error(errorMsg);
      }
      if (action.returnValue) {
        return action.returnValue;
      }
    }

    throw new Error('Failed to get redirect URL from login response');
  }

  /**
   * Follow redirects and extract tokens from final URL
   * @param {string} startUrl
   * @private
   */
  async _extractTokens(startUrl) {
    let currentUrl = startUrl;

    // Handle relative URLs
    if (currentUrl.startsWith('/')) {
      currentUrl = AUTH_API + currentUrl;
    }

    let maxRedirects = 10;

    while (maxRedirects > 0) {
      // Check if we've reached the callback URL with tokens
      if (currentUrl.includes(REDIRECT_URI) || currentUrl.includes('#access_token=')) {
        break;
      }

      const response = await fetch(currentUrl, {
        method: 'GET',
        headers: this._buildHeaders(),
        redirect: 'manual',
      });

      this._storeCookies(response);

      // Check for Location header redirect
      const location = response.headers.get('location');
      if (location) {
        currentUrl = location.startsWith('/') ? AUTH_API + location : location;
        maxRedirects--;
        continue;
      }

      // Check for href in HTML response
      const html = await response.text();
      const hrefMatch = html.match(/href\s*=\s*['"]([^'"]+)['"]/i);
      if (hrefMatch) {
        let href = hrefMatch[1];
        // Decode HTML entities
        href = href.replace(/&amp;/g, '&');
        currentUrl = href.startsWith('/') ? AUTH_API + href : href;
        maxRedirects--;
        continue;
      }

      break;
    }

    // Parse tokens from URL fragment
    const hashIndex = currentUrl.indexOf('#');
    if (hashIndex === -1) {
      throw new Error('No token fragment found in redirect URL');
    }

    const fragment = currentUrl.substring(hashIndex + 1);
    const params = new URLSearchParams(fragment);

    this.accessToken = params.get('access_token');
    this.idToken = params.get('id_token');

    // Refresh token is URL-encoded
    const refreshToken = params.get('refresh_token');
    if (refreshToken) {
      this.refreshToken = decodeURIComponent(refreshToken);
      this.onTokenRefresh(this.refreshToken);
    }

    if (!this.accessToken || !this.idToken) {
      throw new Error('Failed to extract tokens from URL');
    }

    // Calculate token expiry (default 8 hours)
    const expiresIn = parseInt(params.get('expires_in') || '28800', 10);
    this.tokenExpiresAt = Date.now() + (expiresIn * 1000);

    this.log('Tokens extracted successfully');
  }

  /**
   * Get Cognito token for API access
   * @private
   */
  async _getCognitoToken() {
    const mobileId = crypto.randomUUID();

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
        mobileId,
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
   * Refresh the access token using refresh token
   * @private
   */
  async _refreshAccessToken() {
    this.log('Refreshing access token...');

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

    this.accessToken = result.access_token;
    this.idToken = result.id_token;

    if (result.refresh_token) {
      this.refreshToken = result.refresh_token;
      this.onTokenRefresh(this.refreshToken);
    }

    // Persist new access & id tokens
    this.onTokensUpdated(this.accessToken, this.idToken);

    // Calculate token expiry
    const expiresIn = result.expires_in || 28800;
    this.tokenExpiresAt = Date.now() + (expiresIn * 1000);

    // Get new Cognito token
    await this._getCognitoToken();
  }

  /**
   * Ensure we have valid authentication
   * @private
   */
  async _ensureAuthenticated() {
    if (!this.isAuthenticated()) {
      await this.authenticate();
    }
  }

  /**
   * Make an authenticated API request
   * @param {string} endpoint
   * @param {Object} [options]
   * @returns {Promise<Object>}
   * @private
   */
  async _apiRequest(endpoint, options = {}) {
    await this._ensureAuthenticated();

    const url = `${API_URL}${endpoint}`;
    const response = await fetch(url, {
      method: options.method || 'GET',
      headers: {
        ...this._buildAuthHeaders(),
        ...options.headers,
      },
      body: options.body ? JSON.stringify(options.body) : undefined,
    });

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
    this.log(`Fetching state for appliance: ${macAddress}`);

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

    const now = new Date().toISOString().slice(0, -1) + 'Z'; // Format: 2024-01-01T12:00:00.000Z
    const payload = {
      macAddress: macAddress,
      timestamp: now,
      commandName,
      transactionId: `${macAddress}_${now}`,
      applianceOptions: options.applianceOptions || {},
      device: {
        appVersion: APP_VERSION,
        mobileId: crypto.randomUUID(),
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

    // Handle different command types
    // All commands require non-empty parameters and ancillaryParameters
    if (commandName === 'startProgram') {
      const programName = (options.programName || parameters?.program || 'iot_auto').toUpperCase();
      payload.programName = programName;
      // startProgram also needs mandatory parameters (not empty)
    } else if (commandName === 'stopProgram') {
      // stopProgram needs mandatory parameters with onOffStatus=0
    }
    // For 'settings' command, parameters are already set from the function argument

    const result = await this._apiRequest('/commands/v1/send', {
      method: 'POST',
      body: payload,
    });
    return result;
  }

}

module.exports = HonApi;
