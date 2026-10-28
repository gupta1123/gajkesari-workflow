# Connector 0.1.80: in-app updates and held-entry recovery

Production-fixes branch `codex/production-fixes`, based on deployed `2f681fd`.
This change does not include the payment-follow-up feature commits.

## Customer experience

Existing 0.1.78/0.1.79 installations need one manual upgrade to 0.1.80. Earlier
versions have a placeholder update button and cannot bootstrap this updater.

From 0.1.80 onward, the connector checks public GitHub releases shortly after
launch and every four hours. Check for updates also performs a real check.
An available update appears on the home screen and in Connector updates.
Update now downloads the installer with progress, verifies its size and SHA-256,
and restarts only after Tally tasks/claimed commands and local sync have finished.
If work is active, the download stays ready and the customer chooses Restart and
update afterward. No Tally voucher is created by the updater.

The background helper uses Inno Setup's very-silent mode without an installer
wizard or Windows restart. The connector closes briefly while files are replaced.
Pairing and matching data live outside the installation directory and are kept.
The helper backs up the installation first, verifies the installed version, and
waits for the new connector UI to acknowledge startup. Installer failure, version
mismatch, and failed startup restore the previous application files. A failed
update is shown honestly; network errors never claim the app is up to date.

Downloads are restricted to this repository's versioned release paths. There is
no GitHub token embedded in the application. The SHA-256 manifest and executable
are published together. This does not add an Authenticode publisher certificate.
Installer authenticity relies on the controlled public GitHub release over HTTPS.

## Publishing

1. Increment the wrapper package, bridge package, BRIDGE_VERSION, Inno AppVersion,
   and workspace package-lock version together. Installer validation checks these.
2. Run the updater, helper and bridge tests, bank recovery tests, type checks,
   frontend/backend builds, and installer validation/build.
3. `node scripts/prepare-connector-release.mjs` creates the versioned installer and
   `connector-update.json` under `installer/tally-bridge/release`.
4. Push the reviewed connector changes to GitHub main when release is authorized.
   The workflow builds a fresh Windows installer, uploads both files to a draft
   release, and publishes only after upload completes. Tags use the real version;
   released binaries must not be overwritten. A version that already exists fails
   publication and requires a new version. A failed draft may be inspected/removed
   and the workflow retried; do not remove published releases to reuse a version.
5. Frontend deployment still uses GitHub main / Netlify auto-deploy. The bank
   recovery API change must separately be deployed to Heroku. No Supabase schema
   migration is required.

## Client case and recovery

PNB `OpTransactionHistory24-10-2026.pdf`, import
`c713bc8e-3524-4d29-bf17-2082d3fad1ba`: connector 0.1.78 held Jagdamba's
23 October receipt for 1,000,000 against Shantai's receipt voucher 6757.
The existing 0.1.79 different-party fix is retained in 0.1.80.

After updating, Recheck in Tally can clear a prior hold only when the original
command proves duplicate preflight prevented any import and the read-only recheck
returns zero matches. The row becomes Ready to post; an explicit Post to Tally
is still required and performs another live duplicate preflight. Accepted,
partially imported or unknown-outcome entries remain held. Original command
evidence is retained. A partial database write can be completed idempotently.

## Verification limits

Helper tests exercise real file backup/replacement/rollback in a temporary
installation with process/installer calls simulated. Browser checks render the
actual connector HTML with simulated Electron IPC. The production installer is
built locally. A real upgrade from an installed 0.1.80 to a subsequent GitHub
release still needs a controlled release smoke test. This setup has not silently
installed over the user's running connector, changed client posting records,
created Tally vouchers, or published a GitHub release.
