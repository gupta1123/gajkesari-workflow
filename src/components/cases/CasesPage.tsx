"use client";

import Link from "next/link";
import { useEffect, useState, useMemo } from "react";
import {
  Search,
  FolderOpen,
  Folder,
  AlertTriangle,
  Database,
  LayoutGrid,
  List,
  Upload,
  Trash2,
} from "lucide-react";

import { AppShell } from "@/components/dashboard/AppShell";
import { CaseConfirmDialog } from "@/components/cases/CaseConfirmDialog";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  fetchCasesByScope,
  recycleCase,
  type SavedCaseRecord,
} from "@/lib/case-persistence";

type LoadState = "loading" | "ready" | "error";
type ViewMode = "grid" | "table";

function formatDateTime(value: string) {
  return new Date(value).toLocaleString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

function getRiskColor(score: number) {
  if (score >= 70) return "text-red-600 bg-red-50 border-red-200";
  if (score >= 40) return "text-amber-600 bg-amber-50 border-amber-200";
  return "text-emerald-600 bg-emerald-50 border-emerald-200";
}

function getCaseStatusLabel(status: string) {
  if (status === "draft") return "Draft";
  if (status === "accepted") return "Accepted";
  if (status === "rejected") return "Rejected";
  if (status === "failed") return "Failed";
  if (status === "processing") return "Processing";
  return "Pending";
}

function getCaseStatusColor(status: string) {
  if (status === "draft") return "text-amber-700 bg-amber-50 border-amber-200";
  if (status === "accepted") return "text-emerald-700 bg-emerald-50 border-emerald-200";
  if (status === "rejected") return "text-rose-700 bg-rose-50 border-rose-200";
  if (status === "failed") return "text-red-700 bg-red-50 border-red-200";
  if (status === "processing") return "text-blue-700 bg-blue-50 border-blue-200";
  return "text-slate-600 bg-slate-50 border-slate-200";
}

function useIsMobileView() {
  const [isMobileView, setIsMobileView] = useState(false);

  useEffect(() => {
    const mediaQuery = window.matchMedia("(max-width: 767px)");
    const update = () => setIsMobileView(mediaQuery.matches);

    update();
    mediaQuery.addEventListener("change", update);

    return () => mediaQuery.removeEventListener("change", update);
  }, []);

  return isMobileView;
}

function CasesGridSkeleton() {
  return (
    <div className="grid grid-cols-1 gap-3 px-4 sm:grid-cols-2 md:px-6 lg:grid-cols-3 xl:grid-cols-4">
      {Array.from({ length: 8 }).map((_, index) => (
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
            <Skeleton className="h-5 w-5 rounded-md bg-slate-100" />
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

function CasesTableSkeleton() {
  return (
    <Table className="w-full text-sm">
      <TableHeader>
        <TableRow className="border-b border-slate-100 hover:bg-transparent">
          <TableHead className="h-10 pl-4 md:pl-6 font-bold text-slate-400 text-[11px] uppercase tracking-wider">Name</TableHead>
          <TableHead className="h-10 font-bold text-slate-400 text-[11px] uppercase tracking-wider">Status</TableHead>
          <TableHead className="h-10 font-bold text-slate-400 text-[11px] uppercase tracking-wider hidden lg:table-cell">Category</TableHead>
          <TableHead className="h-10 font-bold text-slate-400 text-[11px] uppercase tracking-wider">Risk</TableHead>
          <TableHead className="h-10 font-bold text-slate-400 text-[11px] uppercase tracking-wider hidden md:table-cell">Date</TableHead>
          <TableHead className="h-10 font-bold text-slate-400 text-[11px] uppercase tracking-wider text-right pr-4 md:pr-6">Actions</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {Array.from({ length: 9 }).map((_, index) => (
          <TableRow key={index} className="border-slate-100/60 h-11">
            <TableCell className="py-2 pl-4 md:pl-6">
              <div className="flex items-center gap-2.5">
                <Skeleton className="h-7 w-7 shrink-0 rounded-md bg-[#f0ece6]" />
                <div className="min-w-0 space-y-1.5">
                  <Skeleton className="h-3.5 w-44 bg-slate-100" />
                  <Skeleton className="hidden h-3 w-28 bg-slate-100 sm:block" />
                </div>
              </div>
            </TableCell>
            <TableCell className="py-2">
              <Skeleton className="h-5 w-16 rounded bg-slate-100" />
            </TableCell>
            <TableCell className="py-2 hidden lg:table-cell">
              <Skeleton className="h-3.5 w-28 bg-slate-100" />
            </TableCell>
            <TableCell className="py-2">
              <Skeleton className="h-5 w-10 rounded bg-slate-100" />
            </TableCell>
            <TableCell className="py-2 hidden md:table-cell">
              <Skeleton className="h-3.5 w-20 bg-slate-100" />
            </TableCell>
            <TableCell className="pr-4 md:pr-6 py-2">
              <div className="flex justify-end gap-3">
                <Skeleton className="h-3.5 w-9 bg-slate-100" />
                <Skeleton className="h-3.5 w-3.5 rounded bg-slate-100" />
              </div>
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}

function CasesLoadingSkeleton({ viewMode }: { viewMode: ViewMode }) {
  return (
    <>
      <div className="md:hidden">
        <CasesGridSkeleton />
      </div>
      <div className="hidden md:block">
        {viewMode === "grid" ? <CasesGridSkeleton /> : <CasesTableSkeleton />}
      </div>
    </>
  );
}

export function CasesPage() {
  const [cases, setCases] = useState<SavedCaseRecord[]>([]);
  const [status, setStatus] = useState<LoadState>("loading");
  const [error, setError] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState("");
  const [viewMode, setViewMode] = useState<ViewMode>("table");
  const [pendingCase, setPendingCase] = useState<SavedCaseRecord | null>(null);
  const [isDeleting, setIsDeleting] = useState(false);
  const isMobileView = useIsMobileView();

  useEffect(() => {
    let active = true;

    fetchCasesByScope("active", 100)
      .then((payload) => {
        if (!active) return;
        setCases(payload.cases);
        setStatus("ready");
      })
      .catch((loadError) => {
        if (!active) return;
        setError(loadError instanceof Error ? loadError.message : "Failed to load cases.");
        setStatus("error");
      });

    return () => {
      active = false;
    };
  }, []);

  const totalDocs = useMemo(() => cases.reduce((acc, curr) => acc + curr.documentCount, 0), [cases]);

  // Client-side filtering logic
  const filteredCases = useMemo(() => {
    if (!searchQuery.trim()) return cases;
    const query = searchQuery.toLowerCase();

    return cases.filter((c) =>
      c.displayName.toLowerCase().includes(query) ||
      (c.receiverName && c.receiverName.toLowerCase().includes(query)) ||
      c.category.toLowerCase().includes(query) ||
      (c.poNumber && c.poNumber.toLowerCase().includes(query)) ||
      c.slug.toLowerCase().includes(query)
    );
  }, [cases, searchQuery]);

  const effectiveViewMode: ViewMode = isMobileView ? "grid" : viewMode;

  async function handleConfirmDelete() {
    if (!pendingCase) return;

    try {
      setIsDeleting(true);
      setError(null);
      await recycleCase(pendingCase.id);
      setCases((current) => current.filter((item) => item.id !== pendingCase.id));
      setPendingCase(null);
    } catch (mutationError) {
      setError(
        mutationError instanceof Error
          ? mutationError.message
          : "Failed to move case to the recycle bin."
      );
    } finally {
      setIsDeleting(false);
    }
  }

  return (
    <AppShell>
      <div className="mx-auto max-w-[1500px] w-full px-4 sm:px-6 lg:px-8 py-8 animate-in fade-in duration-700 ease-out text-[#1a1a1a]">

        {/* MAIN CONTAINER matching the image's white box UI */}
        <div className="bg-white border border-[#e5ddd0] rounded-2xl shadow-[0_8px_30px_rgb(0,0,0,0.04)] overflow-hidden flex flex-col">

          {/* =========================================
              HEADER SECTION (Matches Image)
              ========================================= */}
          <div className="p-6 md:p-8 border-b border-[#e5ddd0] flex flex-col xl:flex-row justify-between items-start xl:items-center gap-6">

            {/* Title Area */}
            <div className="flex items-center gap-5">
              <div className="w-14 h-14 bg-[#f0ece6] border border-[#e5ddd0] text-[#1a1a1a] rounded-2xl flex items-center justify-center shadow-sm">
                <FolderOpen className="w-7 h-7" />
              </div>
              <div>
                <h1 className="text-2xl font-extrabold text-[#1a1a1a] tracking-tight">Case Directory</h1>
                <p className="text-sm font-semibold text-[#8a7f72] mt-0.5">Root</p>
              </div>
            </div>

            {/* Action Cluster */}
            <div className="flex items-center gap-3 w-full xl:w-auto overflow-x-auto pb-2 xl:pb-0">
              {/* View Toggles */}
              <div className="hidden md:flex items-center gap-1 border border-[#e5ddd0] rounded-lg p-1 bg-[#faf8f4] shrink-0">
                <button
                  type="button"
                  onClick={() => setViewMode("grid")}
                  className={`p-1.5 rounded-md transition-colors ${viewMode === "grid"
                      ? "bg-white shadow-sm border border-[#e5ddd0] text-[#1a1a1a]"
                      : "text-[#8a7f72] hover:text-[#1a1a1a]"
                    }`}
                  aria-label="Card view"
                >
                  <LayoutGrid className="w-4 h-4" />
                </button>
                <button
                  type="button"
                  onClick={() => setViewMode("table")}
                  className={`p-1.5 rounded-md transition-colors ${viewMode === "table"
                      ? "bg-white shadow-sm border border-[#e5ddd0] text-[#1a1a1a]"
                      : "text-[#8a7f72] hover:text-[#1a1a1a]"
                    }`}
                  aria-label="Table view"
                >
                  <List className="w-4 h-4" />
                </button>
              </div>

              {/* Status Summary */}
              <div className="hidden md:flex items-center text-xs font-semibold text-[#8a7f72] px-4 border-x border-[#e5ddd0] shrink-0">
                {status === "loading" ? (
                  <Skeleton className="h-3.5 w-36 bg-[#e5ddd0]" />
                ) : (
                  `${cases.length} folders • ${totalDocs} documents`
                )}
              </div>

              <Button asChild className="bg-[#1a1a1a] hover:bg-[#2d2d2d] text-white font-bold shadow-md shadow-[#1a1a1a]/15 shrink-0 transition-transform hover:scale-[1.02]">
                <Link href="/workspace">
                  <Upload className="w-4 h-4 mr-2" /> Upload
                </Link>
              </Button>
            </div>
          </div>

          {/* =========================================
              FILTER / SEARCH BAR (Matches Image)
              ========================================= */}
          <div className="p-6 md:px-8 md:py-6">
            <div className="flex items-center rounded-xl border border-slate-200 bg-white shadow-sm">
              <div className="flex-1 flex items-center px-5 py-3 bg-white">
                <Search className="w-4 h-4 text-slate-400 mr-3 shrink-0" />
                <input
                  type="text"
                  placeholder="Search documents..."
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  className="w-full outline-none text-sm font-medium text-slate-900 placeholder:text-slate-400 bg-transparent"
                />
              </div>
            </div>

            <div className="mt-6 flex items-center gap-1 text-sm font-semibold text-slate-500">
              <span>Documents</span>
              {status === "loading" ? (
                <Skeleton className="h-3.5 w-32 bg-slate-100" />
              ) : (
                <span className="text-slate-400">({filteredCases.length} in current view)</span>
              )}
            </div>
          </div>

          {/* =========================================
              TABLE AREA
              ========================================= */}
          <div className="w-full overflow-x-auto pb-4">

            {status === "loading" && (
              <CasesLoadingSkeleton viewMode={viewMode} />
            )}

            {status === "error" && (
              <div className="m-8 rounded-2xl border border-red-200 bg-red-50 p-6 text-sm text-red-700 flex items-start shadow-sm">
                <AlertTriangle className="mr-3 h-5 w-5 text-red-500 shrink-0 mt-0.5" />
                <div>
                  <div className="font-bold text-base mb-1">Failed to load cases</div>
                  <div>{error}</div>
                </div>
              </div>
            )}

            {status === "ready" && cases.length === 0 && (
              <div className="flex flex-col items-center justify-center py-24 text-center px-4">
                <div className="mb-5 flex h-16 w-16 items-center justify-center rounded-full bg-slate-50 border border-slate-100 shadow-sm">
                  <Database className="h-8 w-8 text-slate-300" />
                </div>
                <h3 className="text-lg font-bold text-slate-900">Directory is empty</h3>
                <p className="mt-2 text-sm font-medium text-slate-500 max-w-sm">
                  No cases have been processed yet. Upload your first packet to see it here.
                </p>
                <Button asChild className="mt-6 rounded-lg font-bold bg-[#1a1a1a] hover:bg-[#2d2d2d] text-white">
                  <Link href="/workspace">Start Upload</Link>
                </Button>
              </div>
            )}

            {status === "ready" && filteredCases.length > 0 && (
              effectiveViewMode === "grid" ? (
                <div className="grid grid-cols-1 gap-3 px-4 sm:grid-cols-2 md:px-6 lg:grid-cols-3 xl:grid-cols-4">
                  {filteredCases.map((item) => (
                    <Link
                      key={item.id}
                      href={`/cases/${item.id}`}
                      className="group flex flex-col rounded-xl border border-[#e5ddd0] bg-white p-3.5 shadow-sm transition-all hover:-translate-y-px hover:border-[#d4c9b8] hover:shadow-md"
                    >
                      <div className="flex items-start justify-between gap-2">
                        <div className="flex min-w-0 items-start gap-2.5">
                          <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border border-[#e5ddd0] bg-[#f0ece6] text-[#5a5046]">
                            <Folder className="h-4 w-4 fill-[#e5ddd0]" />
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
                        <button
                          type="button"
                          className="shrink-0 rounded-md p-1 text-slate-300 transition-colors hover:bg-rose-50 hover:text-rose-500"
                          aria-label="Delete"
                          onClick={(e) => { e.preventDefault(); e.stopPropagation(); setPendingCase(item); }}
                        >
                          <Trash2 className="h-3.5 w-3.5" />
                        </button>
                      </div>

                      <div className="mt-2.5 flex flex-wrap items-center gap-1.5">
                        <span
                          className={`rounded border px-1.5 py-0.5 text-[9px] font-bold uppercase tracking-wider ${getCaseStatusColor(item.status)}`}
                        >
                          {getCaseStatusLabel(item.status)}
                        </span>
                        <span
                          className={`rounded border px-1.5 py-0.5 text-[9px] font-bold uppercase tracking-wider ${getRiskColor(item.riskScore)}`}
                        >
                          R:{item.riskScore}
                        </span>
                      </div>

                      <div className="mt-2.5 flex items-center justify-between border-t border-slate-100 pt-2.5 text-[11px] font-semibold text-slate-400">
                        <span>{item.documentCount} docs · {item.mismatchCount} issues</span>
                        <span>{formatDateTime(item.createdAt)}</span>
                      </div>
                    </Link>
                  ))}
                </div>
              ) : (
                <Table className="w-full text-sm">
                  <TableHeader>
                    <TableRow className="border-b border-slate-100 hover:bg-transparent">
                      <TableHead className="h-10 pl-4 md:pl-6 font-bold text-slate-400 text-[11px] uppercase tracking-wider">Name</TableHead>
                      <TableHead className="h-10 font-bold text-slate-400 text-[11px] uppercase tracking-wider">Status</TableHead>
                      <TableHead className="h-10 font-bold text-slate-400 text-[11px] uppercase tracking-wider hidden lg:table-cell">Category</TableHead>
                      <TableHead className="h-10 font-bold text-slate-400 text-[11px] uppercase tracking-wider">Risk</TableHead>
                      <TableHead className="h-10 font-bold text-slate-400 text-[11px] uppercase tracking-wider hidden md:table-cell">Date</TableHead>
                      <TableHead className="h-10 font-bold text-slate-400 text-[11px] uppercase tracking-wider text-right pr-4 md:pr-6">Actions</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {filteredCases.map((item) => (
                      <TableRow
                        key={item.id}
                        className="group cursor-pointer border-slate-100/60 transition-colors hover:bg-slate-50/80 h-11"
                      >
                        <TableCell className="py-2 pl-4 md:pl-6">
                          <Link href={`/cases/${item.id}`} className="flex items-center gap-2.5 outline-none">
                            <div className="w-7 h-7 rounded-md bg-[#f0ece6] border border-[#e5ddd0] text-[#5a5046] flex items-center justify-center shrink-0">
                              <Folder className="w-3.5 h-3.5 fill-[#e5ddd0]" />
                            </div>
                            <div className="min-w-0">
                              <span className="font-semibold text-[#1a1a1a] text-[13px] group-hover:text-[#5a5046] transition-colors truncate block max-w-[180px] xl:max-w-[280px]" title={item.displayName}>
                                {item.displayName}
                              </span>
                              <span className="hidden sm:block truncate text-[11px] text-slate-400 mt-px" title={item.receiverName || ""}>
                                {item.receiverName || ""}
                              </span>
                            </div>
                          </Link>
                        </TableCell>

                        <TableCell className="py-2">
                          <span className={`font-bold text-[9px] uppercase tracking-wider px-2 py-0.5 rounded border ${getCaseStatusColor(item.status)}`}>
                            {getCaseStatusLabel(item.status)}
                          </span>
                        </TableCell>

                        <TableCell className="py-2 hidden lg:table-cell">
                          <span className="text-[13px] font-medium text-slate-500 truncate block max-w-[160px]" title={item.category}>
                            {item.category}
                          </span>
                        </TableCell>

                        <TableCell className="py-2">
                          <span className={`font-bold text-[9px] uppercase tracking-wider px-2 py-0.5 rounded border ${getRiskColor(item.riskScore)}`}>
                            {item.riskScore}
                          </span>
                        </TableCell>

                        <TableCell className="py-2 whitespace-nowrap text-[13px] font-medium text-slate-400 hidden md:table-cell">
                          {formatDateTime(item.createdAt)}
                        </TableCell>

                        <TableCell className="pr-4 md:pr-6 py-2 text-right">
                          <div className="flex items-center justify-end gap-3 opacity-0 group-hover:opacity-100 transition-opacity">
                            <Link href={`/cases/${item.id}`} className="text-[13px] font-bold text-[#1a1a1a] hover:text-[#5a5046] transition-colors">
                              Open
                            </Link>
                            <button
                              type="button"
                              className="text-slate-300 hover:text-rose-500 transition-colors"
                              aria-label="Delete"
                              onClick={() => setPendingCase(item)}
                            >
                              <Trash2 className="w-3.5 h-3.5" />
                            </button>
                          </div>
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              )
            )}
          </div>
        </div>

        <CaseConfirmDialog
          open={Boolean(pendingCase)}
          onOpenChange={(open) => {
            if (!open && !isDeleting) {
              setPendingCase(null);
            }
          }}
          title="Move case to recycle bin?"
          description={
            pendingCase
              ? `"${pendingCase.displayName}" will be removed from the active cases list and moved to the recycle bin.`
              : ""
          }
          confirmLabel="Move to recycle bin"
          loading={isDeleting}
          onConfirm={handleConfirmDelete}
        />

      </div>
    </AppShell>
  );
}
