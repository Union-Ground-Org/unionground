import type { MobileSessionWriter } from './supabase';
import { readEventSchema, LEGACY_EVENT_COLUMNS } from '../../../../src/lib/eventSchemaCompatibility.js';
import { compareEventSchedule } from '../lib/eventModelShared';
import { recognitionRung, type RecognitionRule, type RecognitionRung } from '../lib/featureCatalog';
import type { SupabaseClient } from '@supabase/supabase-js';

import type { CompassMessage, CompassSource } from '../models/member';
import { compassSourcesWithDestinations } from '../lib/compassSourceNavigation';
import { normalizeReferralSummary, type MemberReferralSummary, type ReferralRule } from '../lib/memberReferral';
import { collectPages } from './pagination';
import {
  TASK_DISCUSSION_MESSAGE_LIMIT,
  nativeTaskReference,
  taskDiscussionRowList,
  taskDiscussionsFromRows,
  type TaskDiscussion,
} from '../lib/taskDiscussions';
import type { CalendarExportPayload } from './nativeCalendarExport';
import { calendarRecordGone } from '../lib/calendarExportFailure';
import { assertFreshMobileCalendarSession, getSupabaseClient } from './supabase';

type Row = Record<string, unknown>;


export type LivedInEvent = {
  id: string;
  chapterID: string | null;
  title: string;
  summary: string;
  startsAt: string;
  endsAt?: string | null;
  eventKind?: 'meeting' | 'deadline' | 'date_only';
  eventDate?: string | null;
  seriesId?: string | null;
  location: string;
  cancelled: boolean;
  cancellationReason: string | null;
  rsvp: 'going' | 'not_going' | null;
  checkedInAt: string | null;
  checkInOffered: boolean;
  // Staff can switch RSVP collection off per event (member_events.rsvp_open);
  // absent means open, as every event was before the switch existed.
  rsvpOpen?: boolean;
};

// Union Ground acknowledges contributions without points. The safe
// recognition migration revoked client reads of member_point_events and
// retired the points summary, so the native history reads the same
// recognition summary, rules and events the web's Contributions view does.
export type LivedInContributions = {
  totalVerified: number;
  recentVerified: number;
  currentRung: RecognitionRung;
  rules: RecognitionRule[];
  events: { id: string; recognitionKind: string; sourceLabel: string; occurredAt: string }[];
  // #8175: the member's own referral code and recruited count, null when the
  // server gave neither or the read failed; the rule is null when referral
  // points are off and undefined when it could not be read.
  referral: MemberReferralSummary | null;
  referralRule: ReferralRule | null | undefined;
};

export type LivedInWorkload = {
  stats: Record<string, unknown>;
  logs: {
    id: string;
    unitName?: string | null;
    loggedOn: string;
    priority: number;
    pending: number;
    todos: number;
    referrals: number;
    assistanceRequests: number;
    note: string | null;
  }[];
};

export type LivedInRights = {
  lessons: {
    id: string;
    label: string;
    title: string;
    description: string;
    steps: string[];
    script: string;
    completedSteps: number[];
    requestStatus: string | null;
  }[];
  articles: { id: string; slug: string; ref: string; title: string; body: string; updatedAt: string }[];
};

export type LivedInChapter = {
  documents: { id: string; kind: string; title: string; summary: string; version: number; updatedAt: string }[];
  records: { id: string; kind: string; title: string; body: string; occurredAt: string }[];
  broadcasts: { id: string; sender: string; title: string; body: string; publishedAt: string; readAt: string | null }[];
};

export type LivedInChapterDocument = LivedInChapter['documents'][number] & { body: string };

export type LivedInTask = {
  id: string;
  identifier: string;
  title: string;
  description: string;
  status: string;
  priority: string;
  workstream: string;
  assignee: string;
  startDate: string | null;
  dueDate: string | null;
  progress: number;
  blocked: boolean;
  milestone: boolean;
  unitName?: string | null;
};

export type LivedInCompassHistory = {
  threadID: string | null;
  title: string | null;
  messages: CompassMessage[];
  threads: { id: string; title: string; messages: CompassMessage[] }[];
};

export type LivedInStewardAppointment = {
  id: string;
  memberName: string;
  type: string;
  durationMinutes: number;
  startsAt: string;
  endsAt: string | null;
  place: string;
  status: string;
  reasonCategory: string | null;
  routedVia: string | null;
};

export type LivedInStewardAppointmentsDesk = {
  upcoming: LivedInStewardAppointment[];
  recent: LivedInStewardAppointment[];
  outcomes: { completed30d: number | null; noShows30d: number | null };
  availability: {
    timezone: string | null;
    accepting: boolean | null;
    minNoticeMinutes: number | null;
    windows: { id: string; weekday: number; startMinute: number; endMinute: number }[];
    blackouts: { id: string; startDate: string; endDate: string }[];
  };
  connections: { id: string; provider: string; status: string; accountLabel: string | null }[];
};

