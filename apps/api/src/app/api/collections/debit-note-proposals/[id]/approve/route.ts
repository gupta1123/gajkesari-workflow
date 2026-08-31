import { browserDatasetIds, targetForDataset } from "@/lib/tally/browser-scope";
import { jsonWithCors, optionsWithCors } from "@/lib/api/cors";
import { requireRequestUser } from "@/lib/api/request-auth";
import {
  serializeDebitNoteProposal,
  toNumber,
  toText,
  type DebitNoteProposalRow,
} from "@/lib/collections";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { serializeTallyBridgeCommand, type TallyBridgeCommandRow } from "@/lib/tally/commands";

function isMissingTableError(error: unknown) {
  const message = error instanceof Error ? error.message : String((error as { message?: unknown })?.message ?? "");
  return /debit_note_proposals|relation .* does not exist|schema cache/i.test(message);
}

export function OPTIONS(request: Request) {
  return optionsWithCors(request);
}

export async function POST(
  request: Request,
  context: { params: Promise<{ id: string }> }
) {
  try {
    const user = await requireRequestUser(request);
    if (!user) {
      return jsonWithCors(request, { error: "Unauthorized" }, { status: 401 });
    }

    const { id } = await context.params;
    const supabase = createSupabaseAdminClient();
    const { data: proposalData, error: proposalError } = await supabase
      .from("debit_note_proposals")
      .select("*")
      .eq("id", id)
      .eq("owner_user_id", user.id)
      .in("company_dataset_id", await browserDatasetIds(request, user.id))
      .maybeSingle();

    if (proposalError) throw proposalError;
    if (!proposalData) {
      return jsonWithCors(request, { error: "Debit note proposal not found." }, { status: 404 });
    }

    const proposal = proposalData as unknown as DebitNoteProposalRow;
    if (!["draft", "pending_approval", "failed"].includes(proposal.status)) {
      return jsonWithCors(
        request,
        { error: `Proposal cannot be approved from status ${proposal.status}.` },
        { status: 409 }
      );
    }
    if (!proposal.connection_id) {
      return jsonWithCors(request, { error: "Proposal is missing a Tally connection." }, { status: 400 });
    }
    if (toNumber(proposal.recoverable_amount) <= 0) {
      return jsonWithCors(request, { error: "Recoverable amount must be greater than zero." }, { status: 400 });
    }
    const salesLedgerName = toText(proposal.customer_snapshot?.sourceSalesLedgerName, 500);
    if (!salesLedgerName) {
      return jsonWithCors(
        request,
        { error: "The original invoice Sales ledger is not available for this saved proposal. Sync Tally and refresh to regenerate it safely." },
        { status: 409 }
      );
    }

    const target = await targetForDataset(request, user.id, String(proposalData.company_dataset_id));
    const commandConnection = { id: target.connectionId };
    const proposalCompanyName = target.companyName;

    const commandPayload = {
      target,
      proposalId: proposal.id,
      companyName: proposalCompanyName,
      partyLedgerName: proposal.party_ledger_name,
      partyGstin: proposal.party_gstin,
      linkedInvoiceNumber: proposal.linked_invoice_number,
      linkedInvoiceDate: proposal.linked_invoice_date,
      voucherDate: proposal.debit_note_date,
      amount: toNumber(proposal.recoverable_amount),
      adjustOriginalInvoice: false,
      salesLedgerName,
      referenceNumber: proposal.linked_invoice_number
        ? `DN-CD-${proposal.linked_invoice_number}`.slice(0, 120)
        : `DN-CD-${proposal.id.slice(0, 8)}`,
      narration: proposal.narration,
      reasonCode: proposal.reason_code,
      gstMode: proposal.gst_mode,
    };

    const { data: queued, error: queueError } = await supabase.rpc("enqueue_debit_note_proposal", {
      p_owner: user.id, p_proposal: proposal.id, p_connection: target.connectionId,
      p_target: target, p_payload: commandPayload,
    });
    if (queueError) throw queueError;
    const command = queued.command as TallyBridgeCommandRow;
    const updatedData = queued.proposal as DebitNoteProposalRow;

    await supabase.from("tally_connection_events").insert({
      connection_id: commandConnection.id,
      owner_user_id: user.id,
      event_type: "command_queued",
      message: "Debit note creation queued for bridge.",
      payload: {
        commandType: "create_debit_note",
        proposalId: proposal.id,
        amount: commandPayload.amount,
        commandConnectionId: commandConnection.id,
      },
    });

    return jsonWithCors(request, {
      proposal: serializeDebitNoteProposal(updatedData as unknown as DebitNoteProposalRow),
      command: serializeTallyBridgeCommand(command),
    });
  } catch (error) {
    if (isMissingTableError(error)) {
      return jsonWithCors(
        request,
        { error: "Run the collections cash discount migration before approving proposals.", setupRequired: true },
        { status: 409 }
      );
    }

    console.error("Error in POST /api/collections/debit-note-proposals/[id]/approve:", error);
    return jsonWithCors(
      request,
      { error: error instanceof Error ? error.message : "Internal server error" },
      { status: 500 }
    );
  }
}
