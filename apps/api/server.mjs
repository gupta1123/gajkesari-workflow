import { createServer } from "node:http";
import next from "next";

import { startCashDiscountGateway } from "../cash-discount-gateway/src/server.mjs";

const port = Number.parseInt(process.env.PORT || "3001", 10);
const hostname = process.env.HOST || "0.0.0.0";
const app = next({ dev: false, dir: process.cwd(), hostname, port });
const handle = app.getRequestHandler();

await app.prepare();

const httpServer = createServer((request, response) => handle(request, response));
const cashDiscountGateway = startCashDiscountGateway({
  server: httpServer,
  path: "/cash-discount-live",
  apiBaseUrl: process.env.CASH_DISCOUNT_API_BASE_URL || `http://127.0.0.1:${port}`,
});

httpServer.listen(port, hostname, () => {
  console.log(`API and Cash Discount live gateway listening on http://${hostname}:${port}`);
});

function shutdown(signal) {
  console.log(`${signal} received; closing API and Cash Discount gateway.`);
  for (const socket of cashDiscountGateway.clients) socket.close(1001, "Server shutting down.");
  cashDiscountGateway.close(() => {
    httpServer.close(() => process.exit(0));
  });
  setTimeout(() => process.exit(1), 10_000).unref();
}

process.once("SIGTERM", () => shutdown("SIGTERM"));
process.once("SIGINT", () => shutdown("SIGINT"));
