import { NextResponse } from "next/server";
import { getFieldSettings, saveFieldSettings } from "@/lib/field-settings-service";

export async function GET() {
  try {
    const settings = await getFieldSettings();

    if (!settings) {
      return NextResponse.json(
        { error: "Failed to load settings" },
        { status: 500 }
      );
    }

    return NextResponse.json({
      fieldSettings: settings.fieldSettings,
      docTypeSettings: settings.docTypeSettings,
    });
  } catch (error) {
    console.error("Error in GET /api/settings/field:", error);
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 }
    );
  }
}

export async function POST(request: Request) {
  try {
    const body = await request.json();
    const { settings } = body;

    if (!Array.isArray(settings)) {
      return NextResponse.json(
        { error: "Invalid settings format" },
        { status: 400 }
      );
    }

    const success = await saveFieldSettings(settings);

    if (!success) {
      return NextResponse.json(
        { error: "Failed to save settings" },
        { status: 500 }
      );
    }

    return NextResponse.json({ success: true });
  } catch (error) {
    console.error("Error in POST /api/settings/field:", error);
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 }
    );
  }
}
