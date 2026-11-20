import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fetchCompanyOpenBillsScan } from "./bridge.mjs";
import { createCustomerDues } from "./customer-dues.mjs";

test("prepared dues reuse the collections scan, stay scoped, and refuse stale results", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gajkesari-dues-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const company = { companyName: "Example", guid: "sample-guid", financialYear: "2026-27", tallyUrl: "http://127.0.0.1:9000" };
  const date = "2026-11-19";
  let voucherId = 3;
  let changeDuringScan = false;
  let requests = [];
  const readCounters = async () => ({ companyGuid: company.guid, altVchId: voucherId, altMstId: 1 });
  const createStore = () => createCustomerDues({
    dir, normalizeLedger: (name) => name.toLowerCase(), today: () => date,
    readActiveCompany: async () => company, readCounters,
    async scan(active, { date, ...deps }) {
      const outcome = await fetchCompanyOpenBillsScan({ tallyUrl: active.tallyUrl }, { companyName: active.companyName, asOfDate: date }, {
        ...deps, prepareDues: true,
        async exportCollection(_url, options) {
          requests.push(options.tallyType);
          if (options.tallyType === "Bill") {
            return `<BILL NAME="INV-1"><LEDGERNAME>Customer A</LEDGERNAME><DATE>20261101</DATE><VOUCHERTYPENAME>Sales</VOUCHERTYPENAME><OPENINGBALANCE>1000</OPENINGBALANCE><CLOSINGBALANCE>${voucherId > 3 ? 500 : 1000}</CLOSINGBALANCE></BILL>`;
          }
          if (changeDuringScan) voucherId++;
          return `<VOUCHER><MASTERID>1</MASTERID><ALTERID>${voucherId}</ALTERID><DATE>20261101</DATE><VOUCHERTYPENAME>Sales</VOUCHERTYPENAME><VOUCHERNUMBER>INV-1</VOUCHERNUMBER><PARTYLEDGERNAME>Customer A</PARTYLEDGERNAME><NARRATION>Same day RTGS</NARRATION></VOUCHER>`;
        },
      });
      return outcome.result;
    },
  });
  const dues = createStore();
  await dues.prepare({ automatic: true });
  assert.deepEqual(requests, []);
  await dues.prepare();
  assert.deepEqual(requests, ["Bill", "Voucher"]);
  const afterRestart = createStore();
  const result = await afterRestart.read(company, ["customer a", "Customer B"], readCounters);
  assert.equal(result.dataSource, "prepared_customer_dues");
  assert.equal(result.byLedger["customer a"].openBills[0].pendingAmount, 1000);
  assert.equal(result.byLedger["customer a"].openBills[0].narration, "Same day RTGS");
  assert.deepEqual(result.byLedger["Customer B"].openBills, []);
  assert.equal(await afterRestart.read({ ...company, guid: "other" }, ["Customer A"], readCounters), null);
  assert.equal(await afterRestart.read({ ...company, financialYear: "2025-26" }, ["Customer A"], readCounters), null);

  requests = [];
  await afterRestart.prepare();
  assert.deepEqual(requests, []);
  voucherId++;
  assert.equal(await afterRestart.read(company, ["Customer A"], readCounters), null);
  await afterRestart.prepare({ automatic: true });
  const refreshed = await afterRestart.read(company, ["Customer A"], readCounters);
  assert.equal(refreshed.openBills[0].pendingAmount, 500);

  changeDuringScan = true;
  await assert.rejects(afterRestart.prepare({ full: true }), /Tally changed during the scan/);
  assert.match(afterRestart.status(company).lastError, /Tally changed/);
  assert.equal(await createStore().read(company, ["Customer A"], readCounters), null);
});
import { WebSocketServer } from "ws";
import { once } from "node:events";
import { createBridgeRunner, decodeTallyResponseBytes } from "./bridge.mjs";

