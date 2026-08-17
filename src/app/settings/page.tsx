"use client";

import { useEffect, useState } from "react";
import {
  Check,
  CheckCircle2,
  FileStack,
  Loader2,
  Settings2,
  SlidersHorizontal,
} from "lucide-react";

import { AppShell } from "@/components/dashboard/AppShell";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  DOC_TYPE_EXTRACTION_FIELDS,
  FIELD_DEFINITIONS,
  FIELD_LABELS,
  IGNORED_PACKET_FIELD_KEYS,
  buildPacketFieldConfiguration,
  setPacketFieldConfiguration,
} from "@/lib/document-schema";
import type { DocType, FieldKey } from "@/types/pipeline";

type ActiveTab = "documents" | "overview";
type BannerState = {
  tone: "success" | "error";
  text: string;
} | null;

type SettingsResponse = {
  fieldSettings?: Array<{ doc_type: string; field_key: string; enabled: boolean }>;
  docTypeSettings?: Array<{ doc_type: string; enabled: boolean }>;
  error?: string;
};

type DocTypeEnabledState = Record<string, boolean>;
type FieldEnabledState = Record<string, Record<string, boolean>>;

const AVAILABLE_DOC_TYPES = (Object.keys(DOC_TYPE_EXTRACTION_FIELDS) as DocType[]).filter(
  (docType) => docType !== "Unknown"
);

const HIDDEN_SETTING_FIELD_KEYS = new Set<string>(IGNORED_PACKET_FIELD_KEYS);
const PRIORITY_FIELD_KEYS = new Set<FieldKey>(
  FIELD_DEFINITIONS.filter((field) => field.important).map((field) => field.key)
);

function getConfigurableFields(docType: string): FieldKey[] {
  const seen = new Set<string>();

  return (DOC_TYPE_EXTRACTION_FIELDS[docType as DocType] ?? []).flatMap((fieldKey) => {
    if (HIDDEN_SETTING_FIELD_KEYS.has(fieldKey) || seen.has(fieldKey)) {
      return [];
    }

    seen.add(fieldKey);
    return [fieldKey];
  });
}

function createDefaultDocTypeState(): DocTypeEnabledState {
  return Object.fromEntries(AVAILABLE_DOC_TYPES.map((docType) => [docType, true]));
}

function createDefaultFieldState(): FieldEnabledState {
  return Object.fromEntries(
    AVAILABLE_DOC_TYPES.map((docType) => [
      docType,
      Object.fromEntries(getConfigurableFields(docType).map((fieldKey) => [fieldKey, true])),
    ])
  );
}

function buildStateFromPayload(payload?: SettingsResponse) {
  const docTypeEnabled = createDefaultDocTypeState();
  const fieldEnabled = createDefaultFieldState();

  for (const setting of payload?.docTypeSettings ?? []) {
    if (setting.doc_type in docTypeEnabled) {
      docTypeEnabled[setting.doc_type] = Boolean(setting.enabled);
    }
  }

  for (const setting of payload?.fieldSettings ?? []) {
    if (!(setting.doc_type in fieldEnabled)) {
      continue;
    }

    if (!(setting.field_key in fieldEnabled[setting.doc_type])) {
      continue;
    }

    fieldEnabled[setting.doc_type][setting.field_key] = Boolean(setting.enabled);
  }

  return { docTypeEnabled, fieldEnabled };
}

function serializeSettings(docTypeEnabled: DocTypeEnabledState, fieldEnabled: FieldEnabledState) {
  return JSON.stringify({
    docTypeSettings: AVAILABLE_DOC_TYPES.map((docType) => [docType, docTypeEnabled[docType] ?? true]),
    fieldSettings: AVAILABLE_DOC_TYPES.flatMap((docType) =>
      getConfigurableFields(docType).map((fieldKey) => [
        docType,
        fieldKey,
        fieldEnabled[docType]?.[fieldKey] ?? true,
      ])
    ),
  });
}

async function getResponseError(response: Response) {
  try {
    const payload = (await response.json()) as { error?: string };
    if (payload?.error) {
      return payload.error;
    }
  } catch {}

  try {
    const text = await response.text();
    if (text) {
      return text;
    }
  } catch {}

  return `Request failed with status ${response.status}`;
}

