// Member forms on the native apps
// (BUG-UG-NATIVE-SEVEN-FEATURE-KEYS-OPEN-ONLY-THE-GENERIC-SCREEN-20261113,
//; REQ-UG-NATIVE-FORMS-FULL-PARITY-WITH-THE-WEBSITE-20261113,
// The phone lists the member's own forms and starts, fills, saves, signs and
// submits them through the server paths the web uses: save_form_draft for an
// ordinary form, the sensitive-content API (src/lib/sensitiveContentApi.js, the
// web's own transport) for the sealed FMLA forms, sign_member_form and
// submit_form. No rule is relaxed for the phone; every call carries the
// member's own session. The co-signed alliance grievance and attachments stay on
// the website until the second part of .
import { sensitiveContentRpc as webSensitiveContentRpc } from '../../../../src/lib/sensitiveContentApi.js';
import { signatureIsSendable, type SignatureStrokes } from '../lib/signatureStrokes';
import type { Session } from '@supabase/supabase-js';

import { createCapturedSessionRpcClient, getSupabaseClient } from './supabase';

// src/lib/memberApi.js SEALED_FORM_TEMPLATE_KEYS and api/_lib/sensitiveContent.js
// SEALED_FORM_TEMPLATES; save_form_draft refuses them, so their answers are
// read and written only through the sensitive-content API.
export const SEALED_FORM_TEMPLATE_KEYS: ReadonlySet<string> = new Set(['fmla_self', 'fmla_family']);
// save_form_draft resets accepted co-signatures on this template whenever its
// answers change, and notifies each co-signer.
export const COSIGNED_FORM_TEMPLATE_KEYS: ReadonlySet<string> = new Set(['alliance_grievance']);

export function formIsSealed(templateKey: string): boolean {
  return SEALED_FORM_TEMPLATE_KEYS.has(templateKey);
}

export type FormFieldType = 'text' | 'textarea' | 'date' | 'select' | 'radio' | 'checkbox' | 'multiselect' | 'number';
export const FORM_FIELD_TYPES: readonly FormFieldType[] = ['text', 'textarea', 'date', 'select', 'radio', 'checkbox', 'multiselect', 'number'];
export type FormFieldOption = { value: string; label: string };
export type FormField = { key: string; type: FormFieldType; label: string; required: boolean; maxLength: number | null; options: FormFieldOption[] };
export type FormStep = { title: string; fields: FormField[] };
export type FormTemplate = { key: string; version: number; label: string; blurb: string; steps: FormStep[]; active: boolean; startable: boolean; ownedByOrganization: boolean };

export type FormAnswerValue = string | boolean | string[];
export type FormAnswers = Record<string, FormAnswerValue>;

// Answers as the database stores them: the base an ordinary save names must
// equal the stored jsonb, so it is kept as read, not as the editor shows it.
export type StoredAnswers = Record<string, unknown>;

export type MemberForm = {
  id: string;
  templateKey: string;
  templateVersion: number;
  status: string;
  answers: FormAnswers;
  step: number;
  reviewNote: string;
  updatedAt: string;
  signed: boolean;
  // A filer signature for the form's current content (filer_signature_digest);
  // a later change to the answers clears it on the server.
  signatureCurrent: boolean;
  // Sealed templates only: the row carries the sealed marker (its answers are
  // opened through the sensitive-content API), or it still holds plaintext
  // answers from before the backfill and is never opened or edited (web
  // hydrateSealedFormAnswers,  r1g4).
  sealedMarker: boolean;
  sealedPlaintext: boolean;
  // The unit a form was made for, once it is bound: its saves keep that
  // unit whatever the new-form picker shows. Absent for a form with no unit
  // stamp, which takes the unit chosen now.
  boundUnit?: { unitId: string | null };
  // An ordinary form's answers exactly as the row stores them, which an
  // ordinary save names as its base; {} for a sealed form.
  storedAnswers: StoredAnswers;
};

export const MEMBER_FORM_LIMIT = 100;
const TEMPLATE_PAGE = 500;
const FORM_STATUS_LABELS: Record<string, string> = { draft: 'Draft', returned: 'Returned to you', submitted: 'Submitted', in_review: 'In review', approved: 'Approved' };

export function formStatusLabel(status: string): string {
  return FORM_STATUS_LABELS[status] ?? status.replaceAll('_', ' ');
}

export function formIsEditable(form: Pick<MemberForm, 'status' | 'templateKey'>): boolean {
  return form.status === 'draft' || form.status === 'returned';
}

type Row = Record<string, unknown>;

// The web transport, typed for TypeScript callers: its last argument pins a
// request to the session a sealed save began under ( round 3).
const sensitiveContentRpc = webSensitiveContentRpc as (
  client: unknown, operation: string, args: object, origin: string, accessToken?: string | null,
) => Promise<{ data: unknown; error: unknown }>;

