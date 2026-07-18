# Gajkesari native Tally PDF exporter

This add-on lets the connector ask TallyPrime to export one exact voucher as a
native PDF. It identifies the voucher by Tally `MasterID`, rather than by the
currently open screen.

One-time installation in TallyPrime:

1. Press `Ctrl+Alt+T` (or `F1: Help > TDL & Add-On`).
2. Select `F4: Manage Local TDLs`.
3. Set **Load selected TDL files on startup** to **Yes**.
4. Select `gajkesari-native-debit-note-export.tdl` from this folder.
5. Accept and restart TallyPrime.

The connector sends the report the voucher `MasterID` and a private output
path. It will fail closed if the native PDF is not written.
