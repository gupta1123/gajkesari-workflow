import { jsonWithCors, optionsWithCors } from "@/lib/api/cors";
import { requireRequestUser } from "@/lib/api/request-auth";
import { getNativeTallyPdfEvidence, serializeDebitNoteProposal, toNullableText, type DebitNoteProposalRow } from "@/lib/collections";
import { createDebitNotePdfSignedUrl } from "@/lib/debit-notes/pdf";
import { sendDebitNoteWhatsapp, getMsg91WhatsappConfig, normalizeWhatsappPhone } from "@/lib/msg91/whatsapp";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";

function isMissingTableError(error: unknown) {
  const message = error instanceof Error ? error.message : String((error as { message?: unknown })?.message ?? "");
  return /debit_note_proposals|relation .* does not exist|schema cache/i.test(message);
}

function getTenDigitPhone(value: unknown) {
  const digits = String(value ?? "").replace(/\D/g, "");
  if (digits.length === 10) return digits;
  if (digits.length === 12 && digits.startsWith("91")) return digits.slice(2);
  return null;
}

function getSnapshotPhone(snapshot: unknown) {
  if (!snapshot || typeof snapshot !== "object" || Array.isArray(snapshot)) return null;
  return getTenDigitPhone((snapshot as Record<string, unknown>).phone);
}

export function OPTIONS(request: Request) {
  return optionsWithCors(request);
}

