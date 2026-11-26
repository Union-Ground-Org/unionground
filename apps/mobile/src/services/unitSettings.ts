import { businessRpc } from './businessWriters';
import type { MobileSessionWriter } from './supabase';
import { getSupabaseClient } from './supabase';

type Row = Record<string, unknown>;
export type UnitChoice = { id: string; name: string };
export type UnitCategory = { key: string; label: string; visible: boolean };
export type UnitSettingGroup = 'workload' | 'forms' | 'templates' | 'capabilities';
export type UnitOverrides = Partial<{ workload: UnitCategory[]; forms: string[]; templates: string[]; capabilities: Record<string, boolean> }>;
export type UnitField = {
  key: string; label: string; type: 'number' | 'text' | 'date' | 'boolean' | 'select';
  kind: 'category' | 'field'; required: boolean; visible: boolean; retired: boolean;
  unit: string; summary: 'none' | 'sum' | 'average'; options: string[];
};
export type UnitConfiguration = {
  actorId: string; chapterId: string; organizationId: string; unitId: string | null; unitName: string | null;
  version: number; settingsRevision: string;
  definition: { title: string; period: 'week' | 'month' | 'quarter'; statuses: string[]; fields: UnitField[] };
};
export type UnitEffective = {
  workload: UnitCategory[]; forms: string[]; templates: string[]; capabilities: Record<string, boolean>;
  configuration?: UnitConfiguration;
};
export type UnitContext = {
  actorId: string; chapterId: string; organizationId: string; units: UnitChoice[]; unitId: string | null;
  needsChoice: boolean; effective: UnitEffective | null; canManage: boolean; legacy?: boolean;
  unitCount?: number; nextUnitOffset?: number | null; unitName?: string | null;
};
export type UnitWorkspace = {
  actorId: string; chapterId: string; units: UnitChoice[]; unitId: string | null; canSetChapter: boolean;
  allowed: Partial<Record<UnitSettingGroup, boolean>>; defaults: UnitEffective; effective: UnitEffective;
  organizationDefaults: UnitEffective; chapterOverrides: UnitOverrides;
  overrides: UnitOverrides; chapterVersion: number; unitVersion: number;
  formChoices: { key: string; labelEn: string; labelEs: string }[];
  templateChoices: { key: string; labelEn: string; labelEs: string }[];
  audit: { id: string; createdAt: string; unitName: string | null }[];
  unitCount?: number; nextUnitOffset?: number | null; unitName?: string | null;
};

