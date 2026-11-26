import { gunzipSync } from "node:zlib";
import { jsonWithCors, optionsWithCors } from "@/lib/api/cors";
import { requireRequestUser } from "@/lib/api/request-auth";
import { buildLiveCashDiscountDashboard } from "@/lib/cash-discount-live-dashboard";
import { loadLiveAnalysisContext } from "@/lib/cash-discount-live-context";
import { toText } from "@/lib/collections";
import { followupsEnabledFor } from "@/lib/followups/access";

// A large company's scan is about 6.5 MB of JSON, which gzips to about 0.5 MB.
// The browser sends it compressed (marked by this content type); plain JSON from
// older pages and from the connector is still read as before.
const GZIP_JSON = "application/x-gzip-json";
const MAX_UNPACKED_BYTES = 128 * 1024 * 1024;

async function readJsonBody(request: Request): Promise<Record<string, unknown>> {
  try {
    if (request.headers.get("content-type")?.toLowerCase().startsWith(GZIP_JSON)) {
      const packed = Buffer.from(await request.arrayBuffer());
      return JSON.parse(gunzipSync(packed, { maxOutputLength: MAX_UNPACKED_BYTES }).toString("utf8"));
    }
    return await request.json();
  } catch {
    return {};
  }
}

export function OPTIONS(request: Request) {
  return optionsWithCors(request);
}

// Analyses a connector scan that arrived with its open bills. Connectors from
// 1.2.24 can analyse the scan themselves (with /api/collections/live/analysis-context)
// when the gateway enables CASH_DISCOUNT_CONNECTOR_ANALYSIS; otherwise every
// scan comes through here.
async function POSTHandler(request: Request) {
  const diagnosticStartedAt = performance.now();
  try {
    const user = await requireRequestUser(request);
    if (!user) return jsonWithCors(request, { error: "Unauthorized" }, { status: 401 });

    const body = await readJsonBody(request);
    const connectionId = toText(body.connectionId, 80);
    const companyName = toText(body.companyName, 240);
    const scan = body.scan && typeof body.scan === "object" ? body.scan as Record<string, unknown> : {};
    const benchmarkDiagnostics = scan.benchmarkDiagnostics && typeof scan.benchmarkDiagnostics === "object"
      ? scan.benchmarkDiagnostics
      : null;
    const financialYear = toText(scan.financialYear, 20) || null;
    if (!connectionId || !companyName || !scan.openBillsResult || typeof scan.openBillsResult !== "object") {
      return jsonWithCors(request, { error: "A live Tally company scan is required." }, { status: 400 });
    }

    const followUps = new URL(request.url).pathname === '/api/collections/follow-ups/analyse';
    if (followUps && !followupsEnabledFor(user.id)) return jsonWithCors(request, { error: "Not found." }, { status: 404 });
    const context = await loadLiveAnalysisContext(request, user.id, {
      connectionId, companyName, financialYear: toText(body.financialYear, 20) || financialYear, followUps,
    });
    if (!context.ok) return jsonWithCors(request, { error: context.error }, { status: context.status });

    const analysisStartedAt = performance.now();
    const dashboard = buildLiveCashDiscountDashboard({
      connectionId,
      companyName,
      financialYear,
      scan,
      proposalRows: context.proposalRows,
      connectionStatus: context.connectionStatus,
      lastHeartbeatAt: context.lastHeartbeatAt,
      followUps,
    });
    const analysisMs = performance.now() - analysisStartedAt;
    if (followUps) return jsonWithCors(request, dashboard);
    // The Cash Discount page shows only the debit note tabs and the totals. The
    // follow-up rows and per-bill narration analysis are about 21 MB for a large
    // company, so they are not sent back to it.
    const tabs = (dashboard as { tabs?: Record<string, unknown> }).tabs ?? {};
    return jsonWithCors(request, {
      ...dashboard,
      tabs: { ...tabs, paymentFollowUps: [] },
      narrationAnalysis: [],
      ...(benchmarkDiagnostics ? {
        benchmarkDiagnostics: {
          connector: benchmarkDiagnostics,
          api: {
            databaseMs: Number(context.databaseMs.toFixed(2)),
            analysisMs: Number(analysisMs.toFixed(2)),
            totalMs: Number((performance.now() - diagnosticStartedAt).toFixed(2)),
          },
        },
      } : {}),
    });
  } catch (error) {
    console.error("Error in POST /api/collections/live/analyse:", error);
    return jsonWithCors(request, {
      error: error instanceof Error ? error.message : "Could not analyse the live Tally data.",
    }, { status: 500 });
  }
}

export const POST = POSTHandler;