function record(value: unknown): Row | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Row : null;
}

// A label is a plain string or an { en, es } pair (web templateFromDbRow).
function pick(value: unknown, spanish: boolean): string {
  if (typeof value === 'string') return value;
  const pair = record(value);
  if (!pair) return '';
  const preferred = spanish ? pair.es : pair.en;
  if (typeof preferred === 'string' && preferred) return preferred;
  return typeof pair.en === 'string' ? pair.en : '';
}

function fieldFrom(value: unknown, spanish: boolean): FormField | null {
  const field = record(value);
  if (!field || typeof field.key !== 'string' || !field.key) return null;
  const type = (FORM_FIELD_TYPES as readonly unknown[]).includes(field.type) ? field.type as FormFieldType : null;
  if (!type) return null;
  const options = (Array.isArray(field.options) ? field.options as unknown[] : []).flatMap((item): FormFieldOption[] => {
    const option = record(item);
    if (!option || typeof option.value !== 'string') return [];
    return [{ value: option.value, label: pick(option.label, spanish) || option.value }];
  });
  return {
    key: field.key,
    type,
    label: pick(field.label, spanish) || field.key,
    required: field.required === true,
    maxLength: typeof field.maxLength === 'number' && field.maxLength > 0 ? field.maxLength : null,
    options,
  };
}

export function formTemplateFromRow(row: Row, spanish = false): FormTemplate | null {
  if (typeof row.key !== 'string' || typeof row.version !== 'number') return null;
  const schema = record(row.field_schema);
  const steps = (Array.isArray(schema?.steps) ? schema.steps as unknown[] : []).map((value) => {
    const step = record(value);
    return {
      title: pick(step?.title, spanish),
      fields: (Array.isArray(step?.fields) ? step.fields as unknown[] : []).flatMap((field) => {
        const parsed = fieldFrom(field, spanish);
        return parsed ? [parsed] : [];
      }),
    };
  });
  return {
    key: row.key,
    version: row.version,
    label: (spanish && typeof row.label_es === 'string' && row.label_es) || (typeof row.label_en === 'string' ? row.label_en : row.key),
    blurb: (spanish && typeof row.blurb_es === 'string' && row.blurb_es) || (typeof row.blurb_en === 'string' ? row.blurb_en : ''),
    steps,
    active: row.active !== false,
    startable: row.available_to_start !== false,
    ownedByOrganization: row.is_platform_seed === false && row.organization_id != null,
  };
}

// The template to start: per key, among the rows the registry offers to start,
// the organization's own copy above a platform seed, then the highest version
// (web compareTemplateRowPrecedence); then only if that current row is active.
// Precedence comes first, as in the web's currentFormTemplateRows and in
// save_form_draft, so an organization that turned its own copy off does not
// bring the platform seed back (gate stage 118 on).
export function startableFormTemplates(templates: readonly FormTemplate[]): FormTemplate[] {
  const current = new Map<string, FormTemplate>();
  for (const template of templates) {
    if (!template.startable) continue;
    const held = current.get(template.key);
    const outranks = !held
      || Number(template.ownedByOrganization) > Number(held.ownedByOrganization)
      || (template.ownedByOrganization === held.ownedByOrganization && template.version > held.version);
    if (outranks) current.set(template.key, template);
  }
  return [...current.values()].filter((template) => template.active);
}

// The template a NEW form starts from. An organization that runs no dues is
// offered no Dues choice (web formTemplatesForDues). A saved form keeps its
// pinned template whole, so a Dues answer it already holds is never dropped by
// a later save (gate stage 118 on).
export function formTemplateForNewStart(template: FormTemplate, runsDues: boolean | null): FormTemplate {
  if (runsDues !== false) return template;
  return {
    ...template,
    steps: template.steps.map((step) => ({
      ...step,
      fields: step.fields.map((field) => ({ ...field, options: field.options.filter((option) => option.value !== 'dues') })),
    })),
  };
}

// The template version a saved form is pinned to.
export function templateForForm(templates: readonly FormTemplate[], form: Pick<MemberForm, 'templateKey' | 'templateVersion'>): FormTemplate | null {
  const pinned = templates.filter((template) => template.key === form.templateKey && template.version === form.templateVersion);
  return pinned.find((template) => template.ownedByOrganization) ?? pinned[0] ?? null;
}

// Required fields still unanswered, by label. An explicit No on a required
// checkbox is an answer, as the web's formProgress and submit_form count it
// (gate stage 136 on, r1s2); only an absent answer is missing.
export function missingRequiredFields(template: FormTemplate, answers: FormAnswers): string[] {
  return template.steps.flatMap((step) => step.fields).filter((field) => {
    if (!field.required) return false;
    const value = answers[field.key];
    if (Array.isArray(value)) return value.length === 0;
    if (typeof value === 'boolean') return false;
    return typeof value !== 'string' || !value.trim();
  }).map((field) => field.label);
}

