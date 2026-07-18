import { getFieldSettings, saveDocTypeSettings } from "@/lib/field-settings-service";
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

    const settings = await getFieldSettings();
    
    if (!settings) {
      return jsonWithCors(request,
        { error: "Failed to load settings" },
        { status: 500 }
      );
    }

    return jsonWithCors(request, {
      docTypeSettings: settings.docTypeSettings,
    });
  } catch (error) {
    console.error("Error in GET /api/settings/doctype:", error);
    return jsonWithCors(request,
      { error: "Internal server error" },
      { status: 500 }
    );
  }
}

export async function POST(request: Request) {
  try {
    const user = await requireRequestUser(request);
    if (!user) {
      return jsonWithCors(request, { error: "Unauthorized" }, { status: 401 });
    }

    const body = await request.json();
    const { settings } = body;

    if (!Array.isArray(settings)) {
      return jsonWithCors(request,
        { error: "Invalid settings format" },
        { status: 400 }
      );
    }

    const success = await saveDocTypeSettings(settings);

    if (!success) {
      return jsonWithCors(request,
        { error: "Failed to save settings" },
        { status: 500 }
      );
    }

    return jsonWithCors(request, { success: true });
  } catch (error) {
    console.error("Error in POST /api/settings/doctype:", error);
    return jsonWithCors(request,
      { error: "Internal server error" },
      { status: 500 }
    );
  }
}
