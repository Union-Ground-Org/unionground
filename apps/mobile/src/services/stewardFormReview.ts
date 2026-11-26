import type { StewardFormReviewRow } from './stewardDeskSections';
import { nativeUiText, readableRecordKey, type NativeLanguage } from '../lib/nativeUiCopy';

export type { StewardFormReviewRow } from './stewardDeskSections';

// The same two templates src/lib/memberApi.js seals. A copy here keeps this
// read off the web member API module. Plaintext on either one stays hidden.
// The web template and protected-answer modules load only when a review opens,
// so the desk list tests do not pull the native runtime.
const SEALED_FORM_TEMPLATE_KEYS = new Set(['fmla_self', 'fmla_family']);

export type StewardFormAnswerLine = { label: string; value: string };
export type StewardFormAttachment = { id: string; filename: string; scanCurrent: boolean; confirmed: boolean };
export type StewardFormCosigner = { id: string; name: string };

// What the steward was shown, as approve_form compares it under the form lock
// (#8728, the website's #8707 contract): a sealed form by the stored version
// its opened answers came from, an ordinary one by its answers, plus the
// confirmed attachments and the accepted co-signers shown ([] when none).
export type StewardFormApprovalExpectation =
  | { dataVersion: string | null; attachmentIds: string[]; cosignerIds: string[] }
  | { answers: Record<string, unknown>; attachmentIds: string[]; cosignerIds: string[] };

export type StewardFormReviewDetail = {
  templateLabel: string;
  templateVersion: number | null;
  submittedAt: string | null;
  lines: StewardFormAnswerLine[];
  answersUnavailable: boolean;
  filingUnavailable: boolean;
  filerSigned: boolean;
  /** False only for a template that is not a signed statement; an older server reads as required. */
  signatureRequired: boolean;
  attachments: StewardFormAttachment[];
  cosigners: StewardFormCosigner[];
  cosignersUnavailable: boolean;
  // Null when part of the review could not be read; approval then stays off.
  expectation: StewardFormApprovalExpectation | null;
};