// Answers the member typed that the save leaves out because they do not parse
// (a date not written year-month-day, a number that is not one), by label, so
// the review can name them before anything is signed (gate stage 136 on,
// r1s4, r2s3).
export function unsavedAnswerFields(template: FormTemplate, answers: FormAnswers): string[] {
  const clean = cleanFormAnswers(template, answers);
  return template.steps.flatMap((step) => step.fields).filter((field) => {
    const value = answers[field.key];
    const given = typeof value === 'string' ? value.trim() !== '' : Array.isArray(value) ? value.length > 0 : typeof value === 'boolean';
    return given && !Object.hasOwn(clean, field.key);
  }).map((field) => field.label);
}

export const FORM_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

// Answers as the web stores them; a date or number that does not parse is
// left out rather than saved as text the web editor cannot show.
export function cleanFormAnswers(template: FormTemplate, answers: FormAnswers): FormAnswers {
  const fields = new Map(template.steps.flatMap((step) => step.fields).map((field) => [field.key, field]));
  const clean: FormAnswers = {};
  for (const [key, value] of Object.entries(answers)) {
    const field = fields.get(key);
    if (!field) continue;
    if (field.type === 'checkbox') { if (typeof value === 'boolean') clean[key] = value; continue; }
    if (field.type === 'multiselect') { if (Array.isArray(value)) clean[key] = value.filter((item) => field.options.some((option) => option.value === item)); continue; }
    if (typeof value !== 'string') continue;
    const text = field.type === 'textarea' ? value.trim() : value.trim().replace(/\s+/g, ' ');
    if (!text) continue;
    if (field.type === 'date' && !FORM_DATE_PATTERN.test(text)) continue;
    if (field.type === 'number' && !Number.isFinite(Number(text))) continue;
    if ((field.type === 'select' || field.type === 'radio') && !field.options.some((option) => option.value === text)) continue;
    clean[key] = field.maxLength ? text.slice(0, field.maxLength) : text;
  }
  return clean;
}

function answersFrom(value: unknown): FormAnswers {
  const source = record(value) ?? {};
  const answers: FormAnswers = {};
  for (const [key, item] of Object.entries(source)) {
    if (typeof item === 'string' || typeof item === 'boolean') answers[key] = item;
    else if (typeof item === 'number' && Number.isFinite(item)) answers[key] = String(item);
    else if (Array.isArray(item)) {
      const entries: unknown[] = item;
      const strings: string[] = [];
      for (const entry of entries) if (typeof entry === 'string') strings.push(entry);
      answers[key] = strings;
    }
  }
  return answers;
}

function client() {
  const supabase = getSupabaseClient();
  if (!supabase) throw new Error('The secure mobile backend is not configured.');
  return supabase;
}

// Every registry version the member may read, so a draft pinned to an older
// version still renders. Read whole, in (sort, key, version) order, a page at a
// time until a short page, as the web's fetchAllFormTemplates does: one page
// could leave out a current version (gate stage 118 on). A failed page,
// or a walk that does not end, fails the read rather than show a partial list.
const TEMPLATE_PAGE_LIMIT = 40;
export async function loadFormTemplates(spanish = false): Promise<FormTemplate[]> {
  const rows: Row[] = [];
  for (let page = 0; page < TEMPLATE_PAGE_LIMIT; page += 1) {
    const from = page * TEMPLATE_PAGE;
    const result: { data: unknown; error: unknown } = await client().from('form_template_registry')
      .select('key,version,label_en,label_es,blurb_en,blurb_es,active,sort,field_schema,organization_id,is_platform_seed,available_to_start')
      .order('sort').order('key').order('version')
      .range(from, from + TEMPLATE_PAGE - 1);
    if (result.error) throw result.error;
    const pageRows = Array.isArray(result.data) ? result.data as Row[] : [];
    rows.push(...pageRows);
    if (pageRows.length < TEMPLATE_PAGE) {
      return rows.flatMap((row) => {
        const template = formTemplateFromRow(row, spanish);
        return template ? [template] : [];
      });
    }
  }
  throw new Error('The form templates did not finish loading.');
}

const FORM_COLUMNS = 'id,template_key,template_version,status,answers,step,review_note,updated_at,filer_signed_at,filer_signature_digest';

// The unit stamp is read too; a server that predates the per-unit settings
// migration has no such column, and the list then reads without it .
async function selectMyForms(query: (columns: string) => PromiseLike<{ data: unknown; error: unknown }>): Promise<{ data: unknown; error: unknown }> {
  const result = await query(`${FORM_COLUMNS},settings_scope`);
  const code = record(result.error)?.code;
  return code === '42703' || code === 'PGRST204' ? query(FORM_COLUMNS) : result;
}

