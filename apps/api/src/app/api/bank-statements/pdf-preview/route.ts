import { NextResponse } from "next/server";

import { applyCorsHeaders, jsonWithCors, optionsWithCors } from "@/lib/api/cors";
import { requireRequestUser } from "@/lib/api/request-auth";
import { PdfSecurityError, unlockPdfIfNeeded } from "@/lib/pdf-security";

export const runtime = "nodejs";

function isPdfUpload(file: File) {
  return file.type === "application/pdf" || file.name.toLowerCase().endsWith(".pdf");
}

export function OPTIONS(request: Request) {
  return optionsWithCors(request);
}

export async function POST(request: Request) {
  try {
    const user = await requireRequestUser(request);
    if (!user) {
      return jsonWithCors(request, { error: "Unauthorized" }, { status: 401 });
    }

    const formData = await request.formData();
    const file = formData.get("file");
    if (!(file instanceof File) || !isPdfUpload(file)) {
      return jsonWithCors(request, { error: "Upload a PDF bank statement." }, { status: 400 });
    }

    const passwordValue = formData.get("statementPassword");
    const password = typeof passwordValue === "string" ? passwordValue : "";
    const unlockedBytes = await unlockPdfIfNeeded(
      new Uint8Array(await file.arrayBuffer()),
      password
    );

    return applyCorsHeaders(
      new NextResponse(Buffer.from(unlockedBytes), {
        status: 200,
        headers: {
          "Cache-Control": "no-store, private",
          "Content-Type": "application/pdf",
          "X-Content-Type-Options": "nosniff",
        },
      }),
      request
    );
  } catch (error) {
    if (error instanceof PdfSecurityError) {
      const status =
        error.code === "BANK_STATEMENT_PASSWORD_REQUIRED"
          ? 423
          : error.code === "BANK_STATEMENT_PDF_SERVICE_UNAVAILABLE"
            ? 503
            : 400;
      return jsonWithCors(
        request,
        { error: error.message, code: error.code },
        { status }
      );
    }

    console.error("Error in POST /api/bank-statements/pdf-preview:", error);
    return jsonWithCors(request, { error: "This PDF could not be prepared for preview." }, { status: 500 });
  }
}
