import type { PostingMatch } from "./statement-bank-book";

export type ReviewStatement = { date: string; amount: number; ledger: string; bank: string; reference: string; direction: "incoming" | "outgoing" };
const normalize = (value: string) => value.toUpperCase().replace(/[^A-Z0-9]/g, "");
const money = (value: number) => new Intl.NumberFormat("en-IN", { style: "currency", currency: "INR", minimumFractionDigits: 2 }).format(value);
const date = (value: string) => /^\d{4}-\d{2}-\d{2}$/.test(value) ? value.split("-").reverse().join("/") : value;
export function comparePostingVoucher(statement: ReviewStatement, match: Partial<PostingMatch>) {
  const refs = match.bankReferences?.length ? match.bankReferences : match.reference ? [match.reference] : [];
  const fields = [
    { label: "Date", statement: date(statement.date), tally: match.date ? date(match.date) : null, equal: statement.date === match.date },
    { label: "Amount", statement: money(statement.amount), tally: typeof match.amount === "number" ? money(match.amount) : null,
      equal: typeof match.amount === "number" && Math.round(statement.amount * 100) === Math.round(match.amount * 100) },
    { label: "Party / ledger", statement: statement.ledger || "Not selected", tally: match.partyLedgerName || match.ledgerNames?.find(name => normalize(name) !== normalize(statement.bank)) || null,
      equal: Boolean(statement.ledger && (match.ledgerNames?.some(name => normalize(name) === normalize(statement.ledger)) || normalize(match.partyLedgerName || "") === normalize(statement.ledger))) },
    { label: "Bank ledger", statement: statement.bank, tally: match.bankLedgerName || null, equal: normalize(statement.bank) === normalize(match.bankLedgerName || "") },
    { label: "Payment / receipt", statement: statement.direction === "incoming" ? "Receipt" : "Payment", tally: match.direction ? match.direction === "incoming" ? "Receipt" : "Payment" : null,
      equal: statement.direction === match.direction },
    { label: "Bank reference / UTR", statement: statement.reference || "Not recorded", tally: refs.join(", ") || null,
      equal: Boolean(statement.reference && refs.some(ref => normalize(ref) === normalize(statement.reference))) },
  ];
  return fields.map(field => ({ ...field, state: !field.tally ? "unavailable" : field.label === "Bank reference / UTR" && !statement.reference ? "unavailable" : field.equal ? "match" : "different" }));
}

export function recheckResultMessage(result: { confirmed: number; checked: number; remaining: number; checkFailed?: number }) {
  const remaining = result.remaining ? `${result.remaining} ${result.remaining === 1 ? "entry still needs" : "entries still need"} review.` : "All entries are confirmed in Tally.";
  if (!result.checked && result.remaining) return `No entries could be checked. ${remaining} Keep Tally and the connector open, then try again.`;
  if (result.checkFailed) return `${result.confirmed ? `${result.confirmed} ${result.confirmed === 1 ? "entry confirmed" : "entries confirmed"}. ` : ""}${result.checkFailed} ${result.checkFailed === 1 ? "entry couldn't" : "entries couldn't"} be checked. ${remaining} No vouchers were posted by this check.`;
  return `${result.confirmed ? `${result.confirmed} ${result.confirmed === 1 ? "entry confirmed" : "entries confirmed"} in Tally.` : result.remaining ? "No additional entries were confirmed." : "No entries needed rechecking."} ${remaining} No vouchers were posted by this check.`;
}