// The member's own forms only: co-signed forms that belong to someone else
// stay on the website.
export async function loadMyForms(userID: string): Promise<MemberForm[]> {
  if (!userID) return [];
  const result = await selectMyForms((columns) => client().from('member_forms')
    .select(columns)
    .eq('user_id', userID)
    .order('updated_at', { ascending: false })
    .limit(MEMBER_FORM_LIMIT));
  if (result.error) throw result.error;
  return (Array.isArray(result.data) ? result.data as Row[] : []).map(memberFormFrom);
}

// The member's open draft of a template, wherever it falls in their history.
// save_form_draft writes into the member's newest draft or returned form of
// the template, replacing its answers, so a new form on the phone starts from
// that draft rather than from an empty one when the recent list does not show
// it (gate stage 118 on).
export async function loadMyOpenFormDraft(userID: string, templateKey: string): Promise<MemberForm | null> {
  if (!userID || !templateKey) return null;
  const result = await selectMyForms((columns) => client().from('member_forms')
    .select(columns)
    .eq('user_id', userID)
    .eq('template_key', templateKey)
    .in('status', ['draft', 'returned'])
    .order('updated_at', { ascending: false })
    .limit(1));
  if (result.error) throw result.error;
  const [row] = Array.isArray(result.data) ? result.data as Row[] : [];
  return row ? memberFormFrom(row) : null;
}

function memberFormFrom(row: Row): MemberForm {
  const templateKey = String(row.template_key ?? '');
  const sealed = SEALED_FORM_TEMPLATE_KEYS.has(templateKey);
  const stored = record(row.answers) ?? {};
  // answers.sealed is the envelope marker only on a sealed template; an
  // ordinary template may have a plain field named "sealed" .
  const sealedMarker = sealed && stored.sealed === true;
  return {
    id: String(row.id),
    templateKey,
    templateVersion: typeof row.template_version === 'number' ? row.template_version : 1,
    status: String(row.status ?? 'draft'),
    // A sealed form's answers are opened only through openFormAnswers.
    answers: sealed ? {} : answersFrom(row.answers),
    step: typeof row.step === 'number' ? row.step : 0,
    reviewNote: typeof row.review_note === 'string' ? row.review_note : '',
    updatedAt: String(row.updated_at ?? ''),
    signed: typeof row.filer_signed_at === 'string' && row.filer_signed_at !== '',
    signatureCurrent: typeof row.filer_signature_digest === 'string' && row.filer_signature_digest !== '',
    sealedMarker,
    sealedPlaintext: sealed && !sealedMarker && Object.keys(stored).some((key) => key !== 'seedSequence'),
    storedAnswers: sealed ? {} : stored,
    ...boundUnitFrom(row.settings_scope),
  };
}

function boundUnitFrom(value: unknown): { boundUnit?: { unitId: string | null } } {
  const scope = record(value);
  if (!scope || typeof scope.chapterId !== 'string') return {};
  return { boundUnit: { unitId: typeof scope.unitId === 'string' && scope.unitId ? scope.unitId : null } };
}

export class FormActionError extends Error {
  // A fixed reason the screen words in the member's language; never a server
  // message, a form id or an answer.
  // 'closed': the form this editor writes was submitted or replaced, so
  // nothing was saved into another one (gate stage 138 on, r3s1).
  // 'attachments-changed': the form's attachments are not the ones the member
  // was shown, so nothing was signed or submitted (gate stage 139 on,
  // r5s2 and r6s1).
  // 'form-changed': the form no longer holds what the member reviewed, so the
  // server signed nothing .
  // 'unit-required': the member belongs to several units and has not chosen
  // the one this form is for .
  readonly reason: 'unavailable' | 'session-changed' | 'signature-required' | 'attachments-pending' | 'attachments-changed' | 'form-changed' | 'closed' | 'unit-required' | 'failed';
  // The answers a save sent when its outcome is unknown: they may be
  // stored, under a version the editor never received (r3s3).
  readonly sent: FormAnswers | null;
  // The version of an earlier unanswered save that this save found stored:
  // the editor's baseline from now on, even though this save failed (gate
  // stage 139 on, r6s2).
  readonly baseline: string | null;
  constructor(reason: FormActionError['reason'], sent: FormAnswers | null = null, baseline: string | null = null) {
    super(reason);
    this.reason = reason;
    this.sent = sent;
    this.baseline = baseline;
  }
}

// A sealed request goes to the portal of the backend that issued the member's
// session, the strict pairing the file safety check uses (privateFileApiOrigin);
// a build whose backend and portal do not pair sends nothing. Loaded on use, so
// listing forms never reads the build configuration.
async function sealedOrigin(reason: FormActionError['reason']): Promise<string> {
  try {
    return (await import('./privateFileAccess')).privateFileApiOrigin();
  } catch {
    throw new FormActionError(reason);
  }
}

