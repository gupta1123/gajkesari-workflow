# Bank Statement Module

## Goal

Add a separate workflow for importing bank statements, resolving the target bank account, storing new transactions in the local database, and preparing confirmed rows for future Tally posting.

## Database Changes

Migration: `supabase/bank_statement_imports_backend_v1.sql`

New tables:

- `bank_accounts`
  - Stores normalized account identity, masked account number, holder name, optional Tally ledger mapping, latest imported transaction timestamp, and latest Tally-posted timestamp.
- `bank_statement_imports`
  - Stores uploaded statement file metadata, extracted account details, statement period, import status, counts, and processing metadata.
  - After confirmation, older import metadata/files for the same bank account are removed so the DB keeps the latest statement record for that account.
- `bank_transactions`
  - Stores the latest confirmed transaction snapshot for a bank account with debit/credit/balance, category, type, reference, fingerprint, and Tally posting status.
  - Confirming a newer statement replaces the current snapshot rows for that account.
- `bank_transaction_posting_log`
  - Stores durable Tally posting memory by bank account and transaction fingerprint.
  - Prevents already queued or posted transactions from being appended to Tally again after a new snapshot is imported.

New private storage bucket:

- `bank-statement-files`

Deduplication:

- Transactions use a SHA-256 fingerprint built from account id, dates, description, reference, debit, credit, and balance.
- The table has a unique constraint on `(owner_user_id, bank_account_id, fingerprint)`.

## API Changes

New server helper:

- `apps/api/src/lib/bank-statements.ts`

New API routes:

- `GET /api/bank-statements/accounts`
  - Lists bank accounts for the authenticated user.
- `GET /api/bank-statements/imports`
  - Lists recent statement imports.
- `POST /api/bank-statements/imports`
  - Uploads a statement file to storage.
  - Parses CSV/text files into preview transactions.
  - Stores an import record.
  - Finds account candidates by exact account number first, then by account holder name.
  - Returns account candidates and draft transactions to the frontend.
- `POST /api/bank-statements/imports/:id/confirm`
  - Confirms a reviewed import.
  - Uses the selected account when provided.
  - Creates a new account when no selected account exists.
  - Replaces the current account transaction snapshot with the reviewed statement rows.
  - Copies any previously posted rows into `bank_transaction_posting_log` before replacement.
  - Marks rows already present in the posting log as `tally_status = 'posted'`.
  - Removes older confirmed import records/files for that same bank account.
  - Marks inserted transactions as `tally_status = 'pending'`.
  - Updates `last_imported_transaction_at`.
- `POST /api/bank-statements/tally/queue`
  - Queues pending/failed bank transactions as `post_bank_voucher` bridge commands.
  - Requires a Tally connection, bank account, and Tally bank ledger name.
  - Uses one bridge command per transaction so each transaction can be marked posted or failed independently.
  - Skips transactions whose fingerprint is already queued or posted in `bank_transaction_posting_log`.

## Frontend Changes

New page:

- `apps/web/src/app/bank-statements/page.tsx`

New component:

- `apps/web/src/components/bank-statements/BankStatementsPage.tsx`

Navigation:

- Added `Bank Statements` to `DashboardSidebar`.

User flow:

1. Upload a bank statement file.
2. Optionally enter bank name, account number, and account holder name.
3. Preview import.
4. If one account matches, show the matched account.
5. If no account matches, show that a new account will be created.
6. If multiple accounts match, require the user to select one.
7. Review or edit transaction rows.
8. Confirm import.
9. Store new rows and skip duplicates.
10. Select a Tally connection and bank account.
11. Queue pending transactions as Tally voucher commands.

## Current Extraction Boundary

CSV and text statements are parsed locally in the API as the fast path.

PDF/image statements are rendered/prepared in the API and extracted through the existing OpenRouter processing helper using a dedicated bank-statement extraction prompt. The API still returns preview rows only; users must review/edit them before confirming the import. If OpenRouter is unavailable or no usable rows are extracted, the import is stored and marked for manual review.

## Tally Boundary

Confirmed transactions are stored in the latest account snapshot. Transactions not already present in the posting log are stored with `tally_status = 'pending'`; transactions already posted to Tally are stored with `tally_status = 'posted'`.

Added Tally bridge command support:

- Migration: `supabase/tally_bridge_commands_bank_voucher_v5.sql`
- Command type: `post_bank_voucher`
- Bridge XML builder: `buildBankVoucherXml`
- Result handling updates `bank_transactions.tally_status`, `tally_posted_at`, and `tally_voucher_id`.
- Result handling also updates `bank_transaction_posting_log`, so Tally posting memory survives later snapshot replacement.

- `last_imported_transaction_at`
- `last_tally_posted_transaction_at`

This allows statement imports and Tally posting to move independently.

The bridge must still run on the Windows machine where TallyPrime is open and reachable at `http://localhost:9000`.
