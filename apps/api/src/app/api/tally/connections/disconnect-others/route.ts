import { jsonWithCors, optionsWithCors } from "@/lib/api/cors";

export const OPTIONS = optionsWithCors;
export async function POST(request: Request) {
  return jsonWithCors(request, { error: "Each browser controls only its paired PC. Disconnect the connector on that computer." }, { status: 403 });
}