function requireClient(): SupabaseClient {
  const client = getSupabaseClient();
  if (!client) throw new Error('The secure mobile backend is not configured.');
  return client;
}

type MemberEventsReadError = {
  code?: string;
  message?: string;
  details?: string;
  hint?: string;
};

type MemberEventsReadResult = {
  data: unknown;
  error: MemberEventsReadError | null;
};

// Retain the same RLS-scoped read while hosted schema catches up with code.
// Keep unvalidated response data unknown until the caller narrows its fields.
// A database without check_in_offered predates rsvp_open too, so that retry
// drops both; one with check_in_offered but no rsvp_open drops only the switch
// (the web loader in src/lib/memberApi.js does the same).
async function readMemberEvents(
  columns: string,
  query: (selectedColumns: string) => PromiseLike<MemberEventsReadResult>,
): Promise<MemberEventsReadResult> {
  const result = await query(columns);
  const error = result.error;
  const missing = ['42703', 'PGRST204'].includes(error?.code ?? '') ? [error?.message, error?.details, error?.hint].join(' ') : '';
  if (/\bcheck_in_offered\b/.test(missing)) {
    return query(columns.split(',').filter((column) => column !== 'check_in_offered' && column !== 'rsvp_open').join(','));
  }
  if (/\brsvp_open\b/.test(missing)) {
    return query(columns.split(',').filter((column) => column !== 'rsvp_open').join(','));
  }
  return result;
}

async function rows(
  table: string,
  columns: string,
  orderColumn: string,
  ascending = false,
  tieColumn = 'id',
  whereNull?: string,
  legacyEventColumns?: string,
): Promise<Row[]> {
  const client = requireClient();
  return collectPages(async (from, to) => {
    const queryPage = async (legacy: boolean, selectedColumns = columns) => {
      let query = client.from(table).select((legacy && legacyEventColumns) || selectedColumns);
      if (!legacy && whereNull) query = query.is(whereNull, null);
      return query
        .order(legacy ? 'starts_at' : orderColumn, { ascending })
        .order(tieColumn, { ascending: true })
        .range(from, to);
    };
    const readCurrent = () => table === 'member_events'
      ? readMemberEvents(columns, (selectedColumns) => queryPage(false, selectedColumns))
      : queryPage(false);
    const result = legacyEventColumns
      ? await readEventSchema((legacy) => legacy ? queryPage(true) : readCurrent())
      : await readCurrent();
    if (result.error) {
      const status: unknown = Reflect.get(result, 'status');
      if (typeof status === 'number') Object.assign(result.error, { status });
      throw result.error;
    }
    return (result.data ?? []) as unknown as Row[];
  });
}

