"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import {
  ChevronDown,
  Clock,
  Eye,
  FileText,
  RotateCcw,
  Search,
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
  fetchCasesByScope,
  restoreCase,
  type SavedCaseRecord,
} from "@/lib/case-persistence";

type LoadState = "loading" | "ready" | "error";
type PendingAction =
  | { type: "destroy"; item: SavedCaseRecord }
  | { type: "restore"; item: SavedCaseRecord }
  | null;

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
            <TableHead className="h-10 pl-4 md:pl-6 font-bold text-[#94a3b8] text-[11px] uppercase tracking-wider">Document</TableHead>
            <TableHead className="h-10 font-bold text-[#94a3b8] text-[11px] uppercase tracking-wider">Receiver</TableHead>
            <TableHead className="h-10 font-bold text-[#94a3b8] text-[11px] uppercase tracking-wider">Expires</TableHead>
            <TableHead className="h-10 font-bold text-[#94a3b8] text-[11px] uppercase tracking-wider text-right pr-4 md:pr-6">Actions</TableHead>
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
  const [pendingAction, setPendingAction] = useState<PendingAction>(null);
  const [isMutating, setIsMutating] = useState(false);

  useEffect(() => {
    let active = true;

    fetchCasesByScope("deleted", 100)
      .then((payload) => {
        if (!active) return;
        setCases(payload.cases);
        setStatus("ready");
      })
      .catch((loadError) => {
        if (!active) return;
        setError(
          loadError instanceof Error ? loadError.message : "Failed to load recycle bin."
        );
        setStatus("error");
      });

    return () => {
      active = false;
    };
  }, []);

  const filteredCases = useMemo(() => {
    if (!query.trim()) return cases;
    const normalized = query.trim().toLowerCase();

    return cases.filter((item) => {
      return (
      item.displayName.toLowerCase().includes(normalized) ||
      item.slug.toLowerCase().includes(normalized) ||
      (item.receiverName ?? "").toLowerCase().includes(normalized) ||
      item.category.toLowerCase().includes(normalized)
      );
    });
  }, [cases, query]);

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
      <div className="mx-auto max-w-[1500px] w-full px-4 sm:px-6 lg:px-8 py-8 animate-in fade-in duration-700 ease-out text-[#0f172a]">

        {/* MAIN CONTAINER matching the image's white box UI */}
        <div className="bg-white border border-[#e2e8f0] rounded-2xl shadow-[0_8px_30px_rgba(0,0,0,0.04)] overflow-hidden flex flex-col">

          {/* =========================================
              HEADER SECTION (Matches Image)
              ========================================= */}
          <div className="p-6 md:p-8 border-b border-[#f1f5f9] flex flex-col md:flex-row justify-between items-start md:items-center gap-6">

            <div className="flex items-center gap-5">
              <div className="w-14 h-14 bg-[#fef2f2] border border-[#fecaca] text-[#e11d48] rounded-2xl flex items-center justify-center shadow-sm">
                <Trash2 className="w-7 h-7" />
              </div>
              <div>
                <h1 className="text-2xl font-extrabold text-[#0f172a] tracking-tight">Recycle Bin</h1>
                <div className="text-sm font-semibold text-[#94a3b8] mt-0.5">
                  {status === "loading" ? (
                    <Skeleton className="mt-1 h-3.5 w-60 bg-slate-100" />
                  ) : (
                    `${filteredCases.length} items • Auto-deleted after 30 days`
                  )}
                </div>
              </div>
            </div>
          </div>

          {/* =========================================
              SEARCH BAR (Matches Image)
              ========================================= */}
          <div className="p-6 md:px-8 md:py-6">
            <div className="flex items-center px-4 py-2.5 border border-[#e2e8f0] rounded-xl bg-[#f8fafc] shadow-sm max-w-md">
              <Search className="w-4 h-4 text-[#94a3b8] mr-3 shrink-0" />
              <input
                type="text"
                placeholder="Search deleted items..."
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                className="w-full outline-none text-sm font-medium text-[#0f172a] placeholder:text-[#94a3b8] bg-transparent"
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
                  <div className="font-bold text-base mb-1">Failed to load recycle bin</div>
                  <div>{error}</div>
                </div>
              </div>
            )}

            {status === "ready" && cases.length === 0 && (
              <div className="flex flex-col items-center justify-center py-24 text-center px-4">
                <div className="mb-5 flex h-16 w-16 items-center justify-center rounded-full bg-[#f8fafc] border border-[#e2e8f0] shadow-sm">
                  <Trash2 className="h-8 w-8 text-[#cbd5e1]" />
                </div>
                <h3 className="text-lg font-bold text-[#0f172a]">Recycle Bin is Empty</h3>
                <p className="mt-2 text-sm font-medium text-[#64748b] max-w-sm">
                  Items you delete will appear here for 30 days before being permanently removed.
                </p>
              </div>
            )}

            {status === "ready" && cases.length > 0 && filteredCases.length === 0 && (
              <div className="flex flex-col items-center justify-center py-24 text-center px-4">
                <Search className="h-10 w-10 text-[#e2e8f0] mb-4" />
                <h3 className="text-base font-bold text-[#0f172a]">No matches found</h3>
                <p className="mt-1 text-sm font-medium text-[#64748b]">
                  We couldn&apos;t find any deleted items matching &quot;{query}&quot;.
                </p>
                <Button
                  variant="link"
                  onClick={() => setQuery("")}
                  className="mt-2 text-[#4f46e5] font-bold"
                >
                  Clear search
                </Button>
              </div>
            )}

            {status === "ready" && filteredCases.length > 0 && (
              <>
                <div className="grid gap-3 px-4 pb-2 md:hidden">
                  {filteredCases.map((item) => (
                    <div
                      key={item.id}
                      className="rounded-xl border border-[#e2e8f0] bg-white p-3.5 shadow-sm"
                    >
                      <div className="flex items-start gap-2.5">
                        <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border border-[#e2e8f0] bg-[#f8fafc] text-[#64748b]">
                          <FileText className="h-4 w-4" />
                        </div>
                        <div className="min-w-0 flex-1">
                          <Link
                            href={`/cases/${item.id}`}
                            className="block truncate text-sm font-bold text-[#0f172a] hover:text-[#4f46e5]" title={item.displayName || "Unnamed Document"}
                          >
                            {item.displayName || "Unnamed Document"}
                          </Link>
                          <div className="mt-0.5 text-[11px] font-medium text-[#94a3b8]">
                            {formatDateTime(item.deletedAt)} • by Admin
                          </div>
                        </div>
                      </div>

                      <div className="mt-2.5 flex items-center justify-between border-t border-slate-100 pt-2.5 text-[11px] font-semibold text-[#94a3b8]">
                        <span className="truncate max-w-[140px]" title={item.receiverName || "Receiver pending"}>{item.receiverName || "Receiver pending"}</span>
                        <span className="flex items-center gap-1 shrink-0">
                          <Clock className="h-3 w-3" />
                          {calculateDaysRemaining(item.deletedAt)}d left
                        </span>
                      </div>

                      <div className="mt-2.5 flex items-center justify-end gap-2">
                        <Link
                          href={`/cases/${item.id}`}
                          className="rounded-md border border-[#e2e8f0] p-1.5 text-[#64748b] transition-colors hover:bg-[#f8fafc] hover:text-[#0f172a]"
                          aria-label="View"
                        >
                          <Eye className="h-3.5 w-3.5" />
                        </Link>
                        <button
                          className="rounded-md border border-[#e0e7ff] p-1.5 text-[#4f46e5] transition-colors hover:bg-[#eef2ff]"
                          aria-label="Restore"
                          onClick={() => setPendingAction({ type: "restore", item })}
                        >
                          <RotateCcw className="h-3.5 w-3.5" />
                        </button>
                        <button
                          className="rounded-md border border-[#fecaca] p-1.5 text-[#e11d48] transition-colors hover:bg-[#fef2f2]"
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
                      <TableRow className="border-b border-[#f1f5f9] hover:bg-transparent">
                        <TableHead className="h-10 pl-4 md:pl-6 font-bold text-[#94a3b8] text-[11px] uppercase tracking-wider">Document</TableHead>
                        <TableHead className="h-10 font-bold text-[#94a3b8] text-[11px] uppercase tracking-wider">Receiver</TableHead>
                        <TableHead className="h-10 font-bold text-[#94a3b8] text-[11px] uppercase tracking-wider">Expires</TableHead>
                        <TableHead className="h-10 font-bold text-[#94a3b8] text-[11px] uppercase tracking-wider text-right pr-4 md:pr-6">Actions</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {filteredCases.map((item) => (
                        <TableRow
                          key={item.id}
                          className="group border-[#f1f5f9] transition-colors hover:bg-[#f8fafc] h-11"
                        >
                          <TableCell className="py-2 pl-4 md:pl-6">
                            <div className="flex items-center gap-2.5">
                              <div className="w-7 h-7 rounded-md bg-[#f1f5f9] border border-[#e2e8f0] text-[#64748b] flex items-center justify-center shrink-0">
                                <FileText className="w-3.5 h-3.5" />
                              </div>
                              <div className="min-w-0">
                                <Link
                                  href={`/cases/${item.id}`}
                                  className="font-semibold text-[#0f172a] text-[13px] transition-colors hover:text-[#4f46e5] truncate block max-w-[200px] xl:max-w-[300px]" title={item.displayName || "Unnamed Document"}
                                >
                                  {item.displayName || "Unnamed Document"}
                                </Link>
                                <div className="text-[11px] font-medium text-[#94a3b8] mt-px">
                                  {formatDateTime(item.deletedAt)}
                                </div>
                              </div>
                            </div>
                          </TableCell>

                          <TableCell className="py-2">
                            <div className="flex items-center gap-1.5">
                              <div className="w-1.5 h-1.5 rounded-full bg-[#10b981] shrink-0" />
                              <span className="text-[13px] font-medium text-[#64748b] truncate max-w-[140px]" title={item.receiverName || "Receiver pending"}>
                                {item.receiverName || "Receiver pending"}
                              </span>
                            </div>
                          </TableCell>

                          <TableCell className="py-2">
                            <div className="flex items-center gap-1 text-[13px] font-medium text-[#64748b]">
                              <Clock className="w-3 h-3" />
                              {calculateDaysRemaining(item.deletedAt)}d
                            </div>
                          </TableCell>

                          <TableCell className="pr-4 md:pr-6 py-2 text-right">
                            <div className="flex items-center justify-end gap-2 text-[#94a3b8]">
                              <Link
                                href={`/cases/${item.id}`}
                                className="p-1 hover:text-[#0f172a] hover:bg-[#f1f5f9] rounded-md transition-colors"
                                aria-label="View"
                              >
                                <Eye className="w-3.5 h-3.5" />
                              </Link>
                              <button
                                className="p-1 hover:text-[#4f46e5] hover:bg-[#eef2ff] rounded-md transition-colors"
                                aria-label="Restore"
                                onClick={() => setPendingAction({ type: "restore", item })}
                              >
                                <RotateCcw className="w-3.5 h-3.5" />
                              </button>
                              <button
                                className="p-1 hover:text-[#e11d48] hover:bg-[#fef2f2] rounded-md transition-colors"
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

            {/* Pagination Footer (Placeholder matching image) */}
            {status === "ready" && filteredCases.length > 0 && (
              <div className="px-6 md:px-8 pt-4 pb-2 flex items-center justify-between text-sm font-semibold text-[#94a3b8]">
                <div>Page 1 of 1</div>
                <div className="flex items-center gap-4">
                  <button className="flex items-center opacity-50 cursor-not-allowed">
                    <ChevronDown className="w-4 h-4 rotate-90 mr-1" /> Previous
                  </button>
                  <button className="flex items-center opacity-50 cursor-not-allowed">
                    Next <ChevronDown className="w-4 h-4 -rotate-90 ml-1" />
                  </button>
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
