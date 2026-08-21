function toMoneyNumber(value) {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function roundMoney(value) {
  return Number(value.toFixed(2));
}

function sameMoney(left, right) {
  return Math.abs(left - right) < 0.01;
}

export function correctRowsFromRunningBalance(
  transactions,
  { openingBalance = null, detectCategory = (_description, debit, credit) => (credit ? "receipt" : debit ? "payment" : "unknown") } = {}
) {
  let previousBalance = toMoneyNumber(openingBalance);
  const hasOpeningBalance = previousBalance !== null;

  return transactions.map((transaction) => {
    const balance = toMoneyNumber(transaction.balance_amount);
    const debit = toMoneyNumber(transaction.debit_amount);
    const credit = toMoneyNumber(transaction.credit_amount);
    const amount = Math.max(debit && debit > 0 ? debit : 0, credit && credit > 0 ? credit : 0);
    let next = transaction;

    // An unsigned balance does not tell us whether the statement is showing a
    // normal credit balance or an overdraft/debit balance. Without an opening
    // balance, rewriting explicit Debit/Credit columns from that ambiguous
    // movement can invert every row after the first. Negative balances are
    // explicitly signed DR balances and are safe to reconcile.
    const hasSignedDebitBalance = (previousBalance ?? 0) < 0 || (balance ?? 0) < 0;
    const canInferDirection = hasOpeningBalance || hasSignedDebitBalance;

    if (canInferDirection && previousBalance !== null && balance !== null && amount > 0) {
      const delta = roundMoney(balance - previousBalance);
      const expectedAmount = roundMoney(Math.abs(delta));
      const hasDirectionMismatch =
        (delta > 0 && (!credit || !sameMoney(credit, expectedAmount) || (debit ?? 0) > 0)) ||
        (delta < 0 && (!debit || !sameMoney(debit, expectedAmount) || (credit ?? 0) > 0));

      if (!sameMoney(delta, 0) && sameMoney(expectedAmount, amount) && hasDirectionMismatch) {
        const correctedDebit = delta < 0 ? expectedAmount : null;
        const correctedCredit = delta > 0 ? expectedAmount : null;
        next = {
          ...transaction,
          debit_amount: correctedDebit,
          credit_amount: correctedCredit,
          category: detectCategory(transaction.description, correctedDebit, correctedCredit),
          confidence: Math.max(transaction.confidence ?? 0, 0.9),
          raw_payload: {
            ...(transaction.raw_payload ?? {}),
            balanceCorrection: {
              previousBalance,
              balanceAmount: balance,
              delta,
              originalDebitAmount: debit,
              originalCreditAmount: credit,
            },
          },
        };
      }
    }

    if (balance !== null) previousBalance = balance;
    return next;
  });
}
