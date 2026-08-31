import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import ts from "typescript";

// Exercise the shipped TS module with a fake browser clock/socket. No server,
// Supabase credential, or Tally instance is involved.
async function browserHarness(t) {
  const originalWindow = globalThis.window;
  const originalSocket = globalThis.WebSocket;
  const originalHooks = globalThis.__liveTestHooks;
  const originalUrl = process.env.NEXT_PUBLIC_CASH_DISCOUNT_GATEWAY_URL;
  let now = 1_000_000;
  let timerId = 0;
  const timers = new Map();
  const sockets = [];
  const hooks = { token: "token-a", binding: "pc-a", dataset: "dataset-a" };
  class Socket extends EventTarget {
    static OPEN = 1; static CONNECTING = 0;
    readyState = 0; sent = [];
    constructor() { super(); sockets.push(this); }
    send(text) { if (this.readyState !== 1) throw Error("closed"); this.sent.push(JSON.parse(text)); }
    close() { if (this.readyState === 3) return; this.readyState = 3; this.dispatchEvent(new Event("close")); }
    open() { this.readyState = 1; this.dispatchEvent(new Event("open")); }
    message(data) { this.dispatchEvent(new MessageEvent("message", { data: JSON.stringify(data) })); }
  }
  globalThis.window = {
    setTimeout: (fn, delay) => { const id = ++timerId; timers.set(id, { fn, at: now + delay }); return id; },
    clearTimeout: (id) => timers.delete(id),
  };
  globalThis.WebSocket = Socket;
  globalThis.__liveTestHooks = hooks;
  process.env.NEXT_PUBLIC_CASH_DISCOUNT_GATEWAY_URL = "ws://test.invalid";
  t.mock.method(Date, "now", () => now);
  t.after(() => {
    for (const socket of sockets) socket.close();
    globalThis.window = originalWindow; globalThis.WebSocket = originalSocket;
    globalThis.__liveTestHooks = originalHooks;
    if (originalUrl === undefined) delete process.env.NEXT_PUBLIC_CASH_DISCOUNT_GATEWAY_URL;
    else process.env.NEXT_PUBLIC_CASH_DISCOUNT_GATEWAY_URL = originalUrl;
  });
  const source = (await readFile(new URL("./cash-discount-live.ts", import.meta.url), "utf8")).replace(
    /import \{ getApiAccessToken, getTallyBrowserBinding, getSelectedTallyDatasetId \} from "[^"]+";/,
    `const hooks = globalThis.__liveTestHooks;
     const getApiAccessToken = async () => hooks.token;
     const getTallyBrowserBinding = () => hooks.binding;
     const getSelectedTallyDatasetId = () => hooks.dataset;`
  );
  const code = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText;
  const liveClient = await import("data:text/javascript;base64," + Buffer.from(code + "\n// " + crypto.randomUUID()).toString("base64"));
  const flush = () => new Promise((resolve) => setImmediate(resolve));
  return {
    hooks, sockets, flush, request: liveClient.runCashDiscountLiveRequest,
    advance(ms) { now += ms; for (const [id, timer] of [...timers]) if (timer.at <= now) { timers.delete(id); timer.fn(); } },
    authenticate(socket) { socket.open(); socket.message({ type: "authenticated" }); },
    finish(socket, data) {
      const request = socket.sent.findLast((message) => message.type === "request");
      socket.message({ type: "result", requestId: request.requestId, success: true, data });
    },
  };
}
const request = { connectionId: "connection-a", companyName: "Same company", operation: "match_bank_statement" };

test("a >2 minute request survives another request and token renewal", async (t) => {
  const h = await browserHarness(t);
  const first = h.request(request);
  await h.flush(); h.authenticate(h.sockets[0]); await h.flush();
  h.advance(121_000);
  const second = h.request(request);
  await h.flush();
  assert.equal(h.sockets.length, 1);
  h.finish(h.sockets[0], "second"); assert.equal(await second, "second");
  h.hooks.token = "token-b";
  const renewed = h.request(request);
  await h.flush(); h.authenticate(h.sockets[1]); await h.flush();
  assert.equal(h.sockets[0].readyState, 1, "old in-flight session must drain");
  const firstMessage = h.sockets[0].sent.find((message) => message.type === "request");
  h.sockets[0].message({ type: "result", requestId: firstMessage.requestId, success: true, data: "first" });
  assert.equal(await first, "first"); assert.equal(h.sockets[0].readyState, 3);
  h.finish(h.sockets[1], "renewed"); assert.equal(await renewed, "renewed");
});

test("authentication has a ten-second deadline", async (t) => {
  const h = await browserHarness(t);
  const pending = h.request(request);
  const rejected = assert.rejects(pending, /authentication timed out/i);
  await h.flush(); h.advance(10_001); await rejected;
  assert.equal(h.sockets[0].readyState, 3);
});

test("cancellation reaches the gateway and rejects without treating partial data as final", async (t) => {
  const h = await browserHarness(t);
  const controller = new AbortController();
  let partial = null;
  const pending = h.request({ ...request, signal: controller.signal, onPartialResult: (data) => { partial = data; } });
  const rejected = assert.rejects(pending, /cancelled/i);
  await h.flush(); h.authenticate(h.sockets[0]); await h.flush();
  const message = h.sockets[0].sent.find((value) => value.type === "request");
  h.sockets[0].message({ type: "partial_result", requestId: message.requestId, data: { complete: false } });
  assert.deepEqual(partial, { complete: false });
  controller.abort(); await rejected;
  assert.ok(h.sockets[0].sent.some((value) => value.type === "cancel" && value.requestId === message.requestId));
});
