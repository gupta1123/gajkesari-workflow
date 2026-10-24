# Electron updater and NSIS trial

This trial is local to `codex/electron-updater-trial`. It does not publish a
release, change the installed connector, deploy the website, or change Tally
matching/posting logic.

## Build

Install the independent packaging toolchain with
`npm ci --prefix installer/tally-bridge/nsis`. It pins electron-builder 26.18.0
and electron-updater 6.8.11. The normal repository dependencies must also be
installed for the existing connector payload builder.

Run `npm run installer:tally-bridge:nsis`. The default trial version is 0.1.84;
`node scripts/build-tally-connector-nsis.mjs --version X.Y.Z` selects another
unpublished trial version. It reuses the current runtime/native-module payload,
adds electron-updater and its dependencies, and builds with `--publish never`.
Outputs are under `installer/tally-bridge/output/nsis/VERSION/`:

- `GajkesariTallyConnectorSetup-VERSION.exe`
- the matching `.exe.blockmap`
- `latest.yml` with the installer size and SHA512

The NSIS payload opts into the new updater using `connectorUpdater` metadata.
Legacy Inno builds retain their existing updater. The new controller uses the
library's download verification, caching, differential requests, silent install,
and restart. It disables installation on normal app exit, waits for Tally work
to finish, and closes native database handles before the explicit update.
Diagnostic logs are written to `connector-update.log` in Electron user data.

Manual setup in 0.1.84 uses a guided wizard: branded welcome with an Install
button, installation progress, and a success page with a checked option to open
the connector. The per-user scope is selected automatically. Before replacing
files, native Windows tools close exact-name connector processes belonging to
the current user, covering the old Inno and current NSIS locations. The welcome
page asks the user to finish current Tally work before clicking Install. If a
connector cannot be closed, setup stops before replacing files. In-app updates
still run silently and restart automatically after the existing Tally busy guard.

## Verification

Run the updater tests with:

```powershell
node --test installer/tally-bridge/electron-app/electron-updates.test.mjs installer/tally-bridge/electron-app/updates.test.mjs installer/tally-bridge/electron-app/update-helper.test.mjs apps/tally-bridge/src/bridge.test.mjs
```

Run `npm run test:tally-bridge:nsis-updates` for an actual Windows installation
test. It builds two versions of a tiny test application using the same runtime,
library and controller. Each run gets a unique application ID, installation,
user-data folder and cache. It never imports the Tally bridge or pairing data.
It installs the first version silently, serves the second through a loopback
HTTP server supporting ranges, then downloads, verifies, installs and restarts
through the real library. It asserts that the restarted version is correct,
the success receipt matches, and less than 80% of a full installer was fetched.
Artifacts and audit logs are retained under `C:/tmp/gajkesari-nsis-tests/`.

## Before distribution

This is a packaging/update trial, not a published replacement for 0.1.82.
NSIS uses its standard per-user installation and registry identity. The old
Inno installation at `C:/Gajkesari/tally-bridge` has a separate uninstall entry;
a controlled one-time migration must be verified before distributing to clients.
Pairing and local data must be preserved and the old uninstall entry must not
later be allowed to remove the new installation.

The existing GitHub workflow still builds Inno and publishes the legacy
manifest. A future NSIS release must publish `latest.yml`, the matching installer
and blockmap together, and replace that workflow only after migration testing.
Never replace the already published immutable 0.1.82 files. This local trial is
unsigned, matching the existing local build's signing availability; distribution
signing policy remains a separate release decision.

The isolated update test exercises the real update engine and Windows installer.
It does not establish that migration of the customer's full connector and saved
data is complete. The full connector's bank-statement behavior remains subject
to the existing connector regression checks.

## Local result, 24 October 2026

The real isolated update from 0.0.1 to 0.0.2 passed, including silent installation
and automatic restart into the new version. It fetched 234,384 installer bytes
through five range requests instead of the full 84,424,444 bytes (99.72% saved).
This is a measured small-change test, not a guarantee for every future release.
The application update adapter and existing updater/bridge regression suite
passed 99 tests. The currently installed production connector remained 0.1.81.

After the user installed the 0.1.83 trial, the 0.1.84 guided setup was built and
its shared welcome/finish page definitions were visually inspected through a
non-installing preview. A real isolated assisted-NSIS update test also passed:
the installer closed a running test connector outside the new installation,
then updated 0.0.1 to 0.0.2 silently and restarted successfully. It fetched
263,121 bytes instead of 84,468,827 bytes (99.69% saved). No real connector was
closed or replaced during this test. The full regression run had one legacy
PowerShell-helper timeout; the seven helper tests passed on recheck.
