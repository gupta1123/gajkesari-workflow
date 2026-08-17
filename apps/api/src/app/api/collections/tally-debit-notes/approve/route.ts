import { jsonWithCors, optionsWithCors } from "@/lib/api/cors";
import { requireRequestUser } from "@/lib/api/request-auth";
import { toNullableText, toNumber, toText } from "@/lib/collections";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { serializeTallyBridgeCommand, type TallyBridgeCommandRow } from "@/lib/tally/commands";

function isLiveConnection(row: { status?: string | null; last_tally_reachable?: boolean | null; last_company_loaded?: boolean | null }) {
  return row.status === "company_loaded" || (row.last_tally_reachable === true && row.last_company_loaded === true);
}

function normalizeCompanyName(value: string | null | undefined) {
  return String(value ?? "").trim().toLowerCase().replace(/\s+/g, " ");
}

export function OPTIONS(request: Request) {
  return optionsWithCors(request);
}

export async function POST(request: Request) {
  try {
    const user = await requireRequestUser(request);
    if (!user) {
      return jsonWithCors(request, { error: "Unauthorized" }, { status: 401 });
    }

    const body = await request.json().catch(() => ({}));
    const proposal = body.proposal && typeof body.proposal === "object"
      ? (body.proposal as Record<string, unknown>)
      : body;
    const connectionId = toNullableText(body.connectionId ?? proposal.connectionId, 80);
    const partyLedgerName = toText(proposal.partyLedgerName, 500);
    const salesLedgerName = toText(proposal.sourceSalesLedgerName, 500);
    const recoverableAmount = toNumber(proposal.recoverableAmount);

    if (!connectionId) {
      return jsonWithCors(request, { error: "Tally company/connection is required." }, { status: 400 });
    }
    if (!partyLedgerName) {
      return jsonWithCors(request, { error: "Party ledger is required." }, { status: 400 });
    }
    if (!salesLedgerName) {
      return jsonWithCors(
        request,
        { error: "The original invoice Sales ledger could not be verified. Sync Tally and refresh before creating this debit note." },
        { status: 409 }
      );
    }
    if (recoverableAmount <= 0) {
      return jsonWithCors(request, { error: "Recoverable amount must be greater than zero." }, { status: 400 });
    }

    const supabase = createSupabaseAdminClient();
    const { data: connection, error: connectionError } = await supabase
      .from("tally_connections")
      .select("id, owner_user_id, last_company_name, status, last_tally_reachable, last_company_loaded, last_heartbeat_at, updated_at")
      .eq("id", connectionId)
      .eq("owner_user_id", user.id)
      .maybeSingle();

    if (connectionError) throw connectionError;
    if (!connection) {
      return jsonWithCors(request, { error: "Tally connection not found." }, { status: 404 });
    }

    const companyName = toNullableText(body.companyName ?? proposal.companyName, 240) ?? connection.last_company_name;
    if (!isLiveConnection(connection)) {
      return jsonWithCors(request, { error: "The selected Tally connection is not live." }, { status: 409 });
    }
    if (!companyName || normalizeCompanyName(connection.last_company_name) !== normalizeCompanyName(companyName)) {
      return jsonWithCors(
        request,
        { error: `Tally is currently open to ${connection.last_company_name || "another company"}. Switch it to ${companyName || "the selected company"}, refresh, then create the debit note.` },
        { status: 409 }
      );
    }

    const linkedInvoiceNumber = toNullableText(proposal.linkedInvoiceNumber, 120);
    const commandPayload = {
      companyName,
      partyLedgerName,
      partyGstin: toNullableText(proposal.partyGstin, 32),
      linkedInvoiceNumber,
      linkedInvoiceDate: toNullableText(proposal.linkedInvoiceDate, 20),
      voucherDate: toNullableText(proposal.debitNoteDate, 20) ?? new Date().toISOString().slice(0, 10),
      amount: recoverableAmount,
      // The original open bill stays open. This is an additional charge for
      // the missed discount, posted against the Sales ledger of that invoice.
      adjustOriginalInvoice: false,
      salesLedgerName,
      referenceNumber:
        toNullableText(proposal.referenceNumber, 120) ??
        (linkedInvoiceNumber ? `DN-CD-${linkedInvoiceNumber}`.slice(0, 120) : `DN-CD-${Date.now()}`),
      narration:
        toNullableText(proposal.narration, 1000) ??
        `Cash discount recovery against invoice ${linkedInvoiceNumber ?? "-"}.`,
      reasonCode: toNullableText(proposal.reasonCode, 80) ?? "cash_discount_expired",
      gstMode: toNullableText(proposal.gstMode, 80) ?? "finance_review",
      sourceProposal: proposal,
    };

    const { data: commandData, error: commandError } = await supabase
      .from("tally_bridge_commands")
      .insert({
        connection_id: connection.id,
        owner_user_id: user.id,
        command_type: "create_debit_note",
        status: "queued",
        priority: 35,
        payload: commandPayload,
      })
      .select("*")
      .single();

    if (commandError) throw commandError;

    await supabase.from("tally_connection_events").insert({
      connection_id: connection.id,
      owner_user_id: user.id,
      event_type: "command_queued",
      message: "Debit note creation queued from Tally open-bill suggestion.",
      payload: {
        commandType: "create_debit_note",
        amount: recoverableAmount,
        partyLedgerName,
      },
    });

    return jsonWithCors(request, {
      command: serializeTallyBridgeCommand(commandData as unknown as TallyBridgeCommandRow),
    });
  } catch (error) {
    console.error("Error in POST /api/collections/tally-debit-notes/approve:", error);
    return jsonWithCors(
      request,
      { error: error instanceof Error ? error.message : "Internal server error" },
      { status: 500 }
    );
  }
}
