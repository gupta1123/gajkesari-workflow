"use client";

import { Loader2, TriangleAlert } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

type CaseConfirmDialogProps = {
  open: boolean;
  title: string;
  description: string;
  confirmLabel: string;
  loading?: boolean;
  variant?: "danger" | "default";
  onOpenChange: (open: boolean) => void;
  onConfirm: () => void;
};

export function CaseConfirmDialog({
  open,
  title,
  description,
  confirmLabel,
  loading = false,
  variant = "danger",
  onOpenChange,
  onConfirm,
}: CaseConfirmDialogProps) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md p-0">
        <div className="border-b border-slate-100 bg-gradient-to-r from-white to-slate-50 px-6 py-5">
          <DialogHeader>
            <div className="mb-3 flex h-11 w-11 items-center justify-center rounded-2xl bg-rose-50 text-rose-600">
              <TriangleAlert className="h-5 w-5" />
            </div>
            <DialogTitle>{title}</DialogTitle>
            <DialogDescription>{description}</DialogDescription>
          </DialogHeader>
        </div>

        <DialogFooter className="px-6 pb-6">
          <Button
            type="button"
            variant="outline"
            className="border-slate-200 text-slate-700 hover:bg-slate-50"
            onClick={() => onOpenChange(false)}
            disabled={loading}
          >
            Cancel
          </Button>
          <Button
            type="button"
            variant={variant === "danger" ? "destructive" : "default"}
            className={variant === "default" ? "bg-slate-900 hover:bg-slate-800" : undefined}
            onClick={onConfirm}
            disabled={loading}
          >
            {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
            {confirmLabel}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
