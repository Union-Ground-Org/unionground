import { withReadDeadline } from '../lib/readDeadline';
import type { MobileSessionWriter } from './supabase';
import { projectStewardFormRow, type StewardFormApprovalExpectation } from './stewardFormReview';
import { getSupabaseClient } from './supabase';
import { loadNoticeAudiences, publishNoticeAudience, NOTICE_AUDIENCE_UNAVAILABLE, type NoticeAudience } from '../../../../src/lib/noticeAudience.js';
export type { NoticeAudience } from '../../../../src/lib/noticeAudience.js';

// The four Steward Work rows that used to open the shared Casework list.
// Each call is the same RPC or assignee read the website desk already uses.

export type StewardCaseloadCase = {
  id: string;
  reference: string;
  title: string;
  status: string;
};

export type StewardRequestRow = {
  id: string;
  memberName: string;
  topic: string;
  status: string;
  createdAt: string | null;
};

export type StewardFormReviewRow = {
  id: string;
  memberName: string;
  userID: string;
  templateKey: string;
  templateLabel: string;
  templateVersion: number | null;
  submittedAt: string | null;
  status: string;
  answers: Record<string, unknown>;
  protectedAnswers: boolean;
  // Plaintext left on a sealed template is dropped and never opened.
  answersHidden: boolean;
  unitName?: string | null;
};

export type StewardBroadcastRow = {
  id: string;
  title: string;
  // When it went out (#9609): what tells two notices with one title apart.
  publishedAt: string | null;
  retracted: boolean;
};

// Same caps the screen already used. Paging walks them; it does not raise them.
const CASELOAD_PAGE = 100;
const REQUEST_PAGE = 50;
const FORM_PAGE = 50;
const BROADCAST_PAGE = 20;

export type StewardCaseloadCursor = { updatedAt: string; id: string };
export type StewardRequestCursor = { createdAt: string; id: string };
export type StewardFormCursor = { submittedAt: string; id: string };
export type StewardBroadcastCursor = { publishedAt: string; id: string };

export type StewardListPage<T, C> = {
  rows: T[];
  total: number | null;
  nextCursor: C | null;
};

function finiteCount(value: unknown): number | null {
  const number = typeof value === 'number' ? value : typeof value === 'string' && value.trim() !== '' ? Number(value) : Number.NaN;
  return Number.isFinite(number) ? number : null;
}

// total_count rides the raw page. An empty later page keeps the caller's total.
function listedTotal(rows: Record<string, unknown>[], cursor: unknown): number | null {
  if (rows.length === 0) return cursor ? null : 0;
  return finiteCount(rows[0]?.total_count);
}

// The cursor is the last raw row, including one the client then drops, so the
// next page is not hidden behind a filtered draft.
function rawCursor(rows: Record<string, unknown>[], pageSize: number, stampKey: string): { stamp: string; id: string } | null {
  if (rows.length < pageSize) return null;
  const last = rows[rows.length - 1];
  const id = typeof last?.id === 'string' ? last.id : '';
  const stamp = typeof last?.[stampKey] === 'string' ? last[stampKey] : '';
  if (!id || !stamp) return null;
  return { stamp, id };
}

function caseloadStamp(value: string): string {
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/.test(value)) return value;
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? value : new Date(parsed).toISOString();
}

function client() {
  const supabase = getSupabaseClient();
  if (!supabase) throw new Error('The secure mobile backend is not configured.');
  return supabase;
}

function rowsOf(data: unknown): Record<string, unknown>[] {
  const items: readonly unknown[] = Array.isArray(data) ? data : [];
  const rows: Record<string, unknown>[] = [];
  for (const item of items) if (item && typeof item === 'object') rows.push(item as Record<string, unknown>);
  return rows;
}

