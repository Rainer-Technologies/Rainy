# Rainy Presence

Windows companion app that shows what is playing in your Rainy account on your Discord profile. It reads the playback state from Rainy Connect (the same data used for cross-device control) and publishes it as an activity in the Discord desktop app running on this PC.

**Windows only for now.** macOS and Linux are not supported yet.

## Requirements

- Windows 10 or 11, with the Discord desktop app open.
- Go 1.26+ to build from source.

## Status: stage 2 (publishing to Discord)

Every 3 seconds the companion checks which device in your account is playing (Rainy Connect) and publishes it to Discord. For something to show up you need:

- The Discord desktop app open on this PC.
- A track playing in Rainy on one of your devices (web or mobile).

Pausing or stopping playback removes the activity. If Discord rejects the cover URL, the activity is published with the Rainy logo instead.

## First run

If there is no server or session saved, the setup window opens in two steps:

1. **Server**: enter the address and click **Next**. The app checks that it is a Rainy server before continuing.
2. **Account**: enter your email and password, then click **Sign in**. **Back** returns to step 1.

Sign-in uses your email, because that is what the Rainy login endpoint expects.

- The password is not saved. The session is stored encrypted with DPAPI (your Windows account) in `%APPDATA%\RainyPresence\config.json`.
- Local server: `192.168.1.10:5000` (uses `http://`; the app logs a warning).
- Server with a domain: `your-domain.com` (uses `https://`).

You can preselect a server with `-server`, for example `go run . -server 192.168.1.10:5000`.

## Daily use

Build without a console window:

```bash
go build -ldflags "-H windowsgui" -o rainy-presence.exe .
```

The tray icon shows the current status. Its menu has:

- Current status (what is playing, or why nothing is published).
- **Pause / resume publishing**.
- **Settings…**: change server or account.
- **Quit**: removes the Discord activity before closing.

The log is written to `%APPDATA%\RainyPresence\presence.log`.

## Tests

```bash
go test ./...
RAINY_LIVE=1 go test -run TestLiveITunesCover ./...   # live iTunes lookup
```

## Layout

- `main.go`: startup, logging and server URL normalization.
- `ui.go`: tray icon, menu and setup window (walk).
- `app.go`: loop that reads Connect and publishes to Discord.
- `connect_client.go`: login and device listing.
- `discord_ipc.go`: Discord named pipe (Windows only).
- `presence.go`: which device is playing, rate limiting and seek tolerance.
- `cover.go`: public cover lookup via iTunes.
- `config.go`, `secret_windows.go`: configuration and DPAPI encryption.
- `app.manifest`, `rsrc_windows_amd64.syso`: Windows manifest and `.exe` icon, required by the UI. Regenerate with `rsrc -manifest app.manifest -ico assets/icon.ico -o rsrc_windows_amd64.syso`.

## Known limitations

- Windows only (IPC over a named pipe).
- If the session expires, open **Settings…** from the tray menu to sign in again.
- Publishes the device that started playing most recently, web or mobile.
