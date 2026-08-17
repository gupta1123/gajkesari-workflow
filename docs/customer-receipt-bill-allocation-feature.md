# Customer Receipt Bill Allocation

## Scope

This feature adds one review step to the existing Bank Statements to Tally flow.
The original flow is still:

1. Upload bank statement.
2. Match each row to a Tally ledger.
3. Review rows.
4. Send rows to Tally through the existing queue and bridge.

The new step runs before sending to Tally only for customer receipts:

1. Identify credit rows matched to a ledger under `Sundry Debtors`.
2. Fetch that customer's open bill-wise references directly from Tally.
3. Propose bill allocation for the receipt.
4. Let the user review or edit the allocation.
5. Send the same receipt voucher to Tally with bill allocation lines.

No extra local table is used to store open bills. Open bills are fetched from Tally at the time of matching.

## What Is Implemented

### Exact bill match

Example:

- Open bill: `GKS/SALE/184` for `₹10,000`
- Bank receipt: `₹10,000`

Expected allocation:

| Ref Type | Reference | Amount |
| --- | --- | ---: |
| `Agst Ref` | `GKS/SALE/184` | `₹10,000` |

Expected Tally result:

- Receipt voucher is created.
- The bill is fully settled.
- The bill no longer appears in Bills Receivable pending list.

### Partial payment

Example:

- Open bill: `GKS/PARTIAL/001` for `₹15,000`
- Bank receipt: `₹5,000`

Expected allocation:

| Ref Type | Reference | Amount |
| --- | --- | ---: |
| `Agst Ref` | `GKS/PARTIAL/001` | `₹5,000` |

Expected Tally result:

- Receipt voucher is created.
- The bill remains open with `₹10,000` pending.
- Bills Receivable should still show that bill with the reduced pending amount.

### Receipt greater than pending bill

Example:

- Open bill: `GKS/ADV/001` for `₹10,000`
- Bank receipt: `₹15,000`

Expected allocation:

| Ref Type | Reference | Amount |
| --- | --- | ---: |
| `Agst Ref` | `GKS/ADV/001` | `₹10,000` |
| `Advance` | Auto-generated advance reference | `₹5,000` |

Expected Tally result:

- Receipt voucher is created.
- The bill is fully settled.
- The extra `₹5,000` remains under the customer as an advance.

### No pending bill

Example:

- No open bill for the customer.
- Bank receipt: `₹5,000`

Expected allocation:

| Ref Type | Reference | Amount |
| --- | --- | ---: |
| `Advance` | Auto-generated advance reference | `₹5,000` |

Expected Tally result:

- Receipt voucher is created.
- The full receipt amount remains as a customer advance.

## Existing Advance Adjustment

Existing advances can now be applied against bills that remain pending after the current bank receipt is allocated.

Example:

- Old advance already exists in Tally: `₹5,000`
- New sales bill exists: `₹15,000`
- New bank receipt is only `₹10,000`

Expected allocation:

1. Receipt voucher:
   - `₹10,000` is posted against the bill as `Agst Ref`.
2. Separate journal voucher:
   - `₹5,000` old `Advance` is adjusted against the same bill.

Expected Tally result:

- The receipt voucher still matches the actual bank deposit of `₹10,000`.
- The separate journal clears the old advance against the bill.
- The bill should be cleared if the receipt plus old advance equals the bill amount.

## How Existing Advance Auto-Adjustment Works

The adjustment is intentionally separate from the bank receipt:

1. Keep the current receipt posting unchanged.
2. Detect when the customer has both:
   - open bills after current receipt allocation, and
   - existing advance references.
3. Show a separate review section named `Apply Existing Advances`.
4. If the user keeps it enabled, queue a new command named `adjust_customer_advance`.
5. The bridge posts a Journal voucher that moves the old advance against the open bill.

Journal effect:

| Ledger | Bill Type | Reference | Amount |
| --- | --- | --- | ---: |
| Customer ledger | `Advance` | old advance reference | debit amount |
| Customer ledger | `Agst Ref` | pending bill reference | credit amount |

The total journal amount should be limited to the lower of:

- existing advance pending amount
- remaining bill pending amount

This keeps the current bank statement import stable and makes advance adjustment an explicit, reviewable action.

## Test Cases

