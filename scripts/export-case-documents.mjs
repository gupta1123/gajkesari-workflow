import { createClient } from "@supabase/supabase-js";
import { mkdir, writeFile } from "node:fs/promises";
import { createWriteStream } from "node:fs";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const args = process.argv.slice(2);
const positionalArgs = args.filter((arg) => !arg.startsWith("--"));
const getFlagValue = (name) => {
  const prefix = `--${name}=`;
  const match = args.find((arg) => arg.startsWith(prefix));
  return match ? match.slice(prefix.length) : undefined;
};

const OUTPUT_ROOT = positionalArgs[0]
  ? path.resolve(positionalArgs[0])
  : path.resolve("exports/case-documents");
const START_DATE = getFlagValue("start");
const END_DATE = getFlagValue("end");

if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  throw new Error("Missing NEXT_PUBLIC_SUPABASE_URL/SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY");
}

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
  auth: {
    persistSession: false,
    autoRefreshToken: false,
  },
});

function sanitizeSegment(value, fallback = "untitled") {
  const cleaned = String(value || fallback)
    .normalize("NFKD")
    .replace(/[^\w\s.-]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 90);
  return cleaned || fallback;
}

function dateSegment(value) {
  return new Date(value).toISOString().slice(0, 10);
}

function uniqueFileName(index, originalName) {
  const parsed = path.parse(originalName || `document-${index}`);
  const base = sanitizeSegment(parsed.name, `document-${index}`);
  const ext = sanitizeSegment(parsed.ext, "");
  return `${String(index).padStart(2, "0")}-${base}${ext}`;
}

async function downloadObject(bucket, storagePath, destinationPath) {
  const { data, error } = await supabase.storage.from(bucket).download(storagePath);
  if (error) {
    throw error;
  }

  await mkdir(path.dirname(destinationPath), { recursive: true });

  if (data?.stream) {
    await pipeline(Readable.fromWeb(data.stream()), createWriteStream(destinationPath));
    return;
  }

  const arrayBuffer = await data.arrayBuffer();
  await writeFile(destinationPath, Buffer.from(arrayBuffer));
}

async function fetchAllCases() {
  const pageSize = 1000;
  const cases = [];

  for (let from = 0; ; from += pageSize) {
    const to = from + pageSize - 1;
    let query = supabase
      .from("packet_cases")
      .select("id, display_name, status, created_at, updated_at, upload_count, document_count, mismatch_count")
      .order("created_at", { ascending: false });

    if (START_DATE) query = query.gte("created_at", START_DATE);
    if (END_DATE) query = query.lt("created_at", END_DATE);

    const { data, error } = await query.range(from, to);

    if (error) throw error;
    cases.push(...(data || []));
    if (!data || data.length < pageSize) break;
  }

  return cases;
}

async function fetchCaseFiles(caseIds) {
  const filesByCase = new Map();
  const chunkSize = 200;

  for (let i = 0; i < caseIds.length; i += chunkSize) {
    const chunk = caseIds.slice(i, i + chunkSize);
    const { data, error } = await supabase
      .from("packet_case_files")
      .select("id, case_id, original_name, storage_bucket, storage_path, mime_type, size_bytes, created_at")
      .in("case_id", chunk)
      .order("created_at", { ascending: true });

    if (error) throw error;

    for (const file of data || []) {
      const files = filesByCase.get(file.case_id) || [];
      files.push(file);
      filesByCase.set(file.case_id, files);
    }
  }

  return filesByCase;
}

async function main() {
  await mkdir(OUTPUT_ROOT, { recursive: true });

  const cases = await fetchAllCases();
  const filesByCase = await fetchCaseFiles(cases.map((item) => item.id));
  const manifest = [];

  let downloaded = 0;
  let failed = 0;

  for (const [caseIndex, packetCase] of cases.entries()) {
    const files = filesByCase.get(packetCase.id) || [];
    const folderName = `${dateSegment(packetCase.created_at)}__${sanitizeSegment(packetCase.display_name)}__${packetCase.id.slice(0, 8)}`;
    const caseDir = path.join(OUTPUT_ROOT, folderName);
    const docsDir = path.join(caseDir, "original-documents");

    await mkdir(docsDir, { recursive: true });

    const caseRecord = {
      ...packetCase,
      exportFolder: path.relative(OUTPUT_ROOT, caseDir),
      files: [],
    };

    for (const [fileIndex, file] of files.entries()) {
      const fileName = uniqueFileName(fileIndex + 1, file.original_name);
      const destinationPath = path.join(docsDir, fileName);
      const fileRecord = {
        ...file,
        exportedPath: path.relative(OUTPUT_ROOT, destinationPath),
        downloadStatus: "pending",
      };

      try {
        await downloadObject(file.storage_bucket || "packet-files", file.storage_path, destinationPath);
        fileRecord.downloadStatus = "downloaded";
        downloaded += 1;
      } catch (error) {
        fileRecord.downloadStatus = "failed";
        fileRecord.error = error instanceof Error ? error.message : String(error);
        failed += 1;
      }

      caseRecord.files.push(fileRecord);
    }

    await writeFile(path.join(caseDir, "case-metadata.json"), JSON.stringify(caseRecord, null, 2));
    manifest.push(caseRecord);

    console.log(
      `[${caseIndex + 1}/${cases.length}] ${packetCase.display_name} - ${files.length} file(s), downloaded so far: ${downloaded}, failed: ${failed}`,
    );
  }

  await writeFile(path.join(OUTPUT_ROOT, "manifest.json"), JSON.stringify(manifest, null, 2));
  await writeFile(
    path.join(OUTPUT_ROOT, "summary.json"),
    JSON.stringify(
      {
        exportedAt: new Date().toISOString(),
        outputRoot: OUTPUT_ROOT,
        caseCount: cases.length,
        fileCount: manifest.reduce((sum, item) => sum + item.files.length, 0),
        downloaded,
        failed,
      },
      null,
      2,
    ),
  );

  console.log(`Export complete: ${downloaded} downloaded, ${failed} failed, ${cases.length} cases.`);
  console.log(`Output: ${OUTPUT_ROOT}`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
