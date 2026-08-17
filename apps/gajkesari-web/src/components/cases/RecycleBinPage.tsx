"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import {
  ChevronLeft,
  ChevronRight,
  Clock,
  Eye,
  FileText,
  RotateCcw,
  Search,
  Sparkles,
  Trash,
  Trash2,
} from "lucide-react";

import { CaseConfirmDialog } from "@/components/cases/CaseConfirmDialog";
import { AppShell } from "@/components/dashboard/AppShell";
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
  deleteCaseForever,
  fetchCasePage,
  restoreCase,
  type SavedCaseRecord,
} from "@/lib/case-persistence";

type LoadState = "loading" | "ready" | "error";
type PendingAction =
  | { type: "destroy"; item: SavedCaseRecord }
  | { type: "restore"; item: SavedCaseRecord }
  | null;

const RECYCLE_BIN_PAGE_SIZE = 25;

function getVisiblePages(currentPage: number, totalPages: number) {
  const pages = new Set([1, totalPages, currentPage - 1, currentPage, currentPage + 1]);
  return Array.from(pages)
    .filter((page) => page >= 1 && page <= totalPages)
    .sort((a, b) => a - b);
}

function formatDateTime(value: string | null) {
  if (!value) return "—";

  return new Date(value).toLocaleString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).replace(',', ' -').replace(/\s([AP]M)$/, '_$1'); // Rough match for image format
}

function calculateDaysRemaining(deletedAt: string | null) {
  if (!deletedAt) return 30;
  const deletedDate = new Date(deletedAt);
  const expiryDate = new Date(deletedDate.getTime() + (30 * 24 * 60 * 60 * 1000));
  const now = new Date();
  const diffTime = Math.max(0, expiryDate.getTime() - now.getTime());
  const diffDays = Math.ceil(diffTime / (1000 * 60 * 60 * 24));
  return diffDays;
}

function RecycleBinCardSkeleton() {
  return (
    <div className="grid gap-3 px-4 pb-2 md:hidden">
      {Array.from({ length: 5 }).map((_, index) => (
        <div key={index} className="rounded-xl border border-[#e2e8f0] bg-white p-3.5 shadow-sm">
          <div className="flex items-start gap-2.5">
            <Skeleton className="h-8 w-8 shrink-0 rounded-lg bg-[#f8fafc]" />
            <div className="min-w-0 flex-1 space-y-2">
              <Skeleton className="h-3.5 w-4/5 bg-slate-100" />
              <Skeleton className="h-3 w-3/5 bg-slate-100" />
            </div>
          </div>
          <div className="mt-2.5 flex items-center justify-between border-t border-slate-100 pt-2.5">
            <Skeleton className="h-3 w-28 bg-slate-100" />
            <Skeleton className="h-3 w-14 bg-slate-100" />
          </div>
          <div className="mt-2.5 flex items-center justify-end gap-2">
            <Skeleton className="h-7 w-7 rounded-md bg-slate-100" />
            <Skeleton className="h-7 w-7 rounded-md bg-slate-100" />
            <Skeleton className="h-7 w-7 rounded-md bg-slate-100" />
          </div>
        </div>
      ))}
    </div>
  );
}

