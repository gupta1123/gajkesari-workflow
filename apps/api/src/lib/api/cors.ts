import { after, NextResponse } from "next/server";

const DEFAULT_DEV_ORIGINS = [
  "http://localhost:3000",
  "http://localhost:3001",
  "http://127.0.0.1:3000",
  "http://127.0.0.1:3001",
];

function getAllowedOrigins() {
  return new Set(
    [process.env.FRONTEND_ORIGIN, ...DEFAULT_DEV_ORIGINS]
      .filter((value): value is string => typeof value === "string" && value.trim().length > 0)
      .map((value) => value.replace(/\/+$/, ""))
  );
}

function getRequestOrigin(request: Request) {
  return request.headers.get("origin")?.replace(/\/+$/, "") ?? null;
}

function getCorsOrigin(request: Request) {
  const origin = getRequestOrigin(request);
  if (!origin) {
    return null;
  }

  return getAllowedOrigins().has(origin) ? origin : null;
}

export function applyCorsHeaders(response: NextResponse, request: Request) {
  const origin = getCorsOrigin(request);

  if (origin) {
    response.headers.set("Access-Control-Allow-Origin", origin);
    response.headers.set("Vary", "Origin, Access-Control-Request-Headers, Access-Control-Request-Method");
    response.headers.set("Access-Control-Allow-Credentials", "false");
    response.headers.set("Access-Control-Allow-Headers", "Authorization, Content-Type, X-Tally-Browser-Binding, X-Tally-Control-Token, X-Tally-Dataset-Id");
    response.headers.set("Access-Control-Allow-Methods", "GET, POST, PATCH, DELETE, OPTIONS");
    response.headers.set("Access-Control-Max-Age", "86400");
  }

  return response;
}

export function jsonWithCors(
  request: Request,
  body: unknown,
  init?: ResponseInit
) {
  const status = init?.status ?? 200;
  if (status >= 400) {
    const token = request.headers.get("x-tally-browser-binding");
    const route = new URL(request.url).pathname.replace(/[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}/gi,"[id]");
    if (token && /^\/api\/(collections|bank-statements)(?:\/(?:[a-z-]{1,48}|\[id\])){0,6}$/.test(route)) {
      const message = typeof body === "object" && body && "error" in body ? String(body.error) : "";
      const requestId = request.headers.get("x-request-id");
      after(async () => {
        try {
          const {recordSupportRequestError}=await import("@/lib/support-request-errors");
          await recordSupportRequestError(token,route,request.method,status,message,requestId);
        } catch { console.warn("Could not record connector support request error"); }
      });
    }
  }
  return applyCorsHeaders(NextResponse.json(body, init), request);
}

export function optionsWithCors(request: Request) {
  const origin = getRequestOrigin(request);
  if (!origin || !getCorsOrigin(request)) {
    return new NextResponse(null, { status: 403 });
  }

  return applyCorsHeaders(new NextResponse(null, { status: 204 }), request);
}
