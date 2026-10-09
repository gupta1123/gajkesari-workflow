# Bank statement posting messages

Completed duplicate checks no longer appear as pending when rows were held for review. The banner and footer separately report newly posted entries, entries already in Tally, possible duplicates that were not posted, accepted entries awaiting confirmation, unknown posting outcomes, and actual failures. Completion messages do not call skipped vouchers newly posted.

Held rows open a details drawer with candidate voucher numbers, dates, parties, voucher references and bank references. Explanations distinguish repeated statement rows without references, multiple candidates, reference conflicts and party conflicts, using existing connector evidence. Opening details does not resolve or post a row. The navigation buttons say Next entry and Close. Held rows appear under review filters rather than ready or failed checks.

Recheck in Tally explains that it checks without posting and conflicting details may still need review. Ledger labels describe ledger selection separately from voucher confirmation. Reported balance differences show statement and Tally opening/closing amounts and differences, while explaining that the download retains source balances.

Posting commands, duplicate matching rules, API routes, database records, connector version, PDF/CSV columns and download eligibility are unchanged. This update needs only the frontend deployment via GitHub main.

Validation: 39 focused posting, readiness, extraction-state and export tests pass, along with frontend TypeScript checking and the production Webpack build. A read-only replay of the saved 19-row ICICI upload reports 9 newly posted, 5 existing and 5 held, preserves all 19 export movements, and shows the expected reason and voucher evidence for each held row. No vouchers were posted or changed during validation.
