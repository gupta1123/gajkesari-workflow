"use client";

import type { RefObject } from "react";
import { Filter, Search, X } from "lucide-react";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";

export type ReviewWorkStatusFilter = "all" | "needs_action" | "ready" | "completed";
export type ReviewTallyResultFilter = "all" | "pending" | "found" | "missing" | "review" | "failed";
export type ReviewLedgerFilter = "all" | "needs_action" | "automatic" | "manual" | "suspense";
export type ReviewAllocationFilter = "all" | "needs_action" | "ready" | "completed" | "not_applicable";
type Direction = "all" | "debit" | "credit";

type Props = {
  total: number;
  visible: number;
  counts: { ready: number; completed: number; needsAction: number };
  checkAttempted: boolean;
  checkMessage: string;
  hasPayments: boolean;
  hasReceipts: boolean;
  hasReceiptAllocations: boolean;
  open: boolean;
  onOpenChange: (value: boolean) => void;
  search: string;
  onSearchChange: (value: string) => void;
  searchRef: RefObject<HTMLInputElement | null>;
  periodRef: RefObject<HTMLInputElement | null>;
  workStatus: ReviewWorkStatusFilter;
  onWorkStatusChange: (value: ReviewWorkStatusFilter) => void;
  tallyStatus: ReviewTallyResultFilter;
  onTallyStatusChange: (value: ReviewTallyResultFilter) => void;
  ledger: ReviewLedgerFilter;
  onLedgerChange: (value: ReviewLedgerFilter) => void;
  direction: Direction;
  onDirectionChange: (value: Direction) => void;
  allocation: ReviewAllocationFilter;
  onAllocationChange: (value: ReviewAllocationFilter) => void;
  from: string;
  to: string;
  onFromChange: (value: string) => void;
  onToChange: (value: string) => void;
};

const tallyLabels = {
  all: "All check results", pending: "Check pending", found: "Found in Tally",
  missing: "Not found in Tally", review: "Possible duplicates", failed: "Could not check",
};
const ledgerLabels = {
  all: "All ledger selections", needs_action: "Needs ledger review", automatic: "Automatically selected",
  manual: "Manually confirmed", suspense: "Suspense / no match",
};
const allocationLabels = {
  all: "All allocations", needs_action: "Needs allocation review", ready: "Allocation ready",
  completed: "Allocation completed", not_applicable: "Not applicable",
};

