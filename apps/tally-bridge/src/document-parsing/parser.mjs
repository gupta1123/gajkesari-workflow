import fs from "node:fs";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { formatFromBytes, formatFromExtension, toDocument, toMarkdownBytes } from "@firecrawl/anydoc";

export const MAX_DOCUMENT_BYTES = 25 * 1024 * 1024;
export const SUPPORTED_DOCUMENT_EXTENSIONS = [
  ".doc", ".docx", ".docm", ".odt", ".rtf", ".epub", ".pdf",
  ".ppt", ".pps", ".pot", ".pptx", ".pptm", ".ppsx", ".ppsm", ".odp",
  ".xls", ".xlsx", ".xlsm", ".xlsb", ".ods", ".csv",
];

function normalizeOutput(value) {
  const output = String(value || "markdown").trim().toLowerCase();
  if (output === "md") return "markdown";
  if (output !== "markdown" && output !== "json") {
    throw new Error('Document output must be "markdown" or "json".');
  }
  return output;
}

async function readRequestBytes(request) {
  if (request?.filePath) {
    const filePath = path.resolve(String(request.filePath));
    const stat = fs.statSync(filePath);
    if (!stat.isFile()) throw new Error("Document path does not point to a file.");
    if (stat.size === 0) throw new Error("Document is empty.");
    if (stat.size > MAX_DOCUMENT_BYTES) throw new Error("Document is larger than the 25 MB limit.");
    return { bytes: fs.readFileSync(filePath), fileName: path.basename(filePath) };
  }
  const remoteUrl = request?.documentUrl || request?.sourceUrl || request?.url;
  if (remoteUrl) {
    const parsedUrl = new URL(String(remoteUrl));
    if (parsedUrl.protocol !== "https:") throw new Error("Remote documents must use HTTPS.");
    const response = await fetch(parsedUrl, { signal: AbortSignal.timeout(30_000) });
    if (!response.ok) throw new Error(`Document download failed with HTTP ${response.status}.`);
    const declaredSize = Number(response.headers.get("content-length") || 0);
    if (declaredSize > MAX_DOCUMENT_BYTES) throw new Error("Document is larger than the 25 MB limit.");
    if (!response.body) throw new Error("Document download returned no content.");
    const reader = response.body.getReader();
    const chunks = [];
    let byteLength = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      byteLength += value.byteLength;
      if (byteLength > MAX_DOCUMENT_BYTES) {
        await reader.cancel();
        throw new Error("Document is larger than the 25 MB limit.");
      }
      chunks.push(Buffer.from(value));
    }
    const bytes = Buffer.concat(chunks, byteLength);
    if (!bytes.length) throw new Error("Document is empty.");
    if (bytes.length > MAX_DOCUMENT_BYTES) throw new Error("Document is larger than the 25 MB limit.");
    const urlName = path.basename(decodeURIComponent(parsedUrl.pathname)) || "document";
    return { bytes, fileName: path.basename(String(request?.fileName || urlName)) };
  }
  let bytes = null;
  if (Buffer.isBuffer(request?.bytes) || request?.bytes instanceof Uint8Array) {
    bytes = Buffer.from(request.bytes);
  } else if (typeof request?.base64 === "string" && request.base64.trim()) {
    const encoded = request.base64.trim().replace(/\s+/g, "");
    if (!/^[A-Za-z0-9+/]*={0,2}$/.test(encoded) || encoded.length % 4 === 1) {
      throw new Error("Document base64 content is invalid.");
    }
    bytes = Buffer.from(encoded, "base64");
  }
  if (!bytes?.length) throw new Error("Document request requires filePath, bytes, or base64.");
  if (bytes.length > MAX_DOCUMENT_BYTES) throw new Error("Document is larger than the 25 MB limit.");
  return { bytes, fileName: path.basename(String(request?.fileName || "document")) };
}

function requestedFormat(request, fileName, bytes) {
  const explicit = String(request?.format || "").trim().toLowerCase().replace(/^\./, "");
  if (explicit) {
    const format = formatFromExtension(explicit);
    if (!format) throw new Error(`Unsupported document format: ${explicit}.`);
    return format;
  }
  return formatFromBytes(bytes) || formatFromExtension(path.extname(fileName));
}

function jsonSafeDocument(document) {
  return {
    ...document,
    assets: (document.assets || []).map((asset) => {
      const { data, ...rest } = asset;
      return {
        ...rest,
        byteLength: data?.length || 0,
        dataBase64: data ? Buffer.from(data).toString("base64") : "",
      };
    }),
  };
}

function metadata({ fileName, format, bytes, startedAt, structured }) {
  return {
    fileName,
    format,
    byteLength: bytes.length,
    structured,
    parser: "firecrawl-anydoc",
    processing: "local",
    ocrUsed: false,
    durationMs: Number((performance.now() - startedAt).toFixed(2)),
  };
}

export async function parseDocumentLocal(request = {}) {
  const startedAt = performance.now();
  const output = normalizeOutput(request.output || request.outputFormat);
  const { bytes, fileName } = await readRequestBytes(request);
  const format = requestedFormat(request, fileName, bytes);
  if (!format) throw new Error("Document format could not be detected. Supply a supported file extension or format.");

  try {
    if (output === "markdown") {
      const markdown = await toMarkdownBytes(bytes, format);
      return { outputFormat: "markdown", content: markdown, metadata: metadata({ fileName, format, bytes, startedAt, structured: false }) };
    }
    if (format === "pdf") {
      const markdown = await toMarkdownBytes(bytes, format);
      return {
        outputFormat: "json",
        content: { blocks: null, notes: [], assets: [], markdown },
        metadata: metadata({ fileName, format, bytes, startedAt, structured: false }),
      };
    }
    const document = await toDocument(bytes, format);
    return {
      outputFormat: "json",
      content: jsonSafeDocument(document),
      metadata: metadata({ fileName, format, bytes, startedAt, structured: true }),
    };
  } catch (error) {
    const wrapped = new Error(error?.message || "Document could not be parsed locally.");
    wrapped.code = error?.code || "parse_failed";
    throw wrapped;
  }
}
