# Bank statement references and posting results — connector 0.1.78

The Axis QA upload ignored its `Bank reference` column. Without the original UTRs, a cross-date manual voucher was posted again, exact numeric-reference entries were held, and a genuinely different same-amount transaction was held. The screen also called existing vouchers newly posted. Bank commission was mapped to Suspense despite an existing Bank Commission expense ledger.

## Changes

- Backend and connector extraction recognize qualified bank/transaction reference headings and UTR/transaction ID aliases. Blank placeholders remain blank. Independent source-row evidence recovers missing references using date, description, amounts and running balance; conflicting references require review and are checked again on the server before posting.
- When Markdown loses amount columns on a sparse continuation page, physical PDF columns can recover the full row set. Date, description and reference coverage must agree, and the recovered running balances must pass validation. Recovery never invents a transaction from a balance difference.
- Tally bank-detail exports now fetch `AllLedgerEntries.BankAllocations.*`. Live Tally returned empty instrument details for individual nested field requests, even though the voucher retained its UTR. The fix keeps ledger/date/amount scoping and existing response-size/time limits; it does not export every ledger-entry field.
- A clear bank commission/charge description uses an unambiguous existing standard expense ledger. Automatic Suspense mapping requires review for bank charges; an explicit user selection remains available.
- Existing entries, newly posted entries and held entries have distinct labels and counts. Saved row identity includes running balance, and the API returns that balance when reopening a statement so repeated amounts cannot inherit another row's status.
- Older connector extraction results, including completed eager commands, use backend recovery. Posting requires connector 0.1.78 or later, with a plain-language update message.
- Download timing remains after posting. PDF/CSV include every source movement and preserve opening, running and closing balances. No Tally-status column was added.

## Validation

111 connector tests and 114 focused bank extraction/posting/export tests pass, including sparse continuation recovery, stale eager commands, repeated rows, source-reference conflicts and existing/new/held counts. API and frontend TypeScript checks pass. Both original two-page test PDFs were parsed and compared against their manifest: all 41 movements, source references, amounts, dates and running balances agree. Read-only live Tally checks then verified all 19 ICICI planned outcomes and the important Axis identity cases. An allocation-only UTR was separately verified with a different statement date and selected party, proving the result did not depend on party/date fallback.

After the earlier Axis upload and cleanup, its live outcomes are **20 existing, 1 new, 1 requiring review**. ICICI remains **5 existing, 9 new, 5 requiring review**. These validate extraction and live duplicate preflight; a fresh upload through the deployed app after installing the connector remains the final user workflow test.

## QA cleanup

Only the identified local test duplicate **5268 / MasterID 28542** was deleted. Original **5265 / MasterID 28531** remains. Bank commission **5271 / MasterID 28545** was corrected from Suspense to Bank Commission without changing its amount. An initial alteration attempt unexpectedly created a temporary voucher; that exact voucher was removed before the verified correction. All other bank vouchers were read back unchanged.

The two affected QA posting records were repaired: the duplicate statement row now links to original 5265 and preserves its source UTR, and the bank-charge row records Bank Commission. Before/after snapshots and the original posting result were preserved locally; financial amounts and source balances were not changed. Historical command results remain untouched. No schema migration or broad production data reset is needed.

Rollout: deploy API/worker to Heroku, push GitHub main for automatic frontend deployment, and install `GajkesariTallyConnectorSetup-0.1.78.exe` on the Tally PC.