export function BankStatementReviewToolbar(p: Props) {
  const chips = [
    ...(p.tallyStatus !== "all" ? [{ text: tallyLabels[p.tallyStatus], clear: () => p.onTallyStatusChange("all") }] : []),
    ...(p.ledger !== "all" ? [{ text: ledgerLabels[p.ledger], clear: () => p.onLedgerChange("all") }] : []),
    ...(p.direction !== "all" ? [{ text: p.direction === "debit" ? "Payments" : "Receipts", clear: () => p.onDirectionChange("all") }] : []),
    ...(p.checkAttempted && p.allocation !== "all" ? [{ text: allocationLabels[p.allocation], clear: () => p.onAllocationChange("all") }] : []),
    ...(p.from || p.to ? [{ text: `${p.from || "Start"} to ${p.to || "End"}`, clear: () => { p.onFromChange(""); p.onToChange(""); } }] : []),
  ];
  const hasFilters = chips.length > 0 || Boolean(p.search.trim()) || p.workStatus !== "all";
  const clearAll = () => {
    p.onSearchChange(""); p.onWorkStatusChange("all"); p.onTallyStatusChange("all");
    p.onLedgerChange("all"); p.onDirectionChange("all"); p.onAllocationChange("all");
    p.onFromChange(""); p.onToChange("");
  };
  const statuses: { value: ReviewWorkStatusFilter; label: string; count: number }[] = [
    { value: "all", label: "All", count: p.total },
    { value: "needs_action", label: "Needs review", count: p.counts.needsAction },
    { value: "ready", label: p.checkAttempted ? "Ready to post" : "Prepared", count: p.counts.ready },
    { value: "completed", label: "In Tally", count: p.counts.completed },
  ];
  const inputClass = "mt-1 h-9 w-full min-w-0 rounded-lg border border-[#ddd3c5] bg-white px-2.5 text-xs font-semibold text-[#2b241d] outline-none focus-visible:ring-2 focus-visible:ring-amber-400";

  return (
    <div className="border-b border-[#e5ddd0] px-3 py-2.5 sm:px-4" data-review-toolbar>
      <div className="flex flex-wrap items-center gap-2">
        <label className="relative min-w-0 flex-[1_1_200px] sm:max-w-[260px]">
          <span className="sr-only">Search transactions</span>
          <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-slate-500" />
          <input className="h-9 w-full rounded-lg border border-[#ddd3c5] bg-white pl-8 pr-8 text-xs text-[#2b241d] outline-none placeholder:text-slate-500 focus-visible:ring-2 focus-visible:ring-amber-400"
            onChange={e => p.onSearchChange(e.target.value)} placeholder="Party, reference or amount" ref={p.searchRef} value={p.search} />
          {p.search ? <button aria-label="Clear search" className="absolute right-0 top-0 flex h-9 w-8 items-center justify-center rounded-lg text-slate-500 focus-visible:ring-2 focus-visible:ring-amber-400" onClick={() => p.onSearchChange("")} type="button"><X className="h-3.5 w-3.5" /></button> : null}
        </label>
        <div aria-label="Transaction status" className="flex flex-wrap items-center gap-1">
          {statuses.filter(s => s.value === "all" || s.count > 0 || s.value === p.workStatus).map(s => (
            <button key={s.value} aria-pressed={p.workStatus === s.value} type="button" onClick={() => p.onWorkStatusChange(s.value)}
              className={`inline-flex min-h-9 items-center gap-1.5 rounded-lg border px-2.5 text-xs font-semibold transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-400 ${p.workStatus === s.value ? "border-[#2d2d2d] bg-[#2d2d2d] text-white" : "border-transparent text-[#5a5046] hover:border-[#ddd3c5] hover:bg-[#faf8f4]"}`}>
              {s.label}<span className="tabular-nums opacity-75">{s.count}</span>
            </button>
          ))}
        </div>
        <Popover open={p.open} onOpenChange={p.onOpenChange}>
          <PopoverTrigger asChild>
            <button type="button" className={`inline-flex h-9 items-center gap-1.5 rounded-lg border px-3 text-xs font-semibold focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-400 ${p.open || chips.length ? "border-amber-300 bg-amber-50 text-amber-900" : "border-[#ddd3c5] bg-white text-[#5a5046] hover:bg-[#faf8f4]"}`}>
              <Filter className="h-3.5 w-3.5" />More filters{chips.length ? ` (${chips.length})` : ""}
            </button>
          </PopoverTrigger>
          <PopoverContent align="end" aria-label="More transaction filters" className="max-h-[min(70vh,540px)] w-[min(440px,calc(100vw-24px))] overflow-y-auto rounded-xl border-[#ddd3c5] bg-[#faf8f4] p-4 shadow-xl"
            onOpenAutoFocus={e => { e.preventDefault(); p.periodRef.current?.focus(); }}>
            <div className="mb-3 flex items-center justify-between">
              <span className="text-sm font-bold text-[#2b241d]">More filters</span>
              <button aria-label="Close filters" type="button" onClick={() => p.onOpenChange(false)} className="flex h-8 w-8 items-center justify-center rounded-md text-[#5a5046] hover:bg-[#efe7dc] focus-visible:ring-2 focus-visible:ring-amber-400"><X className="h-4 w-4" /></button>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <label className="min-w-0 text-xs font-semibold text-[#5a5046]">From date<input type="date" className={inputClass} ref={p.periodRef} max={p.to || undefined} value={p.from} onChange={e => p.onFromChange(e.target.value)} /></label>
              <label className="min-w-0 text-xs font-semibold text-[#5a5046]">To date<input type="date" className={inputClass} min={p.from || undefined} value={p.to} onChange={e => p.onToChange(e.target.value)} /></label>
              <label className="col-span-2 text-xs font-semibold text-[#5a5046]">Ledger selection<select className={inputClass} value={p.ledger} onChange={e => p.onLedgerChange(e.target.value as ReviewLedgerFilter)}>{Object.entries(ledgerLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
              <label className="col-span-2 text-xs font-semibold text-[#5a5046]">Tally check result<select className={inputClass} value={p.tallyStatus} onChange={e => p.onTallyStatusChange(e.target.value as ReviewTallyResultFilter)}>{Object.entries(tallyLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
              {(p.hasPayments && p.hasReceipts) || p.direction !== "all" ? <label className="col-span-2 text-xs font-semibold text-[#5a5046]">Payments or receipts<select className={inputClass} value={p.direction} onChange={e => p.onDirectionChange(e.target.value as Direction)}><option value="all">Payments + receipts</option><option value="debit">Payments only</option><option value="credit">Receipts only</option></select></label> : null}
              {p.checkAttempted && (p.hasReceiptAllocations || p.allocation !== "all") ? <label className="col-span-2 text-xs font-semibold text-[#5a5046]">Receipt bill allocation<select className={inputClass} value={p.allocation} onChange={e => p.onAllocationChange(e.target.value as ReviewAllocationFilter)}>{Object.entries(allocationLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label> : null}
            </div>
            <div className="mt-4 flex items-center justify-between gap-2">
              <button type="button" disabled={!hasFilters} onClick={clearAll} className="h-9 rounded-lg px-2 text-xs font-semibold text-[#5a5046] hover:bg-[#efe7dc] focus-visible:ring-2 focus-visible:ring-amber-400 disabled:opacity-40">Clear all filters</button>
              <button type="button" onClick={() => p.onOpenChange(false)} className="h-9 rounded-lg bg-[#2d2d2d] px-3 text-xs font-semibold text-white hover:bg-[#1a1a1a] focus-visible:ring-2 focus-visible:ring-amber-400">Show {p.visible} {p.visible === 1 ? "entry" : "entries"}</button>
            </div>
          </PopoverContent>
        </Popover>
        <span className="ml-auto text-[11px] font-medium text-slate-600" role="status">{p.checkMessage}</span>
      </div>
      {chips.length > 0 || hasFilters ? <div className="mt-2 flex flex-wrap items-center gap-1.5 text-[11px] text-slate-600">
        <span>{p.visible} of {p.total} entries</span>
        {chips.map(chip => <button key={chip.text} type="button" onClick={chip.clear} aria-label={`Remove filter: ${chip.text}`} className="inline-flex min-h-7 max-w-full items-center gap-1 rounded-md bg-[#efe7dc] px-2 text-[#5a5046] focus-visible:ring-2 focus-visible:ring-amber-400"><span className="truncate">{chip.text}</span><X className="h-3 w-3 shrink-0" /></button>)}
        <button type="button" onClick={clearAll} className="min-h-7 rounded px-2 font-semibold underline underline-offset-2 focus-visible:ring-2 focus-visible:ring-amber-400">Clear all</button>
      </div> : null}
    </div>
  );
}
