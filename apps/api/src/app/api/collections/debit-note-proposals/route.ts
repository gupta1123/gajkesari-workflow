import { jsonWithCors, optionsWithCors } from "@/lib/api/cors";
import { requireRequestUser } from "@/lib/api/request-auth";
import {
  serializeDebitNoteProposal,
  toDateText,
  toNullableText,
  toNumber,
  toText,
  type DebitNoteProposalRow,
} from "@/lib/collections";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";

function isMissingTableError(error: unknown) {
  const message = error instanceof Error ? error.message : String((error as { message?: unknown })?.message ?? "");
  return /debit_note_proposals|relation .* does not exist|schema cache/i.test(message);
}

function normalizeStatus(value: unknown) {
  const text = toText(value, 40);
  return ["draft", "pending_approval"].includes(text) ? text : "draft";
}

function normalizeGstMode(value: unknown) {
  const text = toText(value, 80);
  return ["without_gst", "with_gst", "finance_review"].includes(text) ? text : "finance_review";
}

type TallyLedgerRow = {
  tally_name: string;
  parent_name: string | null;
  gstin: string | null;
  raw_payload: Record<string, unknown> | null;
};

function readRawText(raw: Record<string, unknown> | null | undefined, key: string, maxLength = 500) {
  return toText(raw?.[key], maxLength) || null;
}

function statusPriority(status: string) {
  const rank: Record<string, number> = {
    created_in_tally: 60,
    queued_in_tally: 50,
    approved: 40,
    pending_approval: 30,
    draft: 20,
    failed: 10,
  };
  return rank[status] ?? 0;
}

function pickBestExistingProposal(rows: DebitNoteProposalRow[]) {
  return [...rows].sort((left, right) => {
    const rankDiff = statusPriority(right.status) - statusPriority(left.status);
    if (rankDiff !== 0) return rankDiff;
    return Date.parse(String(right.updated_at ?? right.created_at ?? "")) - Date.parse(String(left.updated_at ?? left.created_at ?? ""));
  })[0] ?? null;
}

export function OPTIONS(request: Request) {
  return optionsWithCors(request);
}

export async function GET(request: Request) {
  try {
    const user = await requireRequestUser(request);
    if (!user) {
      return jsonWithCors(request, { error: "Unauthorized" }, { status: 401 });
    }

    const url = new URL(request.url);
    const connectionId = url.searchParams.get("connectionId")?.trim();
    const status = url.searchParams.get("status")?.trim();
    const supabase = createSupabaseAdminClient();
    let query = supabase
      .from("debit_note_proposals")
      .select("*")
      .eq("owner_user_id", user.id)
      .order("created_at", { ascending: false })
      .limit(100);

    if (connectionId) {
      query = query.eq("connection_id", connectionId);
    }
    if (status && status !== "all") {
      query = query.eq("status", status);
    }

    const { data, error } = await query;
    if (error) throw error;

    return jsonWithCors(request, {
      proposals: ((data ?? []) as unknown as DebitNoteProposalRow[]).map(serializeDebitNoteProposal),
      setupRequired: false,
    });
  } catch (error) {
    if (isMissingTableError(error)) {
      return jsonWithCors(request, {
        proposals: [],
        setupRequired: true,
        error: "Run the collections cash discount migration before using debit-note proposals.",
      });
    }

    console.error("Error in GET /api/collections/debit-note-proposals:", error);
    return jsonWithCors(request, { error: "Internal server error" }, { status: 500 });
  }
}

