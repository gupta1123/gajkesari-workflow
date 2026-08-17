# Tally Bank Statement End-to-End Test Cases

Use this checklist after the Tally bridge is paired, started, and `Sync from Tally` has succeeded.

## Test Data

- Company: `Gajkesari Test`
- Tally API URL on Windows: `http://localhost:9000`
- App URL: `http://localhost:3000`
- API URL from Windows bridge: `http://192.168.1.38:3001` when the API is running on the Mac
- Initial statement file: `test-assets/bank-statements/gajkesari-hdfc-june-sample.csv`
- Latest statement file: `test-assets/bank-statements/gajkesari-hdfc-june-latest-sample.csv`
- April Day Book visibility file: `test-assets/bank-statements/gajkesari-hdfc-apr-1-unique-sample.csv`
- Bank name: `Local Test Bank`
- Account number: `1234567890`
- Account holder name: `Gajkesari Test`
- Tally bank ledger name: `Local Test Bank`
- Default counterparty ledger: `Suspense`

## Setup Check

- [ ] Open `Tally Prime`.
- [ ] Confirm status shows `Bridge: Connected`.
- [ ] Confirm status shows `Tally: Reachable`.
- [ ] Confirm status shows `Company: Gajkesari Test`.
- [ ] Click `Sync from Tally`.
- [ ] Confirm the sync command moves from `Queued` to `Succeeded`.
- [ ] Confirm synced ledgers count is greater than `0`.
- [ ] Search synced ledgers and confirm `Local Test Bank` exists.
- [ ] Search synced ledgers and confirm `Suspense` exists.
- [ ] Search synced ledgers and confirm `Bharat Steels` exists.
- [ ] Search synced ledgers and confirm `Office Supplies` exists.
- [ ] Search synced ledgers and confirm `Transport Vendor` exists.

Expected result:

- Tally bridge is connected and processing commands.
- Synced Tally masters are visible in the app.
- Required ledgers exist before bank voucher posting is tested.

## Bank Statement Import

- [ ] Go to `Bank Statements`.
- [ ] Upload `test-assets/bank-statements/gajkesari-hdfc-june-sample.csv`.
- [ ] Enter bank name `Local Test Bank` if needed.
- [ ] Enter account number `1234567890` if needed.
- [ ] Enter account holder name `Gajkesari Test` if needed.
- [ ] Click `Preview Import`.
- [ ] Confirm preview rows have correct dates, descriptions, references, debit amounts, credit amounts, and balances.
- [ ] Confirm the account match/new-account message is correct.
- [ ] Click `Confirm Import`.
- [ ] Confirm success banner shows imported transaction count.
- [ ] Confirm the bank account appears in `Bank Accounts`.
- [ ] Confirm latest import timestamp updates.

Expected result:

- Rows are stored in the DB as the latest snapshot for the bank account.
- Bank account metadata is saved or matched correctly.

## Queue To Tally

- [ ] Select the Tally connection whose company is loaded.
- [ ] Select the imported bank account.
- [ ] Enter Tally bank ledger name `Local Test Bank`.
- [ ] Enter fallback counterparty ledger `Suspense`.
- [ ] Click `Queue Pending Vouchers`.
- [ ] Confirm success banner shows queued bank voucher command count.
- [ ] Go to `Tally Prime`.
- [ ] Click `Refresh Queue`.
- [ ] Confirm bank voucher commands appear in the Tally write-back queue.
- [ ] Watch the Windows PowerShell bridge logs.
- [ ] Confirm logs show `bank voucher posted`.
- [ ] Refresh queue and confirm commands move to `Succeeded`.

Expected result:

- Commands are created in the Tally write-back queue.
- The bridge posts Receipt, Payment, or Contra vouchers to Tally.

## Verify In Tally

- [ ] In Tally, open `Display More Reports -> Day Book`.
- [ ] Confirm vouchers are created on the statement dates.
- [ ] Open the `Local Test Bank` ledger report.
- [ ] Confirm bank entries match the imported statement rows.
- [ ] Open the `Suspense` ledger report.
- [ ] Confirm counterparty entries match the imported statement rows.
- [ ] Confirm narration/reference matches each bank statement row.
- [ ] Confirm credit transactions become `Receipt` vouchers.
- [ ] Confirm debit transactions become `Payment` vouchers.
- [ ] Confirm bank-to-bank transactions, if present, become `Contra` vouchers.

