# Bank matching fixes - connector 0.1.82

The deployed bank-statement page could overwrite authoritative ledger records
with lightweight vector candidates when hydrating a PDF preview. Nested customer
groups then lost their customer classification and bill-wise flags, causing
Check Tally to skip their open bills and show Direct Receipt.

Preview hydration now preserves authoritative ledger records while retaining
candidate-only names for the picker. No duplicate-check or posting policy was
changed.

A shared invoice-reference resolver is used by the frontend and connector. It
prioritises full references, supports unique prefixed serials such as INV70211,
INV/70211, INV 70211 and leading-zero variants, and limits matching to the selected
party's open bills. Ambiguous aliases and explicitly unmatched invoice references
require review. FIFO still applies when no invoice reference is present.

The installer copies the shared implementation into its standalone local-matching
directory. Its source adapter and frontend package export both use the same
implementation during development.

## Validation

- Connector suite: 121 tests passed, including duplicate safeguards and allocation.
- Shared-reference/frontend hydration/readiness/FIFO regressions: 35 tests passed.
- Frontend typecheck and production build passed.
- The built 0.1.82 connector's actual matching function was run against live
  Solution Nyx Tally data with the six uploaded rows. It found the same two
  existing vouchers and allocated the four missing rows to their named invoices
  (70214, 70215, 70216 and 70211), rather than older FIFO bills.
- That live matching run used exports only and created no vouchers.

Separately, the four identified Nyx RefTest ledgers had bill-wise accounting
enabled as requested. Tally acknowledged four ledger alterations, zero creations
and zero errors. Full before/after XML backups were retained privately. Business
fields were unchanged apart from ISBILLWISEON; Tally also updated its audit fields.
The corresponding four cached flags were refreshed without advancing the
company-wide sync cursor. Existing receipts and bill balances were retained.

The application fixes are prepared locally on the production-fixes branch. They
require the frontend deployment and connector 0.1.82 installation; no backend
application changes are required for these fixes.
