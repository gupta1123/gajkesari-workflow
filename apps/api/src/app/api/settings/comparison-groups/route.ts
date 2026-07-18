import {
  getComparisonGroups,
  sanitizeComparisonGroups,
  saveComparisonGroups,
} from "@/lib/comparison-groups";
import { jsonWithCors, optionsWithCors } from "@/lib/api/cors";
import { requireRequestUser } from "@/lib/api/request-auth";

export function OPTIONS(request: Request) {
  return optionsWithCors(request);
}

export async function GET(request: Request) {
  try {
    const user = await requireRequestUser(request);
    if (!user) {
      return jsonWithCors(request, { error: "Unauthorized" }, { status: 401 });
    }

    const groups = await getComparisonGroups();
    return jsonWithCors(request, { groups });
  } catch (error) {
    console.error("Error in GET /api/settings/comparison-groups:", error);
    return jsonWithCors(request, { error: "Internal server error" }, { status: 500 });
  }
}

export async function POST(request: Request) {
  try {
    const user = await requireRequestUser(request);
    if (!user) {
      return jsonWithCors(request, { error: "Unauthorized" }, { status: 401 });
    }

    const body = (await request.json().catch(() => ({}))) as { groups?: unknown };
    const groups = sanitizeComparisonGroups(body.groups);
    const success = await saveComparisonGroups(groups);

    if (!success) {
      return jsonWithCors(request, { error: "Failed to save comparison groups" }, { status: 500 });
    }

    return jsonWithCors(request, { success: true, groups });
  } catch (error) {
    console.error("Error in POST /api/settings/comparison-groups:", error);
    return jsonWithCors(request, { error: "Internal server error" }, { status: 500 });
  }
}