export async function loadStewardCaseload(
  userID: string,
  cursor: StewardCaseloadCursor | null = null,
): Promise<StewardListPage<StewardCaseloadCase, StewardCaseloadCursor>> {
  if (!userID) return { rows: [], total: 0, nextCursor: null };
  const supabase = client();
  let query = supabase
    .from('member_cases')
    .select('id,reference,title,case_type,step,status,updated_at', cursor ? undefined : { count: 'exact' })
    .eq('steward_user_id', userID)
    .neq('user_id', userID);
  if (cursor) {
    const stamp = caseloadStamp(cursor.updatedAt);
    query = query.or(`updated_at.lt.${stamp},and(updated_at.eq.${stamp},id.lt.${cursor.id})`);
  }
  const result = await query
    .order('updated_at', { ascending: false })
    .order('id', { ascending: false })
    .limit(CASELOAD_PAGE);
  if (result.error) throw new Error('Your caseload did not load. Try again.');
  const raw = rowsOf(result.data);
  const position = rawCursor(raw, CASELOAD_PAGE, 'updated_at');
  return {
    rows: raw.map((row) => {
      const title = String(row.title ?? '').trim();
      const fallback = [row.case_type, row.step].map((part) => String(part ?? '').trim()).filter(Boolean).join(' · ');
      return {
        id: String(row.id),
        reference: String(row.reference ?? ''),
        title: title || fallback || 'Issue',
        status: String(row.status ?? ''),
      };
    }),
    total: cursor ? null : finiteCount(result.count) ?? (raw.length === 0 ? 0 : null),
    nextCursor: position ? { updatedAt: position.stamp, id: position.id } : null,
  };
}

export async function loadStewardRequests(
  cursor: StewardRequestCursor | null = null,
): Promise<StewardListPage<StewardRequestRow, StewardRequestCursor>> {
  const supabase = client();
  const result = await supabase.rpc('list_steward_requests', {
    p_status: 'all',
    p_search: null,
    p_sort: 'newest',
    p_after_created: cursor?.createdAt ?? null,
    p_after_id: cursor?.id ?? null,
    p_limit: REQUEST_PAGE,
  });
  if (result.error) throw new Error('Worker requests did not load. Try again.');
  const rows = rowsOf(result.data);
  const lessonIDs = [...new Set(rows.map((row) => String(row.lesson_id ?? '')).filter(Boolean))];
  const labels = new Map<string, string>();
  if (lessonIDs.length > 0) {
    const lessons = await supabase.from('member_rights_lessons').select('id,label').in('id', lessonIDs);
    if (!lessons.error) {
      for (const lesson of rowsOf(lessons.data)) labels.set(String(lesson.id), String(lesson.label ?? ''));
    }
  }
  const position = rawCursor(rows, REQUEST_PAGE, 'created_at');
  return {
    rows: rows.map((row) => {
      const lessonID = String(row.lesson_id ?? '');
      return {
        id: String(row.id),
        memberName: String(row.member_name || 'Worker'),
        topic: labels.get(lessonID) || '',
        status: String(row.status ?? ''),
        createdAt: typeof row.created_at === 'string' ? row.created_at : null,
      };
    }),
    total: listedTotal(rows, cursor),
    nextCursor: position ? { createdAt: position.stamp, id: position.id } : null,
  };
}

export async function triageStewardRequest(writer: MobileSessionWriter, requestID: string, action: 'acknowledge' | 'close'): Promise<void> {
  const supabase = (await writer.client());
  const result = await supabase.rpc('triage_steward_request', { p_request_id: requestID, p_action: action });
  if (result.error) throw new Error(action === 'acknowledge' ? 'That request was not acknowledged. Try again.' : 'That request was not closed. Try again.');
}

export async function loadStewardFormsForReview(
  cursor: StewardFormCursor | null = null,
): Promise<StewardListPage<StewardFormReviewRow, StewardFormCursor>> {
  const supabase = client();
  const result = await supabase.rpc('list_steward_forms', {
    p_status: 'all',
    p_search: null,
    p_sort: 'oldest',
    p_after_submitted: cursor?.submittedAt ?? null,
    p_after_id: cursor?.id ?? null,
    p_limit: FORM_PAGE,
  });
  if (result.error) throw new Error('Forms waiting for review did not load. Try again.');
  const rows = rowsOf(result.data);
  // Scope metadata follows only the IDs admitted by the existing paged inbox.
  // Its failure cannot hide an already-visible filing.
  const scopeResult = rows.length ? await supabase.from('member_forms').select('id,settings_scope').in('id', rows.map((row) => String(row.id))) : null;
  const scopes = new Map(rowsOf(scopeResult?.data).map((row) => [String(row.id), row.settings_scope]));
  const position = rawCursor(rows, FORM_PAGE, 'submitted_at');
  return {
    rows: rows.flatMap((row) => {
      const projected = projectStewardFormRow(row);
      if (!projected) return [];
      const scope = scopes.get(projected.id);
      const unitName = scope && typeof scope === 'object' && 'unitName' in scope && typeof scope.unitName === 'string' ? scope.unitName : null;
      const review: StewardFormReviewRow = {
        id: projected.id,
        memberName: projected.memberName,
        userID: projected.userID,
        templateKey: projected.templateKey,
        templateLabel: projected.templateLabel,
        templateVersion: projected.templateVersion,
        submittedAt: projected.submittedAt,
        status: projected.status,
        answers: projected.answers,
        protectedAnswers: projected.protectedAnswers,
        answersHidden: projected.answersHidden,
        ...(scopes.has(projected.id) ? { unitName } : {}),
      };
      return [review];
    }),
    total: listedTotal(rows, cursor),
    nextCursor: position ? { submittedAt: position.stamp, id: position.id } : null,
  };
}