export default function SettingsPage() {
  const [activeTab, setActiveTab] = useState<ActiveTab>("documents");
  const [selectedDocType, setSelectedDocType] = useState<string>(AVAILABLE_DOC_TYPES[0] ?? "");
  const [docTypeEnabled, setDocTypeEnabled] = useState<DocTypeEnabledState>(() =>
    createDefaultDocTypeState()
  );
  const [fieldEnabled, setFieldEnabled] = useState<FieldEnabledState>(() => createDefaultFieldState());
  const [savedSignature, setSavedSignature] = useState("");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [banner, setBanner] = useState<BannerState>(null);

  useEffect(() => {
    let cancelled = false;

    const loadSettings = async () => {
      try {
        setLoading(true);
        setBanner(null);

        const response = await fetch("/api/settings/field", {
          method: "GET",
          cache: "no-store",
        });

        if (!response.ok) {
          throw new Error(await getResponseError(response));
        }

        const payload = (await response.json()) as SettingsResponse;
        const hydratedState = buildStateFromPayload(payload);

        if (cancelled) {
          return;
        }

        setDocTypeEnabled(hydratedState.docTypeEnabled);
        setFieldEnabled(hydratedState.fieldEnabled);
        setSavedSignature(
          serializeSettings(hydratedState.docTypeEnabled, hydratedState.fieldEnabled)
        );
      } catch (error) {
        const fallbackDocTypeState = createDefaultDocTypeState();
        const fallbackFieldState = createDefaultFieldState();

        if (cancelled) {
          return;
        }

        setDocTypeEnabled(fallbackDocTypeState);
        setFieldEnabled(fallbackFieldState);
        setSavedSignature(serializeSettings(fallbackDocTypeState, fallbackFieldState));
        setBanner({
          tone: "error",
          text:
            error instanceof Error
              ? `${error.message}. Showing default settings.`
              : "Could not load saved settings. Showing default settings.",
        });
      } finally {
        if (!cancelled) {
          setLoading(false);
        }
      }
    };

    void loadSettings();

    return () => {
      cancelled = true;
    };
  }, []);

  const currentSignature = serializeSettings(docTypeEnabled, fieldEnabled);
  const hasUnsavedChanges = savedSignature !== currentSignature;

  const selectedDocTypeEnabled = docTypeEnabled[selectedDocType] ?? true;
  const selectedFields = getConfigurableFields(selectedDocType);
  const selectedFieldMap = fieldEnabled[selectedDocType] ?? {};
  const selectedPriorityFields = selectedFields.filter((fieldKey) =>
    PRIORITY_FIELD_KEYS.has(fieldKey)
  );
  const selectedStandardFields = selectedFields.filter(
    (fieldKey) => !PRIORITY_FIELD_KEYS.has(fieldKey)
  );

  const enabledDocTypeCount = AVAILABLE_DOC_TYPES.filter(
    (docType) => docTypeEnabled[docType] ?? true
  ).length;
  const totalFieldCount = AVAILABLE_DOC_TYPES.reduce(
    (count, docType) => count + getConfigurableFields(docType).length,
    0
  );
  const enabledFieldCount = AVAILABLE_DOC_TYPES.reduce(
    (count, docType) =>
      count +
      getConfigurableFields(docType).filter((fieldKey) => fieldEnabled[docType]?.[fieldKey] ?? true)
        .length,
    0
  );

  function handleToggleDocType(docType: string) {
    setBanner(null);
    setDocTypeEnabled((current) => ({
      ...current,
      [docType]: !(current[docType] ?? true),
    }));
  }

  function handleToggleField(docType: string, fieldKey: FieldKey) {
    setBanner(null);
    setFieldEnabled((current) => ({
      ...current,
      [docType]: {
        ...current[docType],
        [fieldKey]: !(current[docType]?.[fieldKey] ?? true),
      },
    }));
  }

  function handleSetAllFields(docType: string, enabled: boolean) {
    setBanner(null);
    setFieldEnabled((current) => ({
      ...current,
      [docType]: Object.fromEntries(
        getConfigurableFields(docType).map((fieldKey) => [fieldKey, enabled])
      ),
    }));
  }

  function handleResetDefaults() {
    setBanner(null);
    setDocTypeEnabled(createDefaultDocTypeState());
    setFieldEnabled(createDefaultFieldState());
  }

  async function handleSave() {
    try {
      setSaving(true);
      setBanner(null);

      const docTypeSettingsPayload = AVAILABLE_DOC_TYPES.map((docType) => ({
        docType,
        enabled: docTypeEnabled[docType] ?? true,
      }));

      const fieldSettingsPayload = AVAILABLE_DOC_TYPES.flatMap((docType) =>
        getConfigurableFields(docType).map((fieldKey) => ({
          docType,
          fieldKey,
          enabled: fieldEnabled[docType]?.[fieldKey] ?? true,
        }))
      );

      const [docTypeResponse, fieldResponse] = await Promise.all([
        fetch("/api/settings/doctype", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ settings: docTypeSettingsPayload }),
        }),
        fetch("/api/settings/field", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ settings: fieldSettingsPayload }),
        }),
      ]);

      if (!docTypeResponse.ok) {
        throw new Error(await getResponseError(docTypeResponse));
      }

      if (!fieldResponse.ok) {
        throw new Error(await getResponseError(fieldResponse));
      }

      setPacketFieldConfiguration(
        buildPacketFieldConfiguration({
          docTypeSettings: docTypeSettingsPayload.map((setting) => ({
            doc_type: setting.docType,
            enabled: setting.enabled,
          })),
          fieldSettings: fieldSettingsPayload.map((setting) => ({
            doc_type: setting.docType,
            field_key: setting.fieldKey,
            enabled: setting.enabled,
          })),
        })
      );

      const nextSignature = serializeSettings(docTypeEnabled, fieldEnabled);
      setSavedSignature(nextSignature);
      setBanner({
        tone: "success",
        text: "Settings saved. New extraction, comparison, and mismatch checks will follow these rules.",
      });
    } catch (error) {
      setBanner({
        tone: "error",
        text: error instanceof Error ? error.message : "Failed to save settings.",
      });
    } finally {
      setSaving(false);
    }
  }

  return (
    <AppShell>
      <div className="min-h-screen bg-[#f7f7f5] text-[#1a1a1a]">
        <div className="mx-auto max-w-[1400px] px-4 py-8 sm:px-8">
          <header className="mb-8 flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
            <div>
              <h1 className="text-2xl font-bold tracking-tight">Document Field and Type Settings</h1>
              <p className="mt-1 text-sm font-medium text-[#8a7f72]">
                Keep the same workflow, but decide exactly which document types and fields should
                participate in case extraction and mismatch checks.
              </p>
            </div>

            <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
              <div className="rounded-2xl border border-[#e5ddd0] bg-white px-4 py-3 shadow-sm">
                <div className="text-[10px] font-black uppercase tracking-[0.24em] text-[#8a7f72]">
                  Document Types On
                </div>
                <div className="mt-2 text-xl font-bold text-[#1a1a1a]">
                  {enabledDocTypeCount}/{AVAILABLE_DOC_TYPES.length}
                </div>
              </div>
              <div className="rounded-2xl border border-[#e5ddd0] bg-white px-4 py-3 shadow-sm">
                <div className="text-[10px] font-black uppercase tracking-[0.24em] text-[#8a7f72]">
                  Checks On
                </div>
                <div className="mt-2 text-xl font-bold text-[#1a1a1a]">
                  {enabledFieldCount}/{totalFieldCount}
                </div>
              </div>
              <div className="rounded-2xl border border-[#e5ddd0] bg-white px-4 py-3 shadow-sm">
                <div className="text-[10px] font-black uppercase tracking-[0.24em] text-[#8a7f72]">
                  Save Status
                </div>
                <div className="mt-2">
                  <Badge
                    className={
                      hasUnsavedChanges
                        ? "border-[#f59e0b]/20 bg-[#fff7e6] text-[#a16207]"
                        : "border-[#10b981]/20 bg-[#ecfdf5] text-[#047857]"
                    }
                    variant="outline"
                  >
                    {hasUnsavedChanges ? "Unsaved changes" : "Saved"}
                  </Badge>
                </div>
              </div>
            </div>
          </header>

          {banner ? (
            <div
              className={`mb-6 rounded-2xl border px-4 py-3 text-sm font-medium ${
                banner.tone === "success"
                  ? "border-[#10b981]/20 bg-[#ecfdf5] text-[#047857]"
                  : "border-[#ef4444]/20 bg-[#fff1f2] text-[#b91c1c]"
              }`}
            >
              {banner.text}
            </div>
          ) : null}

          <div className="overflow-hidden rounded-2xl border border-[#e5ddd0] bg-white shadow-sm">
            <div className="flex items-center gap-8 border-b border-[#e5ddd0] px-6">
              <button
                onClick={() => setActiveTab("documents")}
                className={`flex items-center gap-2 border-b-2 py-4 text-sm font-bold transition-all ${
                  activeTab === "documents"
                    ? "border-[#1a1a1a] text-[#1a1a1a]"
                    : "border-transparent text-[#8a7f72] hover:text-[#1a1a1a]"
                }`}
                type="button"
              >
                <FileStack className="h-4 w-4" />
                Document Types
              </button>
              <button
                onClick={() => setActiveTab("overview")}
                className={`flex items-center gap-2 border-b-2 py-4 text-sm font-bold transition-all ${
                  activeTab === "overview"
                    ? "border-[#1a1a1a] text-[#1a1a1a]"
                    : "border-transparent text-[#8a7f72] hover:text-[#1a1a1a]"
                }`}
                type="button"
              >
                <SlidersHorizontal className="h-4 w-4" />
                Overview
              </button>
            </div>

            {activeTab === "documents" ? (
              <div className="flex min-h-[640px] flex-col md:flex-row">
                <aside className="w-full border-r border-[#e5ddd0] bg-[#fafafa]/50 p-4 md:w-80">
                  <div className="mb-4 px-2 text-[10px] font-bold uppercase tracking-widest text-[#8a7f72]">
                    DOCUMENT TYPES
                  </div>

                  <div className="space-y-2">
                    {AVAILABLE_DOC_TYPES.map((docType) => {
                      const docFields = getConfigurableFields(docType);
                      const docEnabledFieldCount = docFields.filter(
                        (fieldKey) => fieldEnabled[docType]?.[fieldKey] ?? true
                      ).length;
                      const isSelected = selectedDocType === docType;
                      const isEnabled = docTypeEnabled[docType] ?? true;

                      return (
                        <button
                          key={docType}
                          onClick={() => setSelectedDocType(docType)}
                          type="button"
                          className={`w-full rounded-xl p-3 text-left transition-all ${
                            isSelected
                              ? "bg-[#10b981]/10 ring-1 ring-[#10b981]/30"
                              : "hover:bg-[#f0ece6]"
                          }`}
                        >
                          <div className="flex items-start justify-between gap-3">
                            <div className="min-w-0">
                              <div
                                className={`text-sm font-bold ${
                                  isSelected ? "text-[#065f46]" : "text-[#1a1a1a]"
                                }`}
                              >
                                {docType}
                              </div>
                              <div
                                className={`mt-1 text-[11px] font-medium leading-tight ${
                                  isSelected ? "text-[#065f46]/70" : "text-[#8a7f72]"
                                }`}
                              >
                                {docEnabledFieldCount} of {docFields.length} checks on
                              </div>
                            </div>

                            <Badge
                              className={
                                isEnabled
                                  ? "border-[#10b981]/20 bg-[#ecfdf5] text-[#047857]"
                                  : "border-[#e5ddd0] bg-white text-[#8a7f72]"
                              }
                              variant="outline"
                            >
                              {isEnabled ? "On" : "Off"}
                            </Badge>
                          </div>
                        </button>
                      );
                    })}
                  </div>
                </aside>

                <main className="flex-1 p-6 sm:p-8">
                  {loading ? (
                    <div className="space-y-4">
                      <div className="h-14 animate-pulse rounded-2xl bg-[#f3eee7]" />
                      <div className="grid gap-4 md:grid-cols-3">
                        <div className="h-24 animate-pulse rounded-2xl bg-[#f3eee7]" />
                        <div className="h-24 animate-pulse rounded-2xl bg-[#f3eee7]" />
                        <div className="h-24 animate-pulse rounded-2xl bg-[#f3eee7]" />
                      </div>
                      <div className="grid gap-4 lg:grid-cols-2">
                        {Array.from({ length: 6 }).map((_, index) => (
                          <div key={index} className="h-24 animate-pulse rounded-2xl bg-[#f3eee7]" />
                        ))}
                      </div>
                    </div>
                  ) : (
                    <>
                      <div className="mb-10 flex items-start gap-5">
                        <div className="flex h-12 w-12 shrink-0 items-center justify-center rounded-xl bg-[#f0ece6] text-[#1a1a1a] shadow-sm ring-1 ring-[#e5ddd0]">
                          <Settings2 className="h-6 w-6" />
                        </div>
                        <div>
                          <h2 className="text-xl font-bold">{selectedDocType}</h2>
                          <p className="mt-0.5 text-sm font-medium text-[#8a7f72]">
                            Control whether this document type is used, and which extracted values
                            from it should be checked in cases.
                          </p>
                        </div>
                      </div>

                      <div className="mb-8 grid gap-4 lg:grid-cols-3">
                        <div className="rounded-2xl border border-[#e5ddd0] bg-[#fafafa] p-4">
                          <div className="text-[10px] font-black uppercase tracking-[0.24em] text-[#8a7f72]">
                            Document Status
                          </div>
                          <div className="mt-2">
                            <Badge
                              className={
                                selectedDocTypeEnabled
                                  ? "border-[#10b981]/20 bg-[#ecfdf5] text-[#047857]"
                                  : "border-[#e5ddd0] bg-white text-[#8a7f72]"
                              }
                              variant="outline"
                            >
                              {selectedDocTypeEnabled ? "Enabled" : "Disabled"}
                            </Badge>
                          </div>
                        </div>

                        <div className="rounded-2xl border border-[#e5ddd0] bg-[#fafafa] p-4">
                          <div className="text-[10px] font-black uppercase tracking-[0.24em] text-[#8a7f72]">
                            Enabled Checks
                          </div>
                          <div className="mt-2 text-xl font-bold text-[#1a1a1a]">
                            {
                              selectedFields.filter(
                                (fieldKey) => selectedFieldMap[fieldKey] ?? true
                              ).length
                            }
                            /{selectedFields.length}
                          </div>
                        </div>

                        <div className="rounded-2xl border border-[#e5ddd0] bg-[#fafafa] p-4">
                          <div className="text-[10px] font-black uppercase tracking-[0.24em] text-[#8a7f72]">
                            Priority Checks
                          </div>
                          <div className="mt-2 text-xl font-bold text-[#1a1a1a]">
                            {selectedPriorityFields.length}
                          </div>
                        </div>
                      </div>

                      <div className="mb-8 flex flex-col gap-4 rounded-2xl border border-[#e5ddd0] bg-[#fafafa] p-4 lg:flex-row lg:items-center lg:justify-between">
                        <label className="flex items-start gap-3">
                          <input
                            checked={selectedDocTypeEnabled}
                            className="mt-1 h-4 w-4 rounded border-[#d8ccbc] accent-[#10b981]"
                            onChange={() => handleToggleDocType(selectedDocType)}
                            type="checkbox"
                          />
                          <div>
                            <div className="text-sm font-bold text-[#1a1a1a]">
                              Use this document type in case checks
                            </div>
                            <div className="mt-0.5 text-[11px] font-medium text-[#8a7f72]">
                              If turned off, this document type will not affect extraction output,
                              comparison, or mismatch results.
                            </div>
                          </div>
                        </label>

                        <div className="flex flex-wrap gap-2">
                          <Button
                            className="rounded-xl border-[#e5ddd0] bg-white text-[#1a1a1a] hover:bg-[#f3eee7]"
                            onClick={() => handleSetAllFields(selectedDocType, true)}
                            type="button"
                            variant="outline"
                          >
                            Enable all fields
                          </Button>
                          <Button
                            className="rounded-xl border-[#e5ddd0] bg-white text-[#1a1a1a] hover:bg-[#f3eee7]"
                            onClick={() => handleSetAllFields(selectedDocType, false)}
                            type="button"
                            variant="outline"
                          >
                            Disable all fields
                          </Button>
                        </div>
                      </div>

                      {selectedDocTypeEnabled ? null : (
                        <div className="mb-6 rounded-2xl border border-[#f59e0b]/20 bg-[#fff7e6] px-4 py-3 text-sm font-medium text-[#a16207]">
                          This document type is off. Its fields stay visible here so you can adjust
                          them, but the case workflow will ignore this document until you enable it
                          again.
                        </div>
                      )}

                      <div className="space-y-10">
                        <section>
                          <div className="mb-4">
                            <h3 className="text-[11px] font-black uppercase tracking-[0.2em] text-[#8a7f72]">
                              PRIORITY CHECKS
                            </h3>
                            <p className="mt-0.5 text-[11px] font-medium uppercase tracking-wide text-[#b5aaa0]">
                              High-signal fields for quick case validation
                            </p>
                          </div>

                          <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
                            {selectedPriorityFields.map((fieldKey) => {
                              const isEnabled = selectedFieldMap[fieldKey] ?? true;

                              return (
                                <button
                                  key={fieldKey}
                                  aria-pressed={isEnabled}
                                  className={`rounded-xl border p-4 text-left transition-all ${
                                    isEnabled
                                      ? "border-[#10b981]/30 bg-[#ecfdf5]"
                                      : "border-[#e5ddd0] bg-white"
                                  } ${selectedDocTypeEnabled ? "hover:bg-[#fafafa]" : "opacity-70"}`}
                                  disabled={!selectedDocTypeEnabled}
                                  onClick={() => handleToggleField(selectedDocType, fieldKey)}
                                  type="button"
                                >
                                  <div className="flex items-start justify-between gap-4">
                                    <div>
                                      <div className="text-sm font-bold text-[#1a1a1a]">
                                        {FIELD_LABELS[fieldKey]}
                                      </div>
                                      <div className="mt-1 text-[11px] font-medium text-[#8a7f72]">
                                        Checked for mismatch and shown in the case workflow.
                                      </div>
                                    </div>
                                    <div
                                      className={`flex h-6 w-6 items-center justify-center rounded-md border ${
                                        isEnabled
                                          ? "border-[#10b981] bg-[#10b981] text-white"
                                          : "border-[#d8ccbc] bg-white text-transparent"
                                      }`}
                                    >
                                      <Check className="h-4 w-4" />
                                    </div>
                                  </div>
                                </button>
                              );
                            })}
                          </div>
                        </section>

                        <section>
                          <div className="mb-4">
                            <h3 className="text-[11px] font-black uppercase tracking-[0.2em] text-[#8a7f72]">
                              OTHER CHECKS
                            </h3>
                            <p className="mt-0.5 text-[11px] font-medium uppercase tracking-wide text-[#b5aaa0]">
                              Additional fields available for this document type
                            </p>
                          </div>

                          <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
                            {selectedStandardFields.map((fieldKey) => {
                              const isEnabled = selectedFieldMap[fieldKey] ?? true;

                              return (
                                <button
                                  key={fieldKey}
                                  aria-pressed={isEnabled}
                                  className={`rounded-xl border p-4 text-left transition-all ${
                                    isEnabled
                                      ? "border-[#10b981]/30 bg-[#ecfdf5]"
                                      : "border-[#e5ddd0] bg-white"
                                  } ${selectedDocTypeEnabled ? "hover:bg-[#fafafa]" : "opacity-70"}`}
                                  disabled={!selectedDocTypeEnabled}
                                  onClick={() => handleToggleField(selectedDocType, fieldKey)}
                                  type="button"
                                >
                                  <div className="flex items-start justify-between gap-4">
                                    <div>
                                      <div className="text-sm font-bold text-[#1a1a1a]">
                                        {FIELD_LABELS[fieldKey]}
                                      </div>
                                      <div className="mt-1 text-[11px] font-medium text-[#8a7f72]">
                                        Toggle this off if users do not want it compared.
                                      </div>
                                    </div>
                                    <div
                                      className={`flex h-6 w-6 items-center justify-center rounded-md border ${
                                        isEnabled
                                          ? "border-[#10b981] bg-[#10b981] text-white"
                                          : "border-[#d8ccbc] bg-white text-transparent"
                                      }`}
                                    >
                                      <Check className="h-4 w-4" />
                                    </div>
                                  </div>
                                </button>
                              );
                            })}
                          </div>
                        </section>
                      </div>
                    </>
                  )}
                </main>
              </div>
            ) : (
              <div className="p-6 sm:p-8">
                <div className="mb-8 flex items-start gap-5">
                  <div className="flex h-12 w-12 shrink-0 items-center justify-center rounded-xl bg-[#f0ece6] text-[#1a1a1a] shadow-sm ring-1 ring-[#e5ddd0]">
                    <CheckCircle2 className="h-6 w-6" />
                  </div>
                  <div>
                    <h2 className="text-xl font-bold">Current Coverage</h2>
                    <p className="mt-0.5 text-sm font-medium text-[#8a7f72]">
                      Review all document types at once before saving. This view shows exactly what
                      will stay active in the workflow.
                    </p>
                  </div>
                </div>

                <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
                  {AVAILABLE_DOC_TYPES.map((docType) => {
                    const docFields = getConfigurableFields(docType);
                    const enabledFieldsForDocType = docFields.filter(
                      (fieldKey) => fieldEnabled[docType]?.[fieldKey] ?? true
                    );
                    const isEnabled = docTypeEnabled[docType] ?? true;

                    return (
                      <div
                        key={docType}
                        className="rounded-2xl border border-[#e5ddd0] bg-[#fafafa] p-4"
                      >
                        <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                          <div>
                            <div className="text-sm font-bold text-[#1a1a1a]">{docType}</div>
                            <div className="mt-1 text-[11px] font-medium text-[#8a7f72]">
                              {enabledFieldsForDocType.length} of {docFields.length} checks enabled
                            </div>
                          </div>

                          <div className="flex items-center gap-2">
                            <Badge
                              className={
                                isEnabled
                                  ? "border-[#10b981]/20 bg-[#ecfdf5] text-[#047857]"
                                  : "border-[#e5ddd0] bg-white text-[#8a7f72]"
                              }
                              variant="outline"
                            >
                              {isEnabled ? "Enabled" : "Disabled"}
                            </Badge>
                            <Button
                              className="rounded-xl border-[#e5ddd0] bg-white text-[#1a1a1a] hover:bg-[#f3eee7]"
                              onClick={() => {
                                setSelectedDocType(docType);
                                setActiveTab("documents");
                              }}
                              type="button"
                              variant="outline"
                            >
                              Edit
                            </Button>
                          </div>
                        </div>

                        <div className="mt-4 flex flex-wrap gap-2">
                          {enabledFieldsForDocType.slice(0, 8).map((fieldKey) => (
                            <Badge
                              key={fieldKey}
                              className="border-[#e5ddd0] bg-white text-[#4b5563]"
                              variant="outline"
                            >
                              {FIELD_LABELS[fieldKey]}
                            </Badge>
                          ))}
                          {enabledFieldsForDocType.length > 8 ? (
                            <Badge
                              className="border-[#e5ddd0] bg-white text-[#8a7f72]"
                              variant="outline"
                            >
                              +{enabledFieldsForDocType.length - 8} more
                            </Badge>
                          ) : null}
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>
            )}
          </div>

          <div className="mt-8 flex flex-col-reverse gap-3 sm:flex-row sm:justify-end">
            <Button
              className="font-bold text-[#8a7f72]"
              disabled={loading || saving}
              onClick={handleResetDefaults}
              type="button"
              variant="ghost"
            >
              Reset to defaults
            </Button>
            <Button
              className="rounded-xl bg-[#1a1a1a] px-8 font-bold text-white shadow-lg shadow-[#1a1a1a]/20"
              disabled={loading || saving || !hasUnsavedChanges}
              onClick={handleSave}
              type="button"
            >
              {saving ? (
                <>
                  <Loader2 className="h-4 w-4 animate-spin" />
                  Saving...
                </>
              ) : (
                "Save settings"
              )}
            </Button>
          </div>
        </div>
      </div>
    </AppShell>
  );
}
