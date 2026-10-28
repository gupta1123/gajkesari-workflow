import { readCompleteHistory } from '@/lib/collections-history';
import { jsonWithCors, optionsWithCors } from "@/lib/api/cors";
import { requireRequestUser } from "@/lib/api/request-auth";
import { readTallyOpenBills } from "@/lib/collections-dashboard";
import { businessDateText } from "@/lib/business-date";
import { analyseCashDiscountNarration, isCashDiscountRecoveryStatus } from "@/lib/cash-discount-narration";
import { isNonSalesVoucher } from '@/lib/payment-terms';
import { toNumber, toText } from "@/lib/collections";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { browserOwnsConnection } from "@/lib/tally/browser-scope";
import { wakeTallyConnector } from "@/lib/tally/command-wake";
import { serializeTallyBridgeCommand, type TallyBridgeCommandRow } from "@/lib/tally/commands";

type LiveLedger = {
  name?: string | null;
  parent?: string | null;
  gstin?: string | null;
  raw?: Record<string, unknown> | null;
};

function normalized(value: unknown) {
  return String(value ?? "").trim().toLowerCase().replace(/\s+/g, " ");
}

function nullableText(value: unknown, maxLength = 500) {
  return toText(value, maxLength) || null;
}

export function OPTIONS(request: Request) {
  return optionsWithCors(request);
}