export async function POST(request: Request) {
  try {
    const user = await requireRequestUser(request);
    if (!user) {
      return jsonWithCors(request, { error: "Unauthorized" }, { status: 401 });
    }

    const body = await request.json().catch(() => ({}));
    const connectionId = toNullableText(body.connectionId ?? body.connection_id, 80);
    const partyLedgerName = toText(body.partyLedgerName ?? body.party_ledger_name, 500);
    const recoverableAmount = toNumber(body.recoverableAmount ?? body.recoverable_amount);

    if (!connectionId) {
      return jsonWithCors(request, { error: "Tally company/connection is required." }, { status: 400 });
    }
    if (!partyLedgerName) {
      return jsonWithCors(request, { error: "Party ledger is required." }, { status: 400 });
    }
    if (recoverableAmount <= 0) {
      return jsonWithCors(request, { error: "Recoverable amount must be greater than zero." }, { status: 400 });
    }

    const supabase = createSupabaseAdminClient();
    const { data: connection, error: connectionError } = await supabase
      .from("tally_connections")
      .select("id, owner_user_id, last_company_name, display_name")
      .eq("id", connectionId)
      .eq("owner_user_id", user.id)
      .maybeSingle();

    if (connectionError) throw connectionError;
    if (!connection) {
      return jsonWithCors(request, { error: "Tally connection not found." }, { status: 404 });
    }

    const companyName = toNullableText(body.companyName ?? body.company_name, 240) ?? connection.last_company_name;
    const linkedInvoiceNumber = toNullableText(body.linkedInvoiceNumber ?? body.linked_invoice_number, 120);
    const compatibleConnectionIds = new Set([connectionId]);

    if (connection.last_company_name) {
      const { data: companyConnectionRows, error: companyConnectionError } = await supabase
        .from("tally_connections")
        .select("id")
        .eq("owner_user_id", user.id)
        .eq("last_company_name", connection.last_company_name)
        .limit(50);

      if (companyConnectionError) throw companyConnectionError;
      for (const row of companyConnectionRows ?? []) {
        if (row.id) compatibleConnectionIds.add(String(row.id));
      }
    }

    if (linkedInvoiceNumber) {
      const { data: existingRows, error: existingError } = await supabase
        .from("debit_note_proposals")
        .select("*")
        .eq("owner_user_id", user.id)
        .in("connection_id", Array.from(compatibleConnectionIds))
        .eq("party_ledger_name", partyLedgerName)
        .eq("linked_invoice_number", linkedInvoiceNumber)
        .eq("recoverable_amount", recoverableAmount)
        .eq("status", "created_in_tally")
        .limit(20);

      if (existingError) throw existingError;
      const existing = pickBestExistingProposal((existingRows ?? []) as unknown as DebitNoteProposalRow[]);
      if (existing) {
        return jsonWithCors(request, {
          proposal: serializeDebitNoteProposal(existing),
          duplicate: true,
        });
      }
    }

    const { data: ledgerData } = await supabase
      .from("tally_masters")
      .select("tally_name, parent_name, gstin, raw_payload")
      .eq("connection_id", connectionId)
      .eq("owner_user_id", user.id)
      .eq("master_type", "ledger")
      .eq("is_active", true)
      .eq("tally_name", partyLedgerName)
      .maybeSingle();

    const ledger = ledgerData as unknown as TallyLedgerRow | null;
    const raw = ledger?.raw_payload && typeof ledger.raw_payload === "object" ? ledger.raw_payload : {};
    const partyEmail =
      toNullableText(body.partyEmail ?? body.party_email, 320) ?? readRawText(raw, "email", 320);
    const partyPhone =
      toNullableText(body.partyPhone ?? body.party_phone, 80) ?? readRawText(raw, "phone", 80);
    const partyContactPerson =
      toNullableText(body.partyContactPerson ?? body.party_contact_person, 240) ??
      readRawText(raw, "contactPerson", 240);
    const partyAddress =
      toNullableText(body.partyAddress ?? body.party_address, 1000) ?? readRawText(raw, "address", 1000);
    const partyGstin = toNullableText(body.partyGstin ?? body.party_gstin, 32) ?? ledger?.gstin ?? null;

    const payload = {
      owner_user_id: user.id,
      connection_id: connectionId,
      company_name: companyName,
      financial_year: toNullableText(body.financialYear ?? body.financial_year, 20),
      source_transaction_id: toNullableText(body.sourceTransactionId ?? body.source_transaction_id, 80),
      party_ledger_name: partyLedgerName,
      party_gstin: partyGstin,
      party_email: partyEmail,
      party_phone: partyPhone,
      party_contact_person: partyContactPerson,
      party_address: partyAddress,
      linked_invoice_number: linkedInvoiceNumber,
      linked_invoice_date: toDateText(body.linkedInvoiceDate ?? body.linked_invoice_date),
      original_invoice_amount: body.originalInvoiceAmount ?? body.original_invoice_amount ?? null,
      cash_discount_rule_id: toNullableText(body.cashDiscountRuleId ?? body.cash_discount_rule_id, 80),
      cash_discount_rule_name: toNullableText(body.cashDiscountRuleName ?? body.cash_discount_rule_name, 160),
      discount_deadline: toDateText(body.discountDeadline ?? body.discount_deadline),
      receipt_date: toDateText(body.receiptDate ?? body.receipt_date),
      amount_received: body.amountReceived ?? body.amount_received ?? null,
      recoverable_amount: recoverableAmount,
      reason_code: toText(body.reasonCode ?? body.reason_code, 80) || "cash_discount_expired",
      narration:
        toNullableText(body.narration, 1000) ??
        `Cash discount reversal against Sales Invoice ${toText(body.linkedInvoiceNumber, 120) || "-"}.`,
      gst_mode: normalizeGstMode(body.gstMode ?? body.gst_mode),
      debit_note_date: toDateText(body.debitNoteDate ?? body.debit_note_date) ?? new Date().toISOString().slice(0, 10),
      status: normalizeStatus(body.status),
      tally_open_reference_name: toNullableText(body.tallyOpenReferenceName ?? body.tally_open_reference_name, 500),
      remaining_recoverable_amount: recoverableAmount,
      communication_status: "not_sent",
      customer_snapshot: {
        ledgerName: ledger?.tally_name ?? partyLedgerName,
        parentName: ledger?.parent_name ?? null,
        sourceSalesLedgerName: toNullableText(body.sourceSalesLedgerName ?? body.source_sales_ledger_name, 500),
        gstin: partyGstin,
        email: partyEmail,
        phone: partyPhone,
        contactPerson: partyContactPerson,
        address: partyAddress,
      },
    };

    const { data, error } = await supabase
      .from("debit_note_proposals")
      .insert(payload)
      .select("*")
      .single();

    if (error) throw error;

    return jsonWithCors(
      request,
      { proposal: serializeDebitNoteProposal(data as unknown as DebitNoteProposalRow) },
      { status: 201 }
    );
  } catch (error) {
    if (isMissingTableError(error)) {
      return jsonWithCors(
        request,
        { error: "Run the collections cash discount migration before creating proposals.", setupRequired: true },
        { status: 409 }
      );
    }

    console.error("Error in POST /api/collections/debit-note-proposals:", error);
    return jsonWithCors(request, { error: "Internal server error" }, { status: 500 });
  }
}
