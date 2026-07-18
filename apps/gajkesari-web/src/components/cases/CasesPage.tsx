"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import {
  ArrowUpDown,
  ChevronLeft,
  ChevronRight,
  ChevronsUpDown,
  FileText,
  Folder,
  FolderOpen,
  LayoutGrid,
  List,
  MoreVertical,
  Search,
  Trash2,
  Upload,
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
  fetchCasePage,
  recycleCase,
  type SavedCaseRecord,
} from "@/lib/case-persistence";

type LoadState = "loading" | "ready" | "error";
type ViewMode = "list" | "grid";
type CachedCaseList = {
  cases: SavedCaseRecord[];
  totalCount: number;
  totalPages: number;
};

const CASE_LIST_PAGE_SIZE = 10;
const caseListCache = new Map<string, CachedCaseList>();

function getCaseListCacheKey(query: string, page: number) {
  return `active:${query.trim().toLowerCase()}:page:${page}:limit:${CASE_LIST_PAGE_SIZE}`;
}

function getVisiblePages(currentPage: number, totalPages: number) {
  const pages = new Set([1, totalPages, currentPage - 1, currentPage, currentPage + 1]);
  return Array.from(pages)
    .filter((page) => page >= 1 && page <= totalPages)
    .sort((a, b) => a - b);
}

