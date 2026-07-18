import { NextResponse } from "next/server";

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
    response.headers.set("Access-Control-Allow-Headers", "Authorization, Content-Type");
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
  return applyCorsHeaders(NextResponse.json(body, init), request);
}

export function optionsWithCors(request: Request) {
  const origin = getRequestOrigin(request);
  if (!origin || !getCorsOrigin(request)) {
    return new NextResponse(null, { status: 403 });
  }

  return applyCorsHeaders(new NextResponse(null, { status: 204 }), request);
}