Expected result:

- Tally contains vouchers matching the imported statement.
- Voucher type, amount, date, narration, reference, bank ledger, and counterparty ledger are correct.

## Duplicate Prevention

- [ ] Go to `Bank Statements`.
- [ ] Upload `test-assets/bank-statements/gajkesari-hdfc-june-sample.csv` again.
- [ ] Preview and confirm the import.
- [ ] Select the same Tally connection and bank account.
- [ ] Enter Tally bank ledger name `Local Test Bank`.
- [ ] Enter fallback counterparty ledger `Suspense`.
- [ ] Click `Queue Pending Vouchers`.

Expected result:

- Already posted fingerprints are not queued again.
- No duplicate vouchers are added in Tally.
- If all rows were already posted, the app should report that no transactions could be queued.

## Latest Snapshot Rule

- [ ] Go to `Bank Statements`.
- [ ] Upload `test-assets/bank-statements/gajkesari-hdfc-june-latest-sample.csv`.
- [ ] Preview and confirm the import.
- [ ] Confirm the current bank transaction snapshot is replaced by the latest file rows.
- [ ] Confirm old import records/files for the same account are removed from the active import list.
- [ ] Confirm previously posted overlapping rows remain protected by the posting log.
- [ ] Select the same Tally connection and bank account.
- [ ] Enter Tally bank ledger name `Local Test Bank`.
- [ ] Enter fallback counterparty ledger `Suspense`.
- [ ] Click `Queue Pending Vouchers`.

Expected result:

- Only new or previously unposted transactions are queued.
- Previously posted overlapping rows do not post again.
- Tally keeps old vouchers even though the app snapshot is replaced.

## Failure Case

- [ ] Go to `Bank Statements`.
- [ ] Select the Tally connection and bank account.
- [ ] Enter Tally bank ledger name `Wrong Bank Ledger`.
- [ ] Enter fallback counterparty ledger `Suspense`.
- [ ] Click `Queue Pending Vouchers`.
- [ ] Keep the bridge running until it processes the command.
- [ ] Refresh the Tally queue.

Expected result:

- Tally bridge marks commands as `Failed`.
- App shows failed queue status.
- App does not crash.
- No invalid voucher is posted in Tally.

Retry:

- [ ] Correct Tally bank ledger name to `Local Test Bank`.
- [ ] Queue the failed or pending vouchers again.
- [ ] Confirm commands eventually succeed.

## Bridge Offline Case

- [ ] Stop the Windows PowerShell bridge with `Ctrl+C`.
- [ ] Refresh the `Tally Prime` page.
- [ ] Wait for heartbeat staleness.
- [ ] Confirm status eventually becomes waiting, stale, or disconnected.
- [ ] Go to `Bank Statements`.
- [ ] Queue pending vouchers.
- [ ] Confirm commands remain queued and are not posted while the bridge is stopped.
- [ ] Start the bridge again:

```powershell
node .\src\bridge.mjs start --company-name "Gajkesari Test"
```

- [ ] Confirm queued commands are processed after the bridge restarts.

Expected result:

- Offline bridge does not post commands.
- Queued commands are picked up when the bridge comes back online.

## Minimum Acceptance

Before calling this feature end-to-end complete, all of these must pass:

- [ ] Sync masters works.
- [ ] Required ledgers are present after sync.
- [ ] Bank statement import works.
- [ ] Confirm import saves the latest transaction snapshot.
- [ ] Queue creates Tally bridge commands.
- [ ] Bridge posts vouchers to Tally.
- [ ] Tally Day Book and ledger reports match app data.
- [ ] Duplicate or repeat import does not repost old vouchers.
- [ ] Latest statement replaces app snapshot.
- [ ] Latest statement queues only new or unposted transactions.
- [ ] Previously posted Tally vouchers remain protected by posting log.
- [ ] Wrong ledger failure is visible and does not crash the app.
- [ ] Bridge offline queueing waits until bridge restart.

## Additional Test Cases Added From Live Run

These cases were discovered during the 2026-06-11 live Tally run and should be kept in the regression checklist.

### Preview Versus Confirm

