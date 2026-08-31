# Tally isolation and reliability release — 0.1.58

## Status

Implementation prepared for the coordinated API and frontend release.
The user reported successfully applying the corrected migration manually.
The assistant has not executed migration SQL or posted test Tally vouchers.

Migration: `supabase/migrations/20260831091749_tally_installation_scope_and_command_leases.sql`.
The Supabase CLI created this migration; production SQL execution was manual.
Database integration and real two-PC acceptance testing remain acceptance checks.

## Implemented

- Durable installation records, GUID-keyed company datasets, revocable hashed
  browser bindings, and per-user browser preferences. Legacy browser selection
  is not imported; both PCs must pair again.
- Pairing replaces only that installation's prior sessions. Browser actions do
  not select another PC by company name, and cannot disconnect other PCs.
- Company-scoped bank accounts, statements, transaction history, mappings and
  master uniqueness. Reconnection changes a session, not the dataset.
- Protected API access for bound data; direct authenticated Supabase table and
  document-bucket access is restricted. Existing signed URLs remain valid until
  their expiry; do not treat re-pairing as immediate signed-URL revocation.
- Live reads carry installation, dataset, GUID and session-generation targets.
  Connector checks the active GUID, including after matching phases. Import
  calls recheck the target before writing.
- No two-minute browser socket retirement. Token renewal drains existing work.
  Authentication deadline 10s; interactive queue wait 15s; overall reads 240s;
  export timeout 60s; progress about every 2s; cancellation reaches queued/active
  exports. Partial matching evidence is not treated as a completed match.
- Small current-company readiness query instead of exporting all ledgers.
  Independent 10s liveness; unchanged presence/probe persistence throttled to
  30s; connector recovery command polling 60s with Realtime, 15s without it.
- Lean immutable catalogue snapshots referenced by imports, no repeated arrays
  in processing metadata, and a bounded 15s live master cache keyed by GUID and
  session. Voucher/date indexing preserves strict reference and party checks.
- Atomic bank command enqueue with posting checkpoints; atomic debit-note
  proposal approval; bank/proposal result checkpoints and generation-fenced result acceptance; claim tokens, 120s leases,
  30s renewal and maintenance quarantine. Unknown import outcomes are not
  automatically replayed. Financial writes are rejected by the transient live
  gateway and use durable approval endpoints instead.

## Local verification

- `npm run test:tally-bridge`: 36 tests, including 9,227/12,000-voucher parity
  fixtures, duplicate GUID/name handling, readiness and queue cancellation.
- `npm run test:tally-live-gateway`: 2 tests including two connectors with one
  login, wrong binding, stale generation, target isolation and cancellation.
- `npm run test:tally-browser-live`: 3 tests including >2-minute work, token
  renewal, authentication timeout and partial-result cancellation.
- API/web TypeScript checks and local production builds.
- Nine bank-statement readiness/UI regression tests (50 tests in total), including
  ready-only batches and existing Suspense receipt/payment handling.
- Connector installer 0.1.58 compiled locally; packaged bridge source hash
  compared against the source tree. The installer was not installed on a PC.

On this Windows host, Turbopack needed
`NEXT_TURBOPACK_EXPERIMENTAL_USE_SYSTEM_TLS_CERTS=1` to download Google Fonts.
This was a command-local environment setting, not a committed deployment setting.
Existing non-blocking lint warnings remain.

These tests use fixtures/mocked services. They do not prove production database
compatibility, live financial correctness, or the client's network performance.

## Manual coordinated rollout

The isolation migration supports databases without the optional
`public.debit_note_proposals` table. It conditionally adds that module's dataset
column, backfill, trigger, grants and reconciliation-report branch. The saved
proposal approval RPC fails closed with a setup-required error when the module
is absent; this does **not** install or enable saved debit-note proposals.
If that module is installed later, add its dataset isolation constraints and
trigger in a separate reviewed migration before enabling its API.

If the earlier version failed with `42P01` at the proposal backfill, use the
corrected full migration file, not just the statements after the failing line.
The file is wrapped in `BEGIN`/`COMMIT`; executing the full file as one transaction
must not commit partial changes on error. If statements were run separately,
inspect the schema first rather than blindly rerunning or deleting objects.

1. Back up the database and record deployed versions. Pause new work and drain
   workers/connectors. Do not mix the old application with the new schema.
2. Verify the existing company-scoped-master and outgoing-verification migrations
   are present. In particular, this migration replaces their named uniqueness
   constraints and relies on their transaction/posting-log status values.
3. Review and manually apply the migration first to an isolated staging database.
   Inspect the read-only queries in `supabase/tally_isolation_verification.sql`.
   Exercise concurrent pairing, two claimers, stale claim results, atomic enqueue
   rollback and expired-lease quarantine there before approving production.
4. Inspect `tally_scope_reconciliation_report`. Only GUID evidence recorded
   with historical work is backfilled. Rows without it remain preserved but
   unassigned and are not shown in the new scoped UI. Do not assign them from
   a connection's current company name. Resolve historical ownership explicitly;
   legacy accounts spanning datasets require a reviewed split.
5. After staging approval, manually apply the migration in a maintenance window
   and release the API/worker, gateway, web and connector together. Frontend
   releases are triggered by pushing GitHub main; backend releases use Heroku.
6. Install 0.1.58 and re-pair each PC from its own browser. Keep the installation-ID
   file; do not copy one PC's connector configuration to another.
7. On each PC, confirm only its own company list and data are visible. Use an
   isolated test company to check duplicate prevention, company switching during
   reads, slow exports, lost acknowledgements, reconnects and PDF generation.
   Verify a quarantined financial command by reading Tally before retrying.

## Remaining acceptance limits

The new RPCs still need full execution-based acceptance validation. No production
records have been reconciled. The fixture sizes test matching parity, not a
measured client-machine speedup. Non-bank document uploads and the existing
debit-note document/result follow-up workflow still involve separate operations;
do not interpret the checkpoint transaction as a distributed transaction
covering Storage, Tally and every proposal side effect.

Do not perform a blind SQL rollback after new data exists. Use the maintenance
backup/release plan; restoring owner-only table grants would remove PC isolation.
