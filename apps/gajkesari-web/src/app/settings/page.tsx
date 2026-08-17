"use client";

import { useEffect, useState } from "react";
import {
  Check,
  Loader2,
  Search,
} from "lucide-react";

import { AppShell } from "@/components/dashboard/AppShell";
import { apiFetch } from "@/lib/api-client";
import { Button } from "@/components/ui/button";
import {
  DEFAULT_COMPARISON_FIELD_GROUPS,
  fetchComparisonGroups,
  normalizeComparisonGroupKey,
  saveComparisonGroups,
  sanitizeComparisonGroups,
  type ComparisonFieldGroup,
} from "@/lib/comparison-groups";
import {
  DOC_TYPE_EXTRACTION_FIELDS,
  FIELD_DEFINITIONS,
  FIELD_LABELS,
  IGNORED_PACKET_FIELD_KEYS,
  buildPacketFieldConfiguration,
  setPacketFieldConfiguration,
} from "@/lib/document-schema";
import type { DocType, FieldKey } from "@/types/pipeline";

type ActiveTab = "documents" | "groups";
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

function serializeComparisonGroups(groups: ComparisonFieldGroup[]) {
  return JSON.stringify(
    sanitizeComparisonGroups(groups).map((group, index) => ({
      groupKey: group.groupKey,
      label: group.label,
      fields: group.fields,
      enabled: group.enabled,
      sortOrder: group.sortOrder || (index + 1) * 10,
    }))
  );
}

const AVAILABLE_GROUP_FIELDS = FIELD_DEFINITIONS.filter(
  (field) => !HIDDEN_SETTING_FIELD_KEYS.has(field.key)
);
const AVAILABLE_GROUP_FIELD_KEYS = new Set(AVAILABLE_GROUP_FIELDS.map((field) => field.key));

function getFirstGroupFieldDocType(fieldKey: string) {
  return AVAILABLE_DOC_TYPES.find((docType) => getConfigurableFields(docType).includes(fieldKey as FieldKey));
}

const GROUP_FIELD_SECTIONS = AVAILABLE_DOC_TYPES.map((docType) => ({
  docType,
  fields: getConfigurableFields(docType).filter(
    (fieldKey) =>
      AVAILABLE_GROUP_FIELD_KEYS.has(fieldKey) && getFirstGroupFieldDocType(fieldKey) === docType
  ),
})).filter((section) => section.fields.length > 0);

