import { NextRequest, NextResponse } from "next/server";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type AnyDocModule = {
  toMarkdown: (inputPath: string) => Promise<string> | string;
  [key: string]: unknown;
};

function errorMessage(error: unknown): string {
  if (!(error instanceof Error)) return String(error);
  const cause = error.cause;
  if (!cause) return error.message;
  return `${error.message} | cause: ${cause instanceof Error ? cause.message : String(cause)}`;
}

export async function POST(req: NextRequest) {
  try {
    const form = await req.formData();
    const file = form.get("file") as File | null;
    if (!file) return NextResponse.json({ error: "No file" }, { status: 400 });
    const buf = new Uint8Array(await file.arrayBuffer());
    const fileName = file.name || "upload.bin";
    const ext = path.extname(fileName).toLowerCase().replace(".", "") || "txt";
    const start = Date.now();

    // Use createRequire to bypass Next/Turbopack bundling of native .node
    let anydoc: AnyDocModule | null = null;
    let loadError: string | null = null;
    try {
      const require = createRequire(import.meta.url);
      const loaded: unknown = require("@firecrawl/anydoc");
      if (loaded && typeof loaded === "object" && typeof (loaded as { toMarkdown?: unknown }).toMarkdown === "function") {
        anydoc = loaded as AnyDocModule;
      }
    } catch (e) {
      loadError = errorMessage(e);
      try {
        const req2 = createRequire(import.meta.url);
        const abs = "C:/Users/Shubham/Desktop/Projects V2/GajkesariAIagents/node_modules/@firecrawl/anydoc/index.js";
        anydoc = req2(abs);
        loadError = null;
      } catch (e2) {
        loadError += " | fallback: " + (e2 instanceof Error ? e2.message : String(e2));
      }
    }

    if (!anydoc || typeof anydoc.toMarkdown !== "function") {
      return NextResponse.json({
        success: false,
        markdownText: "",
        hasMarkdownTables: false,
        tableCount: 0,
        executionTimeMs: Date.now() - start,
        format: ext,
        error: "AnyDoc load failed: " + (loadError || "toMarkdown not found") + " | keys=" + (anydoc ? Object.keys(anydoc).join(",") : "null"),
      });
    }

    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "anydoc-parse-"));
    const inputPath = path.join(tmpDir, `input.${ext}`);
    fs.writeFileSync(inputPath, Buffer.from(buf));
    try {
      const markdownText = await anydoc.toMarkdown(inputPath);
      fs.rmSync(tmpDir, { recursive: true, force: true });
      if (markdownText && markdownText.trim()) {
        const hasTable = /\|\s*:?-{2,}:?\s*\|/.test(markdownText);
        return NextResponse.json({
          success: true,
          markdownText: markdownText.trim(),
          hasMarkdownTables: hasTable,
          tableCount: hasTable ? 1 : 0,
          executionTimeMs: Date.now() - start,
          format: ext,
        });
      }
      return NextResponse.json({
        success: false,
        markdownText: "",
        hasMarkdownTables: false,
        tableCount: 0,
        executionTimeMs: Date.now() - start,
        format: ext,
        error: "AnyDoc returned empty",
      });
    } catch (e) {
      fs.rmSync(tmpDir, { recursive: true, force: true });
      return NextResponse.json({
        success: false,
        markdownText: "",
        hasMarkdownTables: false,
        tableCount: 0,
        executionTimeMs: Date.now() - start,
        format: ext,
        error: e instanceof Error ? e.message : String(e),
      });
    }
  } catch (e) {
    return NextResponse.json({ success: false, error: e instanceof Error ? e.message : String(e) }, { status: 500 });
  }
}
