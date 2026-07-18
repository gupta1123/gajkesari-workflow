# Tally Bank Statement Data Retention

This note explains which database tables are related to Tally, how the app decides whether a bank transaction was already posted, and what data remains or is replaced after queueing/posting.

## Tally-Related Tables

### `tally_connections`

Stores the Tally Bridge connection/session.

Important data:
- Owner user id
- Bridge token hash
- Bridge name, version, machine id
- Connection status
- Last heartbeat time
- Whether Tally is reachable
- Whether a company is loaded
- Loaded company name
- Last error

Retention:
- Kept until the user disconnects/deletes connection data.
- Heartbeat/status fields are updated repeatedly.

### `tally_connection_events`

Stores audit events for Tally Bridge activity.

Examples:
- Bridge heartbeat received
- Command queued
- Master sync queued
- Masters synced
- Disconnect/error events

Retention:
- Kept as history.
- Not used directly for duplicate detection.

### `tally_bridge_commands`

Stores commands sent from backend to the local Tally Bridge app/exe.

Command types:
- `sync_masters`
- `post_bank_voucher`
- `create_ledger`
- `alter_ledger`

Important data:
- Connection id
- Owner user id
- Command type
- Status: `queued`, `claimed`, `succeeded`, `failed`, `canceled`
- Payload
- Result/error
- Attempts
- Timestamps

Retention:
- Kept after completion.
- Status changes through the lifecycle instead of deleting the row.

Lifecycle:
- Backend creates command with `queued`
- Bridge claims it, status becomes `claimed`
- Bridge reports result, status becomes `succeeded` or `failed`

### `tally_masters`

Stores synced Tally masters used by the app.

Master types:
- Ledger
- Group
- Voucher type
- GST/tax ledger

Important data:
- Tally name
- Parent/group name
- Master type
- Master key/GUID
- Active flag
- Raw Tally payload
- Last synced time

Used for:
- Ledger search
- AI ledger matching
- Checking whether selected ledger exists
- Checking ledger group, for example `Sundry Debtors` or `Sundry Creditors`

Retention:
- Kept as synced master data.
- On a new master sync, current records can be replaced or marked inactive if they no longer exist in Tally.

### `tally_master_sync_runs`

Stores history of Tally master sync runs.

Important data:
- Connection id
- Owner user id
- Status
- Company name
- Totals by master type
- Completed time
- Error if any

Used for:
- Knowing when masters were last synced
- Deciding whether sync is stale

Retention:
- Kept as sync history.

## Bank Statement Tables Related To Tally

### `bank_accounts`

Stores bank account records and Tally mapping/checkpoint fields.

Tally-related data:
- `tally_connection_id`
- `tally_ledger_name`
- `last_imported_transaction_at`
- `last_imported_transaction_marker`
- `last_tally_posted_transaction_at`

Used for:
- Mapping bank statement account to Tally bank ledger
- Skipping old already-covered transaction rows using checkpoint logic

Retention:
- Kept.
- Checkpoint fields are updated after successful posting.

### `bank_statement_imports`

Stores uploaded statement/import metadata.

Important data:
- Uploaded file info
- Extracted account info
- Statement period
- Processing status
- Processing metadata
- Analysis metadata, including Tally sync/matching metadata

Retention:
- Kept as import history.

### `bank_statement_import_preview_transactions`

Stores extracted transaction rows before final confirmation/import.

Important data:
- Transaction date
- Description
- Reference number
- Debit/credit/balance
- Counterparty name
- Suggested ledger
- Suggestion confidence/reason
- Raw extraction/matching payload

Used for:
- Showing review table after analysis
- Confirming/importing selected rows

Retention:
- Preview rows for the same import are deleted and replaced when the worker re-saves preview rows for that import.
- They are not the final posting history.

### `bank_transactions`

Stores confirmed/imported bank transaction rows.

Tally-related data:
- `suggested_ledger_name`
- `confirmed_ledger_name`
- `ledger_mapping_source`
- `tally_status`
- `tally_voucher_id`
- `tally_posted_at`
- `raw_payload`
- `fingerprint`

Used for:
- Queueing rows for Tally posting
- Tracking queued/posted/failed status
- Duplicate detection by fingerprint
- Already-posted lookup when `tally_status = 'posted'`

Retention:
- Kept after queueing/posting.
- Status and Tally fields are updated.
- Rows are not deleted after posting.

### `bank_transaction_posting_log`

Stores posting checkpoint/history.

Important data:
- Owner user id
- Bank account id
- Source transaction id
- Fingerprint
- Transaction date
- Reference number
- Description
- Debit/credit/amount
- Voucher type
- Command id
- Status: `queued`, `posted`, `failed`
- Tally voucher id
- Tally posted timestamp
- Result/error

Used for:
- Already-posted detection
- Preventing repeated queueing/posting
- Audit/history of Tally posting

