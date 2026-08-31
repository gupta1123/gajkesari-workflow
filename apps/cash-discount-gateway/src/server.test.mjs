import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";
import { WebSocket } from "ws";

import { startCashDiscountGateway, bankMatchingNeedsConnectorUpdate } from "./server.mjs";

test("bank matching requires the scoped-read connector; unrelated operations remain available", () => {
  for (const version of [undefined, "", "bad", "0.1.57", "0.1.58", "0.0.100"]) {
    assert.equal(bankMatchingNeedsConnectorUpdate("match_bank_statement", {}, version), true);
    assert.equal(bankMatchingNeedsConnectorUpdate("fetch_customer_open_bills", { queryPurpose: "bank_statement_match" }, version), true);
    assert.equal(bankMatchingNeedsConnectorUpdate("company_check", {}, version), false);
    assert.equal(bankMatchingNeedsConnectorUpdate("scan", {}, version), false);
  }
  for (const version of ["0.1.59", "0.1.60", "0.2.0", "1.0.0"]) {
    assert.equal(bankMatchingNeedsConnectorUpdate("match_bank_statement", {}, version), false);
  }
});

function nextMessage(socket, predicate = () => true) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("Timed out waiting for WebSocket message.")), 5_000);
    const onMessage = (buffer) => {
      const message = JSON.parse(buffer.toString());
      if (!predicate(message)) return;
      clearTimeout(timeout);
      socket.off("message", onMessage);
      resolve(message);
    };
    socket.on("message", onMessage);
  });
}