const unavailable = (): never => { throw new Error('Unit settings unavailable'); };
const row = (value: unknown): Row => value && typeof value === 'object' && !Array.isArray(value) ? value as Row : unavailable();
const text = (value: unknown): string => typeof value === 'string' ? value : unavailable();
const flag = (value: unknown): boolean => typeof value === 'boolean' ? value : unavailable();
const integer = (value: unknown): number => typeof value === 'number' && Number.isSafeInteger(value) ? value : unavailable();
const nullableText = (value: unknown): string | null => value === null ? null : text(value);
const array = <T,>(value: unknown, parse: (item: unknown) => T): T[] => Array.isArray(value) ? value.map((item: unknown) => parse(item)) : unavailable();
const strings = (value: unknown): string[] => array(value, text);
function choice(value: unknown): UnitChoice { const item = row(value); return { id: text(item.id), name: text(item.name) }; }
function categories(value: unknown): UnitCategory[] {
  return array(value, (entry) => { const item = row(entry); return { key: text(item.key), label: text(item.label), visible: flag(item.visible) }; });
}
function flags(value: unknown): Record<string, boolean> {
  return Object.fromEntries(Object.entries(row(value)).map(([key, enabled]) => [key, flag(enabled)]));
}
function field(value: unknown): UnitField {
  const item = row(value);
  const type = (['number', 'text', 'date', 'boolean', 'select'] as const).find((entry) => entry === item.type);
  const kind = (['category', 'field'] as const).find((entry) => entry === item.kind);
  const summary = (['none', 'sum', 'average'] as const).find((entry) => entry === item.summary);
  if (!type || !kind || !summary) return unavailable();
  return { key: text(item.key), label: text(item.label), type, kind, summary,
    required: flag(item.required), visible: flag(item.visible), retired: flag(item.retired), unit: text(item.unit), options: strings(item.options) };
}
function workloadDefinition(value: unknown): UnitConfiguration['definition'] {
  const definition = row(value);
  const period = (['week', 'month', 'quarter'] as const).find((entry) => entry === definition.period);
  if (!period) return unavailable();
  return { title: text(definition.title), period, statuses: strings(definition.statuses), fields: array(definition.fields, field) };
}
function configuration(value: unknown): UnitConfiguration {
  const item = row(value);
  return { actorId: text(item.actorId), chapterId: text(item.chapterId), organizationId: text(item.organizationId),
    unitId: nullableText(item.unitId), unitName: nullableText(item.unitName), version: integer(item.version), settingsRevision: text(item.settingsRevision),
    definition: workloadDefinition(item.definition) };
}
function effective(value: unknown): UnitEffective {
  const item = row(value);
  return { workload: categories(item.workload), forms: strings(item.forms), templates: strings(item.templates), capabilities: flags(item.capabilities),
    ...(item.configuration ? { configuration: configuration(item.configuration) } : {}) };
}
function overrides(value: unknown): UnitOverrides {
  const item = row(value);
  if (Object.keys(item).some((key) => !['workload', 'forms', 'templates', 'capabilities'].includes(key))) return unavailable();
  return { ...(item.workload ? { workload: categories(item.workload) } : {}), ...(item.forms ? { forms: strings(item.forms) } : {}),
    ...(item.templates ? { templates: strings(item.templates) } : {}), ...(item.capabilities ? { capabilities: flags(item.capabilities) } : {}) };
}
function workspace(value: unknown): UnitWorkspace {
  const item = row(value), allowed = flags(item.allowed);
  const label = (value: unknown) => { const entry = row(value); return { key: text(entry.key), labelEn: text(entry.labelEn), labelEs: text(entry.labelEs) }; };
  return { actorId: text(item.actorId), chapterId: text(item.chapterId), units: array(item.units, choice), unitId: nullableText(item.unitId), canSetChapter: flag(item.canSetChapter),
    allowed: { workload: allowed.workload === true, forms: allowed.forms === true, templates: allowed.templates === true, capabilities: allowed.capabilities === true },
    defaults: effective(item.defaults), effective: effective(item.effective), organizationDefaults: effective(item.organizationDefaults), chapterOverrides: overrides(item.chapterOverrides),
    overrides: overrides(item.overrides), chapterVersion: integer(item.chapterVersion), unitVersion: integer(item.unitVersion),
    formChoices: array(item.formChoices, label), templateChoices: array(item.templateChoices, label),
    unitCount: item.unitCount === undefined ? undefined : integer(item.unitCount), nextUnitOffset: item.nextUnitOffset == null ? null : integer(item.nextUnitOffset), unitName: item.unitName == null ? null : text(item.unitName),
    audit: array(item.audit, (value) => { const entry = row(value); return { id: text(entry.id), createdAt: text(entry.created_at), unitName: nullableText(entry.unit_name) }; }) };
}

async function call(name: string, args: Row): Promise<unknown> {
  const client = getSupabaseClient();
  if (!client) return unavailable();
  const initial = (await client.auth.getSession()).data.session;
  if (!initial?.user.id || !initial.access_token) return unavailable();
  const result: { data: unknown; error: { code?: string; message: string } | null } = await client.rpc(name, args).setHeader('Authorization', `Bearer ${initial.access_token}`);
  if ((await client.auth.getSession()).data.session?.user.id !== initial.user.id) return unavailable();
  if (result.error) throw Object.assign(new Error(result.error.message), { code: result.error.code });
  return result.data;
}