Retention:
- Kept after posting.
- Status changes from `queued` to `posted` or `failed`.
- Rows are not deleted after successful posting.

## How "Already In Tally" Is Detected

The app does not currently scan all vouchers inside Tally every time. It uses app-side posting history and checkpoints.

### 1. Posted Reference In `bank_transaction_posting_log`

When preview rows are loaded or transactions are confirmed, the app checks:

- Same owner user
- Same bank account
- `status = 'posted'`
- Uploaded row reference matches stored `reference_number` or `tally_voucher_id`

Reference normalization:
- Uppercase
- Remove non-alphanumeric characters

Example:
- `JUN03-001`
- `jun03 001`
- `JUN03/001`

All normalize to the same comparable key.

### 2. Posted Row In `bank_transactions`

The app also checks `bank_transactions` for:

- Same owner user
- Same bank account
- `tally_status = 'posted'`
- Uploaded row reference matches stored `reference_number` or `tally_voucher_id`

### 3. Account Checkpoint

The app uses checkpoint fields on `bank_accounts`:

- `last_tally_posted_transaction_at`
- `last_imported_transaction_marker`

Important:
- `last_imported_transaction_marker` can take priority over the date.
- If the marker is still pointing to a later transaction, changing only `last_tally_posted_transaction_at` may not allow older rows to import.

Rows before the checkpoint are counted as already covered/skipped.

## What Remains After Queueing

When Send to Tally queues rows:

Kept/updated:
- `bank_transactions`
  - `tally_status` becomes `queued`
- `bank_transaction_posting_log`
  - row is created or updated with `status = 'queued'`
- `tally_bridge_commands`
  - command row is created with `status = 'queued'`
- `tally_connection_events`
  - command/event history may be inserted

Not erased:
- Confirmed bank transaction rows
- Posting log rows
- Tally bridge command rows
- Tally master data

## What Remains After Successful Posting

When the bridge reports success:

Kept/updated:
- `tally_bridge_commands`
  - `status = 'succeeded'`
  - result and completion time stored
- `bank_transactions`
  - `tally_status = 'posted'`
  - `tally_voucher_id` stored
  - `tally_posted_at` stored
- `bank_transaction_posting_log`
  - `status = 'posted'`
  - Tally voucher id/posting result stored
- `bank_accounts`
  - checkpoint fields updated:
    - `last_imported_transaction_at`
    - `last_imported_transaction_marker`
    - `last_tally_posted_transaction_at`

Not erased:
- Posted transaction row
- Posting log row
- Bridge command row
- Connection event history

## What Can Be Replaced Or Marked Inactive

### Preview Rows

`bank_statement_import_preview_transactions` can be deleted/replaced for the same import when analysis is rerun or preview rows are regenerated.

### Tally Masters

When Tally masters are synced again:

- New active master rows are stored.
- Older master rows for the synced master types can be marked inactive or replaced.

This keeps ledger matching aligned with current Tally data.

## Resetting Checkpoint Date For Testing

To allow importing statements after May 1, 2026, reset both checkpoint date fields and clear the marker.

```sql
update public.bank_accounts
set
  last_imported_transaction_at = timestamp with time zone '2026-05-01 00:00:00+00',
  last_tally_posted_transaction_at = timestamp with time zone '2026-05-01 00:00:00+00',
  last_imported_transaction_marker = '{}'::jsonb
where id = 'YOUR_BANK_ACCOUNT_ID';
```

If transactions on May 1, 2026 should also be imported, set the checkpoint to April 30, 2026 instead.

```sql
update public.bank_accounts
set
  last_imported_transaction_at = timestamp with time zone '2026-04-30 00:00:00+00',
  last_tally_posted_transaction_at = timestamp with time zone '2026-04-30 00:00:00+00',
  last_imported_transaction_marker = '{}'::jsonb
where id = 'YOUR_BANK_ACCOUNT_ID';
```

## Debug Queries

Find bank account checkpoints:

```sql
select
  id,
  bank_name,
  account_number_masked,
  account_holder_name,
  tally_ledger_name,
  last_imported_transaction_at,
  last_tally_posted_transaction_at,
  last_imported_transaction_marker
from public.bank_accounts
order by updated_at desc;
```

Check posted history:

```sql
select
  reference_number,
  tally_voucher_id,
  status,
  transaction_date,
  tally_posted_at
from public.bank_transaction_posting_log
where bank_account_id = 'YOUR_BANK_ACCOUNT_ID'
order by transaction_date desc;
```

Check posted bank transactions:

```sql
select
  reference_number,
  tally_voucher_id,
  tally_status,
  transaction_date,
  tally_posted_at
from public.bank_transactions
where bank_account_id = 'YOUR_BANK_ACCOUNT_ID'
order by transaction_date desc;
```
