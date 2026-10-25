export type DuplicateDecision = { action: 'skip' | 'separate'; rowKey: string; context: Record<string, unknown>;
  candidates: Array<Record<string, unknown>>; decidedBy: string; decidedAt: string; importId?: string };
export function isTrackingReference(value: unknown): boolean;
export function duplicateRowKey(row: object): string;
export function duplicateContext(row: object, bank?: string, ledger?: string): Record<string, unknown>;
export function candidateIdentity(match: object): Record<string, unknown>;
export function canResolveRepeatedPayment(row: object, rows: object[], matches: object[], bank: string, ledger: string): boolean;
export function resolutionForRow(decisions: Record<string, DuplicateDecision>, row: object, bank: string, ledger: string): DuplicateDecision | null;
export function applySeparatePaymentDecision(decision: unknown, row: object, candidates: any[], bank: string, ledger: string): { candidates: any[]; stale: boolean };
