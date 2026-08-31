# Bank matching: ledger-scoped reads (connector 0.1.59)

## Change

- Bank duplicate checking uses `Vouchers : Ledger` with `ChildOf` set to the selected bank and the statement date range. References stay in the primary export.
- Only unmatched, bill-eligible party ledgers are read. Suspense/non-bill-wise rows retain duplicate checking but do not request bills.
- Each party uses `Bills` with its own `ChildOf`. Reads are sequential and reuse one result per ledger. No company-wide Bill scan or automatic voucher-history fallback occurs in bank matching, even when `full_snapshot` is requested.
- Native `IsAdvance` distinguishes advances from invoices. Native `ClosingBalance` supplies current outstanding amounts; this is not a historical balance reconstruction.
- Each XML read is limited to 20 seconds and 8 MiB. Party reads share a 90-second budget and a 4 MiB parsed-result budget. An interrupted read stops further bill queries in that run, without automatic retry. HTTP cancellation does not guarantee cancellation of Tally's internal report calculation.
- A missing, malformed, or failed ledger response is not an empty bill list. That ledger remains under review; complete ledgers keep their results. Existing final company/session identity checks still apply.
- The gateway rejects bank matching on connectors older than 0.1.59. It uses the current per-operation authorized version so an upgrade's first heartbeat can refresh stale handshake metadata. Other operations are not globally disabled by this gate.

Cash Discount analysis outside bank matching retains its separate evidence workflow. This release does not claim to optimize all Tally reports.

## Verification

- Automated connector, gateway, browser-live, posting-readiness and API bill-policy tests cover scoping, 51 sequential ledgers, Suspense, native advance flags, partial failures, response/result size limits, duplicate detection, old-version gating, two-PC isolation and cancellation.
- Both frontend and API TypeScript checks pass.
- Read-only local Tally `Solution Nyx` checks confirmed native bill/advance responses and bank-ledger voucher export. A supplier read returned four bill objects in approximately 47 ms; a bank query returned 30 vouchers in approximately 53 ms. These timings are not measurements from the client's 4 GB PC.
- No Tally financial records or Supabase rows/migrations are changed by this release work.

The query approach follows Tally's [ledger Bill collection example](https://help.tallysolutions.com/symbols-and-prefixes-in-tdl/) and [collection performance guidance](https://help.tallysolutions.com/how-to-choose-the-right-approach-from-tdl/). `IsAdvance` and `ClosingBalance` were additionally verified against native local Tally output.

## Rollout

1. Rebuild `npm run installer:tally-bridge`. Confirm the setup version and packaged bridge source hash.
2. Push the reviewed commit to Heroku, then GitHub `main`. Netlify publishes from GitHub; do not deploy to Netlify separately.
3. Install `installer/tally-bridge/output/GajkesariTallyConnectorSetup.exe` (0.1.59) on the **client's Tally PC**. The normal setup wizard preserves that PC's pairing/configuration. Do not copy another PC's config.
4. Open the connector, reconnect from that PC's browser if needed, and refresh the statement page. Web deployment alone cannot update an already-installed connector.
5. Re-run Check Tally Matches on the client and inspect the returned diagnostics. Verify that no Customer Bill Evidence request occurs, only eligible ledgers are queried, Suspense remains direct, and incomplete ledgers remain under review. Do not create new financial vouchers just to benchmark reads.

No database migration is required. If rollback is necessary, retain the safe-version matching gate while disabling the affected matching operation; do not restore the heavy scan on the client's low-memory PC.