function canonicalAnswers(answers: FormAnswers): string {
  return JSON.stringify(Object.keys(answers).sort().map((key) => [key, answers[key]]));
}

function sameAnswers(left: FormAnswers, right: FormAnswers): boolean {
  return canonicalAnswers(left) === canonicalAnswers(right);
}

// Every call that reads or writes a member's form runs under that member's own
// session, captured before anything else is awaited and pinned for every
// request after it; between requests the session is read again, and any change
// of signed-in member stops the call (gate stage 136 on, r1). ownerID is
// the member the open editor belongs to, so work begun for one member is never
// sent with, or into the form of, another.
type MemberSession = { session: Session; token: string; userID: string };

async function sessionNow(supabase: ReturnType<typeof client>): Promise<MemberSession | null> {
  const session = (await supabase.auth.getSession()).data?.session;
  return session?.access_token && session.user?.id ? { session, token: session.access_token, userID: session.user.id } : null;
}

async function memberSession(supabase: ReturnType<typeof client>, ownerID: string): Promise<{ pinned: MemberSession; fence: () => Promise<void> }> {
  const pinned = await sessionNow(supabase);
  if (!pinned || !ownerID || pinned.userID !== ownerID) throw new FormActionError('session-changed');
  const fence = async () => {
    if ((await sessionNow(supabase))?.userID !== pinned.userID) throw new FormActionError('session-changed');
  };
  return { pinned, fence };
}

// The member's pinned session and its fence, for the form attachment calls
// (services/formFiles.ts).
export async function pinMemberSession(ownerID: string): Promise<{ session: MemberSession; fence: () => Promise<void> }> {
  const { pinned, fence } = await memberSession(client(), ownerID);
  return { session: pinned, fence };
}

// The answers a form opens with, and for a sealed form the data version its
// next save must name . A sealed form is opened through
// get_sealed_forms, which reads only rows the member's own RLS shows, in their
// organization. One that cannot be opened is unavailable, never shown empty,
// so nothing can save over it.
// stored: an ordinary form's answers exactly as stored .
export type OpenedForm = { answers: FormAnswers; dataVersion: string | null; stored?: StoredAnswers };

export async function openFormAnswers(form: MemberForm, ownerID: string): Promise<OpenedForm> {
  if (!SEALED_FORM_TEMPLATE_KEYS.has(form.templateKey)) return { answers: form.answers, dataVersion: null, stored: form.storedAnswers };
  if (form.sealedPlaintext) throw new FormActionError('unavailable');
  if (!form.sealedMarker) return { answers: {}, dataVersion: null };
  const supabase = client();
  const { pinned, fence } = await memberSession(supabase, ownerID);
  const origin = await sealedOrigin('unavailable');
  await fence();
  const result: { data: unknown; error: unknown } = await sensitiveContentRpc(supabase, 'get_sealed_forms', { formIds: [form.id] }, origin, pinned.token);
  await fence();
  const opened = (Array.isArray(result.data) ? result.data as unknown[] : []).map(record).find((item) => item?.id === form.id);
  if (result.error || !opened || opened.contentError) throw new FormActionError('unavailable');
  return { answers: answersFrom(opened.answers), dataVersion: typeof opened.dataVersion === 'string' ? opened.dataVersion : null };
}

// The save lane of one open editor: the member it belongs to, the form it
// writes, for a sealed form the data version its answers were built from, and
// the answers of earlier saves whose outcome is still unknown, and for an
// ordinary form the answers it last knew to be stored ({} for a new form).
export type FormSaveLane = { ownerID: string; formID: string | null; dataVersion: string | null; unconfirmed?: readonly FormAnswers[]; onFormID?: (formID: string) => void; unit?: UnitFormContext; baseAnswers?: StoredAnswers };

// The unit a form is for, once per-unit settings are released . The
// sealed calls carry it as the web does; an ordinary save goes through
// save_unit_form_draft.
export type UnitFormContext = { unitId: string | null; actorId: string; chapterId: string; organizationId: string };
// answers: the cleaned answers the save sent, which a signature names as the
// ones reviewed .
export type FormSaved = { formID: string; dataVersion: string | null; answers: FormAnswers };

const FILED_FORM_STATUSES: ReadonlySet<string> = new Set(['submitted', 'in_review', 'approved']);

// The status of one of the member's forms, read on their pinned session; null
// when it cannot be read.
async function formStatus(pinned: MemberSession, formID: string): Promise<string | null> {
  const result: { data: unknown; error: unknown } = await createCapturedSessionRpcClient(pinned.session).from('member_forms')
    .select('status').eq('id', formID).eq('user_id', pinned.userID).limit(1);
  const [row] = !result.error && Array.isArray(result.data) ? result.data as Row[] : [];
  return typeof row?.status === 'string' ? row.status : null;
}

