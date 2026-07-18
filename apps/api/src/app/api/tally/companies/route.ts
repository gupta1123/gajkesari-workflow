import { jsonWithCors, optionsWithCors } from "@/lib/api/cors";
import { requireRequestUser } from "@/lib/api/request-auth";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { serializeTallyConnectionStatus, type TallyConnectionRow } from "@/lib/tally/connections";
import fs from "node:fs";
import path from "node:path";

type TallyConnectionWithSync = TallyConnectionRow & {
  latestSync?: LatestSyncRow | null;
};

type LatestSyncRow = {
  connection_id: string;
  company_name: string | null;
  completed_at: string | null;
  totals: Record<string, unknown> | null;
};

type HeartbeatEventRow = {
  connection_id: string;
  created_at: string | null;
  payload: Record<string, unknown> | null;
};

type LocalTallyCompany = {
  companyName: string;
  bankLedgers: Array<{
    name: string;
    parent: string | null;
    bankName: string | null;
    bankAccountNumber: string | null;
  }>;
};

function inferFinancialYear() {
  const now = new Date();
  const year = now.getMonth() >= 3 ? now.getFullYear() : now.getFullYear() - 1;
  return `${year}-${String((year + 1) % 100).padStart(2, "0")}`;
}

function isGenericTallyLabel(value: string | null | undefined) {
  const normalized = String(value ?? "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, " ");

  return (
    !normalized ||
    normalized === "tally" ||
    normalized === "tally prime" ||
    /^tally(?: prime)?\s*[-–]\s*(?:current year|\d{4}[-–]\d{2})$/.test(normalized)
  );
}

function pickCompanyName(connection: TallyConnectionWithSync, overrideName?: string | null) {
  const latestSync = connection.latestSync ?? null;
  const names = [overrideName, connection.last_company_name, latestSync?.company_name, connection.display_name];
  return names.find((name) => !isGenericTallyLabel(name)) ?? names.find((name) => String(name ?? "").trim()) ?? "Tally Prime";
}

function virtualCompanyId(connectionId: string, companyName: string) {
  return `${connectionId}::${encodeURIComponent(companyName)}`;
}

function serializeCompany(connection: TallyConnectionWithSync, companyNameOverride?: string | null) {
  const status = serializeTallyConnectionStatus(connection);
  const latestSync = connection.latestSync ?? null;
  const companyName = pickCompanyName(connection, companyNameOverride);
  const totals = latestSync?.totals && typeof latestSync.totals === "object" ? latestSync.totals : {};
  const bankAccountCount =
    typeof totals.bank_ledger === "number"
      ? totals.bank_ledger
      : typeof totals.ledger === "number"
        ? null
        : null;

  return {
    id: virtualCompanyId(connection.id, companyName),
    connectionId: connection.id,
    companyName,
    financialYear: inferFinancialYear(),
    status: status.status,
    bridgeConnected: status.bridgeConnected,
    tallyReachable: status.tallyReachable,
    companyLoaded: status.companyLoaded,
    bankAccountCount,
    lastSyncAt: latestSync?.completed_at ?? null,
    lastHeartbeatAt: connection.last_heartbeat_at,
    lastError: connection.last_error,
  };
}

function withLocalBankLedgers<T extends { companyName: string }>(
  company: T,
  localTallyCompanies: LocalTallyCompany[]
) {
  const local = localTallyCompanies.find(
    (entry) => entry.companyName.trim().toLowerCase() === company.companyName.trim().toLowerCase()
  );
  return {
    ...company,
    bankLedgers: local?.bankLedgers ?? [],
    bankAccountCount: local?.bankLedgers.length ?? ("bankAccountCount" in company ? company.bankAccountCount : null),
  };
}

function timestampValue(value: string | null | undefined) {
  return value ? new Date(value).getTime() || 0 : 0;
}

function normalizedCompanyNames(values: unknown[]) {
  const seen = new Set<string>();
  const names: string[] = [];

  for (const value of values) {
    let name: unknown = value;
    if (value && typeof value === "object") {
      const row = value as Record<string, unknown>;
      name = row.companyName ?? row.name;
    }
    if (typeof name !== "string") continue;
    const normalized = name.trim();
    if (!normalized || isGenericTallyLabel(normalized)) continue;
    const key = normalized.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    names.push(normalized);
  }

  return names;
}

function companyNamesFromPayload(payload: Record<string, unknown> | null | undefined) {
  if (!payload || typeof payload !== "object") return [];
  const rawCompanies = payload.companies ?? payload.availableCompanies;
  return Array.isArray(rawCompanies) ? normalizedCompanyNames(rawCompanies) : [];
}

function tallyDataRoots() {
  return normalizedCompanyNames([
    process.env.GAJKESARI_TALLY_DATA_ROOT,
    process.env.TALLY_DATA_ROOT,
    process.env.TALLY_DATA_PATH,
    path.join(process.env.PUBLIC || "C:\\Users\\Public", "TallyPrime", "data"),
  ]);
}

function extractReadableTallyStrings(text: string) {
  return [...text.matchAll(/[A-Za-z0-9][A-Za-z0-9 .&()/_-]{1,78}/g)]
    .map((match) => match[0].replace(/\s+/g, " ").trim())
    .filter(Boolean);
}

function isLikelyTallyCompanyName(value: string) {
  const normalized = value.trim();
  const lower = normalized.toLowerCase();

  if (!normalized || normalized.length < 2 || normalized.length > 80) return false;
  if (/^\d+$/.test(normalized)) return false;
  if (lower.includes("company features")) return false;
  if (lower === "company" || lower === "tally" || lower === "tally prime") return false;
  if (lower.startsWith("alter ") || lower.startsWith("create ")) return false;
  return /[a-z]/i.test(normalized);
}

function readTallyCompanyNameFromFile(filePath: string) {
  try {
    if (!fs.existsSync(filePath)) return null;
    const buffer = fs.readFileSync(filePath);
    const candidates = [
      ...extractReadableTallyStrings(buffer.toString("utf16le")),
      ...extractReadableTallyStrings(buffer.toString("latin1")),
    ];
    return candidates.find(isLikelyTallyCompanyName) ?? null;
  } catch {
    return null;
  }
}

function extractLocalBankLedgers(companyDir: string) {
  const candidateFiles = ["Manager.1800", "Index.1800", "TMESSAGE.TSF", "Company.1800", "CmpSave.1800"];
  const candidates: string[] = [];

  for (const fileName of candidateFiles) {
    try {
      const filePath = path.join(companyDir, fileName);
      if (!fs.existsSync(filePath)) continue;
      const buffer = fs.readFileSync(filePath);
      candidates.push(
        ...extractReadableTallyStrings(buffer.toString("utf16le")),
        ...extractReadableTallyStrings(buffer.toString("latin1"))
      );
    } catch {
      // Keep local fallback best-effort.
    }
  }

  const names = normalizedCompanyNames(candidates.map(cleanLocalTallyLabel)).filter((candidate) => {
    const lower = candidate.toLowerCase();
    if (!lower.includes("bank")) return false;
    if (lower.includes("bank charges")) return false;
    if (lower.includes("bank statement suspense")) return false;
    if (lower.includes("bank accounts")) return false;
    if (lower.includes("bank od")) return false;
    if (lower.includes("bank occ")) return false;
    if (lower.includes("cash-in-hand")) return false;
    if (lower.includes("connectedbanking")) return false;
    if (lower.includes("tallyconnect")) return false;
    if (lower.length < 5 || lower.length > 80) return false;
    return /\d{4,}/.test(candidate) || /\b(kotak|hdfc|icici|axis|sbi|yes|idfc|indusind|mahindra)\b/i.test(candidate);
  });

  return names.map((name) => ({
    name,
    parent: "Bank Accounts",
    bankName: name.replace(/\s*[-–]\s*\*?\d[\d* ]*$/, "").trim() || name,
    bankAccountNumber: name.match(/\d{4,}/)?.[0] ?? null,
  }));
}

function cleanLocalTallyLabel(value: string) {
  return value
    .replace(/^[0-9A-Z](?=(?:Kotak|HDFC|ICICI|Axis|SBI|YES|IDFC|IndusInd|Mahindra)\b)/i, "")
    .replace(/\s+/g, " ")
    .trim();
}

function readLocalTallyCompanies() {
  const companies: LocalTallyCompany[] = [];

  for (const dataRoot of tallyDataRoots()) {
    try {
      if (!fs.existsSync(dataRoot)) continue;
      for (const entry of fs.readdirSync(dataRoot, { withFileTypes: true })) {
        if (!entry.isDirectory() || !/^\d+$/.test(entry.name)) continue;
        const companyDir = path.join(dataRoot, entry.name);
        const companyName =
          readTallyCompanyNameFromFile(path.join(companyDir, "Company.1800")) ??
          readTallyCompanyNameFromFile(path.join(companyDir, "CmpSave.1800"));
        if (companyName) {
          companies.push({
            companyName,
            bankLedgers: extractLocalBankLedgers(companyDir),
          });
        }
      }
    } catch {
      // Local Tally data is a best-effort fallback for desktop development.
    }
  }

  const seen = new Set<string>();
  return companies.filter((company) => {
    const key = company.companyName.trim().toLowerCase();
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export function OPTIONS(request: Request) {
  return optionsWithCors(request);
}

export async function GET(request: Request) {
  try {
    const user = await requireRequestUser(request);
    if (!user) {
      return jsonWithCors(request, { error: "Unauthorized" }, { status: 401 });
    }

    const supabase = createSupabaseAdminClient();
    const { data, error } = await supabase
      .from("tally_connections")
      .select(
        [
          "id",
          "owner_user_id",
          "display_name",
          "status",
          "tally_url",
          "pairing_code_hash",
          "pairing_code_expires_at",
          "paired_at",
          "bridge_name",
          "bridge_version",
          "bridge_machine_id",
          "last_heartbeat_at",
          "last_tested_at",
          "last_tally_reachable",
          "last_company_loaded",
          "last_company_name",
          "last_error",
          "created_at",
          "updated_at",
        ].join(", ")
      )
      .eq("owner_user_id", user.id)
      .order("updated_at", { ascending: false })
      .limit(20);

    if (error) throw error;

    const connections = (data ?? []) as unknown as TallyConnectionRow[];
    const connectionIds = connections.map((connection) => connection.id);
    const latestSyncByConnection = new Map<string, LatestSyncRow>();
    const syncCompanyNamesByConnection = new Map<string, string[]>();
    const heartbeatCompanyNamesByConnection = new Map<string, string[]>();
    const localTallyCompanies: LocalTallyCompany[] = [];

    if (connectionIds.length > 0) {
      const { data: syncRows, error: syncError } = await supabase
        .from("tally_master_sync_runs")
        .select("connection_id, company_name, completed_at, totals")
        .eq("owner_user_id", user.id)
        .in("connection_id", connectionIds)
        .order("created_at", { ascending: false })
        .limit(100);

      if (syncError) throw syncError;

      for (const row of (syncRows ?? []) as unknown as LatestSyncRow[]) {
        if (!latestSyncByConnection.has(row.connection_id)) {
          latestSyncByConnection.set(row.connection_id, row);
        }
        const existing = syncCompanyNamesByConnection.get(row.connection_id) ?? [];
        syncCompanyNamesByConnection.set(
          row.connection_id,
          normalizedCompanyNames([...existing, row.company_name])
        );
      }

      const { data: eventRows, error: eventError } = await supabase
        .from("tally_connection_events")
        .select("connection_id, created_at, payload")
        .eq("owner_user_id", user.id)
        .in("connection_id", connectionIds)
        .eq("event_type", "bridge_heartbeat")
        .order("created_at", { ascending: false })
        .limit(200);

      if (eventError) throw eventError;

      for (const row of (eventRows ?? []) as unknown as HeartbeatEventRow[]) {
        if (heartbeatCompanyNamesByConnection.has(row.connection_id)) continue;
        const names = companyNamesFromPayload(row.payload);
        if (names.length > 0) {
          heartbeatCompanyNamesByConnection.set(row.connection_id, names);
        }
      }
    }

    const companyEntries = connections.flatMap((connection) => {
      const latestSync = latestSyncByConnection.get(connection.id) ?? null;
      const heartbeatNames = heartbeatCompanyNamesByConnection.get(connection.id) ?? [];
      const shouldUseHeartbeatNames =
        heartbeatNames.length > 0 &&
        connection.last_tally_reachable === true;
      const names = shouldUseHeartbeatNames
        ? normalizedCompanyNames(heartbeatNames)
        : normalizedCompanyNames([
            ...(syncCompanyNamesByConnection.get(connection.id) ?? []),
            connection.last_company_name,
            latestSync?.company_name,
          ]);
      const companyNames = names.length > 0 ? names : [pickCompanyName({ ...connection, latestSync })];

      return companyNames.map((companyName) => ({
        company: serializeCompany(
          {
            ...connection,
            latestSync,
          },
          companyName
        ),
        hasSpecificName: !isGenericTallyLabel(companyName),
        updatedAt: connection.updated_at,
      }));
    });

    companyEntries.sort((a, b) => {
      if (a.hasSpecificName !== b.hasSpecificName) {
        return a.hasSpecificName ? -1 : 1;
      }

      return timestampValue(b.updatedAt) - timestampValue(a.updatedAt);
    });

    const connectedCompanyEntries = companyEntries.filter(
      (entry) => entry.company.bridgeConnected && entry.company.tallyReachable && entry.company.companyLoaded
    );
    const namedCompanyEntries = companyEntries.filter((entry) => entry.hasSpecificName);
    const liveNamedCompanyEntries = namedCompanyEntries.filter(
      (entry) => entry.company.bridgeConnected && entry.company.tallyReachable
    );
    const visibleCompanyEntries =
      liveNamedCompanyEntries.length > 0
        ? liveNamedCompanyEntries
        : namedCompanyEntries.length > 0
          ? namedCompanyEntries
          : companyEntries;
    const connectedCompanyIds = new Set(connectedCompanyEntries.map((entry) => entry.company.id));
    visibleCompanyEntries.sort((a, b) => {
      const connectedDiff = Number(connectedCompanyIds.has(b.company.id)) - Number(connectedCompanyIds.has(a.company.id));
      if (connectedDiff !== 0) return connectedDiff;
      return timestampValue(b.updatedAt) - timestampValue(a.updatedAt);
    });
    const companies = visibleCompanyEntries.map((entry) => withLocalBankLedgers(entry.company, localTallyCompanies));

    return jsonWithCors(request, {
      companies,
      selectedCompanyId: connectedCompanyEntries[0]?.company.id ?? companies[0]?.id ?? null,
    });
  } catch (error) {
    console.error("Error in GET /api/tally/companies:", error);
    return jsonWithCors(request, { error: "Internal server error" }, { status: 500 });
  }
}