Use unique dates after the bank account's last Tally posted transaction date and unique reference numbers. If the same reference was already posted, the app may correctly show it as already in Tally.

Same-date testing is supported for new references, but duplicate protection still checks posted history. If a row has already been posted to Tally for the same bank account and reference, the app should show it as already in Tally instead of queueing it again.

## Tally Voucher Creation Steps That Worked In Testing

These steps match the Tally Prime screens used during testing. Use `Go To` instead of function keys when VM keyboard shortcuts are difficult.

### Create a Sales Bill

1. `Go To` -> `Create Voucher`.
2. Select voucher type `Sales`.
3. Set the voucher date.
4. Enter `Maharaja Engg` in `Party A/c name`.
5. If dispatch details open, leave the fields blank and press `Enter` through them.
6. Enter `Sales` in `Particulars`.
7. Enter the bill amount.
8. Save the voucher.
9. Go to `Bills Receivable` and note the generated `Ref No.`.

In our Tally setup, Tally sometimes did not ask for manual bill-wise details. It auto-created the bill reference using the voucher number, such as `2`, `3`, or `11`. That is acceptable for testing. Use the displayed `Ref No.` in the bank narration.

Example:

| Tally Bill Ref | Bank Narration To Use |
| --- | --- |
| `2` | `NEFT FROM MAHARAJA ENGG SALE 2` |
| `3` | `NEFT FROM MAHARAJA ENGG SALE 3` |
| `GKS/PARTIAL/001` | `NEFT FROM MAHARAJA ENGG GKS/PARTIAL/001` |

### Create an Old Customer Advance

Use this for the existing advance adjustment test.

1. `Go To` -> `Create Voucher`.
2. Select voucher type `Receipt`.
3. Set the date before the new bank receipt date.
4. In `Account`, enter `Gajkesari HDFC`.
5. In `Particulars`, enter `Maharaja Engg`.
6. Enter amount `5000`.
7. If bill-wise details open, use:
   - `Type of Ref`: `Advance`
   - `Name`: `ADV-OLD-001`
   - `Amount`: `5000 Cr`
8. If Tally opens `Bank Allocations for: Gajkesari HDFC`, keep `Cheque/DD` or choose `Others`, leave `Bank Name` blank, and accept the popup.
9. Save the voucher.
10. Verify in `Bills Payable` that `ADV-OLD-001` appears for `Maharaja Engg` with `5000 Cr`.

In the tested company, the old customer advance appeared under `Bills Payable`. This is okay. The app treats it as an existing customer advance if Tally returns it as an `Advance` reference.

### View Pending Bills

1. `Go To` -> `Bills Receivable`.
2. Check customer `Maharaja Engg`.
3. Pending sales bills appear here.
4. Fully settled bills disappear from this screen.
5. Partially settled bills remain with the reduced pending amount.

### View Existing Advances

1. `Go To` -> `Bills Payable`.
2. Check customer `Maharaja Engg`.
3. Old advance references can appear here, for example `ADV-OLD-001`.

### View Posted Settlement

1. `Go To` -> `Day Book`.
2. Set the date to the bank receipt date.
3. Open the Receipt voucher created by the app.
4. Inspect the `Maharaja Engg` ledger line to see bill-wise allocation.
5. If existing advance adjustment was applied, also look for the Journal voucher on the same date.

Alternative:

1. `Go To` -> `Ledger Vouchers`.
2. Select `Maharaja Engg`.
3. Set the date range covering the Sales voucher, old advance Receipt voucher, bank Receipt voucher, and Journal adjustment.

### Test 1: Exact settlement

1. In Tally, create Sales voucher for `Maharaja Engg`.
2. Amount: `₹10,000`.
3. Bill-wise ref: `GKS/EXACT/001`.
4. Upload bank receipt for `₹10,000` with narration containing `GKS/EXACT/001`.
5. Click `Match Pending Bills`.
6. Confirm allocation shows `Exact Bill Match`.
7. Send to Tally.
8. Verify in Tally Bills Receivable that `GKS/EXACT/001` is not pending.

### Test 2: Partial settlement

1. Create Sales voucher for `Maharaja Engg`.
2. Amount: `₹15,000`.
3. Bill-wise ref: `GKS/PARTIAL/001`.
4. Upload bank receipt for `₹5,000`.
5. Click `Match Pending Bills`.
6. Confirm allocation shows `Partial Settlement`.
7. Send to Tally.
8. Verify Bills Receivable still shows `GKS/PARTIAL/001` with `₹10,000` pending.

