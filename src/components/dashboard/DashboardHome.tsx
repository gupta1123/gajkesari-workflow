"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import {
  ArrowDownRight,
  ArrowUpRight,
  FileText,
  Database,
  Activity,
  TrendingUp,
  FolderOpen,
  Users
} from "lucide-react";

import { AppShell } from "@/components/dashboard/AppShell";
import { Skeleton } from "@/components/ui/skeleton";
import { fetchRecentCases, type SavedCaseRecord } from "@/lib/case-persistence";

type LoadState = "loading" | "ready" | "error";

function average(values: number[]) {
  if (!values.length) return 0;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function MetricValueSkeleton() {
  return <Skeleton className="h-8 w-16 rounded-lg bg-slate-200/70" />;
}

function RecentCasesSkeleton() {
  return (
    <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
      {Array.from({ length: 4 }).map((_, index) => (
        <div
          key={index}
          className="flex flex-col rounded-xl border border-[#e5ddd0] bg-white p-3.5 shadow-sm"
        >
          <div className="flex items-start justify-between gap-2">
            <div className="flex min-w-0 items-start gap-2.5">
              <Skeleton className="h-8 w-8 shrink-0 rounded-lg bg-[#f0ece6]" />
              <div className="min-w-0 space-y-2">
                <Skeleton className="h-3.5 w-36 bg-slate-100" />
                <Skeleton className="h-3 w-24 bg-slate-100" />
              </div>
            </div>
          </div>
          <div className="mt-2.5 flex flex-wrap items-center gap-1.5">
            <Skeleton className="h-5 w-16 rounded bg-slate-100" />
            <Skeleton className="h-5 w-10 rounded bg-slate-100" />
          </div>
          <div className="mt-2.5 flex items-center justify-between border-t border-slate-100 pt-2.5">
            <Skeleton className="h-3 w-24 bg-slate-100" />
            <Skeleton className="h-3 w-16 bg-slate-100" />
          </div>
        </div>
      ))}
    </div>
  );
}

export function DashboardHome() {
  const [cases, setCases] = useState<SavedCaseRecord[]>([]);
  const [status, setStatus] = useState<LoadState>("loading");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;

    fetchRecentCases(12)
      .then((payload) => {
        if (!active) return;
        setCases(payload.cases);
        setStatus("ready");
      })
      .catch((loadError) => {
        if (!active) return;
        setError(loadError instanceof Error ? loadError.message : "Failed to load dashboard cases.");
        setStatus("error");
      });

    return () => {
      active = false;
    };
  }, []);

  const metrics = useMemo(() => {
    const totalCases = cases.length;
    const totalDocuments = cases.reduce((sum, item) => sum + item.documentCount, 0);
    const totalMismatches = cases.reduce((sum, item) => sum + item.mismatchCount, 0);
    const averageRisk = Math.round(average(cases.map((item) => item.riskScore)));

    return {
      totalCases,
      totalDocuments,
      totalMismatches,
      averageRisk,
      recentList: cases.slice(0, 6),
    };
  }, [cases]);

  return (
    <AppShell>
      <div className="w-full animate-in fade-in slide-in-from-bottom-4 px-4 py-6 text-[#0f172a] duration-700 ease-out sm:px-8 sm:py-8">

        {/* HEADER SECTION */}
        <header className="mb-10 flex flex-col items-start gap-4">
          <div>
            <div className="text-sm font-medium text-[#64748b] tracking-wide mb-1">Good Afternoon,</div>
            <h1 className="text-3xl font-extrabold tracking-tight text-[#0f172a]">
              Admin
            </h1>
          </div>
        </header>

        {status === "error" && (
          <div className="mb-6 rounded-[20px] border border-red-200 bg-red-50 px-5 py-4 text-sm font-medium text-red-700">
            {error}
          </div>
        )}

        {/* OVERVIEW SECTION */}
        <section className="mb-12">
          <div className="mb-4 flex items-center justify-between px-1">
            <h2 className="text-xs font-bold uppercase tracking-widest text-[#64748b]">
              OVERVIEW
            </h2>
            <div className="text-[11px] font-medium text-[#94a3b8]">
              Excludes drafts and recycle bin items
            </div>
          </div>

          <div className="grid grid-cols-1 gap-6 sm:grid-cols-2 lg:grid-cols-4">

            {/* Card 1: Active Documents (Beige) */}
            <div className="group relative flex h-[160px] flex-col justify-between overflow-hidden rounded-[24px] bg-[#fdfaf6] p-6 transition-transform hover:-translate-y-1">
              <FileText className="absolute -bottom-6 -right-6 h-32 w-32 -rotate-12 text-[#b45309] opacity-[0.03] transition-transform group-hover:scale-110" />
              <div className="flex h-10 w-10 items-center justify-center rounded-full bg-white shadow-sm border border-[#e2e8f0]">
                <FileText className="h-5 w-5 text-[#94a3b8]" />
              </div>
              <div className="relative z-10">
                <div className="text-[10px] font-bold uppercase tracking-widest text-[#64748b]">
                  ACTIVE DOCUMENTS
                </div>
                <div className="mt-1 flex items-baseline gap-2">
                  {status === "loading" ? (
                    <MetricValueSkeleton />
                  ) : (
                    <span className="text-3xl font-extrabold text-[#0f172a] leading-none">
                      {metrics.totalDocuments}
                    </span>
                  )}
                  <ArrowUpRight className="h-4 w-4 text-[#10b981]" />
                </div>
              </div>
            </div>

            {/* Card 2: Total Cases (Rose) */}
            <div className="group relative flex h-[160px] flex-col justify-between overflow-hidden rounded-[24px] bg-[#fdf6f5] p-6 transition-transform hover:-translate-y-1">
              <Database className="absolute -bottom-6 -right-6 h-32 w-32 -rotate-12 text-[#9f1239] opacity-[0.03] transition-transform group-hover:scale-110" />
              <div className="flex h-10 w-10 items-center justify-center rounded-full bg-white shadow-sm border border-[#e2e8f0]">
                <Database className="h-5 w-5 text-[#94a3b8]" />
              </div>
              <div className="relative z-10">
                <div className="text-[10px] font-bold uppercase tracking-widest text-[#64748b]">
                  TOTAL CASES
                </div>
                <div className="mt-1 flex items-baseline gap-2">
                  {status === "loading" ? (
                    <MetricValueSkeleton />
                  ) : (
                    <span className="text-3xl font-extrabold text-[#0f172a] leading-none">
                      {metrics.totalCases}
                    </span>
                  )}
                </div>
              </div>
            </div>

            {/* Card 3: Mismatches (Lavender) */}
            <div className="group relative flex h-[160px] flex-col justify-between overflow-hidden rounded-[24px] bg-[#f4f5f9] p-6 transition-transform hover:-translate-y-1">
              <Activity className="absolute -bottom-6 -right-6 h-32 w-32 -rotate-12 text-[#4338ca] opacity-[0.03] transition-transform group-hover:scale-110" />
              <div className="flex h-10 w-10 items-center justify-center rounded-full bg-white shadow-sm border border-[#e2e8f0]">
                <Activity className="h-5 w-5 text-[#94a3b8]" />
              </div>
              <div className="relative z-10">
                <div className="text-[10px] font-bold uppercase tracking-widest text-[#64748b]">
                  MISMATCHES
                </div>
                <div className="mt-1 flex items-baseline gap-2">
                  {status === "loading" ? (
                    <MetricValueSkeleton />
                  ) : (
                    <span className="text-3xl font-extrabold text-[#0f172a] leading-none">
                      {metrics.totalMismatches}
                    </span>
                  )}
                </div>
              </div>
            </div>

            {/* Card 4: Average Risk (Mint) */}
            <div className="group relative flex h-[160px] flex-col justify-between overflow-hidden rounded-[24px] bg-[#f1fae5] p-6 transition-transform hover:-translate-y-1">
              <TrendingUp className="absolute -bottom-6 -right-6 h-32 w-32 -rotate-12 text-[#065f46] opacity-[0.03] transition-transform group-hover:scale-110" />
              <div className="flex h-10 w-10 items-center justify-center rounded-full bg-white shadow-sm border border-[#e2e8f0]">
                <TrendingUp className="h-5 w-5 text-[#94a3b8]" />
              </div>
              <div className="relative z-10">
                <div className="text-[10px] font-bold uppercase tracking-widest text-[#64748b]">
                  AVERAGE RISK
                </div>
                <div className="mt-1 flex items-baseline gap-2">
                  {status === "loading" ? (
                    <MetricValueSkeleton />
                  ) : (
                    <span className="text-3xl font-extrabold text-[#0f172a] leading-none">
                      {metrics.averageRisk}
                    </span>
                  )}
                  <ArrowUpRight className="h-4 w-4 text-[#10b981]" />
                </div>
              </div>
            </div>

          </div>
        </section>

        {/* RECENT CASES SECTION */}
        <section>
          <div className="mb-4 flex items-center justify-between px-1">
            <h2 className="text-xs font-bold uppercase tracking-widest text-[#64748b]">
              RECENT CASES
            </h2>
            <div className="rounded-full bg-[#f1f5f9] px-3 py-1 text-[11px] font-bold text-[#64748b]">
              {status === "ready" ? `${metrics.recentList.length} UNITS` : <Skeleton className="h-3 w-12 bg-slate-200/70" />}
            </div>
          </div>

          {status === "loading" ? (
            <RecentCasesSkeleton />
          ) : status === "ready" && metrics.recentList.length === 0 ? (
            <div className="flex h-[300px] flex-col items-center justify-center rounded-[24px] border border-dashed border-[#e2e8f0] bg-white">
              <FolderOpen className="mb-3 h-8 w-8 text-[#cbd5e1]" />
              <p className="text-sm font-medium text-[#64748b]">No cases processed yet.</p>
            </div>
          ) : (
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
              {metrics.recentList.map((item) => (
                <Link
                  href={`/cases/${item.id}`}
                  key={item.id}
                  className="group flex flex-col rounded-xl border border-[#e5ddd0] bg-white p-3.5 shadow-sm transition-all hover:-translate-y-px hover:border-[#d4c9b8] hover:shadow-md"
                >
                  <div className="flex items-start justify-between gap-2">
                    <div className="flex min-w-0 items-start gap-2.5">
                      <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border border-[#e5ddd0] bg-[#f0ece6] text-[#5a5046]">
                        <Users className="h-4 w-4" />
                      </div>
                      <div className="min-w-0">
                        <div className="truncate text-sm font-bold text-[#1a1a1a] group-hover:text-[#5a5046] transition-colors" title={item.displayName}>
                          {item.displayName}
                        </div>
                        <div className="mt-0.5 truncate text-[11px] font-medium text-slate-400">
                          {item.receiverName || "Receiver pending"}
                        </div>
                      </div>
                    </div>
                  </div>

                  <div className="mt-2.5 flex flex-wrap items-center gap-1.5">
                    <span className="rounded border border-emerald-100 bg-emerald-50 px-1.5 py-0.5 text-[9px] font-bold uppercase tracking-wider text-emerald-700">
                      Completed
                    </span>
                    <span className="rounded border border-amber-100 bg-amber-50 px-1.5 py-0.5 text-[9px] font-bold uppercase tracking-wider text-amber-700">
                      R:{item.riskScore}
                    </span>
                  </div>

                  <div className="mt-2.5 flex items-center justify-between border-t border-slate-100 pt-2.5 text-[11px] font-semibold text-slate-400">
                    <span>{item.documentCount} docs · {item.mismatchCount} issues</span>
                    <ArrowUpRight className="h-3 w-3 text-slate-300" />
                  </div>
                </Link>
              ))}
            </div>
          )}
        </section>

      </div>
    </AppShell>
  );
}