// Whether a form whose submission went unanswered was filed after all, so a
// retry never files it twice (gate stage 138 on, r3s1).
export async function myFormWasFiled(formID: string, ownerID: string): Promise<boolean> {
  const { pinned, fence } = await memberSession(client(), ownerID);
  const status = await formStatus(pinned, formID);
  await fence();
  return status !== null && FILED_FORM_STATUSES.has(status);
}

// save_form_draft upserts the member's one open draft for the template and
// returns its id. A change to the answers clears an earlier filer signature.
// A sealed form saves as the web's saveFormDraft does: its draft is prepared
// first so the lane knows its id before any answer is sent, and the save names
// that form and the data version it started from .
export async function saveMyFormDraft(template: FormTemplate, answers: FormAnswers, step: number, lane: FormSaveLane): Promise<FormSaved> {
  const supabase = client();
  const clean = cleanFormAnswers(template, answers);
  const safeStep = Math.max(0, Math.min(50, Math.floor(step)));
  const { pinned, fence } = await memberSession(supabase, lane.ownerID);
  if (SEALED_FORM_TEMPLATE_KEYS.has(template.key)) {
    const origin = await sealedOrigin('failed');
    await fence();
    let formID = lane.formID;
    if (!formID) {
      const prepared: { data: unknown; error: unknown } = await sensitiveContentRpc(supabase, 'prepare_sealed_form', { templateKey: template.key, ...(lane.unit ?? {}) }, origin, pinned.token);
      await fence();
      const preparedID = record(prepared.data)?.formId;
      if (prepared.error || typeof preparedID !== 'string' || !preparedID) throw new FormActionError('failed');
      formID = preparedID;
      lane.onFormID?.(formID);
    }
    const sealedID = formID;
    const storedNow = async (): Promise<OpenedForm | null> => {
      const stored: { data: unknown; error: unknown } = await sensitiveContentRpc(supabase, 'get_sealed_forms', { formIds: [sealedID] }, origin, pinned.token);
      await fence();
      const row = (Array.isArray(stored.data) ? stored.data as unknown[] : []).map(record).find((item) => item?.id === sealedID);
      // A draft prepared but never given answers has no envelope yet, so its
      // version is null: a read like that succeeded (gate stage 146, r7s1).
      if (stored.error || !row || row.contentError || (typeof row.dataVersion !== 'string' && row.dataVersion !== null)) return null;
      return { answers: answersFrom(row.answers), dataVersion: typeof row.dataVersion === 'string' ? row.dataVersion : null };
    };
    // An earlier save whose reply never came may have committed. Its stored
    // answers are recognised before newer ones are sent, so the newer save
    // names the version that save made rather than the one it replaced
    // (gate stage 138 on, r3s3). Answers stored by anything else keep
    // the editor's baseline, and the server refuses the save.
    let expected = lane.dataVersion;
    let recognized: string | null = null;
    const unconfirmed = lane.unconfirmed ?? [];
    if (unconfirmed.length) {
      const stored = await storedNow();
      if (!stored) throw new FormActionError('failed');
      if (unconfirmed.some((sent) => sameAnswers(stored.answers, sent))) expected = recognized = stored.dataVersion;
    }
    const saved: { data: unknown; error: unknown } = await sensitiveContentRpc(supabase, 'save_sealed_form_draft', {
      templateKey: template.key, answers: clean, step: safeStep, expectedDataVersion: expected, formId: formID, ...(lane.unit ?? {}),
    }, origin, pinned.token);
    await fence();
    const result = record(saved.data);
    if (!saved.error && result?.formId === formID) return { formID, dataVersion: typeof result.dataVersion === 'string' ? result.dataVersion : null, answers: clean };
    // A failed or lost reply may hide a save that committed, after which every
    // retry naming the old version is refused. The stored answers are read
    // back once: when they are exactly the answers just sent, and the form is
    // still open, their version becomes the baseline; anything else stays a
    // failure that carries the answers sent, so newer answers saved elsewhere
    // are never written over (gate stage 136 on, r1s3).
    const stored = await storedNow();
    if (stored && sameAnswers(stored.answers, clean)) {
      const status = await formStatus(pinned, formID);
      await fence();
      if (status === 'draft' || status === 'returned') return { formID, dataVersion: stored.dataVersion, answers: clean };
      if (status !== null) throw new FormActionError('closed');
    }
    // Stored answers on a version past the one this save named, and not an
    // earlier save of this editor's, were saved by another session: the
    // version check refused this save because the form changed. That is the
    // same outcome as a refused signature or submission, never a connection
    // failure, and the save is not sent again ( part 2, controller
    // ruling on the  device run).
    if (stored && stored.dataVersion !== expected && !unconfirmed.some((sent) => sameAnswers(stored.answers, sent))) {
      const status = await formStatus(pinned, formID);
      await fence();
      throw new FormActionError(status === 'draft' || status === 'returned' ? 'form-changed' : status !== null ? 'closed' : 'failed');
    }
    throw new FormActionError('failed', clean, recognized);
  }
  // save_form_draft writes into the member's newest open form of the
  // template, and makes a new draft when there is none. An editor bound to a
  // form names it, and the server checks under its lock that the form is
  // still the member's and editable, writing nothing otherwise: a submitted
  // or replaced form is never followed into another draft (gate stage 139 on
  //, r5s1;).
  // It also names the answers it was based on, the ones last known to be
  // stored: a draft another session saved since refuses (PT409
  // form_saved_elsewhere), writing nothing, as on the website .
  const draft = {
    p_template_key: template.key,
    p_answers: clean,
    p_step: safeStep,
    ...(lane.formID ? { p_expected_form_id: lane.formID } : {}),
  };
  const unit = lane.unit;
  const send = async (base: StoredAnswers | undefined): Promise<{ data: unknown; error: unknown }> => {
    const args = base ? { ...draft, p_base_answers: base } : draft;
    const sent: { data: unknown; error: unknown } = unit
      ? await createCapturedSessionRpcClient(pinned.session).rpc('save_unit_form_draft', {
        ...args, p_unit: unit.unitId, p_actor: unit.actorId, p_chapter: unit.chapterId, p_organization: unit.organizationId,
      })
      : await createCapturedSessionRpcClient(pinned.session).rpc('save_form_draft', args);
    await fence();
    return sent;
  };
  let result = await send(lane.baseAnswers);
  // A save is never resent with fewer arguments: one without its base is the
  // overwrite the base exists to refuse (as  rules for the website). A
  // server before 20261113134400 refuses it, and the save fails as unsaved.
  if (refusedAs(result.error, 'form_saved_elsewhere')) {
    // An earlier save of this editor whose reply never came may be what is
    // stored now: those answers are its own, so it saves again on them once.
    // Anything else was saved by another session (gate stage 138 on,
    // r3s3, as the sealed path does).
    const stored = (lane.unconfirmed ?? []).length ? await storedOrdinaryAnswers(pinned, template.key, lane.formID).catch(() => null) : null; // swallow-ok: unread, the refusal stands as form-changed below
    await fence();
    if (stored && (lane.unconfirmed ?? []).some((sent) => sameAnswers(answersFrom(stored), sent))) result = await send(stored);
    if (refusedAs(result.error, 'form_saved_elsewhere')) throw new FormActionError('form-changed');
  }
  if (refusedAs(result.error, 'form_not_editable')) throw new FormActionError('closed');
  // A failure may hide a save that committed: its answers ride along, so the
  // next save recognises them (above) instead of refusing its own .
  if (result.error || typeof result.data !== 'string') throw new FormActionError('failed', refusalCode(result.error) ? null : clean);
  if (lane.formID && result.data !== lane.formID) throw new FormActionError('closed');
  return { formID: result.data, dataVersion: null, answers: clean };
}