test("live scan relays browser to connector and returns analysed dashboard", async (t) => {
  const requests = [];
  const httpServer = createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString() || "{}");
    requests.push({ url: request.url, body });
    response.setHeader("Content-Type", "application/json");
    if (request.url === "/api/tally/live/session") {
      response.end(JSON.stringify({
        authenticated: true,
        bridgeVersion: "0.1.59",
        ownerUserId: "user-1",
        connectionId: "connection-1",
        customerScope: null,
        customerScopes: body.role === "browser"
          ? { "solution nyx": { mode: "strict", selectedGroupNames: ["Dealers"] } }
          : null,
        defaultCustomerScope: { mode: "automatic", selectedGroupNames: ["Sundry Debtors"] },
      }));
      return;
    }
    if (request.url === "/api/collections/live/analyse") {
      response.end(JSON.stringify({ setupRequired: false, tabs: { cashDiscountTracker: [] } }));
      return;
    }
    response.statusCode = 404;
    response.end(JSON.stringify({ error: "Not found" }));
  });
  await new Promise((resolve) => httpServer.listen(0, "127.0.0.1", resolve));
  const address = httpServer.address();
  const baseUrl = `http://127.0.0.1:${address.port}`;
  const gateway = startCashDiscountGateway({
    server: httpServer,
    path: "/cash-discount-live",
    apiBaseUrl: baseUrl,
  });
  t.after(async () => {
    for (const socket of gateway.clients) socket.terminate();
    await new Promise((resolve) => gateway.close(resolve));
    await new Promise((resolve) => httpServer.close(resolve));
  });

  const connector = new WebSocket(`${baseUrl.replace("http", "ws")}/cash-discount-live`);
  await new Promise((resolve, reject) => {
    connector.once("open", resolve);
    connector.once("error", reject);
  });
  connector.send(JSON.stringify({
    type: "authenticate",
    role: "connector",
    connectionId: "connection-1",
    token: "bridge-token",
  }));
  await nextMessage(connector, (message) => message.type === "authenticated");

  const browser = new WebSocket(`${baseUrl.replace("http", "ws")}/cash-discount-live`);
  await new Promise((resolve, reject) => {
    browser.once("open", resolve);
    browser.once("error", reject);
  });
  browser.send(JSON.stringify({
    type: "authenticate",
    role: "browser",
    connectionId: "connection-1",
    companyName: "",
    token: "access-token",
  }));
  await nextMessage(browser, (message) => message.type === "authenticated");

  browser.send(JSON.stringify({
    type: "request",
    requestId: "company-check-1",
    operation: "company_check",
    companyName: "",
  }));
  const companyOperation = await nextMessage(
    connector,
    (message) => message.type === "operation" && message.requestId === "company-check-1"
  );
  assert.equal(companyOperation.operation, "company_check");
  connector.send(JSON.stringify({
    type: "operation_result",
    requestId: "company-check-1",
    success: true,
    data: {
      activeCompany: "Solution Nyx",
      selectedCompany: "Solution Nyx",
      companies: [{ companyName: "Solution Nyx", isActive: true }],
    },
  }));
  const companyResult = await nextMessage(
    browser,
    (message) => message.type === "result" && message.requestId === "company-check-1"
  );
  assert.equal(companyResult.data.activeCompany, "Solution Nyx");

  browser.send(JSON.stringify({
    type: "request",
    requestId: "bank-check-1",
    operation: "verify_bank_transaction",
    companyName: "Solution Nyx",
    payload: {
      bankLedgerName: "State Bank of India - 42861007319",
      transactions: [{ transactionId: "transaction-1", amount: 100 }],
    },
  }));
  const bankCheckOperation = await nextMessage(
    connector,
    (message) => message.type === "operation" && message.requestId === "bank-check-1"
  );
  assert.equal(bankCheckOperation.operation, "verify_bank_transaction");
  assert.equal(bankCheckOperation.payload.bankLedgerName, "State Bank of India - 42861007319");
  connector.send(JSON.stringify({
    type: "operation_result",
    requestId: "bank-check-1",
    success: true,
    data: { transactions: [{ transactionId: "transaction-1", verificationStatus: "missing" }] },
  }));
  const bankCheckResult = await nextMessage(
    browser,
    (message) => message.type === "result" && message.requestId === "bank-check-1"
  );
  assert.equal(bankCheckResult.success, true);
  assert.equal(bankCheckResult.data.transactions[0].transactionId, "transaction-1");

  browser.send(JSON.stringify({
    type: "request",
    requestId: "statement-match-1",
    operation: "match_bank_statement",
    companyName: "Solution Nyx",
    payload: {
      bankLedgerName: "State Bank of India - 42861007319",
      transactions: [{ transactionId: "transaction-1", amount: 100 }],
      ledgers: [{ ledgerName: "Customer A" }],
    },
  }));
  const statementMatchOperation = await nextMessage(
    connector,
    (message) => message.type === "operation" && message.requestId === "statement-match-1"
  );
  assert.equal(statementMatchOperation.operation, "match_bank_statement");
  assert.equal(statementMatchOperation.payload.transactions[0].transactionId, "transaction-1");
  connector.send(JSON.stringify({
    type: "operation_result",
    requestId: "statement-match-1",
    success: true,
    data: {
      transactions: [{ transactionId: "transaction-1", verificationStatus: "missing" }],
      billsByLedger: { "customer a": [{ billName: "INV-1", pendingAmount: 100 }] },
    },
  }));
  const statementMatchResult = await nextMessage(
    browser,
    (message) => message.type === "result" && message.requestId === "statement-match-1"
  );
  assert.equal(statementMatchResult.success, true);
  assert.equal(statementMatchResult.data.billsByLedger["customer a"][0].billName, "INV-1");

  browser.send(JSON.stringify({
    type: "request",
    requestId: "request-1",
    operation: "scan",
    companyName: "Solution Nyx",
    financialYear: "2026-27",
  }));
  const operation = await nextMessage(connector, (message) => message.type === "operation");
  assert.equal(operation.operation, "cash_discount_scan");
  assert.deepEqual(operation.customerScope, { mode: "strict", selectedGroupNames: ["Dealers"] });
  connector.send(JSON.stringify({
    type: "operation_result",
    requestId: "request-1",
    success: true,
    companyName: "Solution Nyx",
    data: { financialYear: "2026-27", ledgers: [], openBillsResult: {} },
  }));

  const result = await nextMessage(browser, (message) => message.type === "result");
  assert.equal(result.success, true);
  assert.deepEqual(result.data.tabs.cashDiscountTracker, []);

  browser.send(JSON.stringify({
    type: "request",
    requestId: "request-2",
    operation: "scan",
    companyName: "Solution Nyx",
    financialYear: "2026-27",
  }));
  const secondOperation = await nextMessage(
    connector,
    (message) => message.type === "operation" && message.requestId === "request-2"
  );
  assert.equal(secondOperation.operation, "cash_discount_scan");
  connector.send(JSON.stringify({
    type: "operation_result",
    requestId: "request-2",
    success: true,
    companyName: "Solution Nyx",
    data: { financialYear: "2026-27", ledgers: [], openBillsResult: {} },
  }));
  const secondResult = await nextMessage(
    browser,
    (message) => message.type === "result" && message.requestId === "request-2"
  );
  assert.equal(secondResult.success, true);

  // Handshake plus per-operation authorization fences revoked bindings and
  // changed session generations without dropping other pending requests.
  assert.equal(requests.filter((request) => request.url === "/api/tally/live/session").length, 7);
  assert.equal(requests.filter((request) => request.url === "/api/collections/live/analyse").length, 2);

  browser.close();
  connector.close();
});

