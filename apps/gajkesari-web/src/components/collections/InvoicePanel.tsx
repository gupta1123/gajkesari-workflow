"use client";

import { useEffect, type ReactNode } from "react";
import "./invoice-panel.css";

export type PanelTone = "bad" | "warn" | "ok" | "quiet";
export type PanelDate = { label: string; date: string | null | undefined; note?: string; tone?: PanelTone };
export type PanelReceipt = { date: string | null; amount: number; reference?: string | null };

export type InvoicePanelProps = {
  invoice: string;
  customer: string;
  status: { label: string; tone: PanelTone };
  /** What is still to be paid, and how much of the invoice that is. */
  invoiceAmount: number | null;
  received: number | null;
  outstanding: number | null;
  /** Dates in the order they happen. */
  dates: PanelDate[];
  facts?: Array<{ label: string; value: ReactNode }>;
  narration?: string | null;
  receipts?: PanelReceipt[];
  onClose: () => void;
  children?: ReactNode;
};

const rupees = (value: number | null | undefined) =>
  value == null ? "—" : new Intl.NumberFormat("en-IN", { style: "currency", currency: "INR", maximumFractionDigits: 2 }).format(value);

const day = (value: string | null | undefined) =>
  value ? new Date(`${value.slice(0, 10)}T00:00:00`).toLocaleDateString("en-IN", { day: "2-digit", month: "short", year: "numeric" }) : "Not recorded";

/** Right-hand panel that explains one open bill: how much is paid, and when things happened. */
export function InvoicePanel({
  invoice, customer, status, invoiceAmount, received, outstanding, dates, facts, narration, receipts, onClose, children,
}: InvoicePanelProps) {
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => event.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const total = invoiceAmount ?? (received ?? 0) + (outstanding ?? 0);
  const paidShare = total > 0 && received ? Math.min(100, Math.max(0, (received / total) * 100)) : 0;
  const listed = (receipts ?? []).filter((r) => r.amount > 0);

  return (
    <>
      <div className="ip-scrim" onClick={onClose} />
      <aside className="ip" role="dialog" aria-label={`Invoice ${invoice}`}>
        <header className="ip-head">
          <div>
            <h2>{invoice}</h2>
            <p title={customer}>{customer}</p>
          </div>
          <button className="ip-x" aria-label="Close" onClick={onClose}>×</button>
        </header>

        <div className="ip-body">
          <span className={`ip-status ${status.tone}`}>{status.label}</span>

          <section className="ip-money" aria-label="Amounts">
            <div className="ip-due">
              <span>Still to pay</span>
              <b>{rupees(outstanding)}</b>
            </div>
            <div className="ip-bar" role="img" aria-label={`${Math.round(paidShare)}% of the invoice is paid`}>
              <i style={{ width: `${paidShare}%` }} />
            </div>
            <dl>
              <div><dt>Invoice amount</dt><dd>{rupees(invoiceAmount)}</dd></div>
              <div><dt>Received so far</dt><dd>{received ? rupees(received) : "Nothing yet"}</dd></div>
            </dl>
          </section>

          <section aria-label="Dates">
            <h3>Dates</h3>
            <ol className="ip-dates">
              {dates.map((entry) => (
                <li key={entry.label} className={entry.tone ?? "quiet"}>
                  <span className="ip-dot" />
                  <div>
                    <b>{entry.label}</b>
                    <span>{day(entry.date)}</span>
                    {entry.note && <em>{entry.note}</em>}
                  </div>
                </li>
              ))}
            </ol>
          </section>

          {listed.length > 0 && (
            <section aria-label="Receipts">
              <h3>Payments received</h3>
              <ul className="ip-receipts">
                {listed.map((r, index) => (
                  <li key={`${r.reference ?? ""}${r.date ?? ""}${index}`}>
                    <span>{day(r.date)}{r.reference ? <small>{r.reference}</small> : null}</span>
                    <b>{rupees(r.amount)}</b>
                  </li>
                ))}
              </ul>
            </section>
          )}

          {facts && facts.length > 0 && (
            <section aria-label="Details">
              <h3>Details</h3>
              <dl className="ip-facts">
                {facts.map((fact) => <div key={fact.label}><dt>{fact.label}</dt><dd>{fact.value}</dd></div>)}
              </dl>
            </section>
          )}

          {narration && (
            <section aria-label="Narration">
              <h3>Narration in Tally</h3>
              <blockquote>{narration}</blockquote>
            </section>
          )}
        </div>

        {children && <footer className="ip-foot">{children}</footer>}
      </aside>
    </>
  );
}