function RecycleBinTableSkeleton() {
  return (
    <div className="hidden md:block">
      <Table className="w-full text-sm">
        <TableHeader>
          <TableRow className="border-b border-[#f1f5f9] hover:bg-transparent">
            <TableHead className="h-10 pl-4 md:pl-6 font-medium text-[#94a3b8] text-[11px] uppercase tracking-wider">Document</TableHead>
            <TableHead className="h-10 font-medium text-[#94a3b8] text-[11px] uppercase tracking-wider">Receiver</TableHead>
            <TableHead className="h-10 font-medium text-[#94a3b8] text-[11px] uppercase tracking-wider">Expires</TableHead>
            <TableHead className="h-10 font-medium text-[#94a3b8] text-[11px] uppercase tracking-wider text-right pr-4 md:pr-6">Actions</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {Array.from({ length: 8 }).map((_, index) => (
            <TableRow key={index} className="border-[#f1f5f9] h-11">
              <TableCell className="py-2 pl-4 md:pl-6">
                <div className="flex items-center gap-2.5">
                  <Skeleton className="h-7 w-7 shrink-0 rounded-md bg-[#f1f5f9]" />
                  <div className="min-w-0 space-y-1.5">
                    <Skeleton className="h-3.5 w-44 bg-slate-100" />
                    <Skeleton className="h-3 w-28 bg-slate-100" />
                  </div>
                </div>
              </TableCell>
              <TableCell className="py-2">
                <Skeleton className="h-3.5 w-36 bg-slate-100" />
              </TableCell>
              <TableCell className="py-2">
                <Skeleton className="h-3.5 w-12 bg-slate-100" />
              </TableCell>
              <TableCell className="pr-4 md:pr-6 py-2">
                <div className="flex justify-end gap-2">
                  <Skeleton className="h-5 w-5 rounded-md bg-slate-100" />
                  <Skeleton className="h-5 w-5 rounded-md bg-slate-100" />
                  <Skeleton className="h-5 w-5 rounded-md bg-slate-100" />
                </div>
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}

export function RecycleBinPage() {
  const [cases, setCases] = useState<SavedCaseRecord[]>([]);
  const [status, setStatus] = useState<LoadState>("loading");
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [debouncedQuery, setDebouncedQuery] = useState("");
  const [currentPage, setCurrentPage] = useState(1);
  const [totalCount, setTotalCount] = useState(0);
  const [totalPages, setTotalPages] = useState(1);
  const [pendingAction, setPendingAction] = useState<PendingAction>(null);
  const [isMutating, setIsMutating] = useState(false);

  useEffect(() => {
    const timeout = window.setTimeout(() => {
      setDebouncedQuery(query.trim());
      setCurrentPage(1);
    }, 250);

    return () => window.clearTimeout(timeout);
  }, [query]);

  useEffect(() => {
    const controller = new AbortController();

    setStatus("loading");
    setError(null);

    fetchCasePage({
      scope: "deleted",
      limit: RECYCLE_BIN_PAGE_SIZE,
      page: currentPage,
      query: debouncedQuery,
      signal: controller.signal,
    })
      .then((payload) => {
        setCases(payload.cases);
        setTotalCount(payload.totalCount ?? payload.cases.length);
        setTotalPages(payload.totalPages ?? 1);
        setStatus("ready");
      })
      .catch((loadError) => {
        if (controller.signal.aborted) return;
        setError(
          loadError instanceof Error ? loadError.message : "Failed to load recycle bin."
        );
        setStatus("error");
      });

    return () => {
      controller.abort();
    };
  }, [currentPage, debouncedQuery]);

  const visiblePages = useMemo(
    () => getVisiblePages(currentPage, totalPages),
    [currentPage, totalPages]
  );
  const pageStart = totalCount === 0 ? 0 : (currentPage - 1) * RECYCLE_BIN_PAGE_SIZE + 1;
  const pageEnd = Math.min(currentPage * RECYCLE_BIN_PAGE_SIZE, totalCount);

  async function handleConfirmAction() {
    if (!pendingAction) return;

    try {
      setIsMutating(true);
      setError(null);

      if (pendingAction.type === "restore") {
        await restoreCase(pendingAction.item.id);
      } else {
        await deleteCaseForever(pendingAction.item.id);
      }

      setCases((current) =>
        current.filter((item) => item.id !== pendingAction.item.id)
      );
      const nextTotalCount = Math.max(0, totalCount - 1);
      const nextTotalPages = Math.max(1, Math.ceil(nextTotalCount / RECYCLE_BIN_PAGE_SIZE));
      setTotalCount(nextTotalCount);
      setTotalPages(nextTotalPages);
      if (currentPage > nextTotalPages) {
        setCurrentPage(nextTotalPages);
      }
      setPendingAction(null);
    } catch (mutationError) {
      setError(
        mutationError instanceof Error
          ? mutationError.message
          : "Failed to update recycle bin."
      );
    } finally {
      setIsMutating(false);
    }
  }

  return (
    <AppShell>
      <div className="mx-auto max-w-[1500px] w-full px-4 sm:px-6 lg:px-8 py-8 animate-in fade-in duration-700 ease-out text-[#1a1a1a]">

        {/* MAIN CONTAINER matching the image's white box UI */}
        <div className="bg-white border border-[#e5ddd0] rounded-2xl shadow-[0_2px_8px_rgba(0,0,0,0.02)] overflow-hidden flex flex-col">

          {/* =========================================
              HEADER SECTION (Matches Image)
              ========================================= */}
          <div className="p-6 border-b border-[#e5ddd0] flex flex-col md:flex-row justify-between items-start md:items-center gap-6">

            <div className="flex items-center gap-5">
              <div className="w-12 h-12 bg-amber-50 border border-amber-250 text-amber-800 rounded-xl flex items-center justify-center shadow-sm">
                <Trash2 className="w-6 h-6" />
              </div>
              <div>
                <div className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full bg-amber-50 border border-amber-200/50 text-[10px] font-bold uppercase tracking-wider text-amber-800">
                  <Sparkles className="h-3 w-3 text-amber-600 animate-spin duration-3000" />
                  System Cleanup
                </div>
                <h1 className="text-2xl font-black text-[#1a1a1a] tracking-tight mt-1.5">Recycle Bin</h1>
                <div className="text-xs font-semibold text-slate-400 mt-1">
                  {status === "loading" ? (
                    <Skeleton className="mt-1 h-3.5 w-60 bg-slate-100" />
                  ) : (
                    `${totalCount} items • Auto-deleted after 30 days`
                  )}
                </div>
              </div>
            </div>
          </div>

          {/* =========================================
              SEARCH BAR (Matches Image)
              ========================================= */}
          <div className="p-6 md:px-8 md:py-6">
            <div className="flex items-center px-4 py-2.5 border border-[#e5ddd0] rounded-xl bg-[#faf8f4]/60 shadow-sm max-w-md focus-within:border-amber-500 transition-all">
              <Search className="w-4 h-4 text-slate-400 mr-3 shrink-0" />
              <input
                type="text"
                placeholder="Search deleted items..."
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                className="w-full outline-none text-xs font-semibold text-[#1a1a1a] placeholder:text-slate-400 bg-transparent"
              />
            </div>
          </div>

          {/* =========================================
              TABLE AREA
              ========================================= */}
          <div className="w-full overflow-x-auto pb-4">

            {status === "loading" && (
              <>
                <RecycleBinCardSkeleton />
                <RecycleBinTableSkeleton />
              </>
            )}

            {status === "error" && (
              <div className="m-8 rounded-2xl border border-red-200 bg-red-50 p-6 text-sm text-red-700 flex items-start shadow-sm">
                <Trash className="mr-3 h-5 w-5 text-red-500 shrink-0 mt-0.5" />
                <div>
                  <div className="font-medium text-base mb-1">Failed to load recycle bin</div>
                  <div>{error}</div>
                </div>
              </div>
            )}

            {status === "ready" && totalCount === 0 && !debouncedQuery && (
              <div className="flex flex-col items-center justify-center py-24 text-center px-4">
                <div className="mb-5 flex h-16 w-16 items-center justify-center rounded-full bg-[#f8fafc] border border-[#e2e8f0] shadow-sm">
                  <Trash2 className="h-8 w-8 text-[#cbd5e1]" />
                </div>
                <h3 className="text-lg font-medium text-[#0f172a]">Recycle Bin is Empty</h3>
                <p className="mt-2 text-sm font-medium text-[#64748b] max-w-sm">
                  Items you delete will appear here for 30 days before being permanently removed.
                </p>
              </div>
            )}

            {status === "ready" && totalCount === 0 && debouncedQuery && (
              <div className="flex flex-col items-center justify-center py-24 text-center px-4">
                <Search className="h-10 w-10 text-[#e2e8f0] mb-4" />
                <h3 className="text-base font-medium text-[#0f172a]">No matches found</h3>
                <p className="mt-1 text-sm font-medium text-[#64748b]">
                  We couldn&apos;t find any deleted items matching &quot;{debouncedQuery}&quot;.
                </p>
                <Button
                  variant="link"
                  onClick={() => setQuery("")}
                  className="mt-2 text-amber-600 hover:text-amber-700 font-medium"
                >
                  Clear search
                </Button>
              </div>
            )}

            {status === "ready" && cases.length > 0 && (
              <>
                <div className="grid gap-3 px-4 pb-2 md:hidden">
                  {cases.map((item) => (
                    <div
                      key={item.id}
                      className="rounded-xl border border-[#e5ddd0] bg-white p-3.5 shadow-sm"
                    >
                      <div className="flex items-start gap-2.5">
                        <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border border-[#e5ddd0] bg-[#faf8f4]/60 text-slate-500">
                          <FileText className="h-4 w-4" />
                        </div>
                        <div className="min-w-0 flex-1">
                          <Link
                            href={`/cases/${item.id}`}
                            className="block truncate text-sm font-extrabold text-[#1a1a1a] hover:text-amber-600 transition-colors" title={item.displayName || "Unnamed Document"}
                          >
                            {item.displayName || "Unnamed Document"}
                          </Link>
                          <div className="mt-0.5 text-[11px] font-semibold text-slate-400">
                            {formatDateTime(item.deletedAt)} • by Admin
                          </div>
                        </div>
                      </div>

                      <div className="mt-2.5 flex items-center justify-between border-t border-slate-100 pt-2.5 text-[11px] font-semibold text-slate-450">
                        <span className="truncate max-w-[140px]" title={item.receiverName || "Receiver pending"}>{item.receiverName || "Receiver pending"}</span>
                        <span className="flex items-center gap-1 shrink-0 text-slate-500 font-bold">
                          <Clock className="h-3 w-3" />
                          {calculateDaysRemaining(item.deletedAt)}d left
                        </span>
                      </div>

                      <div className="mt-2.5 flex items-center justify-end gap-2">
                        <Link
                          href={`/cases/${item.id}`}
                          className="rounded-lg border border-[#e5ddd0] p-1.5 text-slate-400 hover:text-slate-900 transition-colors hover:bg-slate-100"
                          aria-label="View"
                        >
                          <Eye className="h-3.5 w-3.5" />
                        </Link>
                        <button
                          className="rounded-lg border border-emerald-200 p-1.5 text-emerald-600 transition-colors hover:bg-emerald-50"
                          aria-label="Restore"
                          onClick={() => setPendingAction({ type: "restore", item })}
                        >
                          <RotateCcw className="h-3.5 w-3.5" />
                        </button>
                        <button
                          className="rounded-lg border border-rose-200 p-1.5 text-rose-600 transition-colors hover:bg-rose-50"
                          aria-label="Delete Permanently"
                          onClick={() => setPendingAction({ type: "destroy", item })}
                        >
                          <Trash2 className="h-3.5 w-3.5" />
                        </button>
                      </div>
                    </div>
                  ))}
                </div>

                <div className="hidden md:block">
                  <Table className="w-full text-sm">
                    <TableHeader>
                      <TableRow className="border-b border-[#e5ddd0] bg-[#fcfbfa] hover:bg-transparent">
                        <TableHead className="h-10 pl-4 md:pl-6 font-bold text-slate-400 text-[10px] uppercase tracking-wider">Document</TableHead>
                        <TableHead className="h-10 font-bold text-slate-400 text-[10px] uppercase tracking-wider">Receiver</TableHead>
                        <TableHead className="h-10 font-bold text-slate-400 text-[10px] uppercase tracking-wider">Expires</TableHead>
                        <TableHead className="h-10 font-bold text-slate-400 text-[10px] uppercase tracking-wider text-right pr-4 md:pr-6">Actions</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {cases.map((item) => (
                        <TableRow
                          key={item.id}
                          className="group border-b border-[#e5ddd0] hover:bg-[#fcfbfa]/60 transition-colors h-11"
                        >
                          <TableCell className="py-2.5 pl-4 md:pl-6">
                            <div className="flex items-center gap-2.5">
                              <div className="w-7 h-7 rounded-lg bg-[#faf8f4]/60 border border-[#e5ddd0] text-slate-500 flex items-center justify-center shrink-0">
                                <FileText className="w-3.5 h-3.5" />
                              </div>
                              <div className="min-w-0">
                                <Link
                                  href={`/cases/${item.id}`}
                                  className="font-extrabold text-[#1a1a1a] text-[13px] transition-colors hover:text-amber-600 truncate block max-w-[200px] xl:max-w-[300px]" title={item.displayName || "Unnamed Document"}
                                >
                                  {item.displayName || "Unnamed Document"}
                                </Link>
                                <div className="text-[11px] font-semibold text-slate-400 mt-px">
                                  {formatDateTime(item.deletedAt)}
                                </div>
                              </div>
                            </div>
                          </TableCell>

                          <TableCell className="py-2.5">
                            <div className="flex items-center gap-1.5">
                              <div className="w-1.5 h-1.5 rounded-full bg-emerald-500 shrink-0" />
                              <span className="text-[13px] font-semibold text-slate-500 truncate max-w-[140px]" title={item.receiverName || "Receiver pending"}>
                                {item.receiverName || "Receiver pending"}
                              </span>
                            </div>
                          </TableCell>

                          <TableCell className="py-2.5">
                            <div className="flex items-center gap-1 text-[13px] font-bold text-slate-500">
                              <Clock className="w-3 h-3 text-slate-400" />
                              {calculateDaysRemaining(item.deletedAt)}d
                            </div>
                          </TableCell>

                          <TableCell className="pr-4 md:pr-6 py-2.5 text-right">
                            <div className="flex items-center justify-end gap-2 text-slate-400">
                              <Link
                                href={`/cases/${item.id}`}
                                className="p-1.5 hover:text-slate-900 hover:bg-slate-100 rounded-xl transition-all"
                                aria-label="View"
                              >
                                <Eye className="w-3.5 h-3.5" />
                              </Link>
                              <button
                                className="p-1.5 hover:text-emerald-700 hover:bg-emerald-50 border border-transparent hover:border-emerald-200 rounded-xl transition-all"
                                aria-label="Restore"
                                onClick={() => setPendingAction({ type: "restore", item })}
                              >
                                <RotateCcw className="w-3.5 h-3.5" />
                              </button>
                              <button
                                className="p-1.5 hover:text-rose-700 hover:bg-rose-50 border border-transparent hover:border-rose-200 rounded-xl transition-all"
                                aria-label="Delete Permanently"
                                onClick={() => setPendingAction({ type: "destroy", item })}
                              >
                                <Trash2 className="w-3.5 h-3.5" />
                              </button>
                            </div>
                          </TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </div>
              </>
            )}

            {status === "ready" && totalCount > 0 && (
              <div className="flex flex-col gap-3 border-t border-[#e5ddd0] px-6 pb-2 pt-4 text-xs font-semibold text-slate-400 md:flex-row md:items-center md:justify-between md:px-8">
                <div>
                  Showing {pageStart}-{pageEnd} of {totalCount}
                </div>
                <div className="flex items-center gap-1">
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    className="h-8.5 w-8.5 rounded-xl border border-[#e5ddd0] bg-white px-2 font-bold text-[#5a5046] hover:bg-[#faf8f4] hover:text-[#1a1a1a] shadow-sm transition-all"
                    disabled={currentPage <= 1}
                    onClick={() => setCurrentPage((page) => Math.max(1, page - 1))}
                    aria-label="Previous page"
                  >
                    <ChevronLeft className="h-4 w-4" />
                  </Button>
                  {visiblePages.map((page, index) => {
                    const previousPage = visiblePages[index - 1];
                    return (
                      <div key={page} className="flex items-center gap-1">
                        {previousPage && page - previousPage > 1 && (
                          <span className="px-1 text-slate-350">...</span>
                        )}
                        <Button
                          type="button"
                          variant={page === currentPage ? "default" : "outline"}
                          size="sm"
                          className={
                            page === currentPage
                              ? "h-8.5 min-w-8.5 bg-[#2d2d2d] px-2 font-bold text-white hover:bg-[#1a1a1a] rounded-xl shadow-sm transition-all"
                              : "h-8.5 min-w-8.5 border border-[#e5ddd0] bg-white px-2 font-bold text-[#5a5046] hover:bg-[#faf8f4] hover:text-[#1a1a1a] rounded-xl shadow-sm transition-all"
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
                    size="sm"
                    className="h-8.5 w-8.5 rounded-xl border border-[#e5ddd0] bg-white px-2 font-bold text-[#5a5046] hover:bg-[#faf8f4] hover:text-[#1a1a1a] shadow-sm transition-all"
                    disabled={currentPage >= totalPages}
                    onClick={() => setCurrentPage((page) => Math.min(totalPages, page + 1))}
                    aria-label="Next page"
                  >
                    <ChevronRight className="h-4 w-4" />
                  </Button>
                </div>
              </div>
            )}

          </div>
        </div>

        {/* Confirmation Dialog remains unchanged functionally, but styled to fit if possible via its own component */}
        <CaseConfirmDialog
          open={Boolean(pendingAction)}
          onOpenChange={(open) => {
            if (!open && !isMutating) {
              setPendingAction(null);
            }
          }}
          title={
            pendingAction?.type === "restore"
              ? "Restore this case?"
              : "Delete this case permanently?"
          }
          description={
            pendingAction
              ? pendingAction.type === "restore"
                ? `"${pendingAction.item.displayName}" will be moved back into the active cases list.`
                : `"${pendingAction.item.displayName}" and its stored documents will be removed permanently. This cannot be undone.`
              : ""
          }
          confirmLabel={pendingAction?.type === "restore" ? "Restore case" : "Delete forever"}
          variant={pendingAction?.type === "restore" ? "default" : "danger"}
          loading={isMutating}
          onConfirm={handleConfirmAction}
        />
      </div>
    </AppShell>
  );
}
