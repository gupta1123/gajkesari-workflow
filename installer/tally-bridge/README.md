# Gajkesari Tally Connector Installer

This folder contains the Windows installer assets for the Gajkesari desktop Tally connector.

The installer:

- uses the visible product name `Gajkesari Tally Connector`
- installs without elevation under `C:\Gajkesari\tally-bridge`
- preserves the existing `%USERPROFILE%\.gajkesari-tally-bridge\config.json` pairing during updates
- registers the `gajkesari-tally://` protocol expected by the Gajkesari web application
- starts the connector after installation
- includes the Gajkesari native Tally Debit Note PDF TDL
- uses its own executable, protocol, setup filename, application ID, configuration folder, and installation directory

## Build on Windows

Provide a Windows Electron runtime directory. It may contain `Gajkesari Tally Connector.exe`,
`electron.exe`, or one other Electron runtime `.exe`:

```powershell
$env:GAJKESARI_CONNECTOR_RUNTIME = "C:\path\to\electron-runtime"
npm run installer:tally-bridge
```

You can also run `installer\tally-bridge\build.cmd` from Windows.

The setup executable is written to:

```text
installer\tally-bridge\output\GajkesariTallyConnectorSetup.exe
```

## Runtime layout

```text
C:\Gajkesari\tally-bridge
C:\Gajkesari\tally-bridge\resources\app
%USERPROFILE%\.gajkesari-tally-bridge\config.json
```

The generated payload excludes old logs, archives, and stale Electron `app.asar`
files. The current wrapper and `apps/tally-bridge/src/bridge.mjs` are inserted into
the clean runtime during every build.

## User flow

1. Run `GajkesariTallyConnectorSetup.exe`.
2. Open Gajkesari and click **Connect** on the Tally page.
3. Allow the browser to open the `gajkesari-tally://` link.
4. Keep `Gajkesari Tally Connector` open while using Tally Prime.

The connector displays `Connected to <company name>` after pairing when Tally Prime
is reachable and a company is loaded.

### One-time native PDF activation

The canonical TDL is installed at:

```text
C:\Gajkesari\tally-bridge\tdl\gajkesari-native-debit-note-export.tdl
```

The setup also attempts to copy it into the TallyPrime installation folder. In
TallyPrime, select it once in `F1: Help > TDL & Add-On`, enable **Load selected TDL
files on startup**, and restart TallyPrime.
