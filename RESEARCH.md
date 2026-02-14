# HON API Research Notes

Based on analysis of [gvigroux/hon](https://github.com/gvigroux/hon) Home Assistant integration and our Homey implementation.

## API Endpoints

| Endpoint | Method | Purpose |
|----------|--------|---------|
| `/commands/v1/appliance` | GET | List all appliances |
| `/commands/v1/retrieve` | GET | Get command definitions for a device |
| `/commands/v1/context` | GET | Get current device state (polling) |
| `/commands/v1/send` | POST | Send commands (startProgram, stopProgram, settings) |
| `/commands/v1/statistics` | GET | Get energy/usage statistics |
| `/auth/v1/login` | POST | Exchange id_token for cognitoToken |

Base URL: `https://api-iot.he.services`
Auth URL: `https://account2.hon-smarthome.com`

## Command Types

### startProgram
- Powers ON the AC with a specific mode
- Program names: `IOT_AUTO`, `IOT_COOL`, `IOT_HEAT`, `IOT_DRY`, `IOT_FAN`, `IOT_SELF_CLEAN`, `IOT_10_HEATING`, `IOT_SIMPLE_START`
- Requires: `programName` in payload
- Parameters should be empty `{}`

### stopProgram
- Powers OFF the AC
- Requires BOTH `parameters` (all mandatory params with `onOffStatus: "0"`) AND `ancillaryParameters`
- Sending empty `parameters: {}` causes 422 error: "Invalid parameter: parameters"
- Omitting `parameters` entirely causes 400 error: "Missing Mandatory Parameter - parameters"
- Omitting `ancillaryParameters` causes 400 error: "Missing Mandatory Parameter – ancillaryParameters"
- Success response: `{"payload":{"resultCode":"0"}}`

### settings
- Changes device settings (temperature, fan speed, swing, etc.)
- Requires ALL mandatory parameters from command definitions
- Include `ancillaryParameters` from device definitions

## HVAC Mode Mappings

| Mode | HON Value (machMode) | Program Name |
|------|---------------------|--------------|
| Auto | 0 | IOT_AUTO |
| Cool | 1 | IOT_COOL |
| Dry | 2 | IOT_DRY |
| Heat | 4 | IOT_HEAT |
| Fan Only | 6 | IOT_FAN |

Note: machMode 3 also maps to Dry, 5 also maps to Fan Only (aliases).

## Fan Speed Mappings

| Speed | HON Value (windSpeed) |
|-------|----------------------|
| High | 1 |
| Medium | 2 |
| Low | 3 |
| Auto | 5 |
| Off | 0 |

Note: windSpeed 4 also maps to Auto (alias).

## Swing Mode Mappings

### Vertical (windDirectionVertical)
| Value | Position |
|-------|----------|
| 8 | Auto/Swing |
| 7 | Very Low |
| 6 | Low |
| 5 | Middle (default/off) |
| 4 | High |
| 3 | Health Low |
| 2 | Very High |
| 1 | Health High |

### Horizontal (windDirectionHorizontal)
| Value | Position |
|-------|----------|
| 7 | Auto/Swing |
| 6 | Far Right |
| 5 | Right |
| 4 | Left |
| 3 | Far Left |
| 0 | Middle (default/off) |

## Additional AC Features (from reference)

### Switch-type Features
| Parameter | Description |
|-----------|-------------|
| `silentSleepStatus` | Sleep mode |
| `screenDisplayStatus` | Screen display on/off |
| `muteStatus` | Silent/mute mode |
| `echoStatus` | Echo mode |
| `rapidMode` | Rapid heating/cooling |
| `healthMode` | Health mode |
| `10degreeHeatingStatus` | 10-degree heating |

### Eco Pilot Mode (humanSensingStatus)
| Value | Mode |
|-------|------|
| 0 | Off |
| 1 | Avoid (direct away from person) |
| 2 | Follow (direct toward person) |

### Environmental Sensors
| Parameter | Description |
|-----------|-------------|
| `tempIndoor` | Indoor temperature |
| `tempOutdoor` / `tempAirOutdoor` | Outdoor temperature |
| `tempCoilerIndoor` | Indoor coiler temperature |
| `humidity` / `humidityIndoor` | Indoor humidity |
| `humidityOutdoor` | Outdoor humidity |

## Authentication Flow

1. OAuth2 implicit flow via Salesforce
   - Client ID: `3MVG9QDx8IX8nP5T2Ha8ofvlmjLZl5L_gvfbT9.HJvpHGKoAS_dcMN8LYpTSYeVFCraUnV.2Ag1Ki7m4znVO6`
   - Redirect: `hon://mobilesdk/detect/oauth/done`
   - Returns: `access_token`, `id_token`, `refresh_token` in URL fragment
2. Exchange `id_token` for `cognitoToken` via `/auth/v1/login`
3. Use `cognitoToken` as Bearer token for API calls
4. Refresh via OAuth2 `grant_type=refresh_token` when expired

## Command Payload Structure

```json
{
  "macAddress": "xx-xx-xx-xx-xx-xx",
  "timestamp": "2024-01-01T12:00:00.000Z",
  "commandName": "startProgram|stopProgram|settings",
  "transactionId": "macAddress_timestamp",
  "applianceOptions": {},
  "device": {
    "appVersion": "2.0.10",
    "mobileId": "uuid",
    "mobileOs": "ios",
    "osVersion": "17.6.1",
    "deviceModel": "iPhone16,2"
  },
  "attributes": {
    "channel": "mobileApp",
    "origin": "standardProgram",
    "energyLabel": "0"
  },
  "ancillaryParameters": {},
  "parameters": {},
  "applianceType": "AC",
  "programName": "IOT_HEAT"
}
```

## Polling

- State endpoint: `/commands/v1/context?macAddress=XX&applianceType=AC&category=CYCLE`
- Returns `payload.shadow.parameters` with device state
- Values wrapped in `{parNewVal: "value", lastUpdate: "timestamp"}` objects
- Reference uses 60s interval; we use 30s

## Bugs Fixed

1. **onOffStatus string comparison** - `_extractValue()` returns string "1", must use `Number()` before comparing
2. **stopProgram 422 error** - Must NOT include `parameters` or `ancillaryParameters` in stopProgram payload
3. **fan_only mode value** - Should be `6` not `5` (machMode)
4. **fan auto speed value** - Should be `5` not `4` (windSpeed)

## Future Improvements

- Add humidity sensor (`measure_humidity`)
- Add eco pilot mode capability
- Add silent/rapid/sleep mode switches
- Implement `/commands/v1/statistics` for energy monitoring
- Fine-grained wind direction control (not just preset combinations)
- Better error handling (429 rate limit, 500 server errors)