// approve_form refused because the filing changed after the steward's read
// (PT409 form_changed_since_review): a return and resubmission, or a co-signer
// joining or withdrawing. Nothing was approved.
export class StewardFormChangedError extends Error {
  constructor() {
    super('form-changed-since-review');
    this.name = 'StewardFormChangedError';
  }
}

// return_form refused because the member already has a draft or a returned
// copy of this form open (23505; the one-active-form-per-template rule).
// Nothing was returned. The website names this refusal; the phone must too
// (#9158: on both phones the return failed with a generic message).
export class StewardFormReturnBlockedError extends Error {
  constructor() {
    super('form-return-blocked-by-open-draft');
    this.name = 'StewardFormReturnBlockedError';
  }
}

// An approval names what the steward was shown (#8728, as the website does
// since #8707); approve_form compares it under the form lock. The phone never
// approves without it: with nothing to compare the server approves whatever is
// stored.
export async function reviewStewardForm(
  writer: MobileSessionWriter, formID: string,
  action: 'start' | 'approve' | 'return',
  note: string,
  shown: StewardFormApprovalExpectation | null = null,
): Promise<void> {
  const trimmed = note.trim();
  if (action === 'return' && !trimmed) throw new Error('A return needs a note.');
  if (action === 'approve' && !shown) throw new Error('That form was not updated. Try again.');
  const supabase = (await writer.client());
  let result: { error: { code: string; details: string } | null; status: number };
  if (action === 'start') result = await supabase.rpc('steward_start_review', { p_form_id: formID });
  else if (action === 'return') {
    result = await supabase.rpc('return_form', { p_form_id: formID, p_note: trimmed });
    if (result.error?.code === '23505') throw new StewardFormReturnBlockedError();
  } else {
    const common = { p_form_id: formID, p_note: trimmed || null };
    // Sent once, with what the steward was shown (#8960): a resend without it
    // approved content nobody reviewed. approve_form takes it since 20261113123000.
    result = await supabase.rpc('approve_form', { ...common, p_expected: shown });
    if (result.error?.code === 'PT409' && result.error.details === 'form_changed_since_review') throw new StewardFormChangedError();
  }
  if (result.error) throw new Error('That form was not updated. Try again.');
}

export async function loadStewardBroadcasts(
  cursor: StewardBroadcastCursor | null = null,
): Promise<StewardListPage<StewardBroadcastRow, StewardBroadcastCursor>> {
  const supabase = client();
  const result = await supabase.rpc('list_steward_broadcasts', {
    p_filter: 'all',
    p_search: null,
    p_after_published: cursor?.publishedAt ?? null,
    p_after_id: cursor?.id ?? null,
    p_limit: BROADCAST_PAGE,
  });
  if (result.error) throw new Error('Broadcasts did not load. Try again.');
  const rows = rowsOf(result.data);
  const position = rawCursor(rows, BROADCAST_PAGE, 'published_at');
  return {
    rows: rows.map((row) => ({
      id: String(row.id),
      title: String(row.title ?? ''),
      publishedAt: typeof row.published_at === 'string' ? row.published_at : null,
      retracted: Boolean(row.retracted_at),
    })),
    total: listedTotal(rows, cursor),
    nextCursor: position ? { publishedAt: position.stamp, id: position.id } : null,
  };
}

export async function loadStewardNoticeAudiences(chapterID: string, role: string | null): Promise<NoticeAudience[]> {
  return loadNoticeAudiences(client(), { chapterId: chapterID, role });
}

// The notice's own language, stored as the broadcast's locale: readers see the
// In English label from it, as with the website's notice desk (#9117).
export type NoticeLocale = 'en' | 'es';

// A key for one notice draft (#9220): the composer starts it on the draft's
// first try and every later attempt, a locked "Send again" after an uncertain
// failure included, carries it however long the person waits, so the server
// answers a repeat with the notice the lost try published. A send with no key
// gets one of its own for that call.
export async function newNoticeOperationKey(): Promise<string> {
  return (await import('expo-crypto')).randomUUID();
}