// A refusal the database answered (a SQLSTATE of its own), as opposed to a
// request whose outcome is unknown.
function refusalCode(error: unknown): boolean {
  const code = record(error)?.code;
  return typeof code === 'string' && code !== '' && !code.startsWith('PGRST');
}

// The answers stored on the member's ordinary form now, as the row holds them:
// the named form, or their newest open form of the template.
async function storedOrdinaryAnswers(pinned: MemberSession, templateKey: string, formID: string | null): Promise<StoredAnswers | null> {
  let query = createCapturedSessionRpcClient(pinned.session).from('member_forms').select('answers')
    .eq('user_id', pinned.userID).eq('template_key', templateKey);
  query = formID ? query.eq('id', formID) : query.in('status', ['draft', 'returned']).order('updated_at', { ascending: false });
  const result: { data: unknown; error: unknown } = await query.limit(1);
  const [row] = !result.error && Array.isArray(result.data) ? result.data as Row[] : [];
  return row ? record(row.answers) ?? {} : null;
}

// A server refusal the phone acts on: PostgREST's 409 (SQLSTATE PT409) with
// the reason the database names in its details .
function refusedAs(error: unknown, reason: string): boolean {
  const refusal = record(error);
  return refusal?.code === 'PT409' && refusal.details === reason;
}

