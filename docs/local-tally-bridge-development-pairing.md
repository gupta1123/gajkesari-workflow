# Local Tally Bridge Development Pairing

Use this guide when testing the Tally bridge during development before building a Windows tray app or service.

## What Runs Where

- Frontend: deployed on Netlify, or local web app.
- Backend API: deployed on Heroku, or local API.
- Tally bridge: runs on the same Windows machine where Tally Prime is running.
- Tally Prime: must be open with the target company loaded.

The bridge should not run on Heroku or Netlify. It must run next to Tally because it connects to local Tally at:

```text
http://localhost:9000
```

## Parallels / Mac Important Note

If Tally Prime is running inside Windows on Parallels, copy the bridge folder into the Windows file system.

Do not run the bridge from a shared Mac path like:

```text
\\Mac\Home\Desktop\Projects\...
```

Windows `cmd.exe` cannot use that UNC path as the working directory for npm scripts. It may fall back to `C:\Windows`, then Node will fail with an error like:

```text
Cannot find module 'C:\Windows\src\bridge.mjs'
```

## One-Time Setup On Windows

Install Node.js on the Windows machine first.

Then copy the full bridge folder:

```text
gajkesari-workflow/apps/tally-bridge
```

to:

```text
C:\Gajkesari\tally-bridge
```

The Windows folder should look like:

```text
C:\Gajkesari\tally-bridge\
  package.json
  src\
    bridge.mjs
```

Open PowerShell and go to the copied folder:

```powershell
cd C:\Gajkesari\tally-bridge
```

## Pair The Bridge

In the web app, open the hidden Tally page directly:

```text
/tally-prime
```

Create or select a Tally connection and copy:

- backend API base URL
- connection ID
- pairing code

Run the pair command from `C:\Gajkesari\tally-bridge`:

```powershell
npm run pair -- --api-base https://YOUR-HEROKU-APP.herokuapp.com --connection-id YOUR_CONNECTION_ID --pairing-code YOUR_PAIRING_CODE
```

Example:

```powershell
npm run pair -- --api-base https://gajkesari-workflow-465859fe2891.herokuapp.com --connection-id c5723944-f4a1-4566-9601-0e28a96294f6 --pairing-code 519714
```

If the pairing code is expired or invalid, generate a new pairing code from `/tally-prime` and rerun the command.

## Start The Bridge

After pairing succeeds, keep Tally Prime open and start the bridge:

```powershell
npm run start
```

For development, leave the PowerShell window open. It shows useful logs for debugging.

## Client Development Flow

Each time you test:

1. Start Windows or the Parallels VM.
2. Open Tally Prime.
3. Open the required company in Tally.
4. Confirm Tally HTTP/XML access is enabled on port `9000`.
5. Open PowerShell.
6. Run:

```powershell
cd C:\Gajkesari\tally-bridge
npm run start
```

Then use the deployed web app:

```text
/tally-prime
/bank-statements
```

## Common Errors

### Missing script: tally-bridge:pair

Use:

```powershell
npm run pair -- --api-base ... --connection-id ... --pairing-code ...
```

Do not use:

```powershell
npm run tally-bridge:pair
```

### Cannot find module C:\Windows\src\bridge.mjs

You are probably running from a shared Mac path such as `\\Mac\Home\...`.

Copy the whole `apps/tally-bridge` folder to `C:\Gajkesari\tally-bridge`, then run from there.

### Tally Not Reachable

Check:

- Tally Prime is open.
- The correct company is loaded.
- Tally is listening on `http://localhost:9000`.
- The bridge is running inside the same Windows machine or VM as Tally.

### App Connection Failed

Check:

- `--api-base` points to the deployed Heroku backend, not the Netlify frontend.
- The backend is running.
- The connection ID and pairing code are fresh.
- Windows has internet access.

## Development Shortcut

After pairing once, you can create a desktop shortcut or `.bat` file:

```bat
@echo off
cd /d C:\Gajkesari\tally-bridge
npm run start
pause
```

Name it:

```text
Start Tally Bridge
```

For development, this is enough. For production, replace this with a Windows tray app or service installer.
