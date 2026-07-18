"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import {
  FileText,
  Database,
  Activity,
  TrendingUp,
  FolderOpen,
  Users,
  Plus,
  ArrowUpRight,
  Clock,
  Building2,
  AlertTriangle,
  ChevronRight,
  Layers,
  Sparkles
} from "lucide-react";

import { AppShell } from "@/components/dashboard/AppShell";
import { Skeleton } from "@/components/ui/skeleton";
import { fetchRecentCases, type SavedCaseRecord } from "@/lib/case-persistence";

type LoadState = "loading" | "ready" | "error";

function average(values: number[]) {
  if (!values.length) return 0;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function formatDate(dateStr: string) {
  try {
    const d = new Date(dateStr);
    if (isNaN(d.getTime())) return dateStr;
    return d.toLocaleDateString("en-US", {
      month: "short",
      day: "numeric",
      year: "numeric",
    });
  } catch {
    return dateStr;
  }
}

function getRelativeTime(dateStr: string) {
  try {
    const d = new Date(dateStr);
    const now = new Date();
    const diffMs = now.getTime() - d.getTime();
    if (isNaN(diffMs) || diffMs < 0) return formatDate(dateStr);
    
    const diffMins = Math.floor(diffMs / 60000);
    if (diffMins < 1) return "Just now";
    if (diffMins < 60) return `${diffMins}m ago`;
    
    const diffHours = Math.floor(diffMins / 60);
    if (diffHours < 24) return `${diffHours}h ago`;
    
    const diffDays = Math.floor(diffHours / 24);
    if (diffDays === 1) return "Yesterday";
    if (diffDays < 7) return `${diffDays}d ago`;
    
    return formatDate(dateStr);
  } catch {
    return formatDate(dateStr);
  }
}

function getRiskColor(risk: number) {
  if (risk < 30) return "#10b981"; // Emerald / Low Risk
  if (risk < 70) return "#f59e0b"; // Amber / Med Risk
  return "#f43f5e"; // Rose / High Risk
}

function getStatusConfig(status: string) {
  const s = status?.toLowerCase() || "";
  if (s.includes("complete") || s === "success" || s === "ready") {
    return {
      bg: "bg-emerald-50 text-emerald-700 border-emerald-200/50",
      dot: "bg-emerald-500",
      label: "Completed",
    };
  }
  if (s.includes("review") || s === "in_review") {
    return {
      bg: "bg-sky-50 text-sky-700 border-sky-200/50",
      dot: "bg-sky-500",
      label: "In Review",
    };
  }
  if (s.includes("fail") || s === "failed" || s === "error") {
    return {
      bg: "bg-rose-50 text-rose-700 border-rose-200/50",
      dot: "bg-rose-500",
      label: "Failed",
    };
  }
  if (s.includes("draft")) {
    return {
      bg: "bg-slate-50 text-slate-600 border-slate-200/50",
      dot: "bg-slate-400",
      label: "Draft",
    };
  }
  return {
    bg: "bg-amber-50 text-amber-700 border-amber-200/50",
    dot: "bg-amber-500",
    label: "Pending",
  };
}

function Sparkline({ data, color }: { data: number[]; color: string }) {
  const points = useMemo(() => {
    if (!data || data.length <= 1) return "";
    const max = Math.max(...data, 1);
    const min = Math.min(...data, 0);
    const range = max - min || 1;
    
    const width = 120;
    const height = 36;
    const padding = 2;
    
    return data.map((val, idx) => {
      const x = (idx / (data.length - 1)) * (width - padding * 2) + padding;
      const y = height - ((val - min) / range) * (height - padding * 2) - padding;
      return `${x},${y}`;
    }).join(" ");
  }, [data]);

  if (!points) return <div className="h-9 w-[120px] border-b border-dashed border-slate-200" />;

  return (
    <svg width="120" height="36" className="overflow-visible opacity-80">
      <polyline
        fill="none"
        stroke={color}
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
        points={points}
      />
    </svg>
  );
}

function RadialProgress({ value, color }: { value: number; color: string }) {
  const radius = 22;
  const circumference = 2 * Math.PI * radius;
  const strokeDashoffset = circumference - (Math.min(value, 100) / 100) * circumference;
  
  return (
    <div className="relative flex items-center justify-center shrink-0">
      <svg className="w-14 h-14 transform -rotate-90">
        <circle
          className="text-slate-100 dark:text-slate-800"
          strokeWidth="3.5"
          stroke="currentColor"
          fill="transparent"
          r={radius}
          cx="28"
          cy="28"
        />
        <circle
          className="transition-all duration-700 ease-out"
          strokeWidth="3.5"
          strokeDasharray={circumference}
          strokeDashoffset={strokeDashoffset}
          strokeLinecap="round"
          stroke={color}
          fill="transparent"
          r={radius}
          cx="28"
          cy="28"
        />
      </svg>
      <span className="absolute text-[11px] font-extrabold text-[#1a1a1a]">{value}%</span>
    </div>
  );
}

function VolumeChart({ cases }: { cases: SavedCaseRecord[] }) {
  const volumeData = useMemo(() => {
    const days: Array<{
      date: Date;
      label: string;
      localString: string;
      count: number;
    }> = [];
    const now = new Date();
    
    for (let i = 14; i >= 0; i--) {
      const d = new Date(now);
      d.setDate(now.getDate() - i);
      days.push({
        date: d,
        label: d.toLocaleDateString("en-US", { month: "short", day: "numeric" }),
        localString: `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`,
        count: 0
      });
    }

    cases.forEach((c) => {
      if (!c.createdAt) return;
      try {
        const cDate = new Date(c.createdAt);
        const cLocalString = `${cDate.getFullYear()}-${String(cDate.getMonth() + 1).padStart(2, "0")}-${String(cDate.getDate()).padStart(2, "0")}`;
        const match = days.find((d) => d.localString === cLocalString);
        if (match) {
          match.count++;
        }
      } catch (e) {
        console.error(e);
      }
    });

    return days;
  }, [cases]);

  const maxCount = useMemo(() => {
    return Math.max(...volumeData.map((d) => d.count), 4);
  }, [volumeData]);

  const width = 800;
  const height = 180;
  const paddingLeft = 32;
  const paddingRight = 16;
  const paddingTop = 20;
  const paddingBottom = 30;

  const chartWidth = width - paddingLeft - paddingRight;
  const chartHeight = height - paddingTop - paddingBottom;

  const barWidth = 24;
  const gap = (chartWidth - barWidth * 15) / 14;

  return (
    <div className="w-full overflow-x-auto">
      <div className="min-w-[700px] h-[180px] relative">
        <svg viewBox={`0 0 ${width} ${height}`} width="100%" height="100%" className="overflow-visible">
          <defs>
            <linearGradient id="volume-bar-grad" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="#d97706" />
              <stop offset="100%" stopColor="#f59e0b" />
            </linearGradient>
          </defs>

          {/* Y Axis grid lines */}
          {Array.from({ length: 5 }).map((_, i) => {
            const val = Math.round((i / 4) * maxCount);
            const y = paddingTop + chartHeight - (val / maxCount) * chartHeight;
            return (
              <g key={i}>
                <line
                  x1={paddingLeft}
                  y1={y}
                  x2={width - paddingRight}
                  y2={y}
                  stroke="#f1f5f9"
                  strokeWidth="1"
                />
                <text
                  x={paddingLeft - 8}
                  y={y + 3}
                  fill="#94a3b8"
                  fontSize="9"
                  fontWeight="700"
                  textAnchor="end"
                >
                  {val}
                </text>
              </g>
            );
          })}

          {/* Draw bars */}
          {volumeData.map((day, i) => {
            const x = paddingLeft + i * (barWidth + gap);
            const barHeight = (day.count / maxCount) * chartHeight;
            const y = paddingTop + chartHeight - barHeight;
            
            return (
              <g key={day.localString} className="group cursor-pointer">
                {/* Background light hover area */}
                <rect
                  x={x - gap / 4}
                  y={paddingTop}
                  width={barWidth + gap / 2}
                  height={chartHeight}
                  fill="transparent"
                  className="hover:fill-slate-50/50 transition-colors"
                />

                {/* Main Bar */}
                {day.count > 0 ? (
                  <rect
                    x={x}
                    y={y}
                    width={barWidth}
                    height={barHeight}
                    rx="4"
                    fill="url(#volume-bar-grad)"
                    className="transition-all duration-300 hover:brightness-105"
                  />
                ) : (
                  // Tiny indicator for 0-count day
                  <rect
                    x={x}
                    y={paddingTop + chartHeight - 2}
                    width={barWidth}
                    height="2"
                    rx="1"
                    fill="#e2e8f0"
                  />
                )}

                {/* Count label above bar */}
                {day.count > 0 && (
                  <text
                    x={x + barWidth / 2}
                    y={y - 6}
                    fill="#1a1a1a"
                    fontSize="10"
                    fontWeight="800"
                    textAnchor="middle"
                  >
                    {day.count}
                  </text>
                )}

                {/* X Axis Label */}
                <text
                  x={x + barWidth / 2}
                  y={height - 8}
                  fill="#64748b"
                  fontSize="9"
                  fontWeight="600"
                  textAnchor="middle"
                >
                  {day.label}
                </text>
                
                <title>{`${day.label}: ${day.count} case${day.count === 1 ? "" : "s"}`}</title>
              </g>
            );
          })}
        </svg>
      </div>
    </div>
  );
}

function MetricValueSkeleton() {
  return <Skeleton className="h-9 w-16 rounded-lg bg-slate-200/60" />;
}

function RecentCasesSkeleton() {
  return (
    <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
      {Array.from({ length: 4 }).map((_, index) => (
        <div
          key={index}
          className="flex flex-col rounded-2xl border border-[#e5ddd0] bg-white p-4 shadow-sm"
        >
          <div className="flex items-start justify-between gap-3">
            <Skeleton className="h-8 w-8 shrink-0 rounded-xl bg-[#f0ece6]" />
            <div className="flex-1 space-y-2">
              <Skeleton className="h-4 w-32 bg-slate-100" />
              <Skeleton className="h-3 w-20 bg-slate-100" />
            </div>
          </div>
          <div className="mt-4 flex flex-wrap gap-1.5">
            <Skeleton className="h-5 w-16 rounded bg-slate-100" />
            <Skeleton className="h-5 w-12 rounded bg-slate-100" />
          </div>
          <div className="mt-4 border-t border-slate-100 pt-3">
            <Skeleton className="h-3.5 w-full bg-slate-100" />
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
  const [greeting, setGreeting] = useState("Hello");

  useEffect(() => {
    const hours = new Date().getHours();
    if (hours < 12) setGreeting("Good Morning");
    else if (hours < 17) setGreeting("Good Afternoon");
    else setGreeting("Good Evening");
  }, []);

  useEffect(() => {
    let active = true;

    fetchRecentCases(100)
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
    // 1. Generate local date strings for the last 15 days
    const days: Array<{
      localString: string;
      caseCount: number;
      docCount: number;
      issueCount: number;
    }> = [];
    const now = new Date();
    for (let i = 14; i >= 0; i--) {
      const d = new Date(now);
      d.setDate(now.getDate() - i);
      days.push({
        localString: `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`,
        caseCount: 0,
        docCount: 0,
        issueCount: 0,
      });
    }

    // 2. Count volumes daily from the cases array
    cases.forEach((c) => {
      if (!c.createdAt) return;
      try {
        const cDate = new Date(c.createdAt);
        const cLocalString = `${cDate.getFullYear()}-${String(cDate.getMonth() + 1).padStart(2, "0")}-${String(cDate.getDate()).padStart(2, "0")}`;
        const match = days.find((d) => d.localString === cLocalString);
        if (match) {
          match.caseCount++;
          match.docCount += c.documentCount;
          match.issueCount += c.mismatchCount;
        }
      } catch (e) {
        console.error(e);
      }
    });

    const docHistory = days.map((d) => d.docCount);
    const caseHistory = days.map((d) => d.caseCount);
    const issueHistory = days.map((d) => d.issueCount);

    const totalCases = cases.length;
    const totalDocuments = cases.reduce((sum, item) => sum + item.documentCount, 0);
    const totalMismatches = cases.reduce((sum, item) => sum + item.mismatchCount, 0);
    const averageRisk = Math.round(average(cases.map((item) => item.riskScore)));

    return {
      totalCases,
      totalDocuments,
      totalMismatches,
      averageRisk,
      recentList: cases.slice(0, 8),
      docHistory,
      caseHistory,
      issueHistory
    };
  }, [cases]);

  return (
    <AppShell>
      <div className="w-full animate-in fade-in slide-in-from-bottom-4 px-4 py-8 text-[#1a1a1a] duration-500 ease-out sm:px-8 sm:py-10">
        
        {/* HEADER SECTION */}
        <header className="mb-8 flex flex-col md:flex-row md:items-center justify-between gap-6 border-b border-[#e5ddd0] pb-6">
          <div>
            <div className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full bg-amber-50 border border-amber-200/50 text-[10px] font-bold uppercase tracking-wider text-amber-800">
              <Sparkles className="h-3 w-3 text-amber-600 animate-spin duration-3000" />
              Dealer Analytics Dashboard
            </div>
            <h1 className="text-3xl font-black tracking-tight text-[#1a1a1a] mt-2 flex items-center gap-2">
              {greeting}, Admin <span className="text-2xl">👋</span>
            </h1>
            <p className="text-xs font-semibold text-slate-500 mt-1">
              Analyze document health, audit discrepancies, and monitor validation issues across your active cases.
            </p>
          </div>

          <div className="flex items-center gap-3">
            <Link
              href="/workspace"
              className="inline-flex items-center gap-2 px-4 py-2.5 bg-[#2d2d2d] hover:bg-[#1a1a1a] text-white text-sm font-semibold rounded-xl transition-all shadow-sm hover:shadow-md active:scale-95"
            >
              <Plus className="h-4 w-4" />
              Upload & Compare
            </Link>
          </div>
        </header>

        {status === "error" && (
          <div className="mb-6 rounded-2xl border border-rose-200 bg-rose-50 px-5 py-4 text-sm font-semibold text-rose-700 flex items-center gap-3">
            <AlertTriangle className="h-5 w-5 text-rose-500 shrink-0" />
            <div>{error}</div>
          </div>
        )}

        {/* OVERVIEW METRICS SECTION */}
        <section className="mb-8">
          <div className="mb-4 flex items-center justify-between px-1">
            <h2 className="text-[11px] font-bold uppercase tracking-wider text-slate-400">
              Workflow Diagnostics
            </h2>
            <div className="text-[10px] font-bold text-slate-400 bg-slate-100 border border-slate-200/40 px-2 py-0.5 rounded-full">
              Realtime Database Metrics
            </div>
          </div>

          <div className="grid grid-cols-1 gap-5 sm:grid-cols-2 lg:grid-cols-4">
            
            {/* Metric 1: Total Documents */}
            <div className="group relative flex flex-col justify-between overflow-hidden rounded-2xl border border-[#e5ddd0] bg-white p-5 shadow-[0_2px_8px_rgba(0,0,0,0.02)] transition-all duration-300 hover:-translate-y-1 hover:shadow-[0_8px_20px_rgba(0,0,0,0.05)]">
              <div className="flex items-start justify-between">
                <div className="flex h-9 w-9 items-center justify-center rounded-xl bg-amber-50 border border-amber-100/50">
                  <FileText className="h-4.5 w-4.5 text-amber-700" />
                </div>
                {status === "ready" && (
                  <Sparkline data={metrics.docHistory} color="#d97706" />
                )}
              </div>
              <div className="mt-4">
                <div className="text-[9px] font-bold uppercase tracking-widest text-slate-400">
                  Active Documents
                </div>
                <div className="mt-1 flex items-baseline gap-2">
                  {status === "loading" ? (
                    <MetricValueSkeleton />
                  ) : (
                    <span className="text-3xl font-extrabold text-[#1a1a1a] leading-none">
                      {metrics.totalDocuments}
                    </span>
                  )}
                  <span className="text-[10px] font-bold text-emerald-600 bg-emerald-50 px-1.5 py-0.5 rounded border border-emerald-100">
                    Live
                  </span>
                </div>
              </div>
            </div>

            {/* Metric 2: Total Cases */}
            <div className="group relative flex flex-col justify-between overflow-hidden rounded-2xl border border-[#e5ddd0] bg-white p-5 shadow-[0_2px_8px_rgba(0,0,0,0.02)] transition-all duration-300 hover:-translate-y-1 hover:shadow-[0_8px_20px_rgba(0,0,0,0.05)]">
              <div className="flex items-start justify-between">
                <div className="flex h-9 w-9 items-center justify-center rounded-xl bg-[#f4f5f9] border border-indigo-100/50">
                  <Database className="h-4.5 w-4.5 text-indigo-700" />
                </div>
                {status === "ready" && (
                  <Sparkline data={metrics.caseHistory} color="#6366f1" />
                )}
              </div>
              <div className="mt-4">
                <div className="text-[9px] font-bold uppercase tracking-widest text-slate-400">
                  Total Active Cases
                </div>
                <div className="mt-1 flex items-baseline gap-2">
                  {status === "loading" ? (
                    <MetricValueSkeleton />
                  ) : (
                    <span className="text-3xl font-extrabold text-[#1a1a1a] leading-none">
                      {metrics.totalCases}
                    </span>
                  )}
                </div>
              </div>
            </div>

            {/* Metric 3: Mismatches */}
            <div className="group relative flex flex-col justify-between overflow-hidden rounded-2xl border border-[#e5ddd0] bg-white p-5 shadow-[0_2px_8px_rgba(0,0,0,0.02)] transition-all duration-300 hover:-translate-y-1 hover:shadow-[0_8px_20px_rgba(0,0,0,0.05)]">
              <div className="flex items-start justify-between">
                <div className="flex h-9 w-9 items-center justify-center rounded-xl bg-rose-50 border border-rose-100/50">
                  <Activity className="h-4.5 w-4.5 text-rose-700" />
                </div>
                {status === "ready" && (
                  <Sparkline data={metrics.issueHistory} color="#f43f5e" />
                )}
              </div>
              <div className="mt-4">
                <div className="text-[9px] font-bold uppercase tracking-widest text-slate-400">
                  Discovered Issues
                </div>
                <div className="mt-1 flex items-baseline gap-2">
                  {status === "loading" ? (
                    <MetricValueSkeleton />
                  ) : (
                    <span className="text-3xl font-extrabold text-rose-600 leading-none">
                      {metrics.totalMismatches}
                    </span>
                  )}
                  {metrics.totalMismatches > 0 && (
                    <span className="text-[10px] font-bold text-rose-600 bg-rose-50 px-1.5 py-0.5 rounded border border-rose-100">
                      Audit
                    </span>
                  )}
                </div>
              </div>
            </div>

            {/* Metric 4: Average Risk */}
            <div className="group relative flex flex-col justify-between overflow-hidden rounded-2xl border border-[#e5ddd0] bg-white p-5 shadow-[0_2px_8px_rgba(0,0,0,0.02)] transition-all duration-300 hover:-translate-y-1 hover:shadow-[0_8px_20px_rgba(0,0,0,0.05)]">
              <div className="flex items-start justify-between">
                <div className="flex h-9 w-9 items-center justify-center rounded-xl bg-emerald-50 border border-emerald-100/50">
                  <TrendingUp className="h-4.5 w-4.5 text-emerald-700" />
                </div>
                {status === "ready" && (
                  <RadialProgress value={metrics.averageRisk} color={getRiskColor(metrics.averageRisk)} />
                )}
              </div>
              <div className="mt-4">
                <div className="text-[9px] font-bold uppercase tracking-widest text-slate-400">
                  Average Risk Index
                </div>
                <div className="mt-1 flex items-baseline gap-2">
                  {status === "loading" ? (
                    <MetricValueSkeleton />
                  ) : (
                    <span className="text-3xl font-extrabold text-[#1a1a1a] leading-none">
                      {metrics.averageRisk}%
                    </span>
                  )}
                </div>
              </div>
            </div>

          </div>
        </section>

        {/* CASE VOLUME (LAST 15 DAYS) */}
        {status === "ready" && (
          <section className="mb-10">
            <div className="rounded-2xl border border-[#e5ddd0] bg-white p-5 shadow-[0_2px_8px_rgba(0,0,0,0.02)]">
              <div className="mb-6 flex flex-col sm:flex-row sm:items-center justify-between gap-4">
                <div>
                  <h3 className="text-xs font-extrabold uppercase tracking-wider text-[#1a1a1a]">
                    Case Volume by Day (Last 15 Days)
                  </h3>
                  <p className="text-[10px] font-bold text-slate-400 mt-0.5">
                    Daily breakdown of validation workflows processed in the system
                  </p>
                </div>
                <div className="flex items-center gap-3">
                  <span className="text-[10px] font-bold text-emerald-700 bg-emerald-50 px-2.5 py-1 rounded-full border border-emerald-100 flex items-center gap-1">
                    <span className="h-1.5 w-1.5 rounded-full bg-emerald-500 animate-pulse" />
                    Live Audit Sync
                  </span>
                </div>
              </div>
              <div className="pt-2">
                <VolumeChart cases={cases} />
              </div>
            </div>
          </section>
        )}

        {/* RECENT CASES GRID SECTION */}
        <section>
          <div className="mb-5 flex items-center justify-between px-1">
            <div className="flex items-center gap-2">
              <h2 className="text-[11px] font-bold uppercase tracking-wider text-slate-400">
                Recent Audits
              </h2>
              <span className="rounded-full bg-slate-100 border border-slate-200/50 px-2.5 py-0.5 text-[9px] font-extrabold text-slate-500">
                {status === "ready" ? `${metrics.recentList.length} Processed` : "..."}
              </span>
            </div>
            <Link
              href="/cases"
              className="text-[10px] font-bold text-slate-500 hover:text-[#1a1a1a] transition-colors"
            >
              See All Cases &rarr;
            </Link>
          </div>

          {status === "loading" ? (
            <RecentCasesSkeleton />
          ) : status === "ready" && metrics.recentList.length === 0 ? (
            <div className="flex h-[280px] flex-col items-center justify-center rounded-2xl border border-dashed border-[#e5ddd0] bg-white">
              <FolderOpen className="mb-3 h-8 w-8 text-slate-300" />
              <p className="text-xs font-semibold text-slate-500">No cases processed yet.</p>
              <Link
                href="/workspace"
                className="mt-4 text-xs font-bold text-amber-700 bg-amber-50 hover:bg-amber-100/60 border border-amber-200 px-4 py-2 rounded-xl transition-all"
              >
                Upload First File
              </Link>
            </div>
          ) : (
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
              {metrics.recentList.map((item) => {
                const statusConf = getStatusConfig(item.status);
                const showSeparatePartners = item.buyerName && item.receiverName && 
                  item.buyerName.toLowerCase().replace(/[^a-z0-9]/g, "") !== item.receiverName.toLowerCase().replace(/[^a-z0-9]/g, "");

                const cleanCategory = (() => {
                  const cat = item.category || "";
                  const partner = item.buyerName || item.receiverName || "";
                  if (partner && cat.toLowerCase().includes(partner.toLowerCase())) {
                    return "Document Verification Packet";
                  }
                  return cat;
                })();

                return (
                  <Link
                    href={`/cases/${item.id}`}
                    key={item.id}
                    className="group flex flex-col justify-between rounded-2xl border border-[#e5ddd0] bg-white p-4.5 shadow-[0_2px_8px_rgba(0,0,0,0.01)] transition-all duration-300 hover:-translate-y-1 hover:border-[#cbd5e1] hover:shadow-[0_8px_24px_rgba(0,0,0,0.04)]"
                  >
                    <div>
                      {/* Top Header Row of Card */}
                      <div className="flex items-start justify-between gap-2.5">
                        <div className="flex min-w-0 items-start gap-2.5">
                          <div className="flex h-8.5 w-8.5 shrink-0 items-center justify-center rounded-xl border border-slate-100 bg-[#f7f7f5] text-slate-500 group-hover:bg-[#ede6d9] group-hover:text-[#2d2d2d] transition-all">
                            <Building2 className="h-4.5 w-4.5" />
                          </div>
                          <div className="min-w-0">
                            <h4 className="truncate text-sm font-extrabold text-[#1a1a1a] transition-colors" title={item.displayName}>
                              {item.displayName}
                            </h4>
                            <div className="truncate text-[10px] font-bold text-slate-400 uppercase tracking-wide mt-0.5">
                              {cleanCategory}
                            </div>
                          </div>
                        </div>
                      </div>

                      {/* Partners Details */}
                      <div className="mt-4 space-y-1 text-[11px] font-semibold text-slate-500">
                        {showSeparatePartners ? (
                          <>
                            <div className="flex items-center gap-1.5">
                              <span className="text-[9px] bg-slate-100 px-1 py-0.2 rounded font-extrabold text-slate-400 shrink-0">B</span>
                              <span className="truncate max-w-[150px]">{item.buyerName}</span>
                            </div>
                            <div className="flex items-center gap-1.5">
                              <span className="text-[9px] bg-slate-100 px-1 py-0.2 rounded font-extrabold text-slate-400 shrink-0">R</span>
                              <span className="truncate max-w-[150px]">{item.receiverName}</span>
                            </div>
                          </>
                        ) : item.buyerName || item.receiverName ? (
                          <div className="flex items-center gap-1.5">
                            <span className="text-[9px] bg-slate-100 px-1 py-0.2 rounded font-extrabold text-slate-400 shrink-0">Entity</span>
                            <span className="truncate max-w-[190px]">{item.buyerName || item.receiverName}</span>
                          </div>
                        ) : (
                          <div className="text-slate-400 italic text-[10px] flex items-center gap-1.5">
                            <Users className="h-3.5 w-3.5 opacity-60" />
                            No counterparties mapped
                          </div>
                        )}
                      </div>

                      {/* Documents / Matches summary */}
                      <div className="mt-4 flex flex-wrap items-center gap-1.5">
                        <span className={`inline-flex items-center gap-1 rounded border px-2 py-0.5 text-[9px] font-bold uppercase tracking-wider ${statusConf.bg}`}>
                          <span className={`h-1.5 w-1.5 rounded-full ${statusConf.dot}`} />
                          {statusConf.label}
                        </span>
                        <span className="rounded border border-slate-100 bg-[#f7f7f5] px-2 py-0.5 text-[9px] font-bold text-slate-500">
                          {item.documentCount} {item.documentCount === 1 ? "doc" : "docs"}
                        </span>
                        {item.mismatchCount > 0 && (
                          <span className="rounded border border-rose-100 bg-rose-50 px-2 py-0.5 text-[9px] font-bold text-rose-700">
                            {item.mismatchCount} {item.mismatchCount === 1 ? "flag" : "flags"}
                          </span>
                        )}
                      </div>
                    </div>

                    {/* Bottom Metadata Section */}
                    <div className="mt-4 border-t border-slate-100 pt-3">
                      <div className="flex items-center justify-between text-[10px] font-bold text-slate-400">
                        <div className="flex items-center gap-1">
                          <Clock className="h-3.5 w-3.5" />
                          <span>{getRelativeTime(item.createdAt)}</span>
                        </div>
                      </div>
                    </div>
                  </Link>
                );
              })}
            </div>
          )}
        </section>

      </div>
    </AppShell>
  );
}