### Test 3: Bill cleared plus new advance

1. Create Sales voucher for `Maharaja Engg`.
2. Amount: `₹10,000`.
3. Bill-wise ref: `GKS/ADV/001`.
4. Upload bank receipt for `₹15,000`.
5. Click `Match Pending Bills`.
6. Confirm allocation shows `Bills Cleared + Advance`.
7. Send to Tally.
8. Verify bill is cleared.
9. Verify the extra `₹5,000` appears as an advance in customer bill-wise details.

### Test 4: No pending bill creates advance

1. Use a customer ledger that has bill-by-bill enabled and no pending sales bills. In testing this was `Test Advance Customer`.
2. Upload bank receipt for `₹5,000`.
   - Date: `06-Jun-2026` or any new test date.
   - Reference: `NOPEND0601` or another unique reference.
   - Narration: `NEFT FROM TEST ADVANCE CUSTOMER ADVANCE PAYMENT`.
3. Click `Match Pending Bills`.
4. Confirm allocation shows `No Pending Bill - Advance`.
5. Send to Tally.
6. Verify the receipt voucher in `Day Book`.
7. Open the voucher and confirm the customer line shows an `Advance` allocation, for example `ADV-20260606-pend0601`, for `₹5,000 Cr`.
8. Verify the customer has a new advance reference for `₹5,000` in bill-wise details. In this Tally company, customer advances may appear under `Bills Payable`.

### Test 5: Existing advance auto-adjustment

1. Create or keep an old customer advance of `₹5,000`.
   - Example from testing: `Test Advance Customer` has advance `ADV-20260606-pend0601` for `₹5,000 Cr`.
2. Create a new Sales bill for the same customer.
   - Example bill reference: `TEST/ADVSETTLE/001`.
   - Example amount: `₹5,000` or higher.
3. Verify the bill appears in `Bills Receivable`.
4. Upload a new bank receipt row for the same customer.
   - Use a new date/reference that has not already been posted.
   - Include the bill reference in narration when possible.
4. Click `Match Pending Bills`.
5. Expected review result:
   - receipt allocation settles the current bank receipt against the bill,
   - `Apply Existing Advances` is shown and enabled,
   - proposed journal adjustment applies the old advance to the remaining bill amount.
6. Send to Tally.
7. Expected Tally result:
   - receipt voucher is created for the actual bank deposit,
   - a separate journal voucher is created for the advance adjustment,
   - the old advance is reduced or cleared,
   - the bill pending amount is reduced or cleared.

Important: a pure settlement of an old advance against a sales bill has no new bank transaction. The Bank Statement screen can trigger this adjustment only when a customer receipt row is being reviewed. A standalone "settle old advance without bank receipt" action would be a separate feature.

## Pending / Future Feature

### Settle existing advance without a bank receipt

This is not part of the current Bank Statements flow.

If the user wants to fully settle an old customer advance against a new sales bill without receiving new money in the bank, there is no bank statement transaction to upload. That settlement should be handled by a separate action, for example `Settle Existing Advance`, outside the bank upload flow.

Current behavior:

1. The app can show existing advances during customer receipt allocation.
2. The app can auto-create a separate journal adjustment only when a bank receipt row is being processed.
3. The app does not yet provide a standalone screen/action to settle old advances against bills when there is no new bank receipt.

Expected future behavior:

1. User selects customer ledger.
2. App fetches open bills and existing advances from Tally.
3. User chooses which advance should be adjusted against which bill.
4. App shows a review screen.
5. App sends a Journal voucher to Tally without requiring a bank statement row.

## Verification In Tally

Use these screens:

1. `Day Book`
   - Open the receipt voucher by date and reference.
   - Inspect the customer ledger line to see bill-wise allocation.

2. `Bills Receivable`
   - Fully settled bills disappear from the pending list.
   - Partially settled bills remain with reduced pending amount.

3. Customer `Ledger Vouchers`
   - Use date range covering the sales voucher and receipt voucher.
   - Confirm both entries are visible for the same customer.

4. Customer bill-wise details
   - Use this to see pending bills and advance references for the customer.