export async function sendChapterBroadcast(writer: MobileSessionWriter, title: string, body: string, audience: NoticeAudience | undefined, locale: NoticeLocale, operationKey?: string): Promise<'already-posted' | void> {
  const trimmedTitle = title.trim();
  const trimmedBody = body.trim();
  if (!trimmedTitle || !trimmedBody) throw new Error('A broadcast needs a title and a message.');
  const supabase = (await writer.client());
  try {
    // The phone has no globalThis.crypto, so a send without a draft gets its key here.
    const key = operationKey ?? await newNoticeOperationKey();
    // Ledger 619: React Native's fetch has no timeout on Android, so a publish
    // that never answers would keep the composer busy until the app restarts.
    // At the shared deadline it fails with no server answer, like a lost
    // reply: the composer holds the notice unconfirmed and Send again carries
    // the same key, so a publish that did land is not posted twice.
    await withReadDeadline(publishNoticeAudience(supabase, trimmedTitle, trimmedBody, locale === 'es' ? 'es' : 'en', audience, key));
  } catch (error) {
    if (typeof error === 'object' && error !== null && Reflect.get(error, 'keyReused') === true) return 'already-posted';
    if (error instanceof Error && 'code' in error && error.code === NOTICE_AUDIENCE_UNAVAILABLE) {
      throw Object.assign(new Error('Your notice audience is unavailable. Reload audiences before sending.'), { code: NOTICE_AUDIENCE_UNAVAILABLE, cause: error });
    }
    // A code means the server answered and refused; with none, the notice may
    // have been published before the answer was lost (#9099 part 2).
    const code: unknown = typeof error === 'object' && error !== null ? Reflect.get(error, 'code') : null;
    const status: unknown = typeof error === 'object' && error !== null ? Reflect.get(error, 'status') : null;
    // withoutKey: the database had no keyed publisher yet, so this try went
    // without the operation key and a retry of it is not deduplicated (#9220).
    const withoutKey = typeof error === 'object' && error !== null && Reflect.get(error, 'withoutKey') === true;
    throw Object.assign(new Error('The broadcast was not sent. Try again.'), {
      serverAnswered: (typeof code === 'string' && code !== '') || (typeof status === 'number' && status >= 400 && status < 500),
      withoutKey, cause: error,
    });
  }
}

// BUG-UG-NATIVE-OFFICERS-CANNOT-INVITE-SCHEDULE-OR-DRAFT-ON-THE-PHONE-20261118
// (#9099, part 2 of 4): the notices this officer sent, read through the RPC
// the website's notice desk lists them with (src/lib/memberApi.js
// listMyMemberNotices -> list_my_member_notices), for the Chapter notices
// list.
export type SentNotice = {
  id: string;
  title: string;
  body: string;
  locale: 'en' | 'es';
  publishedAt: string | null;
  retracted: boolean;
  readCount: number | null;
  audienceCount: number | null;
};

const SENT_NOTICE_PAGE = 20;

function noticeCount(value: unknown): number | null {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : null;
}

type RpcResult = { data: unknown; error: unknown };

function noticeRows(data: unknown): Record<string, unknown>[] {
  if (typeof data !== 'object' || data === null) return [];
  const notices: unknown = Reflect.get(data, 'notices');
  if (!Array.isArray(notices)) return [];
  const list: readonly unknown[] = notices;
  const rows: Record<string, unknown>[] = [];
  for (const item of list) if (typeof item === 'object' && item !== null) rows.push(item as Record<string, unknown>);
  return rows;
}

function noticeText(row: Record<string, unknown>, key: string): string | null {
  const value = row[key];
  return typeof value === 'string' ? value : null;
}

/** The newest notices this account sent, newest first. */
export async function loadMySentNotices(): Promise<SentNotice[]> {
  const result: RpcResult = await client().rpc('list_my_member_notices', { p_limit: SENT_NOTICE_PAGE, p_before_published: null, p_before_id: null });
  if (result.error) throw result.error;
  const notices: SentNotice[] = [];
  for (const row of noticeRows(result.data)) {
    const id = noticeText(row, 'id');
    const title = noticeText(row, 'title');
    if (id === null || title === null) continue;
    notices.push({
      id,
      title,
      body: noticeText(row, 'body') ?? '',
      locale: noticeText(row, 'locale') === 'es' ? 'es' : 'en',
      publishedAt: noticeText(row, 'publishedAt'),
      retracted: Boolean(row.retractedAt),
      readCount: noticeCount(row.readCount),
      audienceCount: noticeCount(row.audienceCount),
    });
  }
  return notices;
}
