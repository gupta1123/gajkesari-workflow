import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export type AnydocParseResult = {
  success: boolean;
  markdownText: string;
  hasMarkdownTables: boolean;
  tableCount: number;
  executionTimeMs: number;
  format: string;
  error?: string | null;
};

type AnydocModule = {
  toMarkdown?: (inputPath: string) => Promise<string> | string;
  toMarkdownBytes?: (buffer: Uint8Array, extension: string) => Promise<string> | string;
};

// Dynamically load @firecrawl/anydoc native module
let anydocModule: AnydocModule | null = null;

async function loadAnydocModule() {
  if (anydocModule) return anydocModule;

  // 1. Try standard package import
  try {
    anydocModule = (await import("@firecrawl/anydoc")) as AnydocModule;
    return anydocModule;
  } catch {
    // 2. Try resolving from local Anydoc directory node_modules
    const localModulePaths = [
      "C:/Users/Shubham/Desktop/Projects V2/Anydoc/node_modules/@firecrawl/anydoc/index.js",
      "../Anydoc/node_modules/@firecrawl/anydoc/index.js",
    ];

    for (const modPath of localModulePaths) {
      if (fs.existsSync(modPath)) {
        try {
          anydocModule = (await import(/* @vite-ignore */ `file:///${path.resolve(modPath).replace(/\\/g, "/")}`)) as AnydocModule;
          return anydocModule;
        } catch {
          // Try next path
        }
      }
    }
  }

  return null;
}

/**
 * Normalizes text content into clean Markdown tables and blocks for LLM consumption.
 */
export function formatAsMarkdownTable(text: string): { markdown: string; tableCount: number } {
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  if (!lines.length) return { markdown: "", tableCount: 0 };

  const tableRows: string[][] = [];
  let inTable = false;
  let count = 0;

  for (const line of lines) {
    const cleanLine = line.replace(/\\t/g, "\t").replace(/\\n/g, "\n");
    const cells = cleanLine.includes("\t")
      ? cleanLine.split("\t").map((c) => c.trim())
      : cleanLine.includes(",")
      ? cleanLine.split(",").map((c) => c.trim())
      : cleanLine.split(/\s{2,}/).map((c) => c.trim());

    if (cells.length >= 3) {
      tableRows.push(cells);
      inTable = true;
    } else if (inTable) {
      inTable = false;
      count += 1;
    }
  }
  if (inTable) count += 1;

  if (!tableRows.length) {
    return { markdown: text, tableCount: 0 };
  }

  const maxCols = Math.max(...tableRows.map((r) => r.length));
  const headers = tableRows[0];
  while (headers.length < maxCols) headers.push("");

  const headerLine = `| ${headers.join(" | ")} |`;
  const separatorLine = `| ${headers.map(() => "---").join(" | ")} |`;

  const dataLines = tableRows.slice(1).map((row) => {
    while (row.length < maxCols) row.push("");
    return `| ${row.join(" | ")} |`;
  });

  const markdown = [headerLine, separatorLine, ...dataLines].join("\n");
  return { markdown, tableCount: Math.max(1, count) };
}

/**
 * Parses document buffer into structured Markdown using Anydoc parser logic.
 */
export async function parseWithAnydoc(
  buffer: Uint8Array,
  fileName: string
): Promise<AnydocParseResult> {
  const startTime = Date.now();
  const ext = path.extname(fileName).toLowerCase().replace(".", "") || "txt";

  try {
    const anydoc = await loadAnydocModule();

    if (anydoc) {
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "anydoc-parse-"));
      const inputPath = path.join(tmpDir, `input.${ext}`);
      fs.writeFileSync(inputPath, Buffer.from(buffer));

      try {
        let markdownText = "";
        if (typeof anydoc.toMarkdown === "function") {
          markdownText = await anydoc.toMarkdown(inputPath);
        } else if (typeof anydoc.toMarkdownBytes === "function") {
          markdownText = await anydoc.toMarkdownBytes(buffer, ext);
        }

        fs.rmSync(tmpDir, { recursive: true, force: true });

        if (markdownText && markdownText.trim()) {
          const { tableCount } = formatAsMarkdownTable(markdownText);
          return {
            success: true,
            markdownText: markdownText.trim(),
            hasMarkdownTables: markdownText.includes("|---") || markdownText.includes("| ---") || tableCount > 0,
            tableCount: Math.max(1, tableCount),
            executionTimeMs: Date.now() - startTime,
            format: ext,
          };
        }
      } catch (err) {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      }
    }

    // Direct text / CSV fallback. Never decode binary PDFs as UTF-8: if the
    // native AnyDoc module is unavailable, the caller should use its existing
    // PDF text/image fallback pipeline instead.
    if (ext === "pdf" || ["doc", "docx", "odt", "rtf", "epub"].includes(ext)) {
      return {
        success: false,
        markdownText: "",
        hasMarkdownTables: false,
        tableCount: 0,
        executionTimeMs: Date.now() - startTime,
        format: ext,
        error: "AnyDoc native module is unavailable for this document type",
      };
    }

    // Direct text / CSV fallback
    const rawText = Buffer.from(buffer).toString("utf8");
    const { markdown, tableCount } = formatAsMarkdownTable(rawText);
    const executionTimeMs = Date.now() - startTime;

    return {
      success: true,
      markdownText: markdown,
      hasMarkdownTables: markdown.includes("|---") || markdown.includes("| ---") || tableCount > 0,
      tableCount,
      executionTimeMs,
      format: ext,
    };
  } catch (error) {
    return {
      success: false,
      markdownText: "",
      hasMarkdownTables: false,
      tableCount: 0,
      executionTimeMs: Date.now() - startTime,
      format: ext,
      error: error instanceof Error ? error.message : "Anydoc extraction error",
    };
  }
}
