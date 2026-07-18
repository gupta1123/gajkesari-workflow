import { createClient } from "@supabase/supabase-js";
import crypto from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const WORKER_SECRET = process.env.WORKER_SECRET;
const APP_BASE_URL = process.env.APP_BASE_URL || process.env.NEXT_PUBLIC_API_BASE_URL || "http://localhost:3001";

const SOURCE_CASE_ID = "8d47a2d9-9df6-4206-bcc7-2bb76e69b94f";
const SOURCE_FILE = path.resolve(
  "exports/case-documents-may-04-05/2026-05-04__Shri Krishna S__8d47a2d9/original-documents/01-Jai Shri Krishna Steel 01.pdf",
);
const ORIGINAL_NAME = "SMOKE Smart Split - Jai Shri Krishna Steel 01.pdf";

if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY || !WORKER_SECRET) {
  throw new Error("Missing Supabase or worker environment variables.");
}

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
  auth: {
    persistSession: false,
    autoRefreshToken: false,
  },
});

function slugify(value) {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
}

function sanitizeFileName(value) {
  return value.replace(/[^a-zA-Z0-9._ -]/g, "_").replace(/\s+/g, " ").trim();
}

async function main() {
  const { data: sourceCase, error: sourceCaseError } = await supabase
    .from("packet_cases")
    .select("owner_user_id")
    .eq("id", SOURCE_CASE_ID)
    .single();

  if (sourceCaseError) throw sourceCaseError;
  if (!sourceCase?.owner_user_id) throw new Error("Source case has no owner_user_id.");

  const caseId = crypto.randomUUID();
  const fileBytes = await readFile(SOURCE_FILE);
  const storagePath = `${caseId}/${Date.now()}-${crypto.randomUUID()}-${sanitizeFileName(ORIGINAL_NAME)}`;
  const comparisonOptions = { considerFormatting: false };

  const { error: uploadError } = await supabase.storage.from("packet-files").upload(storagePath, fileBytes, {
    contentType: "application/pdf",
    upsert: false,
  });

  if (uploadError) throw uploadError;

  const displayName = `[SMOKE] Smart Split - Jai Shri Krishna`;
  const caseRow = {
    id: caseId,
    owner_user_id: sourceCase.owner_user_id,
    slug: `${slugify(displayName)}-${caseId.slice(0, 8)}`,
    display_name: displayName,
    buyer_name: null,
    po_number: null,
    invoice_number: null,
    status: "processing",
    risk_score: 0,
    upload_count: 1,
    document_count: 0,
    mismatch_count: 0,
    processing_meta: {
      smokeTest: true,
      sourceCaseId: SOURCE_CASE_ID,
      draft: false,
      analysisMode: "smart_split",
      comparisonOptions,
    },
  };

  const { error: caseInsertError } = await supabase.from("packet_cases").insert(caseRow);
  if (caseInsertError) throw caseInsertError;

  const { error: fileInsertError } = await supabase.from("packet_case_files").insert({
    case_id: caseId,
    original_name: ORIGINAL_NAME,
    storage_bucket: "packet-files",
    storage_path: storagePath,
    mime_type: "application/pdf",
    size_bytes: fileBytes.byteLength,
  });
  if (fileInsertError) throw fileInsertError;

  const { data: job, error: jobInsertError } = await supabase
    .from("packet_processing_jobs")
    .insert({
      case_id: caseId,
      owner_user_id: sourceCase.owner_user_id,
      job_type: "case_analysis",
      status: "running",
      attempt_count: 1,
      max_attempts: 1,
      progress: 0,
      stage: "Running smart split smoke test",
      error: null,
      locked_at: new Date().toISOString(),
      locked_by: "smart-split-smoke-test",
      started_at: new Date().toISOString(),
      result: {
        smokeTest: true,
        analysisMode: "smart_split",
        comparisonOptions,
      },
    })
    .select("*")
    .single();
  if (jobInsertError) throw jobInsertError;

  const response = await fetch(`${APP_BASE_URL}/api/internal/jobs/${job.id}/run`, {
    method: "POST",
    headers: {
      "x-worker-secret": WORKER_SECRET,
    },
  });

  const responseText = await response.text();
  if (!response.ok) {
    throw new Error(`Job run failed ${response.status}: ${responseText}`);
  }

  const [{ data: finalCase, error: finalCaseError }, { data: finalJob, error: finalJobError }, { data: documents, error: docsError }] =
    await Promise.all([
      supabase
        .from("packet_cases")
        .select("id, display_name, status, document_count, mismatch_count, processing_meta")
        .eq("id", caseId)
        .single(),
      supabase.from("packet_processing_jobs").select("*").eq("id", job.id).single(),
      supabase
        .from("packet_documents")
        .select("id, document_type, title, page_count, source_file_name, source_hint, extracted_fields")
        .eq("case_id", caseId)
        .order("created_at", { ascending: true }),
    ]);

  if (finalCaseError) throw finalCaseError;
  if (finalJobError) throw finalJobError;
  if (docsError) throw docsError;

  console.log(
    JSON.stringify(
      {
        case: finalCase,
        job: {
          id: finalJob.id,
          status: finalJob.status,
          progress: finalJob.progress,
          stage: finalJob.stage,
          error: finalJob.error,
        },
        documents: (documents || []).map((document) => ({
          id: document.id,
          type: document.document_type,
          title: document.title,
          pages: document.page_count,
          sourceHint: document.source_hint,
          fieldKeys: Object.keys(document.extracted_fields || {}).filter((key) => key !== "lineItems"),
        })),
      },
      null,
      2,
    ),
  );
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