async function softRead(read: PromiseLike<{ data: unknown; error: unknown }>): Promise<{ data: unknown; error: unknown }> {
  try { return await read; } catch (error) { return { data: null, error }; }
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

export async function loadMobileEventsHistory(): Promise<LivedInEvent[]> {
  const [events, rsvps, checkins] = await Promise.all([
    rows('member_events', 'id,chapter_id,title,summary,starts_at,ends_at,event_kind,event_date,series_id,check_in_offered,rsvp_open,sort_at,location,order_index,cancelled_at,cancelled_reason', 'sort_at', true, 'id', undefined, LEGACY_EVENT_COLUMNS),
    rows('member_event_rsvps', 'event_id,status,updated_at', 'updated_at', false, 'event_id'),
    rows('member_event_checkins', 'event_id,checked_in_at', 'checked_in_at', false, 'event_id'),
  ]);
  return events.map((event) => ({
    id: String(event.id), chapterID: typeof event.chapter_id === 'string' ? event.chapter_id : null,
    title: String(event.title), summary: String(event.summary ?? ''),
    startsAt: event.starts_at == null ? '' : String(event.starts_at),
    endsAt: event.ends_at == null ? null : String(event.ends_at),
    eventKind: event.event_kind as LivedInEvent['eventKind'],
    eventDate: event.event_date == null ? null : String(event.event_date),
    seriesId: event.series_id == null ? null : String(event.series_id),
    location: String(event.location ?? ''), cancelled: event.cancelled_at != null,
    cancellationReason: event.cancelled_reason == null ? null : String(event.cancelled_reason),
    checkInOffered: event.check_in_offered === true,
    rsvpOpen: event.rsvp_open !== false,
    rsvp: (rsvps.find((item) => item.event_id === event.id)?.status as LivedInEvent['rsvp']) ?? null,
    checkedInAt: (checkins.find((item) => item.event_id === event.id)?.checked_in_at as string | undefined) ?? null,
  })).sort(compareEventSchedule);
}

export async function prepareAuthorizedEventCalendarExport(
  eventID: string,
  nowMs: number,
): Promise<CalendarExportPayload> {
  const authorizedUserID = await assertFreshMobileCalendarSession();
  const client = requireClient();
  const currentColumns = 'id,title,starts_at,ends_at,event_kind,event_date,location,cancelled_at,check_in_offered';
  const read = (columns: string) => client.from('member_events').select(columns).eq('id', eventID).maybeSingle();
  const { data, error } = await readEventSchema((legacy) => legacy
    ? read(LEGACY_EVENT_COLUMNS)
    : readMemberEvents(currentColumns, read));
  if (await assertFreshMobileCalendarSession() !== authorizedUserID) {
    throw new Error('Calendar export authorization changed.');
  }
  // The untyped row is narrowed field by field so the export payload is built
  // from checked strings, never from the client's `any`.
  const event = data ? record(data) : null;
  const title = event?.title;
  const startsAt = event?.starts_at;
  const cancelledAt = event?.cancelled_at;
  const location = event?.location;
  // #9462 (M2-11): only a read that answered with no row means the event is
  // gone for this account; a failed read is not told as "gone".
  if (!error && !event) throw calendarRecordGone('Meeting export is no longer authorized.');
  // A row this read did return, but no longer a meeting (staff made it a
  // deadline or a date-only event, with no start time), cannot go into a
  // calendar: it is told as gone, before the meeting-only start-time check.
  if (!error && event?.id === eventID && typeof event.event_kind === 'string' && event.event_kind !== 'meeting') {
    throw calendarRecordGone('Meeting export is no longer authorized.');
  }
  if (
    error
    || !event
    || event.id !== eventID
    || typeof title !== 'string'
    || typeof startsAt !== 'string'
    || !Object.prototype.hasOwnProperty.call(event, 'cancelled_at')
    || (cancelledAt !== null && typeof cancelledAt !== 'string')
    || (location != null && typeof location !== 'string')
  ) throw new Error('Meeting export is no longer authorized.');
  const freshEvent: LivedInEvent = {
    id: eventID,
    chapterID: null,
    title,
    summary: '',
    startsAt,
    endsAt: typeof event?.ends_at === 'string' ? event.ends_at : null,
    eventKind: event?.event_kind as LivedInEvent['eventKind'],
    eventDate: typeof event?.event_date === 'string' ? event.event_date : null,
    location: location ?? '',
    cancelled: cancelledAt != null,
    cancellationReason: null,
    checkInOffered: event.check_in_offered === true,
    rsvp: null,
    checkedInAt: null,
  };
  const { calendarExportPayloadForEvent } = await import('./nativeCalendarExport');
  const payload = calendarExportPayloadForEvent(freshEvent, nowMs);
  if (!payload) throw calendarRecordGone('Meeting export is no longer authorized.');
  return payload;
}

export type LivedInEventAction = 'rsvp' | 'check-in';

// rsvp_to_event and check_in_to_event refuse with distinct SQLSTATEs: 42501
// when the session has not satisfied its assurance level (an enrolled member
// still at aal1 has to step up), and 22023 for a cancelled event, an event
// outside the member's scope, a closed check-in window, a wrong code, or (for
// an RSVP) an event that has already started or that staff closed to RSVPs. One shared sentence sent every one of those to the code field, so a member who
// only had to finish two-step verification retyped a code that was never the
// problem. Keep the previous sentences as the unmatched fallback.
export function describeEventActionRefusal(error: unknown, action: LivedInEventAction): string {
  const refusal = (typeof error === 'object' && error !== null ? error : {}) as { code?: unknown; message?: unknown; details?: unknown };
  const sqlstate = typeof refusal.code === 'string' ? refusal.code : '';
  const text = `${String(refusal.message ?? '')} ${String(refusal.details ?? '')}`.toLocaleLowerCase();
  if (sqlstate === '42501' || /\bmfa\b|assurance|authentication required/.test(text)) {
    return action === 'rsvp'
      ? 'That RSVP needs two-step verification. Confirm it for this session, then try again.'
      : 'Check-in needs two-step verification. Confirm it for this session, then check in again.';
  }
  if (/event_cancelled|was cancelled/.test(text)) {
    return action === 'rsvp'
      ? 'This meeting was cancelled, so RSVPs are closed.'
      : 'This meeting was cancelled, so check-in is closed.';
  }
  if (/event not found/.test(text)) return 'That meeting is no longer available to your account.';
  if (action === 'rsvp' && /rsvp_closed|not collecting rsvps/.test(text)) return 'This meeting is not collecting RSVPs.';
  if (action === 'rsvp' && /event_past|is in the past/.test(text)) return 'This meeting has already started, so RSVPs are closed.';
  if (action === 'rsvp') return 'That RSVP was not confirmed.';
  if (/checkin_not_offered/.test(text)) return 'This meeting has no check-in.';
  if (/check-in is only open/.test(text)) return 'Check-in opens two hours before the meeting and closes four hours after it starts.';
  if (/invalid check-in code/.test(text)) return 'That check-in code did not match. Confirm it with the meeting organizer.';
  return 'Check-in was not confirmed. Check the meeting time and code.';
}

export async function setMobileEventRsvp(writer: MobileSessionWriter, eventID: string, status: 'going' | 'not_going'): Promise<void> {
  const { error } = await (await writer.client()).rpc('rsvp_to_event', { p_event_id: eventID, p_status: status });
  if (error) throw error;
}

// A refused code (wrong, or a locked-out caller: the owner ruled the two
// indistinguishable) returns a payload instead of raising so the server can
// count it. It is thrown here in the refusal's own shape, so the member sees
// the same failure sentence and nothing retries.
export async function checkInMobileEvent(writer: MobileSessionWriter, eventID: string, code: string): Promise<void> {
  const response: { data: unknown; error: unknown } = await (await writer.client()).rpc('check_in_to_event', { p_event_id: eventID, p_code: code });
  if (response.error) throw response.error;
  const row = record(response.data);
  if (row.checkedIn === false) {
    throw {
      code: nonblankString(row.code) ?? '22023',
      message: nonblankString(row.message) ?? 'invalid check-in code',
      details: null,
    };
  }
}

export type MobileEventScanResult = {
  memberUserID: string;
  memberName: string;
  checkedIn: boolean;
  alreadyCheckedIn: boolean;
  memberAwardedPoints: number;
  scannerAwardedPoints: number;
};

const SCAN_REFUSAL_COPY: Record<string, string> = {
  checkin_not_offered: 'This meeting has no check-in.',
  scan_not_steward: 'A current committee role and required two-step sign-in are needed to scan.',
  scan_code_missing: "Enter the worker's check-in code.",
  scan_code_invalid: 'That code is invalid or no longer available.',
  scan_code_used: 'That code has already been used.',
  scan_code_expired: 'That code expired. Ask the worker to refresh it.',
  scan_code_self: "You can't scan your own check-in code.",
  scan_event_cancelled: 'This meeting was cancelled, so check-in is closed.',
};

const SCAN_REFUSAL_FALLBACK = 'That check-in code was not accepted. Ask the worker to refresh it.';

export function scanCheckinRefusalCopy(error: unknown): string {
  const details = typeof error === 'object' && error !== null && 'details' in error
    && typeof (error as { details: unknown }).details === 'string'
    ? (error as { details: string }).details.trim()
    : '';
  return SCAN_REFUSAL_COPY[details] ?? SCAN_REFUSAL_FALLBACK;
}

function nonblankString(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function finiteNumber(value: unknown): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null;
  return value;
}

export async function scanMobileEventCheckin(writer: MobileSessionWriter, eventID: string, token: string): Promise<MobileEventScanResult> {
  const response: { data: unknown; error: unknown } = await (await writer.client()).rpc('scan_event_checkin', { p_event_id: eventID, p_token: token.trim() });
  if (response.error) throw response.error;
  const row = record(response.data);
  const memberUserID = nonblankString(row.memberUserId);
  const memberName = nonblankString(row.memberName);
  const memberAwardedPoints = finiteNumber(row.memberAwardedPoints);
  const scannerAwardedPoints = finiteNumber(row.scannerAwardedPoints);
  if (
    row.checkedIn !== true
    || memberUserID == null
    || memberName == null
    || typeof row.alreadyCheckedIn !== 'boolean'
    || memberAwardedPoints == null
    || scannerAwardedPoints == null
  ) {
    throw Object.assign(new Error(SCAN_REFUSAL_COPY.scan_code_invalid ?? SCAN_REFUSAL_FALLBACK), { details: 'scan_code_invalid' });
  }
  return {
    memberUserID,
    memberName,
    checkedIn: true,
    alreadyCheckedIn: row.alreadyCheckedIn,
    memberAwardedPoints,
    scannerAwardedPoints,
  };
}

// The web ledger's English entry labels (rewards.kind.* in src/lib/i18n.js), so
// a native ledger row never reads as a raw lowercase kind such as "vote".
const REWARD_KIND_LABELS: Readonly<Record<string, string>> = {
  checkin: 'Meeting check-in',
  rsvp: 'Meeting RSVP',
  case: 'Issue filed',
  vote: 'Vote cast',
  rights: 'Rights lesson',
  form: 'Form filed',
  scan: 'Checked a worker in',
  survey: 'Pulse survey',
  steward: 'Committee answered you',
  workload: 'Workplace log',
  message: 'Committee message',
  referral: 'Recruited a worker',
};

export function rewardKindLabel(kind: string): string {
  const known = REWARD_KIND_LABELS[kind];
  if (known) return known;
  const words = kind.replaceAll('_', ' ').trim();
  return words ? `${words.charAt(0).toLocaleUpperCase()}${words.slice(1)}` : 'Confirmed action';
}

export async function loadMobileContributions(spanish = false): Promise<LivedInContributions> {
  const client = requireClient();
  const [summaryResult, ruleRows, eventRows, referralResult, ruleResult] = await Promise.all([
    client.rpc('get_member_recognition_summary'),
    rows('member_recognition_rules', 'recognition_kind,label_en,label_es,description_en,description_es,active', 'recognition_kind', true, 'recognition_kind'),
    rows('member_recognition_events', 'id,recognition_kind,source_label,occurred_at,verified_at', 'occurred_at'),
    // Soft, as on the web: no code card if either read fails.
    softRead(client.rpc('get_member_referral_summary')),
    softRead(client.from('member_point_rules').select('points,weekly_cap').eq('action_kind', 'referral').limit(1)),
  ]);
  if (summaryResult.error) throw summaryResult.error;
  const summary = record(summaryResult.data);
  const ruleRow = !ruleResult.error && Array.isArray(ruleResult.data) ? record(ruleResult.data[0]) : null;
  return {
    totalVerified: finiteNumber(summary.totalVerified) ?? 0,
    recentVerified: finiteNumber(summary.recentVerified) ?? 0,
    currentRung: recognitionRung(summary.currentRung),
    rules: ruleRows.filter((item) => item.active !== false).map((item) => ({
      recognitionKind: String(item.recognition_kind),
      label: String((spanish ? item.label_es : item.label_en) ?? item.label_en ?? item.recognition_kind),
      description: String((spanish ? item.description_es : item.description_en) ?? item.description_en ?? ''),
    })),
    events: eventRows.map((item) => ({
      id: String(item.id),
      recognitionKind: String(item.recognition_kind),
      sourceLabel: item.source_label == null ? '' : String(item.source_label),
      occurredAt: String(item.occurred_at),
    })),
    referral: referralResult.error ? null : normalizeReferralSummary(referralResult.data),
    referralRule: ruleRow === null ? undefined
      : typeof ruleRow.points === 'number' ? { points: ruleRow.points, weeklyCap: typeof ruleRow.weekly_cap === 'number' ? ruleRow.weekly_cap : null } : null,
  };
}

export async function loadMobileWorkloadHistory(): Promise<LivedInWorkload> {
  const client = requireClient();
  const columns = 'id,logged_on,priority,pending,todos,referrals,assistance_requests,note,created_at';
  const readLogs = async () => {
    try { return await rows('member_workload_logs', `${columns},settings_scope`, 'created_at'); }
    catch (error: unknown) {
      const failure = record(error);
      if (['42703', 'PGRST204'].includes(String(failure.code)) && /\bsettings_scope\b/.test([failure.message, failure.details].join(' '))) return rows('member_workload_logs', columns, 'created_at');
      throw error;
    }
  };
  const [statsResult, logRows] = await Promise.all([
    client.rpc('get_workload_stats'),
    readLogs(),
  ]);
  if (statsResult.error) throw statsResult.error;
  return {
    stats: record(statsResult.data),
    logs: logRows.map((item) => ({
      id: String(item.id), loggedOn: String(item.logged_on), priority: Number(item.priority), pending: Number(item.pending),
      todos: Number(item.todos), referrals: Number(item.referrals), assistanceRequests: Number(item.assistance_requests),
      note: item.note == null ? null : String(item.note),
      ...(item.settings_scope && typeof item.settings_scope === 'object' && 'unitName' in item.settings_scope && typeof item.settings_scope.unitName === 'string' ? { unitName: item.settings_scope.unitName } : {}),
    })),
  };
}

export async function loadMobileRightsHistory(): Promise<LivedInRights> {
  const userID = await currentUserID();
  const client = requireClient();
  const ownRequests = collectPages(async (from, to) => {
    const result = await client.from('member_steward_requests').select('id,lesson_id,status,created_at').eq('user_id', userID)
      .order('created_at', { ascending: false })
      .order('id', { ascending: true })
      .range(from, to);
    if (result.error) throw result.error;
    return (result.data ?? []) as unknown as Row[];
  });
  const [lessons, progress, requests, articles] = await Promise.all([
    rows('member_rights_lessons', 'id,label,title,description,steps,script,order_index', 'order_index', true),
    rows('member_rights_progress', 'lesson_id,completed_steps,updated_at', 'updated_at', false, 'lesson_id'),
    ownRequests,
    rows('member_kb_articles', 'id,slug,article_ref,title,body,status,updated_at,order_index', 'order_index', true),
  ]);
  return {
    lessons: lessons.map((lesson) => ({
      id: String(lesson.id), label: String(lesson.label), title: String(lesson.title), description: String(lesson.description),
      steps: Array.isArray(lesson.steps) ? lesson.steps.map(String) : [], script: String(lesson.script),
      completedSteps: (progress.find((item) => item.lesson_id === lesson.id)?.completed_steps as number[] | undefined) ?? [],
      requestStatus: (requests.find((item) => item.lesson_id === lesson.id)?.status as string | undefined) ?? null,
    })),
    articles: articles.filter((article) => article.status === 'published').map((article) => ({
      id: String(article.id), slug: String(article.slug), ref: String(article.article_ref ?? 'RIGHTS'), title: String(article.title), body: String(article.body), updatedAt: String(article.updated_at),
    })),
  };
}

async function currentUserID(): Promise<string> {
  const { data, error } = await requireClient().auth.getUser();
  if (error || !data.user) throw error ?? new Error('Your secure session has expired.');
  return data.user.id;
}

// An accepted primary write whose follow-up activity row could not be recorded
// is still saved; the mark lets a caller tell the two apart without failing.
export type MobileAuditedWrite = { auditFailed: boolean };

// Ledger 687 (#9254): the activity row follows a write the server already
// accepted. Ask the checked writer for a fresh client for it, so a same-person
// token refresh that landed meanwhile is adopted and a replacement account is
// still refused, and report an audit failure instead of throwing, so the
// accepted write never appears failed or invites a duplicate.
async function recordFollowUpActivity(writer: MobileSessionWriter, row: { user_id: string; action_key: string; action_kind: string }): Promise<MobileAuditedWrite> {
  try {
    const { error } = await (await writer.client()).from('member_action_log').upsert(row, { onConflict: 'user_id,action_key', ignoreDuplicates: true });
    return { auditFailed: Boolean(error) };
  } catch {
    return { auditFailed: true };
  }
}

export async function saveMobileRightsProgress(writer: MobileSessionWriter, lessonID: string, completedSteps: number[]): Promise<MobileAuditedWrite> {
  const userID = writer.userId;
  if (!userID) throw new Error('The composing account is unavailable.');
  const { error } = await (await writer.client()).from('member_rights_progress').upsert({ lesson_id: lessonID, user_id: userID, completed_steps: completedSteps }, { onConflict: 'lesson_id,user_id' });
  if (error) throw error;
  if (!completedSteps.length) return { auditFailed: false };
  return recordFollowUpActivity(writer, { user_id: userID, action_key: `rights-${lessonID}`, action_kind: 'rights' });
}

export async function requestMobileSteward(writer: MobileSessionWriter, lessonID: string): Promise<MobileAuditedWrite> {
  const userID = writer.userId;
  if (!userID) throw new Error('The composing account is unavailable.');
  const { data, error } = await (await writer.client()).from('member_steward_requests').insert({ user_id: userID, lesson_id: lessonID }).select('id').single();
  if (error) throw error;
  if (!data?.id) return { auditFailed: false };
  // This row is audit-only. The request already landed, so an audit failure
  // must not invite a duplicate request by presenting the whole action as failed.
  return recordFollowUpActivity(writer, { user_id: userID, action_key: `steward-${String(data.id)}`, action_kind: 'steward' });
}

export async function loadMobileChapterHistory(): Promise<LivedInChapter> {
  const [documents, records, broadcasts, receipts] = await Promise.all([
    rows('chapter_documents', 'id,title,document_type,summary,version,status,updated_at', 'updated_at'),
    rows('chapter_records', 'id,record_type,title,body,occurred_at,archived_at', 'occurred_at'),
    rows('member_broadcasts', 'id,sender,title,body,published_at,order_index', 'published_at', false, 'id', 'retracted_at'),
    rows('member_broadcast_receipts', 'broadcast_id,read_at', 'read_at', false, 'broadcast_id'),
  ]);
  return {
    documents: documents.filter((document) => document.status === 'published').map((document) => ({
      id: String(document.id), kind: String(document.document_type), title: String(document.title), summary: String(document.summary ?? ''), version: Number(document.version), updatedAt: String(document.updated_at),
    })),
    records: records.filter((item) => !item.archived_at).map((item) => ({
      id: String(item.id), kind: String(item.record_type), title: String(item.title), body: String(item.body), occurredAt: String(item.occurred_at),
    })),
    broadcasts: broadcasts.map((broadcast) => ({
      id: String(broadcast.id), sender: String(broadcast.sender), title: String(broadcast.title), body: String(broadcast.body), publishedAt: String(broadcast.published_at),
      readAt: (receipts.find((receipt) => receipt.broadcast_id === broadcast.id)?.read_at as string | undefined) ?? null,
    })),
  };
}

export async function loadMobileChapterDocument(documentID: string): Promise<LivedInChapterDocument> {
  const { data, error } = await requireClient()
    .from('chapter_documents')
    .select('id,title,document_type,summary,body,version,status,updated_at')
    .eq('id', documentID)
    .eq('status', 'published')
    .maybeSingle();
  if (error) throw error;
  if (!data) throw new Error('The approved campaign source is unavailable.');
  const document = data as Row;
  return {
    id: String(document.id),
    kind: String(document.document_type),
    title: String(document.title),
    summary: String(document.summary ?? ''),
    body: String(document.body),
    version: Number(document.version),
    updatedAt: String(document.updated_at),
  };
}

export async function markMobileBroadcastRead(writer: MobileSessionWriter, broadcastID: string): Promise<void> {
  const userID = writer.userId;
  if (!userID) throw new Error('The composing account is unavailable.');
  const client = await writer.client();
  const { error } = await client.from('member_broadcast_receipts').upsert(
    { broadcast_id: broadcastID, user_id: userID },
    { onConflict: 'broadcast_id,user_id', ignoreDuplicates: true },
  );
  if (error) throw error;
}

function compassMessageRole(value: unknown): 'user' | 'assistant' {
  return value === 'user' ? 'user' : 'assistant';
}

// The person's own task discussions for the Messages tab: the task messages
// they sent or received (participant RLS), each with its task embedded so a
// deleted task, or one no longer readable in their chapter, is excluded before
// the row limit (BUG-UG-NATIVE-CASE-ROWS-AND-TASK-TITLES-DO-NOT-OPEN-20261111).
export async function loadMyTaskDiscussions(): Promise<TaskDiscussion[]> {
  const client = requireClient();
  const userID = await currentUserID();
  if (!/^[0-9a-f-]{36}$/i.test(userID)) return [];
  const messages = await client.from('chapter_task_messages')
    .select('task_id,body,created_at,sender_id,chapter_tasks!inner(id,title,chapter_id,task_number,deleted_at)')
    .or(`sender_id.eq.${userID},recipient_id.eq.${userID}`)
    .is('chapter_tasks.deleted_at', null)
    .order('created_at', { ascending: false })
    .limit(TASK_DISCUSSION_MESSAGE_LIMIT);
  if (messages.error) throw messages.error;
  return taskDiscussionsFromRows(taskDiscussionRowList(messages.data), userID);
}

export async function loadMobileTasksHistory(): Promise<LivedInTask[]> {
  const columns = 'id,chapter_id,task_number,task_type,title,description,status,priority,workstream,assignee_name,start_date,due_date,progress,blocked,milestone,updated_at';
  let taskRows: Row[];
  try { taskRows = await rows('chapter_tasks', `${columns},settings_scope`, 'updated_at'); }
  catch (error: unknown) {
    const failure = record(error);
    if (!['42703', 'PGRST204'].includes(String(failure.code)) || !/\bsettings_scope\b/.test([failure.message, failure.details].join(' '))) throw error;
    taskRows = await rows('chapter_tasks', columns, 'updated_at');
  }
  return taskRows.map((task) => ({
    id: String(task.id), identifier: nativeTaskReference(task.chapter_id, task.task_number), title: String(task.title),
    description: String(task.description ?? ''), status: String(task.status), priority: String(task.priority), workstream: String(task.workstream),
    assignee: String(task.assignee_name || 'Unassigned'),
    startDate: task.start_date == null ? null : String(task.start_date),
    dueDate: task.due_date == null ? null : String(task.due_date),
    progress: Number(task.progress),
    blocked: Boolean(task.blocked), milestone: Boolean(task.milestone),
    ...(task.settings_scope && typeof task.settings_scope === 'object' && 'unitName' in task.settings_scope ? { unitName: typeof task.settings_scope.unitName === 'string' ? task.settings_scope.unitName : null } : {}),
  }));
}

export async function loadMobileCompassHistory(): Promise<LivedInCompassHistory> {
  const [threads, messages] = await Promise.all([
    rows('member_guide_threads', 'id,title,created_at,updated_at', 'updated_at'),
    rows('member_guide_messages', 'id,thread_id,role,body,sources,created_at', 'created_at', true),
  ]);
  const latest = threads[0];
  if (!latest) return { threadID: null, title: null, messages: [], threads: [] };
  const threadRecords = threads.map((thread) => ({
    id: String(thread.id),
    title: String(thread.title),
    messages: messages.filter((message) => message.thread_id === thread.id).map((message) => ({
      id: String(message.id), role: compassMessageRole(message.role), body: String(message.body),
      sources: Array.isArray(message.sources) ? compassSourcesWithDestinations(message.sources) : undefined,
    })),
  }));
  const latestRecord = threadRecords[0]!;
  return {
    threadID: latestRecord.id,
    title: latestRecord.title,
    messages: latestRecord.messages,
    threads: threadRecords,
  };
}

// The desk blob's rows are camelCase jsonb (src/data/fallback.js stewardApptDesk
// documents the shape); list_steward_appointments pages are snake_case rows
// (src/lib/memberApi.js loadStewardAppointmentsPage). One normalizer keeps both
// honest, and neither path ever reads member_cases: this desk is the steward's
// own appointment surface, not the casework evidence loader.
function stewardAppointmentRow(item: Row): LivedInStewardAppointment {
  const endsAt = item.endsAt ?? item.ends_at;
  const reasonCategory = item.reasonCategory ?? item.reason_category;
  const routedVia = item.routedVia ?? item.routed_via;
  return {
    id: String(item.id),
    memberName: String(item.memberName ?? item.member_name ?? 'Worker'),
    type: String(item.type ?? item.appointment_type ?? ''),
    durationMinutes: Number(item.durationMinutes ?? item.duration_minutes ?? 0),
    startsAt: String(item.startsAt ?? item.starts_at ?? ''),
    endsAt: endsAt == null ? null : String(endsAt),
    place: String(item.place ?? ''),
    status: String(item.status ?? ''),
    reasonCategory: reasonCategory == null ? null : String(reasonCategory),
    routedVia: routedVia == null ? null : String(routedVia),
  };
}

function listOfRows(value: unknown): Row[] {
  return Array.isArray(value) ? value as Row[] : [];
}

export async function loadMobileStewardAppointmentsDesk(): Promise<LivedInStewardAppointmentsDesk> {
  const client = requireClient();
  const { data, error } = await client.rpc('get_steward_appointments');
  if (error) throw error;
  const desk = record(data);
  const schedule = record(desk.schedule);
  const stats = record(desk.stats);
  return {
    upcoming: listOfRows(desk.upcoming).map(stewardAppointmentRow),
    recent: listOfRows(desk.recent).map(stewardAppointmentRow),
    outcomes: {
      completed30d: typeof stats.completed30d === 'number' ? stats.completed30d : null,
      noShows30d: typeof stats.noShows30d === 'number' ? stats.noShows30d : null,
    },
    availability: {
      timezone: typeof schedule.timezone === 'string' ? schedule.timezone : null,
      accepting: typeof schedule.accepting === 'boolean' ? schedule.accepting : null,
      minNoticeMinutes: typeof schedule.minNoticeMinutes === 'number' ? schedule.minNoticeMinutes : null,
      windows: listOfRows(desk.windows).map((window) => ({
        id: String(window.id),
        weekday: Number(window.weekday),
        startMinute: Number(window.startMinute),
        endMinute: Number(window.endMinute),
      })),
      blackouts: listOfRows(desk.blackouts).map((blackout) => ({
        id: String(blackout.id),
        startDate: String(blackout.startDate ?? ''),
        endDate: String(blackout.endDate ?? ''),
      })),
    },
    connections: listOfRows(desk.connections).map((connection) => ({
      id: String(connection.id),
      provider: String(connection.provider ?? 'calendar'),
      status: String(connection.status ?? 'unset'),
      accountLabel: connection.accountLabel == null ? null : String(connection.accountLabel),
    })),
  };
}

export async function loadMobileStewardAppointmentsPage(
  scope: 'upcoming' | 'recent',
  cursor: { startsAt: string; id: string } | null,
  limit = 25,
): Promise<{ rows: LivedInStewardAppointment[]; nextCursor: { startsAt: string; id: string } | null }> {
  const client = requireClient();
  const { data, error } = await client.rpc('list_steward_appointments', {
    p_scope: scope,
    p_after_starts: cursor?.startsAt ?? null,
    p_after_id: cursor?.id ?? null,
    p_limit: limit,
  });
  if (error) throw error;
  const rows = listOfRows(data);
  const last: Row | undefined = rows[rows.length - 1];
  return {
    rows: rows.map(stewardAppointmentRow),
    nextCursor: rows.length >= limit && last
      ? { startsAt: String(last.starts_at ?? last.startsAt ?? ''), id: String(last.id) }
      : null,
  };
}

export async function saveMobileCompassExchange(writer: MobileSessionWriter, threadID: string | null, question: string, answer: string, sources: CompassSource[]): Promise<string> {
  const { data, error } = await (await writer.client()).rpc('save_member_guide_exchange', {
    p_thread_id: threadID,
    p_question: question,
    p_answer: answer,
    // Destinations are a mobile navigation projection derived from kind/ref,
    // not part of the server's durable source citation shape.
    p_sources: sources.map(({ id, kind, title, ref }) => ({ id, kind, title, ref })),
  });
  if (error || typeof data !== 'string') throw error ?? new Error('Guide history could not be saved.');
  return data;
}
