# PNB continuation-page amount correction

Implemented locally 5 September 2026; not deployed. No hosted records changed.

The September 4 PNB import had 10 transactions. AnyDoc represented the
headerless second page with a different column count and used the first
transaction as a Markdown header. AI reversed T29161971 (payment 10,000,000)
and T24969455 (receipt 250,000). Deterministic Markdown reconciliation recognized
zero source rows. Balance validation caught the first error but could not
validate the earliest transaction without an opening balance.

The worker now detects the PNB Txn No./Dr Amount/Cr Amount layout and reads
physical PDF text positions. It verifies the headings, amount-column spacing,
page width, reference/date alignment, wrapped money, unique references and
complete agreement with the extracted transaction reference set. It reconciles
amounts and category before ledger matching and preview persistence. If this
verification fails, the existing PDF recovery path runs; it does not guess
from malformed Markdown column counts. Other layouts retain their path.

Verification used the original source PDF and saved AI rows, locally and read
only, with no new AI call or Tally import. All 10 rows were retained, exactly
the two wrong directions changed, and all 9 available balance transitions
matched. Generated XML had Payment/credit-bank for Chaman and Receipt/debit-bank
for Khodiyar. The local physical-column check took approximately 234 ms.

Run unit regressions:

```powershell
node --test apps/api/worker/bank-statement-markdown-amounts.test.mjs apps/api/worker/bank-statement-running-balance.test.mjs apps/api/worker/bank-statement-pdf-columns.test.mjs
```

This is a backend worker change. No connector installer or SQL migration is
required. A backend deployment and new analysis are required for client use;
the previous preview is not automatically rewritten. A new full live AI run
was not performed as part of the read-only incident verification.