type TemplateField = {
  key?: string;
  labelKey?: string;
  options?: { value?: string; labelKey?: string }[];
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

type TemplateReader = {
  byKey: (key: string) => { steps?: { fields?: TemplateField[] }[] } | undefined;
  fromRow: (row: unknown) => { titleKey?: string; steps?: { fields?: TemplateField[] }[] };
  openSealed: (client: unknown, operation: string, args: { formIds: string[] }, origin: string) => Promise<{ data: unknown; error: unknown }>;
  portal: string;
};
let readers: TemplateReader | null = null;

// English labels for the static template fallback. The registry row already
// carries resolved English, and the web catalogue cannot be bundled here.
const FORM_ENGLISH: Record<string, string> = {
  'forms.f.summary': 'Issue summary',
  'forms.f.articles': 'Article(s) cited',
  'forms.f.incidentDate': 'Date of incident',
  'forms.f.narrative': 'What happened',
  'forms.f.remedy': 'Desired remedy',
  'forms.f.witnesses': 'Witnesses',
  'forms.f.conditionType': 'Leave pattern',
  'forms.f.startDate': 'Start date',
  'forms.f.endDate': 'Expected end date',
  'forms.f.provider': 'Health-care provider',
  'forms.f.notes': 'Notes',
  'forms.f.relationship': 'Relationship',
  'forms.f.leaveNeed': 'Leave you need: for your own serious health condition or to care for a family member, continuous or intermittent (not the condition itself)',
  'forms.f.familyMemberInitials': 'Family member: initials or relationship only',
  'forms.f.sharedIssue': 'Shared issue',
  'forms.f.affected': 'Affected workers',
  'forms.f.posting': 'Position / posting',
  'forms.f.appliedDate': 'Date applied',
  'forms.f.notifiedDate': 'Date notified',
  'forms.f.grounds': 'Grounds for appeal',
  'forms.f.currentSchedule': 'Current schedule',
  'forms.f.requested': 'Requested arrangement',
  'forms.f.teleworkDays': 'Preferred telework days',
  'forms.f.reason': 'Reason',
  'forms.f.duration': 'Duration',
  'forms.f.category': 'Category',
  'forms.f.description': 'Description',
  'forms.opt.continuous': 'Continuous',
  'forms.opt.intermittent': 'Intermittent',
  'forms.opt.rel_spouse': 'Spouse',
  'forms.opt.rel_child': 'Child',
  'forms.opt.rel_parent': 'Parent',
  'forms.opt.rel_other': 'Other family',
  'forms.opt.mon': 'Mon',
  'forms.opt.tue': 'Tue',
  'forms.opt.wed': 'Wed',
  'forms.opt.thu': 'Thu',
  'forms.opt.fri': 'Fri',
  'forms.opt.cat_dues': 'Membership',
  'forms.opt.cat_benefits': 'Benefits',
  'forms.opt.cat_training': 'Training',
  'forms.opt.cat_other': 'Other',
};

function english(key: string | undefined, fallback: string): string {
  if (!key) return fallback;
  if (FORM_ENGLISH[key]) return FORM_ENGLISH[key];
  if (key.startsWith('forms.')) return fallback;
  return key;
}

// Titles match apps/mobile/src/lib/featureCatalog.ts FORM_TEMPLATES. This map
// stays local so the desk service tests do not load the native catalog.
const TEMPLATE_TITLES: Record<string, string> = {
  grievance: 'Workplace issue report',
  fmla_self: 'FMLA · my own health',
  fmla_family: 'FMLA · family care',
  alliance_grievance: 'Group workplace issue',
  non_selection: 'Non-selection appeal',
  alt_work: 'Alternative work arrangement',
  service_request: 'Worker service request',
};

export function formTemplateLabel(templateKey: string): string {
  return Object.hasOwn(TEMPLATE_TITLES, templateKey) ? TEMPLATE_TITLES[templateKey]! : readableRecordKey(templateKey) || 'Form';
}

function versionOf(value: unknown): number | null {
  const version = typeof value === 'number' ? value : typeof value === 'string' && value.trim() !== '' ? Number(value) : NaN;
  return Number.isInteger(version) ? version : null;
}

// Drafts never enter the review list. A protected template keeps no answer
// text in the row the list renders; the review read opens it, or refuses it.
export function projectStewardFormRow(row: Record<string, unknown>): StewardFormReviewRow | null {
  const status = String(row.status ?? '');
  if (status !== 'submitted' && status !== 'in_review') return null;
  const id = String(row.id ?? '');
  if (!id) return null;
  const templateKey = String(row.template_key ?? '');
  const answers = isRecord(row.answers) ? row.answers : {};
  const protectedAnswers = SEALED_FORM_TEMPLATE_KEYS.has(templateKey);
  const held = protectedAnswers && answers.sealed === true;
  const answersHidden = protectedAnswers && !held && Object.keys(answers).some((key) => key !== 'seedSequence');
  return {
    id,
    memberName: String(row.member_name || 'Worker'),
    userID: String(row.user_id ?? ''),
    templateKey,
    templateLabel: formTemplateLabel(templateKey),
    templateVersion: versionOf(row.template_version),
    submittedAt: typeof row.submitted_at === 'string' && row.submitted_at ? row.submitted_at : null,
    status,
    answers: answersHidden ? {} : held ? { sealed: true } : answers,
    protectedAnswers,
    answersHidden,
  };
}

export function formatFormSubmittedAt(value: string | null, language: NativeLanguage = 'en'): string {
  const t = nativeUiText(language);
  if (!value) return t('Submission time is not recorded.');
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return t('Submission time is not recorded.');
  const formatted = new Intl.DateTimeFormat(language === 'es' ? 'es-US' : 'en-US', {
    timeZone: 'America/New_York',
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(date);
  return t('Submitted {when}', { when: `${formatted} ET` });
}

function answerText(value: unknown, field: TemplateField | undefined): string {
  const option = (item: unknown) => field?.options?.find((entry) => entry.value === item)?.labelKey;
  if (Array.isArray(value)) {
    const labels = value.map((item) => english(option(item), String(item)));
    return labels.length ? labels.join(', ') : '—';
  }
  if (value === true) return 'Yes';
  if (value === false) return 'No';
  if (isRecord(value) || value == null || String(value).trim() === '') return '—';
  return english(option(value), String(value));
}

function linesFor(answers: Record<string, unknown>, steps: { fields?: TemplateField[] }[]): StewardFormAnswerLine[] {
  const fields = steps.flatMap((step) => step.fields ?? []);
  const known = new Set(fields.map((field) => field.key).filter((key): key is string => Boolean(key)));
  const listed = fields.filter((field) => field.key).map((field) => ({
    label: english(field.labelKey, String(field.key).replaceAll('_', ' ')),
    value: answerText(answers[field.key as string], field),
  }));
  for (const [key, value] of Object.entries(answers)) {
    if (known.has(key) || key === 'sealed' || key === 'seedSequence') continue;
    listed.push({ label: key.replaceAll('_', ' '), value: answerText(value, undefined) });
  }
  return listed;
}

function templateFromRegistry(
  templateKey: string,
  templateVersion: number | null,
  registry: { data: unknown; error: { message?: string } | null } | null,
): { label: string; steps: { fields?: TemplateField[] }[] } {
  const reader = readers;
  const fallback = reader?.byKey(templateKey);
  const fallbackSteps = fallback?.steps ?? [];
  const fallbackLabel = formTemplateLabel(templateKey);
  const row = registry && Array.isArray(registry.data) ? registry.data[0] : null;
  if (!reader || templateVersion === null || !registry || registry.error || !isRecord(row)) {
    return { label: fallbackLabel, steps: fallbackSteps };
  }
  const template = reader.fromRow(row);
  return {
    label: english(template.titleKey, fallbackLabel),
    steps: template.steps ?? fallbackSteps,
  };
}

type OpenedAnswers = { answers: Record<string, unknown>; dataVersion: string | null; unavailable: boolean };

async function openedAnswers(row: StewardFormReviewRow, client: unknown): Promise<OpenedAnswers> {
  if (!row.protectedAnswers) return { answers: row.answers, dataVersion: null, unavailable: false };
  // Plaintext left on a sealed template is never shown (#5827).
  if (row.answersHidden || row.answers.sealed !== true) return { answers: {}, dataVersion: null, unavailable: row.answersHidden || row.answers.sealed === true };
  const reader = readers;
  if (!reader) return { answers: {}, dataVersion: null, unavailable: true };
  const result = await reader.openSealed(client, 'get_sealed_forms', { formIds: [row.id] }, reader.portal);
  const opened = Array.isArray(result.data) ? result.data.find((item) => isRecord(item) && item.id === row.id) : null;
  if (result.error || !isRecord(opened) || opened.contentError || !isRecord(opened.answers)) {
    return { answers: {}, dataVersion: null, unavailable: true };
  }
  // The stored version comes from the same read as the answers shown.
  return { answers: opened.answers, dataVersion: typeof opened.dataVersion === 'string' ? opened.dataVersion : null, unavailable: false };
}

function filingFrom(data: unknown): Pick<StewardFormReviewDetail, 'filingUnavailable' | 'filerSigned' | 'signatureRequired' | 'attachments'> {
  if (!isRecord(data)) return { filingUnavailable: true, filerSigned: false, signatureRequired: true, attachments: [] };
  const attachments = Array.isArray(data.attachments) ? data.attachments.filter(isRecord).map((item) => ({
    id: String(item.id ?? ''),
    filename: String(item.filename || 'Attachment'),
    scanCurrent: item.scanCurrent !== false,
    confirmed: typeof item.confirmedAt === 'string' && item.confirmedAt !== '',
  })) : [];
  return { filingUnavailable: false, filerSigned: data.filerSigned === true, signatureRequired: data.signatureRequired !== false, attachments };
}

type BackendClient = NonNullable<ReturnType<typeof import('./supabase').getSupabaseClient>>;

// The accepted co-signers the review shows, as the website desk reads them.
// A failed read is unavailable, never an empty list that would hide one.
async function acceptedCosigners(client: BackendClient, formID: string): Promise<{ cosigners: StewardFormCosigner[]; unavailable: boolean }> {
  const accepted: { data: unknown; error: unknown } = await client.from('member_form_cosigners')
    .select('id,cosigner_user_id').eq('form_id', formID).eq('status', 'accepted');
  if (accepted.error || !Array.isArray(accepted.data)) return { cosigners: [], unavailable: true };
  const rows = accepted.data.filter(isRecord).map((item) => ({ id: String(item.id ?? ''), userID: String(item.cosigner_user_id ?? '') }));
  if (rows.some((item) => !item.id)) return { cosigners: [], unavailable: true };
  const userIDs = [...new Set(rows.map((item) => item.userID).filter(Boolean))];
  const profiles: { data: unknown; error: unknown } = userIDs.length
    ? await client.from('member_profiles').select('id,full_name').in('id', userIDs)
    : { data: [], error: null };
  const names = new Map((Array.isArray(profiles.data) ? profiles.data : []).filter(isRecord)
    .map((item) => [String(item.id ?? ''), typeof item.full_name === 'string' && item.full_name ? item.full_name : 'A worker']));
  return { cosigners: rows.map((item) => ({ id: item.id, name: names.get(item.userID) ?? 'A worker' })), unavailable: false };
}

export async function loadStewardFormReviewDetail(row: StewardFormReviewRow): Promise<StewardFormReviewDetail> {
  const [{ templateByKey, templateFromDbRow }, { sensitiveContentRpc }, { mobileConfig }, { getSupabaseClient }] = await Promise.all([
    import('../../../../src/lib/formTemplates.js'),
    import('../../../../src/lib/sensitiveContentApi.js'),
    import('../lib/config'),
    import('./supabase'),
  ]);
  const supabase = getSupabaseClient();
  if (!supabase) throw new Error('The secure mobile backend is not configured.');
  readers = {
    byKey: (key) => templateByKey(key) as { steps?: { fields?: TemplateField[] }[] } | undefined,
    fromRow: (value) => templateFromDbRow(value, 'en') as { titleKey?: string; steps?: { fields?: TemplateField[] }[] },
    openSealed: sensitiveContentRpc,
    portal: mobileConfig.portalBaseUrl,
  };
  const registry = row.templateVersion === null ? null : supabase
    .from('form_template_registry')
    .select('key,version,label_en,field_schema')
    .eq('key', row.templateKey)
    .eq('version', row.templateVersion)
    .limit(1);
  const [registered, answers, filing, cosigned] = await Promise.all([
    registry,
    openedAnswers(row, supabase),
    supabase.rpc('get_form_filing_status', { p_form_id: row.id }),
    acceptedCosigners(supabase, row.id),
  ]);
  const template = templateFromRegistry(row.templateKey, row.templateVersion, registered);
  const filingState = filing.error ? { filingUnavailable: true, filerSigned: false, signatureRequired: true, attachments: [] } : filingFrom(filing.data);
  const attachmentIds = filingState.attachments.filter((item) => item.confirmed).map((item) => item.id);
  const cosignerIds = cosigned.cosigners.map((item) => item.id);
  const shown = !answers.unavailable && !filingState.filingUnavailable && !cosigned.unavailable;
  return {
    templateLabel: template.label,
    templateVersion: row.templateVersion,
    submittedAt: row.submittedAt,
    lines: answers.unavailable ? [] : linesFor(answers.answers, template.steps),
    answersUnavailable: answers.unavailable,
    ...filingState,
    cosigners: cosigned.cosigners,
    cosignersUnavailable: cosigned.unavailable,
    expectation: !shown ? null : row.protectedAnswers
      ? { dataVersion: answers.dataVersion, attachmentIds, cosignerIds }
      : { answers: row.answers, attachmentIds, cosignerIds },
  };
}

// Approval stays unavailable until the answers and the filing check can both
// be read. The server still refuses the decision; this is the explanation.
export function stewardFormApprovalBlock(detail: StewardFormReviewDetail): string | null {
  if (detail.answersUnavailable) return 'This form\'s answers cannot be opened right now, so it cannot be approved.';
  if (detail.filingUnavailable) return 'Filing attachments are unavailable right now, so this form cannot be approved.';
  if (detail.cosignersUnavailable) return 'The co-signers could not be read right now, so this form cannot be approved.';
  if (detail.signatureRequired && !detail.filerSigned) return 'The worker signature is missing, so this form cannot be approved.';
  const stale = detail.attachments.filter((item) => item.scanCurrent === false);
  if (stale.length > 0) {
    return `These attachments need a current check before approval: ${stale.map((item) => item.filename).join(', ')}.`;
  }
  return null;
}