test("the ordinary queue diagnoses a broken live channel and restores a prepared-dues read", { timeout: 30000 }, async t => {
  const gateway = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  await once(gateway, "listening");
  const oldUrl = process.env.TALLY_LIVE_GATEWAY_URL;
  process.env.TALLY_LIVE_GATEWAY_URL = "ws://127.0.0.1:" + gateway.address().port;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "connector-support-"));
  const config = { apiBase: "http://support.invalid", tallyUrl: "http://tally.invalid", connectionId: "connector",
    bridgeToken: "local-fixture", installationRef: "installation", sessionGeneration: 1 };
  const target = { installationId: config.installationRef, connectionId: config.connectionId, sessionGeneration: 1, companyGuid: "guid-a" };
  const runner = createBridgeRunner({ config, appUserDataPath: dir, onLog() {} });
  t.after(async () => {
    runner.stop();
    for (const client of gateway.clients) client.terminate();
    await new Promise(resolve => gateway.close(resolve));
    if (oldUrl === undefined) delete process.env.TALLY_LIVE_GATEWAY_URL;
    else process.env.TALLY_LIVE_GATEWAY_URL = oldUrl;
    fs.rmSync(dir, { recursive: true, force: true });
  });

  let accept = false;
  let liveSocket;
  const scan = Promise.withResolvers();
  gateway.on("connection", socket => socket.on("message", bytes => {
    const message = JSON.parse(bytes.toString());
    if (message.type === "authenticate") {
      if (!accept) { socket.close(1008, "Fixture disconnect"); return; }
      liveSocket = socket;
      socket.send(JSON.stringify({ type: "authenticated" }));
    } else if (message.type === "operation_result") scan.resolve(message);
  }));

  const results = [];
  const queue = [];
  const completed = Promise.withResolvers();
  t.mock.method(globalThis, "fetch", async (input, init) => {
    const url = new URL(input);
    if (url.hostname === "tally.invalid") {
      const xml = decodeTallyResponseBytes(init.body);
      let body = '<COMPANY NAME="Example"><GUID>guid-a</GUID><ALTVCHID>1</ALTVCHID><ALTMSTID>1</ALTMSTID></COMPANY>';
      if (xml.includes("<ID>$$CurrentCompany</ID>")) body = "<RESULT>Example</RESULT>";
      if (xml.includes("<TYPE>Bill</TYPE>")) body = '<BILL NAME="INV"><LEDGERNAME>Customer A</LEDGERNAME><DATE>20261001</DATE><OPENINGBALANCE>100</OPENINGBALANCE><CLOSINGBALANCE>100</CLOSINGBALANCE></BILL>';
      if (xml.includes("<TYPE>Voucher</TYPE>")) body = "";
      return new Response("<ENVELOPE><STATUS>1</STATUS>" + body + "</ENVELOPE>");
    }
    if (url.pathname.endsWith("/commands/next")) return Response.json({ commands: queue.splice(0) });
    if (url.pathname.endsWith("/result")) {
      const result = JSON.parse(init.body);
      results.push(result);
      if (results.length === 1) accept = true;
      if (results.length === 2) completed.resolve();
    }
    return Response.json({});
  });

  await runner.start();
  await runner.prepareCustomerDues();
  for (const commandType of ["get_connector_diagnostics", "reconnect_live_channel"]) {
    queue.push({ id: commandType, commandType, createdAt: new Date().toISOString(), payload: { target } });
  }
  await completed.promise;
  assert.equal(results[0].success, true);
  assert.equal(results[0].result.live.lastCloseCode, 1008);
  assert.notEqual(results[0].result.live.state, "authenticated");
  assert.equal(results[0].result.dues.openBills, 1);
  assert.equal(results[1].result?.live?.state, "authenticated", results[1].error);
  liveSocket.send(JSON.stringify({ type: "operation", operation: "fetch_customer_open_bills", requestId: "support-smoke",
    companyName: "Example", target, payload: { companyName: "Example", queryStrategy: "company_scan", scopeLedgerNames: ["Customer A"] } }));
  const outcome = await scan.promise;
  assert.equal(outcome.success, true, outcome.error);
  assert.equal(outcome.data.dataSource, "prepared_customer_dues");
  assert.equal(outcome.data.openBills.length, 1);
});
