# Tally Bridge Local Testing Commands

These commands are intentionally kept out of the client-facing Tally connection UI. Use them only while testing the Tally bridge locally.

## Pair the connector

Run this on the Windows machine where Tally Prime and the bridge package are available:

```powershell
npm.cmd run pair -- --api-base "http://localhost:3001" --connection-id "<connection-id>" --pairing-code "<pairing-code>"
```

If the frontend is proxying API requests through `localhost:3000`, use:

```powershell
npm.cmd run pair -- --api-base "http://localhost:3000" --connection-id "<connection-id>" --pairing-code "<pairing-code>"
```

For deployed API testing, replace `--api-base` with the deployed backend/API base URL.

## Start the connector

```powershell
npm.cmd run start
```

If you want to force a specific Tally company name:

```powershell
npm.cmd run start -- --company-name "<company-name>"
```

## Values

- `<connection-id>` comes from the Tally connection record created by the frontend.
- `<pairing-code>` is returned when a new connection is created.
- `<company-name>` should match the company loaded in Tally Prime.

## Notes

- Keep Tally Prime open before starting the connector.
- Keep the connector running while posting bank statement entries.
- For the current client-facing UI, prefer the `gajkesari-tally://connect?...` one-click connector flow.