- [ ] Upload a CSV and click `Preview Import`.
- [ ] Try to queue before clicking `Confirm Import`.
- [ ] Confirm the app blocks queueing with a clear message that the import must be confirmed first.
- [ ] Confirm no `tally_bridge_commands` rows are created while the statement is only in preview.

Expected result:

- Preview rows are not treated as stored transactions.
- Queueing only uses confirmed `bank_transactions` rows.

### Missing Bank Account Metadata

- [ ] Upload a CSV that has transaction rows but no account number.
- [ ] Leave account number blank.
- [ ] Click `Confirm Import`.
- [ ] Confirm the app requires account identity before creating a new `bank_accounts` row.
- [ ] Enter bank name, account number, and holder name.
- [ ] Confirm import succeeds.

Expected result:

- New accounts cannot be created without enough identity to match future statements.
- The app explains that the app bank account is separate from the Tally company.

### Multiple Accounts For Same Holder

- [ ] Create two app bank accounts with the same holder name and different account numbers.
- [ ] Upload a statement whose holder matches both accounts.
- [ ] Confirm the app shows multiple candidate accounts.
- [ ] Confirm the user must choose one before import.

Expected result:

- The app does not guess when the same client/company has multiple bank accounts.
- Confirmed transactions attach to the selected source bank account.

### Same References On Different Dates

- [ ] Import and post a statement with references such as `CHG-HDFC-0003`.
- [ ] Import a second statement with the same references but different transaction dates.
- [ ] Confirm the fingerprint treats them as distinct rows when the date differs.
- [ ] Confirm duplicate protection still blocks exact repeats with the same date/reference/amount/balance.

Expected result:

- Same reference on a different statement date can be queued if it is a real distinct transaction.
- Exact repeats are not reposted.

### Tally False Success Detection

- [ ] Force a malformed voucher import XML.
- [ ] Confirm Tally may return HTTP success while returning no `CREATED` or `ALTERED` count.
- [ ] Confirm the bridge marks the command `Failed` unless Tally reports `CREATED > 0` or `ALTERED > 0`.
- [ ] Confirm the bridge logs request XML and stores Tally response in command result.

Expected result:

- The app must not mark a bank voucher as posted unless Tally reports actual creation or alteration.

### Tally Voucher Lookup

- [ ] Run the bridge read-only lookup:

```powershell
node .\src\bridge.mjs find-vouchers --refs APR1-CHG-HDFC-0003,APR1-RTGS-HDFC-0004 --company-name "Gajkesari Test"
```

- [ ] Run the bridge read-only voucher dump:

```powershell
node .\src\bridge.mjs list-vouchers --company-name "Gajkesari Test"
```

- [ ] Confirm returned vouchers include date, voucher type, reference, narration, ledgers, and cancelled status.

Expected result:

- Voucher verification does not rely only on Day Book UI filters.
- Cancelled/empty vouchers are distinguishable from posted bank-statement vouchers.

### April Day Book Visibility

- [ ] Upload `test-assets/bank-statements/gajkesari-hdfc-apr-1-unique-sample.csv`.
- [ ] Confirm import with a test account number.
- [ ] Queue the pending vouchers.
- [ ] Confirm Tally bridge reports `bank voucher posted` for all five commands.
- [ ] Open Tally Day Book for `1-Apr-26`.
- [ ] Confirm five visible vouchers exist on `1-Apr-26`:
  - Payment `45,000.00`
  - Payment `118.00`
  - Payment `4,200.00`
  - Receipt `384.50`
  - Receipt `73,500.00`

Expected result:

- Posted vouchers appear on the statement date in Tally Day Book.

## Current Live Check Notes

