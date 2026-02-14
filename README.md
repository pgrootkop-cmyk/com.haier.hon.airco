<p align="center">
  <img src="assets/images/large.png" width="150" />
</p>

# Haier hOn

Control your Haier air conditioners with Homey via the hOn cloud API.

## Usage

1. Install the app from the Homey App Store
2. Add a device and select **Haier hOn** > **Air Conditioner**
3. Log in with your hOn account credentials
4. Select your air conditioner from the list

Authentication uses the native hOn OAuth2 flow, supporting email/password with MFA as well as SSO sign-in via Google, Facebook, and Apple.

> **Important:** Pairing must be done from the Homey desktop or web interface. The mobile app does not support the OAuth2 login screen used during pairing.

> **Tip:** We recommend using a separate hOn account for Homey to avoid potential session conflicts.

## Supported Features

| Feature | Details |
|---------|---------|
| **HVAC Modes** | Auto, Cool, Heat, Dry, Fan Only, Anti-Freeze |
| **Fan Speed** | Auto, Low, Medium, High |
| **Swing** | Off, Vertical, Horizontal, Both |
| **Eco Pilot** | Off, Avoid Me, Follow Me |
| **Toggles** | Silent, Rapid, Sleep, Eco, Health, Screen Display, Beep |
| **Sensors** | Indoor Temperature, Outdoor Temperature |
| **Flow Cards** | Triggers, Conditions, and Actions for all features |

## Supported Brands

Should work with any air conditioner controllable via the [hOn](https://www.hon-smarthome.com/) app, including **Haier**, **Candy**, and **Hoover**. Currently only tested with the Haier AS25RBAHRA-3 (2025).

## Disclaimer

This app is not affiliated with Haier, Candy, or Hoover. The hOn API is reverse-engineered and may change without notice.

## Feedback

Found a bug or have a feature request? Please open an [issue](https://github.com/pgrootkop-cmyk/com.haier.hon.airco/issues).

## Credits

The Node.js hOn API client in this app is largely inspired by [Andre0512/pyhOn](https://github.com/Andre0512/pyhon), the Python library for the hOn ecosystem.