test("two PCs sharing a login stay isolated; cancellation and stale generations are fenced", async (t) => {
  const generations = { a: 1, b: 1 };
  const versions = { a: "0.1.58", b: "0.1.59" };
  const httpServer = createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString() || "{}");
    response.setHeader("Content-Type", "application/json");
    const pc = body.connectionId;
    const allowed = generations[pc] && (body.role === "connector"
      ? request.headers["x-bridge-token"] === `bridge-${pc}`
      : request.headers["x-tally-browser-binding"] === `binding-${pc}`);
    if (!allowed) { response.writeHead(403); response.end(JSON.stringify({ error: "Wrong PC binding" })); return; }
    response.end(JSON.stringify({
      ownerUserId: "shared-login", connectionId: pc, installationId: `installation-${pc}`, bridgeVersion: versions[pc],
      sessionGeneration: generations[pc], target: {
        installationId: `installation-${pc}`, companyDatasetId: `dataset-${pc}`,
        companyGuid: `guid-${pc}`, connectionId: pc, sessionGeneration: generations[pc], companyName: "Same",
      },
    }));
  });
  await new Promise((resolve) => httpServer.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${httpServer.address().port}`;
  const gateway = startCashDiscountGateway({ server: httpServer, path: "/live", apiBaseUrl: base });
  t.after(async () => {
    for (const socket of gateway.clients) socket.terminate();
    await new Promise((resolve) => gateway.close(resolve));
    await new Promise((resolve) => httpServer.close(resolve));
  });
  async function connect(pc, role, binding = pc) {
    const socket = new WebSocket(base.replace("http", "ws") + "/live");
    await new Promise((resolve) => socket.once("open", resolve));
    const authenticated = nextMessage(socket, (message) => ["authenticated","error"].includes(message.type));
    socket.send(JSON.stringify({ type: "authenticate", role, connectionId: pc,
      token: role === "connector" ? `bridge-${pc}` : "same-access-token", browserBinding: `binding-${binding}` }));
    return { socket, result: await authenticated };
  }
  const a = (await connect("a", "connector")).socket;
  const b = (await connect("b", "connector")).socket;
  const browser = (await connect("a", "browser")).socket;
  const wrong = await connect("b", "browser", "a");
  assert.equal(wrong.result.type, "error");
  assert.match(wrong.result.error, /Wrong PC/);
  let bOperations = 0;
  b.on("message", (buffer) => { if (JSON.parse(buffer).type === "operation") bOperations += 1; });
  let aOperations = 0;
  a.on("message", (buffer) => { if (JSON.parse(buffer).type === "operation") aOperations += 1; });
  const updateRequired = nextMessage(browser, (message) => message.type === "result" && message.requestId === "old-connector");
  browser.send(JSON.stringify({ type: "request", requestId: "old-connector", operation: "match_bank_statement", companyName: "Same" }));
  assert.match((await updateRequired).error, /0\.1\.59/);
  assert.equal(aOperations, 0, "old connector never receives the heavy request");
  versions.a = "0.1.59"; // First heartbeat after upgrade; socket's cached metadata is still old.
  const operationPromise = nextMessage(a, (message) => message.type === "operation");
  browser.send(JSON.stringify({ type: "request", requestId: "isolated", operation: "match_bank_statement",
    companyName: "Same", companyDatasetId: "dataset-a", payload: { tallyUrl: "http://other-pc:9000" } }));
  const operation = await operationPromise;
  assert.equal(operation.target.companyDatasetId, "dataset-a");
  assert.equal(operation.payload.tallyUrl, undefined);
  assert.equal(bOperations, 0);
  const cancelled = nextMessage(a, (message) => message.type === "cancel");
  browser.send(JSON.stringify({ type: "cancel", requestId: "isolated" }));
  assert.equal((await cancelled).requestId, "isolated");
  generations.a = 2;
  const stale = nextMessage(browser, (message) => message.type === "result" && message.requestId === "stale");
  browser.send(JSON.stringify({ type: "request", requestId: "stale", operation: "match_bank_statement", companyName: "Same" }));
  assert.match((await stale).error, /session changed/i);
  assert.equal(bOperations, 0);
});
