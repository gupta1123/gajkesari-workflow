import { NextResponse } from "next/server";
import { getFieldSettings } from "@/lib/field-settings-service";

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
      enabled: true, 
      count: settings.fieldSettings.length,
      fieldSettings: settings.fieldSettings,
      docTypeSettings: settings.docTypeSettings,
    });
  } catch (error) {
    console.error("Error initializing field settings:", error);
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 }
    );
  }
}
