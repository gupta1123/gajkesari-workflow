# Bank statement coverage fix — 5 September 2026

Local implementation; not deployed. No migration or installer change required.

## Behaviour

- Supported Markdown tables are compared with normalized AI rows using reference,
  date, debit, credit and balance, retaining repeated-row multiplicity.
- Missing/invalid rows are recovered from their own source table lines: at most
  40 rows, sequential groups of 10. Existing provider transport retry rules remain.
- Unexpected extra/duplicate rows are not silently removed. Unverified recovery
  keeps the original preview incomplete. Unsupported layouts use the existing
  page extraction/recovery pipeline, not PDF single-shot success-by-nonempty.
- Source coverage and running balances must pass before standalone ledger matching.
  Combined extraction/matching is disabled so incomplete extraction cannot spend a
  ledger-matching pass first. The standalone matcher and its ledger inputs remain.
- Valid unmatched transactions keep the existing Suspense behaviour. Missing source
  transactions are not fabricated as Suspense entries. Incomplete statements remain
  non-postable and the footer explicitly says so.

## Verification

49 focused tests cover the actual adaptive worker branch, omitted payment recovery,
duplicate/reference/date/amount checks, bounded/failed recovery, balance validation,
PNB direction correction, page recovery and Suspense posting eligibility.
API/frontend typechecks and worker syntax checks passed.

Read-only replay of import `ecc48fc2-a6ab-4f7f-a553-5516ad5f875a`:
194 source rows, 193 saved rows, one missing row, no unexpected rows. A bounded
live recovery using the configured Markdown model restored that row in 4.312 s;
194 output rows then passed all running-balance transitions. This is recovery-only
timing, not a full analysis or posting benchmark. No database or Tally writes.

Reproduce from this repository with protected Gajkesari environment variables:

```powershell
node --use-system-ca --env-file=apps/api/.env.local scripts/verify-bank-source-coverage.mjs --import ecc48fc2-a6ab-4f7f-a553-5516ad5f875a
```

Default replay uses a deterministic recovery fixture. Add `--live-recovery` only
to intentionally call the configured AI provider for the missing source rows.
Neither mode saves a replacement preview, queues work or posts to Tally.

Existing failed imports are not retroactively changed. After deployment, a new
analysis/retry is needed. Unsupported/ambiguous source layouts can still require
manual review; these checks are not a promise that every PDF can be parsed.
