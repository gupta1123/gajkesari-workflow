# Manual bank voucher duplicate checking — connector 0.1.77

Uploading a bank PDF after entering its movements manually could create another voucher. The posting check treated an app-generated tracking reference as a bank reference and sometimes exported only vouchers whose main Reference field matched. This excluded manual entries with missing references or UTRs recorded in bank allocations or narration.

## Behavior

- The API sends `bankReferenceNumber` and `referenceSource` separately from the reference used to label the posted voucher. The connector also recognizes the existing generated-reference format in older queued commands.
- Every check reads the selected bank's vouchers for the statement period. Alphanumeric bank references additionally use an amount-filtered financial-year export, so matching no longer depends on where the reference is stored. Numeric references and generated tracking IDs require the same date.
- Exact normalized reference matches check the bank, amount and direction. Complete UTR tokens in narration are supported without substring matching. A unique manual voucher without a recorded UTR can match by date, bank, amount, direction and selected non-Suspense party.
- Matching vouchers with recognizable different bank references remain separate transactions. Unfamiliar manual invoice/reference formats, insufficient party evidence and multiple possible matches require review. Incomplete or unavailable reads do not permit posting.
- Exact-reference repeats cannot become postable merely because an earlier row reserved the voucher. Indistinguishable second rows without reliable references are held for review.
- Both single and batch checks treat multiple matches as ambiguous. Matched manual entries retain their existing voucher identity and return `alreadyInTally: true` with `created: 0`.
- App messages distinguish already-entered vouchers from newly posted vouchers, including after reopening a statement. A held possible duplicate explains that nothing was posted for that row.
- Opening/closing balance checks use only movements inside the statement dates, even when other dates are fetched for reference matching. PDF/CSV source rows and the original nine columns remain unchanged.

## Validation and rollout

All 110 connector tests and 31 focused posting/export tests pass. Connector regressions cover missing UTRs, generated references, bank allocations, narration, unknown invoice references, distinct UTRs, same-amount collisions, repeated rows, incomplete reads and statement-period balances. API/web TypeScript checks and `git diff --check` pass. Installer source validation passes, and the staged bridge source SHA-256 matches the workspace source.

The installer is `installer/tally-bridge/output/GajkesariTallyConnectorSetup-0.1.77.exe`. Rollout deploys the API/worker to Heroku, pushes the frontend to GitHub main for its automatic deployment, and installs connector 0.1.77 on the Tally PC. Local Tally was unavailable during verification, so the new amount filter and the full workflow still require a live Tally check during rollout. No database migration or production data reset is needed; previously created duplicates are not deleted automatically.

The bounded financial-year query uses Tally's documented [FilterCount collection function](https://help.tallysolutions.com/what-are-objects-and-collections-related-functions-in-tdl/); reference identity is evaluated in the connector after export rather than by a main-Reference-only Tally filter.