function formatDate(value: string) {
  return new Date(value).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

function formatTime(value: string) {
  return new Date(value).toLocaleTimeString("en-US", {
    hour: "numeric",
    minute: "2-digit",
  });
}

function getAnalysisBadge(item: SavedCaseRecord) {
  if (item.status === "failed") {
    return { label: "Failed", className: "border-rose-200 bg-rose-50 text-rose-700" };
  }
  if (item.status === "processing") {
    return { label: "Running", className: "border-violet-200 bg-violet-50 text-violet-700" };
  }
  if (item.status === "draft") {
    return { label: "Draft", className: "border-amber-200 bg-amber-50 text-amber-700" };
  }
  return { label: "Done", className: "border-emerald-200 bg-emerald-50 text-emerald-700" };
}

function getReconciliationBadge(item: SavedCaseRecord) {
  if (item.status === "draft") {
    return { label: "Not checked", className: "border-slate-200 bg-slate-50 text-slate-600" };
  }
  if (item.status === "processing") {
    return { label: "Checking", className: "border-violet-200 bg-violet-50 text-violet-700" };
  }
  if (item.status === "failed") {
    return { label: "No result", className: "border-rose-200 bg-rose-50 text-rose-700" };
  }
  if (item.mismatchCount > 0) {
    return {
      label: `${item.mismatchCount} issue${item.mismatchCount === 1 ? "" : "s"}`,
      className: "border-rose-200 bg-rose-50 text-rose-700",
    };
  }
  return { label: "No issues", className: "border-emerald-200 bg-emerald-50 text-emerald-700" };
}

function getDecisionBadge(item: SavedCaseRecord) {
  if (item.status === "accepted") {
    return { label: "Approved", className: "border-emerald-200 bg-emerald-50 text-emerald-700" };
  }
  if (item.status === "rejected") {
    return { label: "Rejected", className: "border-rose-200 bg-rose-50 text-rose-700" };
  }
  if (item.status === "completed") {
    return { label: "Pending", className: "border-amber-200 bg-amber-50 text-amber-700" };
  }
  return { label: "-", className: "border-slate-200 bg-slate-50 text-slate-500" };
}

function CaseSignalBadge({ label, className }: { label: string; className: string }) {
  return (
    <span className={`inline-flex whitespace-nowrap rounded-md border px-2.5 py-1 text-[11px] font-medium uppercase ${className}`}>
      {label}
    </span>
  );
}

function getCompanyName(item: SavedCaseRecord) {
  return item.receiverName || item.buyerName || item.category || "Receiver pending";
}

function toReadableCaseText(value: string) {
  return value
    .split(/(\/)/)
    .map((part) => {
      if (part === "/") return part;
      return part
        .split(/(\s+)/)
        .map((word) => {
          if (!word.trim()) return word;
          if (/[0-9]/.test(word)) return word;
          if (word.length <= 3 && word === word.toUpperCase()) return word;
          return word.charAt(0).toUpperCase() + word.slice(1).toLowerCase();
        })
        .join("");
    })
    .join("")
    .replace(/\s+packet$/i, " packet");
}

function getCaseTitle(item: SavedCaseRecord) {
  if (item.invoiceNumber) return `${toReadableCaseText(getCompanyName(item))} / ${item.invoiceNumber}`;
  if (item.poNumber) return `${toReadableCaseText(getCompanyName(item))} / ${item.poNumber}`;
  return toReadableCaseText(item.displayName);
}

function getCaseSubtitle(item: SavedCaseRecord) {
  return toReadableCaseText(getCompanyName(item));
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

function DirectoryHeader({
  totalCount,
  documentCount,
  viewMode,
  status,
  onViewModeChange,
}: {
  totalCount: number;
  documentCount: number;
  viewMode: ViewMode;
  status: LoadState;
  onViewModeChange: (mode: ViewMode) => void;
}) {
  return (
    <section className="rounded-2xl border border-[#e6ded2] bg-white px-5 py-5 shadow-[0_18px_45px_rgba(46,36,28,0.08)] sm:px-7">
      <div className="flex flex-col gap-5 lg:flex-row lg:items-center lg:justify-between">
        <div className="flex items-center gap-4">
          <div className="flex h-16 w-16 items-center justify-center rounded-2xl bg-[#f4eadf] text-[#332015] shadow-inner">
            <FolderOpen className="h-8 w-8" />
          </div>
          <div>
            <h1 className="text-2xl font-medium tracking-[-0.02em] text-[#111827] sm:text-3xl">
              Case Directory
            </h1>
            <div className="mt-1 flex items-center gap-2 text-sm font-medium text-[#8a7f72]">
              <span>Root</span>
              <ChevronRight className="h-4 w-4 text-[#b8ad9f]" />
            </div>
          </div>
        </div>

        <div className="flex flex-col gap-3 sm:flex-row sm:items-center lg:gap-6">
          <div className="grid grid-cols-2 gap-3 sm:min-w-[320px]">
            <div className="flex items-center gap-3 rounded-2xl bg-[#fbfaf8] px-4 py-3 shadow-[0_10px_28px_rgba(46,36,28,0.05)]">
              <div className="flex h-10 w-10 items-center justify-center rounded-full border border-emerald-200 bg-emerald-50 text-emerald-600">
                <Folder className="h-5 w-5" />
              </div>
              <div>
                {status === "loading" ? (
                  <Skeleton className="h-4 w-9 bg-[#eee7dd]" />
                ) : (
                  <div className="text-lg font-medium text-[#111827]">{totalCount}</div>
                )}
                <div className="text-xs font-medium text-[#7b7280]">Folders</div>
              </div>
            </div>
            <div className="flex items-center gap-3 rounded-2xl bg-[#fbfaf8] px-4 py-3 shadow-[0_10px_28px_rgba(46,36,28,0.05)]">
              <div className="flex h-10 w-10 items-center justify-center rounded-full border border-sky-200 bg-sky-50 text-sky-600">
                <FileText className="h-5 w-5" />
              </div>
              <div>
                {status === "loading" ? (
                  <Skeleton className="h-4 w-9 bg-[#eee7dd]" />
                ) : (
                  <div className="text-lg font-medium text-[#111827]">{documentCount}</div>
                )}
                <div className="text-xs font-medium text-[#7b7280]">Documents</div>
              </div>
            </div>
          </div>

          <div className="flex items-center gap-3">
            <div className="hidden rounded-xl border border-[#e8dfd4] bg-[#fbf7f1] p-1 md:flex">
              <button
                type="button"
                aria-label="List view"
                onClick={() => onViewModeChange("list")}
                className={`flex h-10 w-12 items-center justify-center rounded-lg transition ${
                  viewMode === "list"
                    ? "bg-[#eadfd1] text-[#2a1d14] shadow-sm"
                    : "text-[#6f675e] hover:text-[#2a1d14]"
                }`}
              >
                <List className="h-5 w-5" />
              </button>
              <button
                type="button"
                aria-label="Grid view"
                onClick={() => onViewModeChange("grid")}
                className={`flex h-10 w-12 items-center justify-center rounded-lg transition ${
                  viewMode === "grid"
                    ? "bg-white text-[#2a1d14] shadow-sm"
                    : "text-[#6f675e] hover:text-[#2a1d14]"
                }`}
              >
                <LayoutGrid className="h-5 w-5" />
              </button>
            </div>

            <Button
              asChild
              className="h-12 rounded-xl bg-[#2b1a10] px-5 font-medium text-white shadow-[0_14px_30px_rgba(43,26,16,0.22)] hover:bg-[#3b271a]"
            >
              <Link href="/workspace">
                <Upload className="h-4 w-4" />
                Upload
              </Link>
            </Button>
          </div>
        </div>
      </div>
    </section>
  );
}

function CasesTableSkeleton() {
  return (
    <Table className="min-w-[1020px]">
      <TableHeader>
        <TableRow className="border-[#ece6dc] bg-[#fbfaf8] hover:bg-[#fbfaf8]">
          {["Name", "Analysis", "Reconciliation", "Decision", "Last Updated", "Documents", "Actions"].map((heading) => (
            <TableHead key={heading} className="h-11 px-4 text-[11px] font-medium uppercase text-[#536070]">
              {heading}
            </TableHead>
          ))}
        </TableRow>
      </TableHeader>
      <TableBody>
        {Array.from({ length: CASE_LIST_PAGE_SIZE }).map((_, index) => (
          <TableRow key={index} className="h-[58px] border-[#ece6dc]">
            <TableCell className="px-4">
              <div className="flex items-center gap-3">
                <Skeleton className="h-8 w-8 rounded-lg bg-[#eee7dd]" />
                <div className="space-y-1.5">
                  <Skeleton className="h-3.5 w-64 bg-slate-100" />
                  <Skeleton className="h-3 w-36 bg-slate-100" />
                </div>
              </div>
            </TableCell>
            <TableCell><Skeleton className="h-5 w-20 rounded-md bg-slate-100" /></TableCell>
            <TableCell><Skeleton className="h-3.5 w-16 bg-slate-100" /></TableCell>
            <TableCell><Skeleton className="h-8 w-24 bg-slate-100" /></TableCell>
            <TableCell><Skeleton className="h-3.5 w-16 bg-slate-100" /></TableCell>
            <TableCell><Skeleton className="h-6 w-6 rounded-md bg-slate-100" /></TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}

function CasesMobileCards({
  cases,
  onDelete,
}: {
  cases: SavedCaseRecord[];
  onDelete: (item: SavedCaseRecord) => void;
}) {
  const router = useRouter();

  return (
    <div className="grid grid-cols-1 gap-3 p-4 sm:grid-cols-2">
      {cases.map((item) => (
        <Link
          key={item.id}
          href={`/cases/${item.id}`}
          className="group rounded-xl border border-[#e6ded2] bg-white p-4 shadow-sm transition hover:-translate-y-0.5 hover:shadow-md"
          onFocus={() => router.prefetch(`/cases/${item.id}`)}
          onMouseEnter={() => router.prefetch(`/cases/${item.id}`)}
        >
          <div className="flex items-start justify-between gap-3">
            <div className="flex min-w-0 gap-3">
              <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border border-[#e6ded2] bg-[#f4eadf] text-[#4d3828]">
                <Folder className="h-4 w-4" />
              </div>
              <div className="min-w-0">
                <div className="truncate text-sm font-medium text-[#111827]">{getCaseTitle(item)}</div>
                <div className="mt-1 truncate text-xs font-medium text-[#596579]">{getCaseSubtitle(item)}</div>
              </div>
            </div>
            <button
              type="button"
              className="rounded-lg p-1.5 text-slate-400 transition hover:bg-rose-50 hover:text-rose-600"
              aria-label="Move to recycle bin"
              onClick={(event) => {
                event.preventDefault();
                event.stopPropagation();
                onDelete(item);
              }}
            >
              <Trash2 className="h-4 w-4" />
            </button>
          </div>

          <div className="mt-4 flex flex-wrap items-center gap-2 text-xs font-medium">
            <CaseSignalBadge {...getAnalysisBadge(item)} />
            <CaseSignalBadge {...getReconciliationBadge(item)} />
            <CaseSignalBadge {...getDecisionBadge(item)} />
            <span className="rounded-md border border-[#e6ded2] bg-[#fbfaf8] px-2 py-1 text-[#596579]">
              {item.documentCount} docs
            </span>
            <span className="rounded-md border border-[#e6ded2] bg-[#fbfaf8] px-2 py-1 text-[#596579]">
              {formatDate(item.createdAt)}
            </span>
          </div>
        </Link>
      ))}
    </div>
  );
}

export function CasesPage() {
  const router = useRouter();
  const [cases, setCases] = useState<SavedCaseRecord[]>([]);
  const [status, setStatus] = useState<LoadState>("loading");
  const [error, setError] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState("");
  const [debouncedSearchQuery, setDebouncedSearchQuery] = useState("");
  const [currentPage, setCurrentPage] = useState(1);
  const [totalCount, setTotalCount] = useState(0);
  const [totalPages, setTotalPages] = useState(1);
  const [viewMode, setViewMode] = useState<ViewMode>("list");
  const [pendingCase, setPendingCase] = useState<SavedCaseRecord | null>(null);
  const [isDeleting, setIsDeleting] = useState(false);
  const isMobileView = useIsMobileView();
  const cacheKey = useMemo(
    () => getCaseListCacheKey(debouncedSearchQuery, currentPage),
    [currentPage, debouncedSearchQuery]
  );

  useEffect(() => {
    const timeout = window.setTimeout(() => {
      setDebouncedSearchQuery(searchQuery.trim());
      setCurrentPage(1);
    }, 250);

    return () => window.clearTimeout(timeout);
  }, [searchQuery]);

  useEffect(() => {
    const cached = caseListCache.get(cacheKey);
    if (cached) {
      setCases(cached.cases);
      setTotalCount(cached.totalCount);
      setTotalPages(cached.totalPages);
      setStatus("ready");
      setError(null);
      return;
    }

    const controller = new AbortController();

    setCases([]);
    setTotalCount(0);
    setTotalPages(1);
    setStatus("loading");
    setError(null);

    fetchCasePage({
      scope: "active",
      limit: CASE_LIST_PAGE_SIZE,
      page: currentPage,
      query: debouncedSearchQuery,
      signal: controller.signal,
    })
      .then((payload) => {
        const nextTotalCount = payload.totalCount ?? payload.cases.length;
        const nextTotalPages = payload.totalPages ?? 1;
        setCases(payload.cases);
        setTotalCount(nextTotalCount);
        setTotalPages(nextTotalPages);
        setStatus("ready");
        caseListCache.set(cacheKey, {
          cases: payload.cases,
          totalCount: nextTotalCount,
          totalPages: nextTotalPages,
        });
      })
      .catch((loadError) => {
        if (controller.signal.aborted) return;
        setError(loadError instanceof Error ? loadError.message : "Failed to load cases.");
        setStatus("error");
      });

    return () => controller.abort();
  }, [cacheKey, currentPage, debouncedSearchQuery]);

  const displayedCases = cases;
  const visiblePages = useMemo(
    () => getVisiblePages(currentPage, totalPages),
    [currentPage, totalPages]
  );
  const pageStart = totalCount === 0 ? 0 : (currentPage - 1) * CASE_LIST_PAGE_SIZE + 1;
  const pageEnd = Math.min(currentPage * CASE_LIST_PAGE_SIZE, totalCount);
  const pageDocumentCount = cases.reduce((sum, item) => sum + item.documentCount, 0);
  const effectiveViewMode: ViewMode = isMobileView ? "grid" : viewMode;

  async function handleConfirmDelete() {
    if (!pendingCase) return;

    try {
      setIsDeleting(true);
      setError(null);
      await recycleCase(pendingCase.id);
      const nextTotalCount = Math.max(0, totalCount - 1);
      const nextTotalPages = Math.max(1, Math.ceil(nextTotalCount / CASE_LIST_PAGE_SIZE));

      setCases((current) => {
        const nextCases = current.filter((item) => item.id !== pendingCase.id);
        caseListCache.set(cacheKey, {
          cases: nextCases,
          totalCount: nextTotalCount,
          totalPages: nextTotalPages,
        });
        return nextCases;
      });
      setTotalCount(nextTotalCount);
      setTotalPages(nextTotalPages);
      if (currentPage > nextTotalPages) {
        setCurrentPage(nextTotalPages);
      }
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
      <div className="min-h-full bg-[#f7f4ef] px-4 py-6 tracking-normal text-[#111827] sm:px-6 lg:px-8">
        <div className="mx-auto flex w-full max-w-[1540px] flex-col gap-7">
          <DirectoryHeader
            totalCount={totalCount}
            documentCount={pageDocumentCount}
            viewMode={viewMode}
            status={status}
            onViewModeChange={setViewMode}
          />

          <section className="overflow-hidden rounded-2xl border border-[#e6ded2] bg-white shadow-[0_18px_45px_rgba(46,36,28,0.08)]">
            <div className="border-b border-[#eee7df] p-4 md:p-6">
              <label className="flex h-12 min-w-0 items-center gap-3 rounded-lg border border-[#ded8d0] bg-white px-4 shadow-sm focus-within:border-[#b9aa99]">
                <Search className="h-5 w-5 shrink-0 text-[#647084]" />
                <input
                  value={searchQuery}
                  onChange={(event) => setSearchQuery(event.target.value)}
                  placeholder="Search cases by name or identifier..."
                  className="min-w-0 flex-1 bg-transparent text-sm font-medium text-[#111827] outline-none placeholder:text-[#8b94a4]"
                />
              </label>
            </div>

            {status === "loading" && (
              <div className="overflow-x-auto">
                <CasesTableSkeleton />
              </div>
            )}

            {status === "error" && (
              <div className="m-6 rounded-xl border border-rose-200 bg-rose-50 p-5 text-sm font-medium text-rose-700">
                {error}
              </div>
            )}

            {status === "ready" && displayedCases.length === 0 && (
              <div className="flex min-h-[340px] flex-col items-center justify-center px-6 text-center">
                <div className="mb-4 flex h-14 w-14 items-center justify-center rounded-2xl border border-[#e6ded2] bg-[#fbfaf8] text-[#9c8f80]">
                  <FolderOpen className="h-7 w-7" />
                </div>
                <h2 className="text-lg font-medium text-[#111827]">
                  {debouncedSearchQuery ? "No matching cases" : "No cases yet"}
                </h2>
                <p className="mt-2 max-w-sm text-sm font-medium text-[#667085]">
                  {debouncedSearchQuery
                    ? "Try changing the search."
                    : "Upload your first packet to create a case directory entry."}
                </p>
                {!debouncedSearchQuery && (
                  <Button asChild className="mt-5 rounded-xl bg-[#2b1a10] font-medium text-white hover:bg-[#3b271a]">
                    <Link href="/workspace">Upload case</Link>
                  </Button>
                )}
              </div>
            )}

            {status === "ready" && displayedCases.length > 0 && effectiveViewMode === "grid" && (
              <CasesMobileCards cases={displayedCases} onDelete={setPendingCase} />
            )}

            {status === "ready" && displayedCases.length > 0 && effectiveViewMode === "list" && (
              <div className="overflow-x-auto">
                <Table className="min-w-[1040px]">
                  <TableHeader>
                    <TableRow className="border-[#ece6dc] bg-[#fbfaf8] hover:bg-[#fbfaf8]">
                      <TableHead className="h-11 px-4 text-[11px] font-medium uppercase text-[#536070]">
                        <span className="inline-flex items-center gap-1">Name <ChevronsUpDown className="h-3 w-3" /></span>
                      </TableHead>
                      <TableHead className="h-11 px-4 text-[11px] font-medium uppercase text-[#536070]">Analysis</TableHead>
                      <TableHead className="h-11 px-4 text-[11px] font-medium uppercase text-[#536070]">Reconciliation</TableHead>
                      <TableHead className="h-11 px-4 text-[11px] font-medium uppercase text-[#536070]">Decision</TableHead>
                      <TableHead className="h-11 px-4 text-[11px] font-medium uppercase text-[#536070]">
                        <span className="inline-flex items-center gap-1">Last Updated <ArrowUpDown className="h-3 w-3" /></span>
                      </TableHead>
                      <TableHead className="h-11 px-4 text-[11px] font-medium uppercase text-[#536070]">Documents</TableHead>
                      <TableHead className="h-11 px-4 text-right text-[11px] font-medium uppercase text-[#536070]">Actions</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {displayedCases.map((item) => (
                      <TableRow
                        key={item.id}
                        className="group h-[58px] border-[#ece6dc] hover:bg-[#fbfaf8]"
                      >
                        <TableCell className="px-4 py-2">
                          <Link
                            href={`/cases/${item.id}`}
                            className="flex min-w-0 items-center gap-3"
                            onFocus={() => router.prefetch(`/cases/${item.id}`)}
                            onMouseEnter={() => router.prefetch(`/cases/${item.id}`)}
                          >
                            <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border border-[#e6ded2] bg-[#f3eee7] text-[#5b4b3d]">
                              <Folder className="h-4 w-4" />
                            </span>
                            <span className="min-w-0">
                              <span className="block max-w-[330px] truncate text-sm font-medium text-[#111827]">
                                {getCaseTitle(item)}
                              </span>
                              <span className="mt-0.5 block max-w-[280px] truncate text-xs font-medium text-[#596579]">
                                {getCaseSubtitle(item)}
                              </span>
                            </span>
                          </Link>
                        </TableCell>
                        <TableCell className="px-4 py-2">
                          <CaseSignalBadge {...getAnalysisBadge(item)} />
                        </TableCell>
                        <TableCell className="px-4 py-2">
                          <CaseSignalBadge {...getReconciliationBadge(item)} />
                        </TableCell>
                        <TableCell className="px-4 py-2">
                          <CaseSignalBadge {...getDecisionBadge(item)} />
                        </TableCell>
                        <TableCell className="px-4 py-2">
                          <span className="block text-sm font-medium leading-5 text-[#334155]">{formatDate(item.createdAt)}</span>
                          <span className="block text-sm font-medium leading-5 text-[#334155]">{formatTime(item.createdAt)}</span>
                        </TableCell>
                        <TableCell className="px-4 py-2">
                          <span className="inline-flex items-center gap-2 text-sm font-medium text-[#475569]">
                            <FileText className="h-4 w-4 text-[#647084]" />
                            {item.documentCount} docs
                          </span>
                        </TableCell>
                        <TableCell className="px-4 py-2 text-right">
                          <div className="flex justify-end">
                            <button
                              type="button"
                              className="rounded-lg p-2 text-[#111827] transition hover:bg-[#f4eee6] hover:text-rose-700"
                              aria-label="Move to recycle bin"
                              onClick={() => setPendingCase(item)}
                            >
                              <MoreVertical className="h-5 w-5" />
                            </button>
                          </div>
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
            )}

            {status === "ready" && totalCount > 0 && (
              <div className="flex flex-col gap-4 border-t border-[#eee7df] px-4 py-4 text-sm font-medium text-[#475569] md:flex-row md:items-center md:justify-between md:px-6">
                <div>
                  Showing {pageStart} to {pageEnd} of {totalCount} cases
                </div>
                <div className="flex flex-wrap items-center gap-2">
                  <Button
                    type="button"
                    variant="outline"
                    size="icon-sm"
                    className="h-9 w-9 rounded-lg border-[#ded8d0] bg-white text-[#647084]"
                    disabled={currentPage <= 1}
                    onClick={() => setCurrentPage((page) => Math.max(1, page - 1))}
                    aria-label="Previous page"
                  >
                    <ChevronLeft className="h-4 w-4" />
                  </Button>
                  {visiblePages.map((page, index) => {
                    const previousPage = visiblePages[index - 1];
                    return (
                      <div key={page} className="flex items-center gap-2">
                        {previousPage && page - previousPage > 1 && (
                          <span className="px-1 text-[#8b94a4]">...</span>
                        )}
                        <Button
                          type="button"
                          variant={page === currentPage ? "default" : "outline"}
                          size="sm"
                          className={
                            page === currentPage
                              ? "h-9 min-w-9 rounded-lg bg-[#f1e7db] px-3 font-medium text-[#2b1a10] hover:bg-[#eadccd]"
                              : "h-9 min-w-9 rounded-lg border-[#ded8d0] bg-white px-3 font-medium text-[#475569] hover:bg-[#fbfaf8]"
                          }
                          onClick={() => setCurrentPage(page)}
                        >
                          {page}
                        </Button>
                      </div>
                    );
                  })}
                  <Button
                    type="button"
                    variant="outline"
                    size="icon-sm"
                    className="h-9 w-9 rounded-lg border-[#ded8d0] bg-white text-[#647084]"
                    disabled={currentPage >= totalPages}
                    onClick={() => setCurrentPage((page) => Math.min(totalPages, page + 1))}
                    aria-label="Next page"
                  >
                    <ChevronRight className="h-4 w-4" />
                  </Button>
                </div>
              </div>
            )}
          </section>
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
