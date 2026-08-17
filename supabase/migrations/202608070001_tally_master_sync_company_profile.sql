-- Completes V7 company-profile parity for Tally master sync metadata.
-- The bank flow remains backward compatible while this migration is pending.

alter table public.tally_master_sync_runs
  add column if not exists company_gstin text,
  add column if not exists company_state_code text;