const LEGACY_CONTEXT: UnitContext = Object.freeze({
  actorId: '', chapterId: '', organizationId: '', units: [], unitId: null, needsChoice: false, effective: null, canManage: false, legacy: true,
});

export async function loadNativeUnitSettings(unitId: string | null = null, offset = 0): Promise<UnitContext> {
  let value: unknown;
  try { value = await call('get_my_unit_settings', { p_unit: unitId, ...(offset ? { p_offset: offset } : {}) }); }
  catch (error: unknown) {
    if (error instanceof Error && 'code' in error && error.code === 'PGRST202' && error.message.includes('get_my_unit_settings')) return LEGACY_CONTEXT;
    throw error;
  }
  const item = row(value);
  // Held on the release calendar: the chapter workflow, with nothing about units shown.
  if (item.released === false) return LEGACY_CONTEXT;
  return { actorId: text(item.actorId), chapterId: text(item.chapterId), organizationId: text(item.organizationId),
    units: array(item.units, choice), unitId: nullableText(item.unitId), needsChoice: flag(item.needsChoice),
    effective: item.effective === null ? null : effective(item.effective), canManage: flag(item.canManage),
    unitCount: item.unitCount === undefined ? undefined : integer(item.unitCount), nextUnitOffset: item.nextUnitOffset == null ? null : integer(item.nextUnitOffset), unitName: item.unitName == null ? null : text(item.unitName) };
}
// While units are held, the member logs workload on the organization's form,
// through the same server write the website's Workload log uses
// (submitWorkloadLog in src/lib/memberApi.js with a configuration version).
// Version 0 is the default form; the server validates both again.
export type OrganizationWorkload = { organizationId: string; version: number; definition: UnitConfiguration['definition'] };
export async function loadNativeOrganizationWorkload(): Promise<OrganizationWorkload> {
  const item = row(await call('get_organization_workload_configuration', {}));
  return { organizationId: text(item.organizationId), version: integer(item.version), definition: workloadDefinition(item.definition) };
}
export async function saveNativeOrganizationWorkload(writer: MobileSessionWriter, form: OrganizationWorkload, values: Record<string, string | number | boolean>, status: string): Promise<void> {
  await businessRpc(writer, 'save_configured_workload_log', { p_entry_id: null, p_version: form.version, p_values: values, p_status: status, p_organization_id: form.organizationId });
}
export async function loadNativeUnitEditor(chapterId: string, unitId: string | null, offset = 0): Promise<UnitWorkspace> {
  return workspace(await call('get_unit_settings_workspace', { p_chapter: chapterId, p_unit: unitId, ...(offset ? { p_offset: offset } : {}) }));
}
export async function saveNativeUnitOverrides(writer: MobileSessionWriter, context: UnitWorkspace, value: UnitOverrides): Promise<UnitWorkspace> {
  return workspace(await businessRpc(writer, 'save_unit_settings', { p_chapter: context.chapterId, p_unit: context.unitId, p_overrides: value, p_expected_version: context.unitVersion, p_actor: context.actorId }));
}
export async function saveNativeChapterUnitSettings(writer: MobileSessionWriter, context: UnitWorkspace, value: UnitOverrides, allowed: UnitWorkspace['allowed']): Promise<UnitWorkspace> {
  return workspace(await businessRpc(writer, 'save_chapter_unit_settings', { p_chapter: context.chapterId, p_defaults: value, p_allowed: allowed, p_expected_version: context.chapterVersion, p_actor: context.actorId }));
}
export async function saveNativeUnitWorkload(writer: MobileSessionWriter, context: UnitContext, values: Record<string, string | number | boolean>, status: string): Promise<void> {
  const config = context.effective?.configuration;
  if (context.legacy || !config || context.needsChoice) return unavailable();
  await businessRpc(writer, 'save_unit_workload_log', { p_entry_id: null, p_version: config.version, p_values: values, p_status: status,
    p_organization_id: context.organizationId, p_unit: context.unitId, p_settings_revision: config.settingsRevision, p_actor: context.actorId, p_chapter: context.chapterId });
}
