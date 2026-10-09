"use client";

import { useState } from "react";
import { AlertTriangle, Loader2, RefreshCw, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { comparePostingVoucher, type ReviewStatement } from "@/lib/bank-posting-review";
import type { PostingMatch } from "@/lib/statement-bank-book";

type Props = {
  statement: ReviewStatement; title: string; label: string; reason: string;
  matches: Array<Partial<PostingMatch>>; confirmed: boolean; held: boolean;
  checkedAt?: string | null; checkFailed?: boolean; canRecheck: boolean; busy: boolean;
  notice?: string | null;
  ledgers: string[]; onRecheck: (ledgerName?: string) => void; onClose: () => void; onNext: () => void; hasNext: boolean;
};

export function BankPostingReview(props: Props) {
  const [editingLedger, setEditingLedger] = useState(false);
  const [ledgerName, setLedgerName] = useState(props.statement.ledger);
  const [search, setSearch] = useState("");
  const filteredLedgers = props.ledgers.filter(name => name !== props.statement.bank && name.toLowerCase().includes(search.toLowerCase()));
  return (
    <div className="fixed inset-0 z-50 flex justify-end bg-black/20">
      <button aria-label="Close Tally entry details" className="absolute inset-0 cursor-default" onClick={props.onClose} type="button" />
      <aside role="dialog" aria-modal="true" aria-label="Tally entry details" className="relative z-10 flex h-full w-full max-w-[720px] flex-col border-l border-[#ddd3c5] bg-white shadow-2xl">
        <header className="border-b border-[#e5ddd0] px-5 py-4">
          <div className="flex items-start justify-between gap-4">
            <div><p className="text-xs font-semibold text-slate-500">Tally entry details</p><h2 className="mt-1 text-lg font-bold text-[#2b241d]">{props.title}</h2></div>
            <Button autoFocus variant="ghost" size="icon" aria-label="Close" onClick={props.onClose}><X className="h-4 w-4" /></Button>
          </div>
          <p className="mt-2 text-sm text-slate-600">{props.statement.date} · {new Intl.NumberFormat("en-IN", { style: "currency", currency: "INR" }).format(props.statement.amount)}</p>
        </header>
        <div className="min-h-0 flex-1 overflow-y-auto">
          <section className={`border-b px-5 py-4 ${props.confirmed ? "border-sky-100 bg-sky-50" : "border-amber-100 bg-amber-50"}`}>
            <p className={`text-sm font-bold ${props.confirmed ? "text-sky-900" : "text-amber-900"}`}>{props.label}</p>
            <p className="mt-1 text-sm leading-6 text-[#4b4238]">{props.reason}</p>
            <p className="mt-2 text-xs text-slate-600">{props.checkedAt ? `Last recheck: ${new Date(props.checkedAt).toLocaleString("en-IN")}` : "Saved result from the last Tally check."} Opening these details does not run a new check.</p>
            {props.notice ? <p role="status" aria-live="polite" className="mt-3 rounded-lg border border-[#ddd3c5] bg-white p-3 text-sm leading-6">{props.notice}</p> : null}
          </section>
          <section className="px-5 py-4">
            <h3 className="text-sm font-bold">{props.confirmed ? "Matched Tally voucher" : "Compare with Tally"}</h3>
            {props.checkFailed ? <p className="mt-2 text-sm text-amber-800">The latest check failed. These are previously saved voucher details.</p> : null}
            {props.matches.length ? props.matches.map((match, index) => {
              const comparison = comparePostingVoucher(props.statement, match);
              return <div key={`${match.masterId || match.voucherNumber || index}`} className="mt-3 overflow-hidden rounded-lg border border-[#e5ddd0]">
                <div className="flex flex-wrap items-center justify-between gap-2 bg-[#faf8f4] px-3 py-2.5">
                  <h4 className="text-sm font-bold">{match.voucherNumber ? `Voucher ${match.voucherNumber}` : `Possible voucher ${index + 1}`}{match.voucherType ? ` · ${match.voucherType}` : ""}</h4>
                  <span className="text-xs text-slate-500">{props.confirmed ? "Confirmed in Tally" : "Possible match"}</span>
                </div>
                <table className="w-full table-fixed text-left text-xs sm:text-sm">
                  <thead><tr className="border-b border-[#e5ddd0]"><th className="w-[28%] p-3 font-semibold">Compare</th><th className="w-[36%] p-3 font-semibold">Statement</th><th className="w-[36%] p-3 font-semibold">Tally voucher</th></tr></thead>
                  <tbody>{comparison.map(field => <tr key={field.label} className={`border-b border-[#eee8df] last:border-0 ${field.state === "different" ? "bg-amber-50" : ""}`}>
                    <th className="break-words p-3 align-top font-medium text-slate-600">{field.label}{field.state === "different" ? <span className="mt-1 block text-xs font-semibold text-amber-800">Different</span> : null}</th>
                    <td className="break-words p-3 align-top">{field.statement}</td>
                    <td className={`break-words p-3 align-top ${field.state === "different" ? "font-semibold text-amber-900" : !field.tally ? "text-slate-500" : ""}`}>{field.tally || (field.label === "Bank reference / UTR" ? "Not recorded" : "Not returned by this check")}</td>
                  </tr>)}</tbody>
                </table>
                {match.reference ? <p className="border-t border-[#eee8df] px-3 py-2 text-xs text-slate-600">Voucher reference: <span className="break-all font-medium">{match.reference}</span></p> : null}
              </div>;
            }) : <div className="mt-3 rounded-lg border border-[#e5ddd0] p-4 text-sm leading-6">
              <dl className="grid gap-3 sm:grid-cols-2">
                {[["Selected ledger", props.statement.ledger || "Not selected"], ["Bank ledger", props.statement.bank], ["Bank reference / UTR", props.statement.reference || "Not recorded"], ["Payment / receipt", props.statement.direction === "incoming" ? "Receipt" : "Payment"]].map(([label, value]) => <div key={label}><dt className="text-xs text-slate-500">{label}</dt><dd className="break-words font-medium">{value}</dd></div>)}
              </dl>
              <p className="mt-4 text-slate-600">No candidate voucher details were returned. Check the bank ledger in Tally for this date, amount and reference. A missing match alone does not mean it is safe to post again.</p>
            </div>}
          </section>
          {!props.confirmed && props.canRecheck ? <section className="border-t border-[#e5ddd0] px-5 py-4">
            <h3 className="text-sm font-bold">What to do next</h3>
            <p className="mt-2 text-sm leading-6 text-slate-600">{props.held ? "Compare the voucher in Tally with this statement entry. If the selected ledger is wrong, correct it below. If Tally needs a correction, make it there, then recheck." : "Keep Tally and the connector open on this company, then recheck the voucher confirmation. This entry may already have been posted."}</p>
            <div className="mt-3 flex flex-wrap gap-2">
              <Button variant="outline" disabled={props.busy} onClick={() => props.onRecheck()}>{props.busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}Recheck this entry</Button>
              {props.held ? <Button variant="outline" disabled={props.busy} onClick={() => setEditingLedger(!editingLedger)}>Correct selected ledger</Button> : null}
            </div>
            {editingLedger ? <div className="mt-4 space-y-3 rounded-lg bg-[#faf8f4] p-3">
              <label className="block text-sm font-semibold" htmlFor="review-ledger-search">Find a ledger in this company</label>
              <input id="review-ledger-search" type="search" value={search} onChange={event => setSearch(event.target.value)} className="w-full rounded-lg border border-[#ddd3c5] bg-white px-3 py-2 text-sm" placeholder="Search ledgers" disabled={props.busy} />
              <label className="sr-only" htmlFor="review-ledger-selection">Corrected selected ledger</label>
              <select id="review-ledger-selection" value={ledgerName} onChange={event => setLedgerName(event.target.value)} className="w-full rounded-lg border border-[#ddd3c5] bg-white px-3 py-2 text-sm" disabled={props.busy}>
                <option value={props.statement.ledger}>{props.statement.ledger || "Choose a ledger"}</option>
                {filteredLedgers.filter(name => name !== props.statement.ledger).map(name => <option key={name} value={name}>{name}</option>)}
              </select>
              <p className="text-xs leading-5 text-slate-600">This changes the selected ledger for this held entry and checks Tally again. It does not edit or create a Tally voucher.</p>
              <Button disabled={props.busy || !ledgerName || ledgerName === props.statement.ledger || !props.ledgers.includes(ledgerName)} onClick={() => props.onRecheck(ledgerName)}>{props.busy ? <Loader2 className="h-4 w-4 animate-spin" /> : null}Save ledger &amp; recheck</Button>
            </div> : null}
            <p className="mt-3 flex items-start gap-2 text-xs leading-5 text-amber-800"><AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />If this is a separate transaction, verify it in Tally before posting it through your normal workflow. Recheck never posts or overrides a possible duplicate.</p>
          </section> : null}
        </div>
        <footer className="flex items-center justify-between gap-3 border-t border-[#e5ddd0] px-5 py-3">
          <span className="text-xs text-slate-500">Viewing details does not post this entry.</span>
          <Button onClick={props.hasNext ? props.onNext : props.onClose}>{props.hasNext ? "Next entry" : "Close"}</Button>
        </footer>
      </aside>
    </div>
  );
}
