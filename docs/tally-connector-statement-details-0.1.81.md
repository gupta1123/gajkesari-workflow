# Connector 0.1.81: statement details

The connector previously returned correct transaction rows while omitting visible
account-holder names, statement periods and HDFC summary opening balances.

The parser now reads printed statement periods from HDFC, PNB and Central Bank
headers, including same-day periods. It rejects invalid or reversed date ranges
and does not infer statement coverage from transaction dates.

Holder recovery supports PNB's plain-text labels, HDFC's separate holder/branch
columns, and Central Bank's explicit downloaded-by footer. HDFC name lines are
joined above the address label; addresses and branch names are excluded.

Opening balances are read below summary column headings, preserving negative
and DR balances. A narrowly bounded fallback handles HDFC's blank leading
summary column. Statements without a printed opening balance retain null.
Recovering the opening balance also lets running-balance validation check the
first chronological transaction against that printed balance.

Parser diagnostics include statement-detail fields and warnings independently
of transaction balance validation. These diagnostics are not a new frontend
warning or a backend acceptance-policy change.

## Validation

- Connector suite: 120 passing tests.
- Shared account, amount, balance and updater suite: 48 passing tests.
- Built connector replay: 20 client uploads, representing 13 distinct PDFs and
  486 transaction rows. Holder names and printed statement periods match all 20
  source PDFs; all 9 printed HDFC opening balances match their summaries.
- No transaction mismatches, parse errors, database writes or Tally calls during
  the replay. Packaged parser/shared-module hashes match the source files.

The replay uses the actual packaged PDF parser under Electron's Node runtime.
It does not exercise live ledger suggestions, duplicate checks or voucher
creation. The installer is prepared locally; publishing and installation are
separate actions.
