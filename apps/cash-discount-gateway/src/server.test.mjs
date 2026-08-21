import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";
import { WebSocket } from "ws";

import { startCashDiscountGateway } from "./server.mjs";

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

test("live scan relays browser to connector and returns analysed dashboard", async () => {
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

  // One connector authentication and one browser authentication serve both
  // scans; repeat refreshes do not re-run the live-session database checks.
  assert.equal(requests.filter((request) => request.url === "/api/tally/live/session").length, 2);
  assert.equal(requests.filter((request) => request.url === "/api/collections/live/analyse").length, 2);

  browser.close();
  connector.close();
  for (const socket of gateway.clients) socket.terminate();
  await new Promise((resolve) => gateway.close(resolve));
  await new Promise((resolve) => httpServer.close(resolve));
});