function SwitchControl({ checked }: { checked: boolean }) {
  return (
    <span
      aria-hidden="true"
      className={`relative inline-flex h-[19px] w-8 shrink-0 rounded-full transition ${
        checked ? "bg-[#3d6b4a]" : "bg-[#d8d4c9]"
      }`}
    >
      <span
        className={`absolute top-0.5 h-[15px] w-[15px] rounded-full bg-white transition ${
          checked ? "left-[15px]" : "left-0.5"
        }`}
      />
    </span>
  );
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
  const [comparisonGroups, setComparisonGroups] = useState<ComparisonFieldGroup[]>(() =>
    DEFAULT_COMPARISON_FIELD_GROUPS
  );
  const [selectedGroupKey, setSelectedGroupKey] = useState(
    DEFAULT_COMPARISON_FIELD_GROUPS[0]?.groupKey ?? ""
  );
  const [savedSignature, setSavedSignature] = useState("");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [banner, setBanner] = useState<BannerState>(null);
  const [docSearch, setDocSearch] = useState("");
  const [groupFieldSearch, setGroupFieldSearch] = useState("");

  useEffect(() => {
    let cancelled = false;

    const loadSettings = async () => {
      try {
        setLoading(true);
        setBanner(null);

        const [response, loadedGroups] = await Promise.all([
          apiFetch("/api/settings/field", {
            method: "GET",
            cache: "no-store",
          }),
          fetchComparisonGroups(),
        ]);

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
        setComparisonGroups(loadedGroups);
        setSelectedGroupKey(loadedGroups[0]?.groupKey ?? "");
        setSavedSignature(
          `${serializeSettings(hydratedState.docTypeEnabled, hydratedState.fieldEnabled)}:${serializeComparisonGroups(loadedGroups)}`
        );
      } catch (error) {
        const fallbackDocTypeState = createDefaultDocTypeState();
        const fallbackFieldState = createDefaultFieldState();
        const fallbackGroups = DEFAULT_COMPARISON_FIELD_GROUPS;

        if (cancelled) {
          return;
        }

        setDocTypeEnabled(fallbackDocTypeState);
        setFieldEnabled(fallbackFieldState);
        setComparisonGroups(fallbackGroups);
        setSelectedGroupKey(fallbackGroups[0]?.groupKey ?? "");
        setSavedSignature(
          `${serializeSettings(fallbackDocTypeState, fallbackFieldState)}:${serializeComparisonGroups(fallbackGroups)}`
        );
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

  const currentSignature = `${serializeSettings(docTypeEnabled, fieldEnabled)}:${serializeComparisonGroups(comparisonGroups)}`;
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
  const selectedGroup =
    comparisonGroups.find((group) => group.groupKey === selectedGroupKey) ?? comparisonGroups[0] ?? null;
  const enabledGroupCount = comparisonGroups.filter((group) => group.enabled).length;
  const filteredDocTypes = AVAILABLE_DOC_TYPES.filter((docType) =>
    docType.toLowerCase().includes(docSearch.trim().toLowerCase())
  );
  const normalizedGroupFieldSearch = groupFieldSearch.trim().toLowerCase();
  const filteredGroupFieldSections = GROUP_FIELD_SECTIONS.map((section) => ({
    ...section,
    fields: section.fields.filter((fieldKey) => {
      if (!normalizedGroupFieldSearch) {
        return true;
      }

      return (
        section.docType.toLowerCase().includes(normalizedGroupFieldSearch) ||
        fieldKey.toLowerCase().includes(normalizedGroupFieldSearch) ||
        (FIELD_LABELS[fieldKey] ?? "").toLowerCase().includes(normalizedGroupFieldSearch)
      );
    }),
  })).filter((section) => section.fields.length > 0);

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
    if (activeTab === "groups") {
      setComparisonGroups(DEFAULT_COMPARISON_FIELD_GROUPS);
      setSelectedGroupKey(DEFAULT_COMPARISON_FIELD_GROUPS[0]?.groupKey ?? "");
      return;
    }

    setDocTypeEnabled(createDefaultDocTypeState());
    setFieldEnabled(createDefaultFieldState());
  }

  function handleAddGroup() {
    setBanner(null);
    const index = comparisonGroups.length + 1;
    const group: ComparisonFieldGroup = {
      groupKey: `custom_group_${Date.now()}`,
      label: `New Group ${index}`,
      fields: [],
      enabled: true,
      sortOrder: index * 10,
    };
    setComparisonGroups((current) => [...current, group]);
    setSelectedGroupKey(group.groupKey);
    setActiveTab("groups");
  }

  function handleUpdateGroup(groupKey: string, updates: Partial<ComparisonFieldGroup>) {
    setBanner(null);
    setComparisonGroups((current) =>
      current.map((group) => (group.groupKey === groupKey ? { ...group, ...updates } : group))
    );
  }

  function handleRenameGroup(groupKey: string, label: string) {
    const nextKey = normalizeComparisonGroupKey(label, groupKey);
    setBanner(null);
    setComparisonGroups((current) =>
      current.map((group) =>
        group.groupKey === groupKey
          ? {
              ...group,
              label,
              groupKey: nextKey,
            }
          : group
      )
    );
    setSelectedGroupKey(nextKey);
  }

  function handleToggleGroupField(groupKey: string, fieldKey: string) {
    setBanner(null);
    setComparisonGroups((current) =>
      current.map((group) => {
        if (group.groupKey !== groupKey) return group;
        const fields = group.fields.includes(fieldKey)
          ? group.fields.filter((field) => field !== fieldKey)
          : [...group.fields, fieldKey];
        return { ...group, fields };
      })
    );
  }

  function handleDeleteGroup(groupKey: string) {
    setBanner(null);
    setComparisonGroups((current) => {
      const next = current.filter((group) => group.groupKey !== groupKey);
      if (selectedGroupKey === groupKey) {
        setSelectedGroupKey(next[0]?.groupKey ?? "");
      }
      return next;
    });
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

      const [docTypeResponse, fieldResponse, groupResponse] = await Promise.all([
        apiFetch("/api/settings/doctype", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ settings: docTypeSettingsPayload }),
        }),
        apiFetch("/api/settings/field", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ settings: fieldSettingsPayload }),
        }),
        saveComparisonGroups(
          comparisonGroups.map((group, index) => ({
            ...group,
            sortOrder: (index + 1) * 10,
          }))
        ),
      ]);

      if (!docTypeResponse.ok) {
        throw new Error(await getResponseError(docTypeResponse));
      }

      if (!fieldResponse.ok) {
        throw new Error(await getResponseError(fieldResponse));
      }

      if (!groupResponse.success) {
        throw new Error("Failed to save comparison groups.");
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

      const savedGroups = sanitizeComparisonGroups(groupResponse.groups);
      setComparisonGroups(savedGroups);
      const nextSignature = `${serializeSettings(docTypeEnabled, fieldEnabled)}:${serializeComparisonGroups(savedGroups)}`;
      setSavedSignature(nextSignature);
      setBanner({
        tone: "success",
        text: "Settings saved. New checks will follow field settings, and mismatch pages will use the saved groups.",
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
      <div className="min-h-screen bg-[#faf9f6] text-[#20201c]">
        <div className="mx-auto max-w-[1180px] px-4 py-8 sm:px-8">
          <header className="mb-7 flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
            <div>
              <p className="text-[11px] font-medium uppercase tracking-[0.22em] text-[#9b8f82]">
                Settings
              </p>
              <h1 className="mt-1 text-[26px] font-medium tracking-tight">Review rules</h1>
            </div>

            <div className="flex flex-wrap gap-2">
              <Button
                className="h-10 rounded-lg px-4 font-medium text-[#6f6256]"
                disabled={loading || saving}
                onClick={handleResetDefaults}
                type="button"
                variant="ghost"
              >
                Reset defaults
              </Button>
              <Button
                className="h-10 rounded-lg bg-[#20201c] px-5 font-medium text-white shadow-sm hover:bg-[#111]"
                disabled={loading || saving || !hasUnsavedChanges}
                onClick={handleSave}
                type="button"
              >
                {saving ? (
                  <>
                    <Loader2 className="h-4 w-4 animate-spin" />
                    Saving
                  </>
                ) : (
                  "Save changes"
                )}
              </Button>
            </div>
          </header>

          <div className="mb-6 grid gap-3 md:grid-cols-3">
            {[
              {
                label: "Documents",
                value: `${enabledDocTypeCount}/${AVAILABLE_DOC_TYPES.length} enabled`,
              },
              {
                label: "Fields",
                value: `${enabledFieldCount}/${totalFieldCount} active`,
              },
              {
                label: "Review groups",
                value: `${enabledGroupCount}/${comparisonGroups.length} enabled`,
              },
            ].map((item) => (
              <div
                key={item.label}
                className="rounded-[10px] border border-[#e8e5de] bg-white px-5 py-4"
              >
                <div className="text-[10px] font-medium uppercase tracking-[0.18em] text-[#9b8f82]">
                  {item.label}
                </div>
                <div className="mt-1 text-[22px] font-medium tracking-tight text-[#20201c]">
                  {item.value}
                </div>
              </div>
            ))}
          </div>

          {banner ? (
            <div
              className={`mb-4 rounded-xl border px-4 py-3 text-sm font-medium ${
                banner.tone === "success"
                  ? "border-[#10b981]/25 bg-[#ecfdf5] text-[#047857]"
                  : "border-[#ef4444]/25 bg-[#fff1f2] text-[#b91c1c]"
              }`}
            >
              {banner.text}
            </div>
          ) : null}

          <div className="mb-5 inline-flex rounded-[9px] bg-[#f3f0e8] p-[3px]">
            <button
              className={`rounded-[7px] px-4 py-2 text-sm font-medium transition ${
                activeTab === "documents"
                  ? "bg-white text-[#20201c] shadow-sm"
                  : "text-[#6b6a60] hover:text-[#20201c]"
              }`}
              onClick={() => setActiveTab("documents")}
              type="button"
            >
              Documents & fields
            </button>
            <button
              className={`rounded-[7px] px-4 py-2 text-sm font-medium transition ${
                activeTab === "groups"
                  ? "bg-white text-[#20201c] shadow-sm"
                  : "text-[#6b6a60] hover:text-[#20201c]"
              }`}
              onClick={() => setActiveTab("groups")}
              type="button"
            >
              Review groups
            </button>
          </div>

          <div>
            <div className="flex flex-col gap-5 md:flex-row md:items-start">
              {activeTab === "documents" ? (
                <>
                  <aside className="w-full shrink-0 rounded-[10px] border border-[#e8e5de] bg-white p-2.5 md:w-[270px]">
                    <label className="mb-2 flex items-center gap-2 rounded-lg bg-[#f3f0e8] px-3 py-2">
                      <Search className="h-4 w-4 shrink-0 text-[#9c9a8e]" />
                      <input
                        className="w-full bg-transparent text-[13px] text-[#20201c] outline-none placeholder:text-[#9c9a8e]"
                        onChange={(event) => setDocSearch(event.target.value)}
                        placeholder="Search documents"
                        type="search"
                        value={docSearch}
                      />
                    </label>

                    <div className="max-h-[560px] space-y-1 overflow-y-auto">
                      {filteredDocTypes.map((docType) => {
                        const docFields = getConfigurableFields(docType);
                        const docEnabledFieldCount = docFields.filter(
                          (fieldKey) => fieldEnabled[docType]?.[fieldKey] ?? true
                        ).length;
                        const isSelected = selectedDocType === docType;
                        const isEnabled = docTypeEnabled[docType] ?? true;

                        return (
                          <button
                            key={docType}
                            className={`w-full rounded-lg px-2 py-2.5 text-left transition ${
                              isSelected
                                ? "bg-[#e9f2ea] text-[#20201c]"
                                : "text-[#20201c] hover:bg-[#f3f0e8]"
                            }`}
                            onClick={() => setSelectedDocType(docType)}
                            type="button"
                          >
                            <div className="flex items-center justify-between gap-3">
                              <div className="min-w-0">
                                <div className="truncate text-sm font-medium">{docType}</div>
                                <div className="mt-0.5 text-[11px] font-normal text-[#8a7f72]">
                                  {docEnabledFieldCount}/{docFields.length} fields active
                                </div>
                              </div>
                              <span
                                onClick={(event) => {
                                  event.stopPropagation();
                                  handleToggleDocType(docType);
                                }}
                              >
                                <SwitchControl checked={isEnabled} />
                              </span>
                            </div>
                          </button>
                        );
                      })}
                      {filteredDocTypes.length === 0 ? (
                        <div className="rounded-lg border border-dashed border-[#d8d4c9] p-4 text-sm text-[#6b6a60]">
                          No document types found.
                        </div>
                      ) : null}
                    </div>
                  </aside>

                  <main className="min-w-0 flex-1">
                    {loading ? (
                      <div className="space-y-3">
                        <div className="h-16 animate-pulse rounded-xl bg-[#f3eee7]" />
                        <div className="grid gap-2 md:grid-cols-2 xl:grid-cols-3">
                          {Array.from({ length: 12 }).map((_, index) => (
                            <div key={index} className="h-12 animate-pulse rounded-lg bg-[#f3eee7]" />
                          ))}
                        </div>
                      </div>
                    ) : (
                      <>
                        <div className="mb-5 rounded-[10px] border border-[#e8e5de] bg-white px-6 py-5">
                          <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
                            <div>
                              <h2 className="text-lg font-medium tracking-tight">{selectedDocType}</h2>
                              <p className="mt-1 text-[13px] leading-5 text-[#6b6a60]">
                                Include this document type in extraction and reconciliation.
                              </p>
                            </div>

                            <div className="flex flex-wrap items-center gap-2">
                              <button
                                aria-pressed={selectedDocTypeEnabled}
                                className="flex items-center gap-2 rounded-full border border-[#bdd8c2] bg-[#e9f2ea] px-3 py-1.5 text-[12px] font-medium text-[#3d6b4a] transition"
                                onClick={() => handleToggleDocType(selectedDocType)}
                                type="button"
                              >
                                <SwitchControl checked={selectedDocTypeEnabled} />
                                {selectedDocTypeEnabled ? "Included" : "Excluded"}
                              </button>
                            </div>
                          </div>
                        </div>

                        <div className="rounded-[10px] border border-[#e8e5de] bg-white px-6 py-5">
                          <div className="mb-4 flex flex-wrap justify-end gap-2">
                              <Button
                                className="h-8 rounded-lg border-[#d8d4c9] bg-white px-3 text-xs font-medium text-[#20201c] hover:bg-[#f3f0e8]"
                                onClick={() => handleSetAllFields(selectedDocType, true)}
                                type="button"
                                variant="outline"
                              >
                                Enable all
                              </Button>
                              <Button
                                className="h-8 rounded-lg border-[#d8d4c9] bg-white px-3 text-xs font-medium text-[#20201c] hover:bg-[#f3f0e8]"
                                onClick={() => handleSetAllFields(selectedDocType, false)}
                                type="button"
                                variant="outline"
                              >
                                Disable all
                              </Button>
                          </div>

                        {selectedDocTypeEnabled ? null : (
                          <div className="mb-4 rounded-lg border border-[#f59e0b]/25 bg-[#fff7e6] px-3 py-2 text-sm font-medium text-[#a16207]">
                            Excluded documents are ignored by the workflow until included again.
                          </div>
                        )}

                        <div className="space-y-5">
                          <section>
                            <div className="mb-2 flex items-end justify-between gap-3">
                              <div>
                                <h3 className="text-[11px] font-medium uppercase tracking-[0.2em] text-[#8a7f72]">
                                  Essential fields
                                </h3>
                                <p className="text-xs font-medium text-[#9b8f82]">
                                  Used most often for reconciliation.
                                </p>
                              </div>
                              <span className="text-xs font-medium text-[#8a7f72]">
                                {
                                  selectedPriorityFields.filter(
                                    (fieldKey) => selectedFieldMap[fieldKey] ?? true
                                  ).length
                                }
                                /{selectedPriorityFields.length} active
                              </span>
                            </div>

                            <div className="grid grid-cols-1 gap-2 md:grid-cols-2 xl:grid-cols-3">
                              {selectedPriorityFields.map((fieldKey) => {
                                const isEnabled = selectedFieldMap[fieldKey] ?? true;

                                return (
                                  <button
                                    key={fieldKey}
                                    aria-pressed={isEnabled}
                                    className={`flex min-h-10 items-center gap-2.5 rounded-lg border px-3 py-2 text-left transition ${
                                      isEnabled
                                        ? "border-[#e8e5de] bg-white"
                                        : "border-[#e5ddd0] bg-white"
                                    } ${selectedDocTypeEnabled ? "hover:bg-[#fafafa]" : "opacity-60"}`}
                                    disabled={!selectedDocTypeEnabled}
                                    onClick={() => handleToggleField(selectedDocType, fieldKey)}
                                    type="button"
                                  >
                                    <span
                                      className={`flex h-4 w-4 shrink-0 items-center justify-center rounded border ${
                                        isEnabled
                                          ? "border-[#3d6b4a] bg-[#3d6b4a] text-white"
                                          : "border-[#d8d4c9] bg-white text-transparent"
                                      }`}
                                    >
                                      <Check className="h-3 w-3" />
                                    </span>
                                    <span className="min-w-0 truncate text-[13px] text-[#20201c]">
                                      {FIELD_LABELS[fieldKey]}
                                    </span>
                                  </button>
                                );
                              })}
                            </div>
                          </section>

                          <section>
                            <div className="mb-2 flex items-end justify-between gap-3">
                              <div>
                                <h3 className="text-[11px] font-medium uppercase tracking-[0.2em] text-[#8a7f72]">
                                  Optional fields
                                </h3>
                                <p className="text-xs font-medium text-[#9b8f82]">
                                  Extra signals available for this document type.
                                </p>
                              </div>
                              <span className="text-xs font-medium text-[#8a7f72]">
                                {
                                  selectedStandardFields.filter(
                                    (fieldKey) => selectedFieldMap[fieldKey] ?? true
                                  ).length
                                }
                                /{selectedStandardFields.length} active
                              </span>
                            </div>

                            <div className="grid grid-cols-1 gap-2 md:grid-cols-2 xl:grid-cols-3">
                              {selectedStandardFields.map((fieldKey) => {
                                const isEnabled = selectedFieldMap[fieldKey] ?? true;

                                return (
                                  <button
                                    key={fieldKey}
                                    aria-pressed={isEnabled}
                                    className={`flex min-h-10 items-center gap-2.5 rounded-lg border px-3 py-2 text-left transition ${
                                      isEnabled
                                        ? "border-[#e8e5de] bg-white"
                                        : "border-[#e5ddd0] bg-white"
                                    } ${selectedDocTypeEnabled ? "hover:bg-[#fafafa]" : "opacity-60"}`}
                                    disabled={!selectedDocTypeEnabled}
                                    onClick={() => handleToggleField(selectedDocType, fieldKey)}
                                    type="button"
                                  >
                                    <span
                                      className={`flex h-4 w-4 shrink-0 items-center justify-center rounded border ${
                                        isEnabled
                                          ? "border-[#3d6b4a] bg-[#3d6b4a] text-white"
                                          : "border-[#d8d4c9] bg-white text-transparent"
                                      }`}
                                    >
                                      <Check className="h-3 w-3" />
                                    </span>
                                    <span className="min-w-0 truncate text-[13px] text-[#20201c]">
                                      {FIELD_LABELS[fieldKey]}
                                    </span>
                                  </button>
                                );
                              })}
                            </div>
                          </section>
                        </div>
                        </div>
                      </>
                    )}
                  </main>
                </>
              ) : (
                <>
                  <aside className="w-full shrink-0 md:w-[270px]">
                    <div className="max-h-[calc(100vh-260px)] space-y-2 overflow-y-auto pr-1">
                      {comparisonGroups.length === 0 ? (
                        <div className="rounded-[10px] border border-dashed border-[#d8d4c9] bg-white p-4 text-sm text-[#6b6a60]">
                          No groups configured.
                        </div>
                      ) : (
                        comparisonGroups.map((group) => {
                          const isSelected = selectedGroup?.groupKey === group.groupKey;

                          return (
                            <button
                              key={group.groupKey}
                              className={`w-full rounded-[10px] border px-3.5 py-3 text-left transition ${
                                isSelected
                                  ? "border-[#bdd8c2] bg-[#e9f2ea] text-[#20201c]"
                                  : "border-[#e8e5de] bg-white text-[#20201c] hover:bg-[#f3f0e8]"
                              }`}
                              onClick={() => setSelectedGroupKey(group.groupKey)}
                              type="button"
                            >
                              <div className="flex items-center justify-between gap-3">
                                <div className="min-w-0">
                                  <div className="truncate text-sm font-medium">{group.label}</div>
                                  <div className="mt-0.5 text-[11.5px] font-normal text-[#9c9a8e]">
                                    {group.fields.length} field{group.fields.length === 1 ? "" : "s"}
                                  </div>
                                </div>
                                <span
                                  onClick={(event) => {
                                    event.stopPropagation();
                                    handleUpdateGroup(group.groupKey, {
                                      enabled: !group.enabled,
                                    });
                                  }}
                                >
                                  <SwitchControl checked={group.enabled} />
                                </span>
                              </div>
                            </button>
                          );
                        })
                      )}
                      <button
                        className="w-full rounded-[10px] border border-dashed border-[#d8d4c9] bg-transparent px-4 py-3 text-center text-sm text-[#6b6a60] transition hover:border-[#9c9a8e] hover:text-[#20201c]"
                        onClick={handleAddGroup}
                        type="button"
                      >
                        + Add review group
                      </button>
                    </div>
                  </aside>

                  <main className="min-w-0 flex-1 rounded-[10px] border border-[#e8e5de] bg-white p-6">
                    {loading ? (
                      <div className="space-y-3">
                        <div className="h-16 animate-pulse rounded-xl bg-[#f3eee7]" />
                        <div className="grid gap-2 md:grid-cols-2 xl:grid-cols-3">
                          {Array.from({ length: 12 }).map((_, index) => (
                            <div key={index} className="h-12 animate-pulse rounded-lg bg-[#f3eee7]" />
                          ))}
                        </div>
                      </div>
                    ) : selectedGroup ? (
                      <div>
                        <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
                          <label className="min-w-0 flex-1">
                            <div className="mb-1.5 text-[11px] font-medium tracking-[0.06em] text-[#8a7f72]">
                              Group name
                            </div>
                            <input
                              className="h-10 w-full rounded-lg border border-[#d8d4c9] bg-white px-3.5 text-base font-medium text-[#20201c] outline-none transition focus:border-[#3d6b4a]"
                              onChange={(event) =>
                                handleRenameGroup(selectedGroup.groupKey, event.target.value)
                              }
                              value={selectedGroup.label}
                            />
                            <p className="mt-2 text-[12.5px] leading-5 text-[#6b6a60]">
                              Reviewers will see these related fields together whenever any one of them shows a mismatch.
                            </p>
                          </label>

                          <div className="flex shrink-0 items-center gap-4 pt-7">
                            <button
                              className={`rounded-full border px-4 py-2 text-xs font-medium transition ${
                                selectedGroup.enabled
                                  ? "border-[#bdd8c2] bg-[#e9f2ea] text-[#3d6b4a]"
                                  : "border-[#e7c3bb] bg-[#fbeeec] text-[#a3402f]"
                              }`}
                              onClick={() =>
                                handleUpdateGroup(selectedGroup.groupKey, {
                                  enabled: !selectedGroup.enabled,
                                })
                              }
                              type="button"
                            >
                              {selectedGroup.enabled ? "Enabled" : "Disabled"}
                            </button>
                            <button
                              className="text-sm font-medium text-[#a3402f] transition hover:text-[#7f281d]"
                              onClick={() => handleDeleteGroup(selectedGroup.groupKey)}
                              type="button"
                            >
                              Delete
                            </button>
                          </div>
                        </div>

                        <div className="mt-4 rounded-lg bg-[#f3f0e8] p-3">
                          {selectedGroup.fields.length > 0 ? (
                            <div className="flex flex-wrap gap-2">
                              {selectedGroup.fields.map((fieldKey) => (
                                <span
                                  key={fieldKey}
                                  className="max-w-full truncate rounded-full border border-[#e8e5de] bg-white px-3 py-1.5 text-xs text-[#20201c]"
                                >
                                  {FIELD_LABELS[fieldKey as FieldKey] ?? fieldKey}
                                </span>
                              ))}
                            </div>
                          ) : (
                            <span className="text-[12.5px] text-[#9c9a8e]">
                              No fields selected yet. Pick from the list below.
                            </span>
                          )}
                        </div>

                        <section className="mt-5">
                          <div className="mb-3">
                            <h3 className="text-[11px] font-medium tracking-[0.06em] text-[#8a7f72]">
                              Fields in group
                            </h3>
                            <p className="mt-1 text-[12.5px] leading-5 text-[#6b6a60]">
                              Pick every field that should be reviewed as one issue family, across all documents.
                            </p>
                          </div>

                          <label className="mb-3 flex max-w-md items-center gap-2 rounded-lg bg-[#f3f0e8] px-3 py-2">
                            <Search className="h-4 w-4 shrink-0 text-[#9c9a8e]" />
                            <input
                              className="w-full bg-transparent text-[13px] text-[#20201c] outline-none placeholder:text-[#9c9a8e]"
                              onChange={(event) => setGroupFieldSearch(event.target.value)}
                              placeholder="Search fields"
                              type="search"
                              value={groupFieldSearch}
                            />
                          </label>

                          <div className="max-h-[400px] overflow-y-auto rounded-lg border border-[#e8e5de]">
                            {filteredGroupFieldSections.map((section) => (
                              <div key={section.docType}>
                                <div className="sticky top-0 z-10 bg-[#f3f0e8] px-4 py-2.5 text-[11px] font-medium tracking-[0.06em] text-[#9c9a8e]">
                                  {section.docType}
                                </div>
                                {section.fields.map((fieldKey) => {
                                  const isSelected = selectedGroup.fields.includes(fieldKey);
                                  const otherGroup = comparisonGroups.find(
                                    (group) =>
                                      group.groupKey !== selectedGroup.groupKey &&
                                      group.fields.includes(fieldKey)
                                  );

                                  return (
                                    <button
                                      key={`${section.docType}-${fieldKey}`}
                                      aria-pressed={isSelected}
                                      className="flex w-full items-center gap-3 border-t border-[#e8e5de] px-4 py-2.5 text-left transition hover:bg-[#f3f0e8]"
                                      onClick={() =>
                                        handleToggleGroupField(selectedGroup.groupKey, fieldKey)
                                      }
                                      type="button"
                                    >
                                      <span
                                        className={`flex h-4 w-4 shrink-0 items-center justify-center rounded border ${
                                          isSelected
                                            ? "border-[#3d6b4a] bg-[#3d6b4a] text-white"
                                            : "border-[#d8d4c9] bg-white text-transparent"
                                        }`}
                                      >
                                        <Check className="h-3 w-3" />
                                      </span>
                                      <span className="min-w-0 flex-1 truncate text-[13px] text-[#20201c]">
                                        {FIELD_LABELS[fieldKey]}
                                        {otherGroup ? (
                                          <span className="text-[#9c9a8e]">
                                            {" "}
                                            - in {otherGroup.label}
                                          </span>
                                        ) : null}
                                      </span>
                                      <span className="shrink-0 font-mono text-[11px] text-[#9c9a8e]">
                                        {fieldKey}
                                      </span>
                                    </button>
                                  );
                                })}
                              </div>
                            ))}
                            {filteredGroupFieldSections.length === 0 ? (
                              <div className="px-4 py-8 text-center text-sm text-[#6b6a60]">
                                No fields found.
                              </div>
                            ) : null}
                          </div>
                        </section>
                      </div>
                    ) : (
                      <div className="flex h-full items-center justify-center rounded-xl border border-dashed border-[#d8ccbc] bg-[#fbfaf8] text-sm font-medium text-[#8a7f72]">
                        Create a group to start.
                      </div>
                    )}
                  </main>
                </>
              )}
            </div>
          </div>
        </div>
      </div>
    </AppShell>
  );
}
