#!/usr/bin/env node
// Fails when a change touches code that bank-statement posting depends on.
//
// Payment follow-ups and cash-discount work must be additive: new files, new
// tables, new routes. Anything matched below needs a reviewed exception in
// scripts/protected-paths.allow (one repo-relative path per line, "#" comments).
//
// Usage: node scripts/check-protected-paths.mjs [--base <git-ref>]
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const PROTECTED_PATHS = [
  /^apps\/api\/src\/app\/api\/bank-statements\//,
  /^apps\/api\/src\/lib\/bank-/,
  /^apps\/api\/worker\//,
  /^apps\/gajkesari-web\/src\/components\/bank-statements\//,
  /^apps\/gajkesari-web\/src\/lib\/(bank-|statement-bank-book|pdf-preview-state)/,
  /^packages\/shared\/src\/lib\/bank-/,
  // One dispatcher serves bank and collections commands.
  /^apps\/tally-bridge\/src\/(bridge\.mjs|bridge\.test\.mjs|local-matching\/|document-parsing\/)/,
  // The live gateway and its browser client are shared with bank statements
  // (BankStatementsPage imports cash-discount-live.ts).
  /^apps\/cash-discount-gateway\/src\//,
  /^apps\/gajkesari-web\/src\/lib\/cash-discount-live\.ts$/,
  // Command claim/complete, ownership and browser-binding boundary.
  /^apps\/api\/src\/app\/api\/tally\/bridge\//,
  /^apps\/api\/src\/lib\/tally\//,
  /^apps\/api\/src\/lib\/api\/request-auth\.ts$/,
];

// Existing migrations are immutable; new ones must not rewrite shared objects.
export const MIGRATION_DIR = /^supabase\/migrations\//;
export const SHARED_SQL_OBJECTS =
  /tally_bridge_commands_command_type_check|claim_tally_commands|complete_tally_command|enqueue_bank_tally_commands|renew_tally_command_leases|bank_transactions|bank_accounts|bank_statement_|bank_transaction_posting_log/i;

export function classify(changes, readContent, allow = new Set()) {
  const violations = [];
  for (const { status, file } of changes) {
    if (allow.has(file)) continue;
    if (PROTECTED_PATHS.some((pattern) => pattern.test(file))) {
      violations.push({ file, reason: "protected bank-statement path" });
      continue;
    }
    if (!MIGRATION_DIR.test(file)) continue;
    if (status !== "A") {
      violations.push({ file, reason: "existing migrations must not be modified or deleted" });
      continue;
    }
    const match = SHARED_SQL_OBJECTS.exec(readContent(file) ?? "");
    if (match) {
      violations.push({ file, reason: `new migration references shared object "${match[0]}"` });
    }
  }
  return violations;
}

function git(args) {
  return execFileSync("git", args, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
}

function readAllowlist(root) {
  const file = path.join(root, "scripts", "protected-paths.allow");
  if (!existsSync(file)) return new Set();
  return new Set(
    readFileSync(file, "utf8")
      .split(/\r?\n/)
      .map((line) => line.replace(/#.*/, "").trim())
      .filter(Boolean)
  );
}

function main() {
  const baseIndex = process.argv.indexOf("--base");
  const base = baseIndex >= 0 ? process.argv[baseIndex + 1] : "origin/main";
  const root = git(["rev-parse", "--show-toplevel"]).trim();

  // Committed work since the merge point plus tracked edits not yet committed.
  const mergeBase = git(["merge-base", base, "HEAD"]).trim();
  const changes = git(["diff", "--name-status", "--no-renames", mergeBase])
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const [status, ...rest] = line.split("\t");
      return { status: status[0], file: rest.join("\t") };
    });

  const violations = classify(
    changes,
    (file) => {
      const full = path.join(root, file);
      return existsSync(full) ? readFileSync(full, "utf8") : "";
    },
    readAllowlist(root)
  );

  if (violations.length === 0) {
    console.log(`Protected paths untouched (${changes.length} changed file(s) checked against ${base}).`);
    return;
  }
  console.error("Bank-statement protection check failed:\n");
  for (const { file, reason } of violations) console.error(`  ${file}\n    ${reason}`);
  console.error("\nIf a change is unavoidable, review it and list the path in scripts/protected-paths.allow.");
  process.exitCode = 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