async function POSTHandler(request: Request) {
  try {
    const user = await requireRequestUser(request);
    if (!user) return jsonWithCors(request, { error: "Unauthorized" }, { status: 401 });

    const body = await request.json().catch(() => ({}));
    const connectionId = toText(body.connectionId, 80);
    const companyName = toText(body.companyName, 240);
    const requestedProposal = body.proposal && typeof body.proposal === "object"
      ? (body.proposal as Record<string, unknown>)
      : {};
    const partyLedgerName = toText(requestedProposal.partyLedgerName, 500);
    const linkedInvoiceNumber = toText(requestedProposal.linkedInvoiceNumber, 120);
    const scan = body.scan && typeof body.scan === "object"
      ? (body.scan as Record<string, unknown>)
      : {};
    const openBillsResult = scan.openBillsResult && typeof scan.openBillsResult === "object"
      ? (scan.openBillsResult as Record<string, unknown>)
      : null;
    const ledgers = Array.isArray(scan.ledgers) ? (scan.ledgers as LiveLedger[]) : [];

    if (!connectionId || !companyName || !partyLedgerName || !linkedInvoiceNumber || !openBillsResult) {
      return jsonWithCors(request, { error: "The live Debit Note recheck is incomplete." }, { status: 400 });
    }
    if (scan.scanSummary && typeof scan.scanSummary === "object" && (scan.scanSummary as Record<string, unknown>).complete === false) {
      return jsonWithCors(request, { error: "The invoice recheck is incomplete. Refresh before creating a debit note." }, { status: 409 });
    }

    if (!await browserOwnsConnection(request, user.id, connectionId)) {
      return jsonWithCors(request, { error: "Pair this browser with its local connector first." }, { status: 403 });
    }
    const supabase = createSupabaseAdminClient();
    const createdQuery = supabase.from("debit_note_proposals").select("party_ledger_name, linked_invoice_number, recoverable_amount, reason_code, financial_year")
      .eq("company_name", companyName).eq("status", "created_in_tally").eq("owner_user_id", user.id).order("id");
    const [{ data: connection, error: connectionError }, { data: createdRows, error: createdRowsError }] =
      await Promise.all([
        supabase
          .from("tally_connections")
          .select("id, owner_user_id, last_company_name, last_tally_reachable, last_company_loaded")
          .eq("id", connectionId)
          .eq("owner_user_id", user.id)
          .is("revoked_at", null)
          .maybeSingle(),
        readCompleteHistory((from,to) => createdQuery.range(from,to)).then(data => ({data,error:null})),
      ]);
    if (connectionError) throw connectionError;
    if (createdRowsError) throw createdRowsError;
    if (!connection) return jsonWithCors(request, { error: "Tally connection not found." }, { status: 404 });
    if (
      connection.last_tally_reachable !== true ||
      connection.last_company_loaded !== true ||
      normalized(connection.last_company_name) !== normalized(companyName)
    ) {
      return jsonWithCors(request, { error: "The selected Tally company is no longer live." }, { status: 409 });
    }

    const matchingBill = readTallyOpenBills(openBillsResult, true).find(
      (row) => normalized(row.ledgerName) === normalized(partyLedgerName) &&
        [row.bill.referenceName, row.bill.voucherNumber].some((value) => normalized(value) === normalized(linkedInvoiceNumber))
    );
    if (!matchingBill) {
      return jsonWithCors(
        request,
        { error: "The invoice could not be verified in the latest Tally evidence. Refresh Cash Discounts and review it again." },
        { status: 409 }
      );
    }

    const bill = matchingBill.bill;
    const originalAmount = toNumber(bill.originalAmount);
    const pendingAmount = toNumber(bill.pendingAmount);
    const invoiceDate = nullableText(bill.invoiceDate, 20);
    const today = businessDateText();
    if (bill.kind === "advance" || isNonSalesVoucher(bill.sourceVoucherType) || originalAmount <= 0 || pendingAmount < 0) {
      return jsonWithCors(request, { error: "The invoice is no longer eligible for a Debit Note." }, { status: 409 });
    }

    const analysis = analyseCashDiscountNarration({
      narration: bill.narration,
      invoiceDate,
      originalAmount,
      pendingAmount,
      receiptDate: bill.receiptDate,
      matchedReceiptAmount: toNumber(bill.matchedReceiptAmount, Number.NaN),
      invoiceEvidenceAmbiguous: bill.invoiceEvidenceAmbiguous,
      today,
    });
    if (!isCashDiscountRecoveryStatus(analysis.deterministicStatus)) {
      return jsonWithCors(
        request,
        { error: `The latest Tally data is not eligible for a Debit Note: ${analysis.deterministicReason}` },
        { status: 409 }
      );
    }

    const salesLedgerName = toText(bill.sourceSalesLedgerName, 500);
    if (!salesLedgerName) {
      return jsonWithCors(
        request,
        { error: "The original invoice Sales ledger could not be verified in the live Tally data." },
        { status: 409 }
      );
    }

    const alreadyCreatedReversalAmount = (createdRows ?? [])
      .filter(row => !requestedProposal.financialYear || !row.financial_year || row.financial_year === requestedProposal.financialYear)
      .filter((row) => String(row.reason_code ?? "").startsWith("cash_discount_") &&
        normalized(row.party_ledger_name) === normalized(matchingBill.ledgerName) &&
        normalized(row.linked_invoice_number) === normalized(linkedInvoiceNumber))
      .reduce((sum, row) => sum + toNumber(row.recoverable_amount), 0);
    const requiredReversalAmount = toNumber(analysis.reversalPlan?.totalReversalRequired);
    const recoverableAmount = Math.max(
      0,
      Math.round((requiredReversalAmount - alreadyCreatedReversalAmount) * 100) / 100
    );
    if (recoverableAmount <= 0.01) {
      return jsonWithCors(
        request,
        { error: "The required cash-discount reversal has already been created in Tally." },
        { status: 409 }
      );
    }

    const ledger = ledgers.find((entry) => normalized(entry.name) === normalized(matchingBill.ledgerName));
    const raw = ledger?.raw && typeof ledger.raw === "object" ? ledger.raw : {};
    const isTierReversal = isCashDiscountRecoveryStatus(analysis.deterministicStatus);
    const referenceSuffix = isTierReversal
      ? `T${analysis.reversalPlan?.activeDiscount?.eligibilityDays ?? "FINAL"}`
      : "SHORT";
    const referenceNumber = `DN-CD-${linkedInvoiceNumber}-${referenceSuffix}`.slice(0, 120);
    const termsLabel = analysis.termsLabel ?? "Cash discount";
    const stagedNarration = analysis.reversalPlan
      ? ` Tally invoice is treated as net after ${analysis.reversalPlan.initialDiscount.ratePercent}%: gross basis INR ${analysis.reversalPlan.grossInvoiceAmount.toLocaleString("en-IN")}; payable now INR ${analysis.reversalPlan.currentPayableAmount.toLocaleString("en-IN")}; cumulative reversal INR ${analysis.reversalPlan.totalReversalRequired.toLocaleString("en-IN")}; already created INR ${alreadyCreatedReversalAmount.toLocaleString("en-IN")}.`
      : "";

    const commandPayload = {
      companyName,
      partyLedgerName: matchingBill.ledgerName,
      partyGstin: nullableText(ledger?.gstin, 32),
      linkedInvoiceNumber,
      linkedInvoiceDate: invoiceDate,
      voucherDate: today,
      amount: recoverableAmount,
      adjustOriginalInvoice: false,
      salesLedgerName,
      referenceNumber,
      narration: `Cash discount recovery against invoice ${linkedInvoiceNumber}. Terms: ${termsLabel}.${stagedNarration} Source narration: ${analysis.sourceNarration}`,
      reasonCode: isTierReversal ? "cash_discount_unpaid_tier_reversal" : "cash_discount_narration_expired",
      gstMode: "finance_review",
      sourceProposal: {
        financialYear: nullableText(requestedProposal.financialYear, 20),
        partyEmail: nullableText(raw.email, 320),
        partyPhone: nullableText(raw.phone, 80),
        partyContactPerson: nullableText(raw.contactPerson, 240),
        partyAddress: nullableText(raw.address, 1000),
        originalInvoiceAmount: originalAmount,
        cashDiscountRuleId: null,
        cashDiscountRuleName: termsLabel,
        discountDeadline: analysis.discountDeadline,
        receiptDate: analysis.receiptDate,
        amountReceived: Math.max(originalAmount - pendingAmount, 0),
        customerSnapshot: {
          ledgerName: ledger?.name ?? matchingBill.ledgerName,
          parentName: ledger?.parent ?? null,
          gstin: ledger?.gstin ?? null,
          email: nullableText(raw.email, 320),
          phone: nullableText(raw.phone, 80),
          contactPerson: nullableText(raw.contactPerson, 240),
          address: nullableText(raw.address, 1000),
          sourceSalesLedgerName: salesLedgerName,
          cashDiscountAnalysis: { ...analysis, calculationVersion: "cash_discount_v2" },
        },
      },
    };

    if (body.queue !== true) {
      return jsonWithCors(request, { commandPayload });
    }

    const idempotencyKey = [companyName, String(requestedProposal.financialYear || ''), matchingBill.ledgerName, linkedInvoiceNumber, referenceSuffix]
      .map(normalized)
      .join("|");
    const { data: commandData, error: commandError } = await supabase
      .from("tally_bridge_commands")
      .insert({
        connection_id: connection.id,
        owner_user_id: user.id,
        command_type: "create_debit_note",
        idempotency_key: idempotencyKey,
        status: "queued",
        priority: 35,
        payload: commandPayload,
      })
      .select("*")
      .single();
    if (commandError) {
      if (commandError.code === "23505") {
        return jsonWithCors(
          request,
          { error: "A Debit Note for this invoice is already queued or being created." },
          { status: 409 }
        );
      }
      throw commandError;
    }

    await Promise.all([
      supabase.from("tally_connection_events").insert({
        connection_id: connection.id,
        owner_user_id: user.id,
        event_type: "command_queued",
        message: "Revalidated Cash Discount Debit Note queued for bridge.",
        payload: {
          commandType: "create_debit_note",
          partyLedgerName: matchingBill.ledgerName,
          amount: recoverableAmount,
        },
      }),
      wakeTallyConnector(connection.id),
    ]);

    return jsonWithCors(request, {
      durable: true,
      commandPayload,
      command: serializeTallyBridgeCommand(commandData as unknown as TallyBridgeCommandRow),
    });
  } catch (error) {
    
    console.error("Error in POST /api/collections/live/prepare-debit-note:", error);
    return jsonWithCors(
      request,
      { error: error instanceof Error ? error.message : "Could not prepare the live Debit Note." },
      { status: 500 }
    );
  }
}

export const POST = POSTHandler;