- 2026-06-11 15:42: Screenshot shows `Sync Masters` command succeeded.
- 2026-06-11 15:42: Screenshot shows synced ledgers loaded, including visible rows for `Bharat Steels`, `Cash`, `Local Test Bank`, `Office Supplies`, and `Profit & Loss A/c`.
- 2026-06-11 20:46: Initial bank voucher commands failed with `Bridge claimed this command but did not report a result before the retry limit`; root cause was uncaught bridge-side voucher XML build errors before result callback.
- 2026-06-11 20:50: Bridge result callback worked after wrapping voucher XML generation; actual error `staticVariables is not defined` was exposed.
- 2026-06-11 21:00: Tally rejected vouchers with `Voucher date is missing`; voucher XML was updated to include `SVCURRENTDATE`, `DATE`, and `EFFECTIVEDATE`.
- 2026-06-11 21:27: Bridge marked APR1 commands succeeded, but `find-vouchers` returned `matchCount: 0`; root cause was loose success detection that did not require `CREATED` or `ALTERED`.
- 2026-06-11 22:20: `list-vouchers` showed only two exported vouchers and one existing cancelled/empty Payment voucher on `1-Apr-26`; APR1 references were not in Tally.
- 2026-06-11 22:30: Commands failed with Tally response `DESC not found`; root cause was an incompatible voucher import header containing `<TYPE>Data</TYPE>` and `<ID>Vouchers</ID>`.
- 2026-06-11 22:41: After reverting the voucher import header to `<TALLYREQUEST>Import Data</TALLYREQUEST>` and retaining date fields, five APR1 unique bank vouchers posted successfully and appeared in Day Book for `1-Apr-26`.

Current pass/fail status:

- [x] Bridge heartbeat shows Tally reachable and company loaded.
- [x] Master sync loaded required ledgers for test posting.
- [x] CSV preview parses transaction date, description, reference, debit, credit, and balance.
- [x] Confirm import stores rows as pending transactions after account metadata is supplied.
- [x] Queue creates `post_bank_voucher` commands from pending or failed rows.
- [x] Bridge reports real local/Tally failures instead of timing out silently.
- [x] Bridge no longer treats Tally HTTP/XML acceptance as voucher success unless Tally reports creation/alteration.
- [x] APR1 unique sample posts five vouchers visible in Tally Day Book on `1-Apr-26`.
- [ ] Duplicate prevention still needs a clean post-fix rerun.
- [ ] Latest snapshot replacement still needs a clean post-fix rerun.
- [ ] Wrong ledger failure still needs a clean post-fix rerun.
- [ ] Bridge offline retry still needs a clean post-fix rerun.
- [ ] Voucher details should still be spot-checked by opening each Tally voucher and confirming narration/reference/ledger entries.

## Current Product Gaps Before Completion

The app is not complete as a production bank-to-Tally posting product yet. Current implementation is enough for controlled CSV-driven voucher posting, but the following work remains.

### Data Extraction

- CSV/text parsing exists.
- PDF/image statements are stored but still require manual review or later OCR/AI extraction.
- Need bank-specific parsers for common statement formats.
- Need validation for opening balance, closing balance, running balance continuity, and duplicate statement periods.

### Account And Ledger Matching

- App bank accounts are currently the source of truth for statement identity.
- Tally ledger sync does not yet fetch bank account number, IFSC, or detailed bank metadata from Tally ledgers.
- Need optional Tally bank-detail sync so a statement account can be suggested against an existing Tally bank ledger.
- Need a durable mapping from app bank account to Tally bank ledger.
- Need explicit UI for multiple bank accounts under the same client/company/holder.

### Counterparty Mapping

- Current fallback counterparty ledger is coarse, often `Suspense`.
- Need rules or mapping UI for narration/reference patterns:
  - `BHARAT STEELS` -> `Bharat Steels`
  - `OFFICE SUPPLIES` -> `Office Supplies`
  - bank charges -> bank charges ledger
  - interest credit -> interest income ledger
- Need confidence/review state before posting low-confidence matches.

### Tally Posting Robustness

- Need automated smoke tests for voucher XML generation.
- Need Tally response parsing that captures `STATUS`, `CREATED`, `ALTERED`, `ERRORS`, `LINEERROR`, and raw response consistently.
- Need read-after-write verification by exported voucher reference after posting.
- Need idempotency protection against repeated bridge retries after a Tally-side partial success.
- Need controlled handling for cancelled/deleted vouchers in Tally.

### UX And Audit

- Queue action should show why rows are not eligible: preview not confirmed, all posted, active queue exists, missing ledger, invalid amount, no selected account.
- Queue history should distinguish old succeeded commands from new retry commands.
- Need voucher drill-down from app command to request XML, Tally response, transaction row, and posting log.
- Need a safer reset/retry flow for local/test data and for production remediation.

### Security And Operations

- Bridge token/config lifecycle needs rotation and clearer diagnostics.
- Need bridge version display and minimum-version warnings in the app.
- Need structured local bridge logs, not only terminal output.
- Need deployment-specific API base guidance for Windows bridge.