export async function POST(
  request: Request,
  context: { params: Promise<{ id: string }> }
) {
  const { id } = await context.params;
  const supabase = createSupabaseAdminClient();
  let ownerUserId = "";

  try {
    const user = await requireRequestUser(request);
    if (!user) {
      return jsonWithCors(request, { error: "Unauthorized" }, { status: 401 });
    }
    ownerUserId = user.id;

    const body = await request.json().catch(() => ({}));
    const config = getMsg91WhatsappConfig();
    if (!config.isConfigured) {
      return jsonWithCors(request, { error: "MSG91 WhatsApp is not configured." }, { status: 409 });
    }

    const { data: proposalData, error: proposalError } = await supabase
      .from("debit_note_proposals")
      .select("*")
      .eq("id", id)
      .eq("owner_user_id", user.id)
      .maybeSingle();

    if (proposalError) throw proposalError;
    if (!proposalData) {
      return jsonWithCors(request, { error: "Debit note proposal not found." }, { status: 404 });
    }

    const proposal = proposalData as unknown as DebitNoteProposalRow;
    if (proposal.status !== "created_in_tally") {
      return jsonWithCors(request, { error: "Create the debit note in Tally before sending WhatsApp." }, { status: 409 });
    }
    if (!proposal.tally_pdf_reference || !getNativeTallyPdfEvidence(proposal.customer_snapshot)) {
      return jsonWithCors(
        request,
        {
          error: "The official Tally PDF is not ready yet. Prepare and verify the Tally document before sending WhatsApp.",
          nativePdfRequired: true,
        },
        { status: 409 }
      );
    }

    const enteredPhone = body.recipientPhone ? getTenDigitPhone(body.recipientPhone) : null;
    if (body.recipientPhone && !enteredPhone) {
      return jsonWithCors(request, { error: "Enter a valid 10-digit WhatsApp number." }, { status: 400 });
    }

    // The dashboard can recover the current number from the synced Tally
    // ledger before the legacy party_phone column is updated. The snapshot is
    // therefore a safe persisted fallback after an explicit dialog value.
    const recipientPhone = normalizeWhatsappPhone(
      enteredPhone ?? getTenDigitPhone(proposal.party_phone) ?? getSnapshotPhone(proposal.customer_snapshot)
    );
    if (!recipientPhone) {
      return jsonWithCors(request, { error: "Customer WhatsApp number is missing." }, { status: 400 });
    }
    const shouldSavePhoneToTally = body.savePhoneToTally === true && Boolean(body.recipientPhone);
    let tallySaveConnectionId = proposal.connection_id;

    // A proposal can belong to a retired connector after the same company has
    // been paired again. Always use the live connector supplied by the page for
    // a new Tally ledger update, rather than queueing work for an old bridge.
    if (shouldSavePhoneToTally && body.connectionId) {
      const requestedConnectionId = toNullableText(body.connectionId, 80);
      if (!requestedConnectionId) {
        return jsonWithCors(request, { error: "The active Tally connection is invalid." }, { status: 400 });
      }
      const { data: requestedConnection, error: requestedConnectionError } = await supabase
        .from("tally_connections")
        .select("id")
        .eq("id", requestedConnectionId)
        .eq("owner_user_id", user.id)
        .maybeSingle();
      if (requestedConnectionError) throw requestedConnectionError;
      if (!requestedConnection) {
        return jsonWithCors(request, { error: "The active Tally connection was not found." }, { status: 404 });
      }
      tallySaveConnectionId = requestedConnection.id;
    }

    const storedPdfUrl = await createDebitNotePdfSignedUrl(
      supabase as unknown as Parameters<typeof createDebitNotePdfSignedUrl>[0],
      proposal.tally_pdf_reference,
      60 * 60
    );
    const documentUrl = toNullableText(body.documentUrl, 2000) ?? storedPdfUrl ?? config.fallbackDocumentUrl;
    if (!documentUrl) {
      return jsonWithCors(
        request,
        { error: "Debit note PDF is missing. Recreate the debit note PDF before sending WhatsApp." },
        { status: 400 }
      );
    }

    const documentName =
      toNullableText(body.documentName, 180) ??
      (proposal.tally_voucher_number ? `${proposal.tally_voucher_number}.pdf` : undefined);
    const result = await sendDebitNoteWhatsapp({
      proposal,
      recipientPhone,
      documentUrl,
      documentName,
    });

    const now = new Date().toISOString();
    let phoneSaveCommandId: string | null = null;
    let phoneSaveQueueError: string | null = null;
    if (shouldSavePhoneToTally && tallySaveConnectionId) {
      const { data: commandData, error: commandError } = await supabase
        .from("tally_bridge_commands")
        .insert({
          connection_id: tallySaveConnectionId,
          owner_user_id: user.id,
          command_type: "alter_ledger",
          status: "queued",
          payload: {
            oldName: proposal.party_ledger_name,
            newName: proposal.party_ledger_name,
            phoneNumber: recipientPhone,
            companyName: proposal.company_name,
            reason: "cash_discount_whatsapp_phone_capture",
          },
        })
        .select("id")
        .single();

      if (!commandError) {
        phoneSaveCommandId = String(commandData?.id ?? "");
      } else {
        phoneSaveQueueError = "The number could not be queued for saving in Tally.";
        console.warn("Could not queue Tally phone update for debit note WhatsApp:", commandError);
      }
    }

    const { data: updatedData, error: updateError } = await supabase
      .from("debit_note_proposals")
      .update({
        party_phone: recipientPhone,
        communication_status: "sent",
        communication_channel: "whatsapp",
        communication_recipient: recipientPhone,
        communication_sent_at: now,
        customer_snapshot: {
          ...(proposal.customer_snapshot ?? {}),
          phone: recipientPhone,
          whatsapp: {
            provider: "msg91",
            senderNumber: config.senderNumber,
            templateName: config.templateName,
            templateMode: config.templateMode,
            sentAt: now,
            phoneSaveCommandId,
            response: result.payload,
          },
        },
        last_error: null,
        updated_at: now,
      })
      .eq("id", proposal.id)
      .eq("owner_user_id", user.id)
      .select("*")
      .single();

    if (updateError) throw updateError;

    return jsonWithCors(request, {
      proposal: serializeDebitNoteProposal(updatedData as unknown as DebitNoteProposalRow),
      sent: true,
      phoneSaveCommandId: phoneSaveCommandId || null,
      phoneSaveConnectionId: phoneSaveCommandId ? tallySaveConnectionId : null,
      phoneSaveQueueError,
    });
  } catch (error) {
    if (isMissingTableError(error)) {
      return jsonWithCors(
        request,
        { error: "Run the collections debit-note history migration before sending WhatsApp messages.", setupRequired: true },
        { status: 409 }
      );
    }

    const message = error instanceof Error ? error.message : "Internal server error";
    console.error("Error in POST /api/collections/debit-note-proposals/[id]/whatsapp:", error);

    if (id) {
      let query = supabase
        .from("debit_note_proposals")
        .update({
          communication_status: "failed",
          communication_channel: "whatsapp",
          last_error: message,
          updated_at: new Date().toISOString(),
        })
        .eq("id", id);

      if (ownerUserId) {
        query = query.eq("owner_user_id", ownerUserId);
      }
      await query;
    }

    return jsonWithCors(request, { error: message }, { status: 500 });
  }
}