// The answers stored on a form now, read on the member's pinned session: a
// sealed form through get_sealed_forms, an ordinary one from its row. A
// signature is read back against them, because sign_member_form signs
// whatever the row holds when it runs, and a save from another device between
// the review and the signature would be signed unseen (gate stage 138 on
//, r3s2; the server fix is).
export async function readStoredFormAnswers(templateKey: string, formID: string, ownerID: string): Promise<OpenedForm> {
  const supabase = client();
  const { pinned, fence } = await memberSession(supabase, ownerID);
  if (SEALED_FORM_TEMPLATE_KEYS.has(templateKey)) {
    const origin = await sealedOrigin('unavailable');
    await fence();
    const result: { data: unknown; error: unknown } = await sensitiveContentRpc(supabase, 'get_sealed_forms', { formIds: [formID] }, origin, pinned.token);
    await fence();
    const opened = (Array.isArray(result.data) ? result.data as unknown[] : []).map(record).find((item) => item?.id === formID);
    if (result.error || !opened || opened.contentError) throw new FormActionError('unavailable');
    return { answers: answersFrom(opened.answers), dataVersion: typeof opened.dataVersion === 'string' ? opened.dataVersion : null };
  }
  const result: { data: unknown; error: unknown } = await createCapturedSessionRpcClient(pinned.session).from('member_forms')
    .select('answers').eq('id', formID).eq('user_id', pinned.userID).limit(1);
  await fence();
  const [row] = !result.error && Array.isArray(result.data) ? result.data as Row[] : [];
  if (!row) throw new FormActionError('unavailable');
  return { answers: answersFrom(row.answers), dataVersion: null, stored: record(row.answers) ?? {} };
}

// One confirmed form attachment as a signature covers it (the signature
// digest's shape); services/formFiles.ts reads and changes them.
export type FormAttachment = { id: string; filename: string; mimeType: string; sizeBytes: number; confirmed: boolean };

// Whether two sets of answers are the same once both are cleaned the way the
// save stores them, whatever their key order.
export function sameStoredAnswers(template: FormTemplate, left: FormAnswers, right: FormAnswers): boolean {
  return sameAnswers(cleanFormAnswers(template, left), cleanFormAnswers(template, right));
}

// What the member reviewed before signing: the save that stored it and the
// confirmed attachments shown (none, until the phone shows attachments).
export type SignatureReview = { saved: FormSaved; attachmentIDs: readonly string[] };

// The p_expected object sign_member_form and submit_form both take (,
//): the attachment ids shown, and a sealed form's data version or an
// ordinary form's exact saved answers.
function reviewedContent(templateKey: string, review: SignatureReview) {
  const attachmentIds = [...review.attachmentIDs];
  return SEALED_FORM_TEMPLATE_KEYS.has(templateKey)
    ? { attachmentIds, dataVersion: review.saved.dataVersion }
    : { attachmentIds, answers: review.saved.answers };
}

// sign_member_form records the filer's drawn signature for the form's current
// content. The server needs consent and checks the strokes again; a later
// change to the answers clears it. The signature names what the member
// reviewed: a sealed form's data version, or an ordinary form's exact saved
// answers, and the attachment ids. Under the form lock the server refuses it,
// signing nothing, when the form holds anything else (gate stages 138 and 139
// on, r3s2 and r5s2;).
export async function signMyForm(templateKey: string, strokes: SignatureStrokes, consent: boolean, ownerID: string, review: SignatureReview): Promise<void> {
  if (!consent || !signatureIsSendable(strokes)) throw new FormActionError('signature-required');
  const { pinned, fence } = await memberSession(client(), ownerID);
  const result: { error: unknown } = await createCapturedSessionRpcClient(pinned.session).rpc('sign_member_form', {
    p_form_id: review.saved.formID, p_strokes: strokes, p_consent: true, p_expected: reviewedContent(templateKey, review),
  });
  await fence();
  if (refusedAs(result.error, 'form_changed_since_review')) throw new FormActionError('form-changed');
  if (result.error) throw new FormActionError('failed');
}

function serverMessage(error: unknown): string {
  const message = record(error)?.message;
  return typeof message === 'string' ? message : '';
}

// submit_form sends the member's draft or returned form to the stewards. It
// refuses a form without a current signature, or with an attachment still
// uploading, being removed or being checked. The submission names what the
// member reviewed, as the signature does; under the form lock the server
// refuses, filing nothing, when the form holds anything else by now, even a
// version signed again elsewhere (gate stage 146 on, r8s1;).
export async function submitMyForm(templateKey: string, ownerID: string, review: SignatureReview): Promise<void> {
  const { pinned, fence } = await memberSession(client(), ownerID);
  const result: { error: unknown } = await createCapturedSessionRpcClient(pinned.session).rpc('submit_form', {
    p_form_id: review.saved.formID, p_expected: reviewedContent(templateKey, review),
  });
  await fence();
  if (!result.error) return;
  if (refusedAs(result.error, 'form_changed_since_review')) throw new FormActionError('form-changed');
  const message = serverMessage(result.error);
  if (/current signature/.test(message)) throw new FormActionError('signature-required');
  if (/attachment/.test(message)) throw new FormActionError('attachments-pending');
  throw new FormActionError('failed');
}
