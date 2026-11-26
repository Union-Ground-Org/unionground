import { getSupabaseClient as businessTestClient } from './supabase';
import { stubSessionWriter } from '../testing/stubSessionWriter';
const businessWriter = stubSessionWriter(() => businessTestClient());
import { beforeEach, describe, expect, it, vi } from 'vitest';

const backend = vi.hoisted(() => ({
  configured: true,
  rpc: vi.fn(),
  queries: [] as { table: string; calls: [string, unknown[]][] }[],
  results: [] as { data: unknown; error: { message?: string } | null; count?: number | null }[],
}));

function nextQuery(table: string) {
  const calls: [string, unknown[]][] = [];
  const query: Record<string, unknown> = {};
  const record = (name: string) => (...args: unknown[]) => {
    calls.push([name, args]);
    return query;
  };
  for (const name of ['select', 'eq', 'neq', 'order', 'limit', 'in', 'or']) query[name] = record(name);
  query.then = (resolve: (value: unknown) => unknown, reject?: (reason: unknown) => unknown) => {
    const result = backend.results.shift() ?? { data: [], error: null };
    return Promise.resolve(result).then(resolve, reject);
  };
  backend.queries.push({ table, calls });
  return query;
}

const uuids = vi.hoisted(() => ({ next: 0 }));
vi.mock('expo-crypto', () => ({ randomUUID: () => `00000000-0000-4000-8000-${String(++uuids.next).padStart(12, '0')}` }));

vi.mock('./supabase', () => ({
  getSupabaseClient: () => (backend.configured ? { rpc: backend.rpc, from: (table: string) => nextQuery(table) } : null),
}));

import {
  loadStewardBroadcasts,
  loadStewardNoticeAudiences,
  loadStewardCaseload,
  loadStewardFormsForReview,
  loadStewardRequests,
  reviewStewardForm,
  sendChapterBroadcast,
  StewardFormChangedError,
  StewardFormReturnBlockedError,
  triageStewardRequest,
  type NoticeAudience,
  type NoticeLocale,
} from './stewardDeskSections';

beforeEach(() => {
  backend.configured = true;
  backend.rpc.mockReset();
  backend.queries.length = 0;
  backend.results.length = 0;
});

describe('committee member desk section reads', () => {
  it('loads only granted units for an organization committee member and keeps leadership broad', async () => {
    const unit = { role: 'steward', unitId: 'unit-a', name: 'Unit A', notices: true };
    backend.rpc.mockResolvedValue({ data: { chapterId: 'chapter-a', notices: true, unscopedNotices: false, scopes: [unit], organizationRoles: ['steward'] }, error: null });
    const choices = await loadStewardNoticeAudiences('chapter-a', 'steward');
    expect(choices).toEqual([{ value: 'unit:unit-a', kind: 'unit', chapterId: 'chapter-a', unitId: 'unit-a', name: 'Unit A' }]);
    expect(backend.rpc).toHaveBeenCalledWith('get_chapter_office_access');
    expect(backend.queries).toHaveLength(0);
    backend.rpc.mockResolvedValue({ data: { chapterId: 'chapter-a', notices: true, unscopedNotices: true, scopes: [] }, error: null });
    expect(await loadStewardNoticeAudiences('chapter-a', 'vp')).toEqual([{ value: 'chapter', kind: 'chapter', chapterId: 'chapter-a', name: '' }]);
  });

  it('requires an audience and never falls back to broad sending after a unit refusal', async () => {
    await expect(sendChapterBroadcast(businessWriter, 'Title', 'Body', undefined, 'en')).rejects.toMatchObject({ code: 'notice_audience_unavailable' });
    expect(backend.rpc).not.toHaveBeenCalled();
    backend.rpc.mockResolvedValue({ data: null, error: { code: '42501' } });
    await expect(sendChapterBroadcast(businessWriter, 'Title', 'Body', { value: 'unit:unit-a', kind: 'unit', chapterId: 'chapter-a', unitId: 'unit-a', name: 'Unit A' }, 'en')).rejects.toMatchObject({ code: 'notice_audience_unavailable', message: expect.stringContaining('Reload audiences') });
    expect(backend.rpc).toHaveBeenCalledTimes(1);
    expect(backend.rpc).toHaveBeenCalledWith('publish_chapter_office_notice', expect.objectContaining({ p_unit: 'unit-a' }));
  });

  // #9117: the notice's chosen language is what the publish RPC stores.
  it.each<NoticeLocale>(['es', 'en'])('stores the chosen notice language %s as p_locale on both publishers', async (locale: NoticeLocale) => {
    backend.rpc.mockResolvedValue({ data: { broadcastId: 'notice' }, error: null });
    await sendChapterBroadcast(businessWriter, 'Reunión', 'Para la unidad', { value: 'unit:unit-a', kind: 'unit', chapterId: 'chapter-a', unitId: 'unit-a', name: 'Unit A' }, locale);
    expect(backend.rpc).toHaveBeenLastCalledWith('publish_chapter_office_notice', expect.objectContaining({ p_locale: locale, p_unit: 'unit-a' }));
    await sendChapterBroadcast(businessWriter, 'Reunión', 'Para todos', { value: 'organization', kind: 'organization', chapterId: 'chapter-a', name: '' }, locale);
    expect(backend.rpc).toHaveBeenLastCalledWith('publish_member_broadcast', { p_title: 'Reunión', p_body: 'Para todos', p_locale: locale, p_audience_scope: 'organization', p_idempotency_key: expect.any(String) });
  });

  it('sends the selected committee member unit through the office notice RPC, never the broad publisher', async () => {
    backend.rpc.mockResolvedValue({ data: { broadcastId: 'unit-notice' }, error: null });
    await sendChapterBroadcast(businessWriter, ' Unit meeting ', ' For Unit A only ', {
      value: 'unit:11111111-1111-4111-8111-111111111111', kind: 'unit', chapterId: 'chapter-a',
      unitId: '11111111-1111-4111-8111-111111111111', name: 'Unit A',
    }, 'en');
    expect(backend.rpc).toHaveBeenCalledWith('publish_chapter_office_notice', {
      p_chapter: 'chapter-a', p_title: 'Unit meeting', p_body: 'For Unit A only', p_locale: 'en',
      p_unit: '11111111-1111-4111-8111-111111111111', p_committee: null, p_idempotency_key: expect.any(String),
    });
    expect(backend.rpc).not.toHaveBeenCalledWith('publish_member_broadcast', expect.anything());
  });

  // #9220: the composer's draft key travels on every attempt of that draft, so
  // Send again after a lost reply is the same operation. A send with no draft
  // key gets one of its own (expo-crypto) and matches nothing earlier (#9225).
  it('sends the draft key on every attempt, and a key of its own for a send with no draft', async () => {
    const unit = { value: 'unit:unit-a', kind: 'unit', chapterId: 'chapter-a', unitId: 'unit-a', name: 'Unit A' } satisfies Parameters<typeof sendChapterBroadcast>[3];
    backend.rpc
      .mockResolvedValueOnce({ data: null, error: { message: 'TypeError: Network request failed', code: '' } })
      .mockResolvedValue({ data: { broadcastId: 'bc-1' }, error: null });
    await expect(sendChapterBroadcast(businessWriter, 'Contract vote', 'Polls open at noon.', unit, 'en', 'draft-key-1')).rejects.toThrow('The broadcast was not sent. Try again.');
    await sendChapterBroadcast(businessWriter, 'Contract vote', 'Polls open at noon.', unit, 'en', 'draft-key-1');
    await sendChapterBroadcast(businessWriter, 'Contract vote', 'Polls open at noon.', unit, 'en');
    await sendChapterBroadcast(businessWriter, 'Contract vote', 'Polls open at noon.', unit, 'en');
    const keyOf = (args: unknown): unknown => (typeof args === 'object' && args !== null && 'p_idempotency_key' in args ? args.p_idempotency_key : undefined);
    const keys = backend.rpc.mock.calls.map((call: unknown[]) => keyOf(call[1]));
    expect(keys.slice(0, 2)).toEqual(['draft-key-1', 'draft-key-1']);
    expect(keys[2]).toMatch(/^00000000-0000-4000-8000-/);
    expect(keys[3]).toMatch(/^00000000-0000-4000-8000-/);
    expect(keys[3]).not.toBe(keys[2]);
  });
  it('loads the signed-in committee member caseload and leaves their own worker issue off the desk', async () => {
    expect(await loadStewardCaseload('')).toEqual({ rows: [], total: 0, nextCursor: null });
    expect(backend.queries).toHaveLength(0);
    backend.results.push({
      data: [
        { id: 'c1', reference: 'C-1', title: 'Schedule', case_type: 'grievance', step: 'filed', status: 'active', updated_at: '2026-01-02T00:00:00Z' },
        { id: 'c2', reference: 'C-2', title: ' ', case_type: 'fmla', step: 'open', status: 'resolved', updated_at: '2026-01-01T00:00:00Z' },
      ],
      error: null,
      count: 2,
    });
    const rows = await loadStewardCaseload('steward-1');
    expect(rows).toEqual({
      rows: [
        { id: 'c1', reference: 'C-1', title: 'Schedule', status: 'active' },
        { id: 'c2', reference: 'C-2', title: 'fmla · open', status: 'resolved' },
      ],
      total: 2,
      nextCursor: null,
    });
    expect(backend.queries[0]?.table).toBe('member_cases');
    expect(backend.queries[0]?.calls).toContainEqual(['eq', ['steward_user_id', 'steward-1']]);
    expect(backend.queries[0]?.calls).toContainEqual(['neq', ['user_id', 'steward-1']]);
    backend.results.push({ data: null, error: { message: 'denied' } });
    await expect(loadStewardCaseload('steward-1')).rejects.toThrow('Your caseload did not load. Try again.');
  });

  it('maps worker requests and acknowledges or closes one', async () => {
    backend.rpc.mockResolvedValueOnce({
      data: [
        { id: 'r1', member_name: 'Ada', lesson_id: 'L1', status: 'requested', created_at: '2026-11-18T15:47:10Z' },
        { id: 'r2', member_name: '', lesson_id: '', status: 'closed' },
      ],
      error: null,
    });
    backend.results.push({ data: [{ id: 'L1', label: 'Overtime' }], error: null });
    const rows = await loadStewardRequests();
    expect(backend.rpc).toHaveBeenCalledWith('list_steward_requests', {
      p_status: 'all', p_search: null, p_sort: 'newest', p_after_created: null, p_after_id: null, p_limit: 50,
    });
    expect(rows).toEqual({
      rows: [
        { id: 'r1', memberName: 'Ada', topic: 'Overtime', status: 'requested', createdAt: '2026-11-18T15:47:10Z' },
        { id: 'r2', memberName: 'Worker', topic: '', status: 'closed', createdAt: null },
      ],
      total: null,
      nextCursor: null,
    });
    expect(backend.queries[0]?.table).toBe('member_rights_lessons');
    backend.rpc.mockResolvedValueOnce({ data: null, error: null });
    await triageStewardRequest(businessWriter, 'r1', 'acknowledge');
    expect(backend.rpc).toHaveBeenCalledWith('triage_steward_request', { p_request_id: 'r1', p_action: 'acknowledge' });
    backend.rpc.mockResolvedValueOnce({ data: null, error: { message: 'no' } });
    await expect(triageStewardRequest(businessWriter, 'r1', 'close')).rejects.toThrow('That request was not closed. Try again.');
  });

  it('keeps forms that still need review and refuses a return with no note', async () => {
    backend.rpc.mockResolvedValueOnce({
      data: [
        { id: 'f1', user_id: 'u1', member_name: 'Bea', template_key: 'fmla_self', status: 'submitted' },
        { id: 'f2', user_id: 'u2', member_name: 'Cy', template_key: 'draft_form', status: 'draft' },
        { id: 'f3', user_id: 'u3', member_name: '', template_key: '', status: 'in_review' },
      ],
      error: null,
    });
    const forms = await loadStewardFormsForReview();
    expect(forms.rows.map((form) => form.id)).toEqual(['f1', 'f3']);
    expect(forms.total).toBeNull();
    expect(forms.nextCursor).toBeNull();
    expect(forms.rows[0]).toMatchObject({ memberName: 'Bea', userID: 'u1', templateKey: 'fmla_self', templateLabel: 'FMLA · my own health', status: 'submitted' });
    expect(forms.rows[0]?.answers).toEqual({});
    await expect(reviewStewardForm(businessWriter, 'f1', 'return', '  ')).rejects.toThrow('A return needs a note.');
    expect(backend.rpc).toHaveBeenCalledTimes(1);
    backend.rpc.mockResolvedValue({ data: null, error: null });
    await reviewStewardForm(businessWriter, 'f1', 'start', '');
    expect(backend.rpc).toHaveBeenCalledWith('steward_start_review', { p_form_id: 'f1' });
    const shown = { answers: { summary: 'Posted schedule' }, attachmentIds: ['file-1'], cosignerIds: [] };
    await reviewStewardForm(businessWriter, 'f1', 'approve', ' ok ', shown);
    expect(backend.rpc).toHaveBeenCalledWith('approve_form', { p_form_id: 'f1', p_note: 'ok', p_expected: shown });
    await reviewStewardForm(businessWriter, 'f1', 'return', 'send back');
    expect(backend.rpc).toHaveBeenCalledWith('return_form', { p_form_id: 'f1', p_note: 'send back' });
  });

  it('approves only what the committee member was shown, and never without it (#8728)', async () => {
    await expect(reviewStewardForm(businessWriter, 'f1', 'approve', '')).rejects.toThrow('That form was not updated. Try again.');
    expect(backend.rpc).not.toHaveBeenCalled();

    backend.rpc.mockResolvedValue({ data: null, error: null });
    const sealed = { dataVersion: 'v7', attachmentIds: ['file-1'], cosignerIds: ['cosigner-1'] };
    await reviewStewardForm(businessWriter, 'f1', 'approve', '', sealed);
    expect(backend.rpc).toHaveBeenCalledTimes(1);
    expect(backend.rpc).toHaveBeenCalledWith('approve_form', { p_form_id: 'f1', p_note: null, p_expected: sealed });
  });

  it('approves nothing and does not retry when the filing changed since the review (#8728)', async () => {
    backend.rpc.mockResolvedValue({ data: null, error: { code: 'PT409', details: 'form_changed_since_review', message: 'form changed since review' }, status: 409 });
    const shown = { answers: { summary: 'Posted schedule' }, attachmentIds: [], cosignerIds: [] };
    await expect(reviewStewardForm(businessWriter, 'f1', 'approve', 'ok', shown)).rejects.toBeInstanceOf(StewardFormChangedError);
    expect(backend.rpc).toHaveBeenCalledTimes(1);

    backend.rpc.mockReset().mockResolvedValue({ data: null, error: { code: '22023', message: 'form not found, not reviewable, or your own' }, status: 400 });
    await expect(reviewStewardForm(businessWriter, 'f1', 'approve', 'ok', shown)).rejects.toThrow('That form was not updated. Try again.');
    expect(backend.rpc).toHaveBeenCalledTimes(1);
  });

  it('names a return refused because the worker has a draft of the form open (#9158)', async () => {
    backend.rpc.mockResolvedValue({ data: null, error: { code: '23505', details: '', message: 'worker already has an active draft of this template; approve instead or ask them to finish it' }, status: 409 });
    await expect(reviewStewardForm(businessWriter, 'f1', 'return', 'send back')).rejects.toBeInstanceOf(StewardFormReturnBlockedError);
    expect(backend.rpc).toHaveBeenCalledTimes(1);

    backend.rpc.mockReset().mockResolvedValue({ data: null, error: { code: '22023', details: '', message: 'form not found, not reviewable, or your own' }, status: 400 });
    await expect(reviewStewardForm(businessWriter, 'f1', 'return', 'send back')).rejects.toThrow('That form was not updated. Try again.');
  });

  // #8960: an approval is sent once, with what the steward was shown; a
  // missing function is a failed approval, never one without the expectation.
  it('never resends an approval without the expectation', async () => {
    backend.rpc
      .mockResolvedValueOnce({ data: null, error: { code: 'PGRST202', message: 'Could not find the function' }, status: 404 })
      .mockResolvedValue({ data: null, error: null });
    const shown = { answers: {}, attachmentIds: [], cosignerIds: [] };
    await expect(reviewStewardForm(businessWriter, 'f1', 'approve', 'ok', shown)).rejects.toThrow('That form was not updated. Try again.');
    expect(backend.rpc.mock.calls).toEqual([
      ['approve_form', { p_form_id: 'f1', p_note: 'ok', p_expected: shown }],
    ]);
  });

  it('sends a campaign broadcast and lists the ones already sent', async () => {
    await expect(sendChapterBroadcast(businessWriter, '  ', 'hello', undefined, 'en')).rejects.toThrow('A broadcast needs a title and a message.');
    expect(backend.rpc).not.toHaveBeenCalled();
    backend.rpc.mockResolvedValueOnce({ data: null, error: null });
    await sendChapterBroadcast(businessWriter, ' Hello ', ' Campaign ', { value: 'chapter', kind: 'chapter', chapterId: 'chapter-a', name: '' }, 'en');
    expect(backend.rpc).toHaveBeenCalledWith('publish_chapter_office_notice', {
      p_title: 'Hello',
      p_body: 'Campaign',
      p_locale: 'en',
      p_chapter: 'chapter-a', p_unit: null, p_committee: null, p_idempotency_key: expect.any(String),
    });
    backend.rpc.mockResolvedValueOnce({
      data: [
        { id: 'b1', title: 'Meet', published_at: '2025-12-30T15:00:00+00:00', retracted_at: '2026-01-01' },
        { id: 'b2', title: 'Open', published_at: null, retracted_at: null },
      ],
      error: null,
    });
    // #9609: the row keeps when it was sent, so two notices with one title
    // can be told apart on the phone.
    expect(await loadStewardBroadcasts()).toEqual({
      rows: [
        { id: 'b1', title: 'Meet', publishedAt: '2025-12-30T15:00:00+00:00', retracted: true },
        { id: 'b2', title: 'Open', publishedAt: null, retracted: false },
      ],
      total: null,
      nextCursor: null,
    });
    backend.configured = false;
    await expect(loadStewardBroadcasts()).rejects.toThrow('The secure mobile backend is not configured.');
  });
});

function stamp(seconds: number): string {
  return new Date(Date.UTC(2026, 0, 1, 0, 0, seconds)).toISOString();
}

// #9099 part 2: a send the server refused is known not to have published; a
// send with no answer may have, so the composer keeps it unconfirmed.
describe('notice sends whose answer may be lost', () => {
  const chapter: NoticeAudience = { value: 'chapter', kind: 'chapter', chapterId: 'chapter-a', name: '' };

  it('marks a refusal the server answered, and not a failure with no answer', async () => {
    backend.rpc.mockResolvedValueOnce({ data: null, error: { code: '54000', message: 'broadcast limit reached' } });
    await expect(sendChapterBroadcast(businessWriter, 'Title', 'Body', chapter, 'en')).rejects.toMatchObject({ message: 'The broadcast was not sent. Try again.', serverAnswered: true });
    backend.rpc.mockResolvedValueOnce({ data: null, error: { code: '', message: 'TypeError: Network request failed' } });
    await expect(sendChapterBroadcast(businessWriter, 'Title', 'Body', chapter, 'en')).rejects.toMatchObject({ serverAnswered: false });
    backend.rpc.mockRejectedValueOnce(new TypeError('Network request failed'));
    await expect(sendChapterBroadcast(businessWriter, 'Title', 'Body', chapter, 'en')).rejects.toMatchObject({ serverAnswered: false });
  });

  // Ledger 619: a publish that never answers ends at the shared deadline as a
  // send with no answer, so the composer can hold it unconfirmed.
  it('ends a publish that never answers at the deadline, as a send with no server answer', async () => {
    vi.useFakeTimers();
    try {
      backend.rpc.mockReturnValueOnce(new Promise(() => undefined));
      const sent = sendChapterBroadcast(businessWriter, 'Title', 'Body', chapter, 'en', 'draft-key-619');
      const settled = expect(sent).rejects.toMatchObject({ message: 'The broadcast was not sent. Try again.', serverAnswered: false, cause: { name: 'TimeoutError' } });
      await vi.advanceTimersByTimeAsync(19_999);
      expect(backend.rpc).toHaveBeenCalledWith('publish_chapter_office_notice', expect.objectContaining({ p_idempotency_key: 'draft-key-619' }));
      await vi.advanceTimersByTimeAsync(1);
      await settled;
    } finally {
      vi.useRealTimers();
    }
  });

});

describe('committee member desk section pages', () => {
  it('walks past 100 issues and opens the last one from the next page', async () => {
    const first = Array.from({ length: 100 }, (_, index) => ({
      id: `case-${index + 1}`,
      reference: `C-${index + 1}`,
      title: `Issue ${index + 1}`,
      status: 'active',
      updated_at: stamp(1000 - index),
    }));
    const last = { id: 'case-101', reference: 'C-101', title: 'Final issue', status: 'active', updated_at: stamp(1) };
    backend.results.push({ data: first, error: null, count: 101 });
    const page = await loadStewardCaseload('steward-1');
    expect(page.rows).toHaveLength(100);
    expect(page.total).toBe(101);
    expect(page.nextCursor).toEqual({ updatedAt: first[99]?.updated_at, id: 'case-100' });
    expect(backend.queries[0]?.calls).toContainEqual(['limit', [100]]);
    expect(backend.queries[0]?.calls.some(([name]) => name === 'or')).toBe(false);
    backend.results.push({ data: [last], error: null, count: 1 });
    const rest = await loadStewardCaseload('steward-1', page.nextCursor);
    expect(rest.rows).toEqual([{ id: 'case-101', reference: 'C-101', title: 'Final issue', status: 'active' }]);
    expect(rest.total).toBeNull();
    expect(rest.nextCursor).toBeNull();
    const seen = new Set([...page.rows, ...rest.rows].map((row) => row.id));
    expect(seen.size).toBe(101);
    expect(seen.has('case-1')).toBe(true);
    expect(seen.has('case-101')).toBe(true);
    const filter = backend.queries[1]?.calls.find(([name]) => name === 'or')?.[1][0];
    expect(filter).toContain('case-100');
    expect(filter).toContain(first[99]?.updated_at);
    expect(backend.queries[1]?.calls).toContainEqual(['limit', [100]]);
  });

  it('keeps a +00:00 issue stamp in the keyset as a Zulu time', async () => {
    backend.results.push({
      data: Array.from({ length: 100 }, (_, index) => ({
        id: `case-${index + 1}`, reference: `C-${index + 1}`, title: `Issue ${index + 1}`, status: 'active',
        updated_at: index === 99 ? '2026-03-01T15:04:05+00:00' : stamp(1000 - index),
      })),
      error: null,
      count: 101,
    });
    const page = await loadStewardCaseload('steward-1');
    backend.results.push({ data: [], error: null });
    await loadStewardCaseload('steward-1', page.nextCursor);
    const filter = String(backend.queries[1]?.calls.find(([name]) => name === 'or')?.[1][0]);
    expect(filter).toContain('2026-03-01T15:04:05.000Z');
    expect(filter).not.toContain('+');
  });

  it('walks past 50 requests and keeps the last request for acknowledge', async () => {
    const first = Array.from({ length: 50 }, (_, index) => ({
      id: `request-${index + 1}`, member_name: `Worker ${index + 1}`, lesson_id: '', status: 'acknowledged',
      created_at: stamp(500 - index), total_count: 51,
    }));
    backend.rpc.mockResolvedValueOnce({ data: first, error: null });
    const page = await loadStewardRequests();
    expect(page.rows).toHaveLength(50);
    expect(page.total).toBe(51);
    expect(page.nextCursor).toEqual({ createdAt: first[49]?.created_at, id: 'request-50' });
    backend.rpc.mockResolvedValueOnce({
      data: [{ id: 'request-51', member_name: 'Final worker', lesson_id: '', status: 'requested', created_at: stamp(1), total_count: 51 }],
      error: null,
    });
    const rest = await loadStewardRequests(page.nextCursor);
    expect(rest.rows).toEqual([{ id: 'request-51', memberName: 'Final worker', topic: '', status: 'requested', createdAt: stamp(1) }]);
    expect(backend.rpc).toHaveBeenLastCalledWith('list_steward_requests', {
      p_status: 'all', p_search: null, p_sort: 'newest',
      p_after_created: first[49]?.created_at, p_after_id: 'request-50', p_limit: 50,
    });
    const seen = new Set([...page.rows, ...rest.rows].map((row) => row.id));
    expect(seen.size).toBe(51);
    expect(rest.nextCursor).toBeNull();
  });

  it('walks past 50 forms, using the raw cursor when the last row is not reviewable', async () => {
    const first = Array.from({ length: 50 }, (_, index) => ({
      id: `form-${index + 1}`,
      user_id: `user-${index + 1}`,
      member_name: `Person ${index + 1}`,
      template_key: 'grievance',
      status: index === 49 ? 'draft' : 'submitted',
      submitted_at: stamp(index),
      total_count: 51,
    }));
    backend.rpc.mockResolvedValueOnce({ data: first, error: null });
    const page = await loadStewardFormsForReview();
    expect(page.rows.map((row) => row.id)).not.toContain('form-50');
    expect(page.rows).toHaveLength(49);
    expect(page.nextCursor).toEqual({ submittedAt: first[49]?.submitted_at, id: 'form-50' });
    expect(page.total).toBe(51);
    backend.rpc.mockResolvedValueOnce({
      data: [{
        id: 'form-51', user_id: 'user-51', member_name: 'Final person', template_key: 'grievance',
        status: 'submitted', submitted_at: stamp(50), total_count: 51,
      }],
      error: null,
    });
    const rest = await loadStewardFormsForReview(page.nextCursor);
    expect(rest.rows.map((row) => row.id)).toEqual(['form-51']);
    expect(backend.rpc).toHaveBeenLastCalledWith('list_steward_forms', {
      p_status: 'all', p_search: null, p_sort: 'oldest',
      p_after_submitted: first[49]?.submitted_at, p_after_id: 'form-50', p_limit: 50,
    });
    const seen = new Set([...page.rows, ...rest.rows].map((row) => row.id));
    expect(seen.size).toBe(50);
    expect(seen.has('form-1')).toBe(true);
    expect(seen.has('form-51')).toBe(true);
    expect(rest.nextCursor).toBeNull();
  });

  it('walks past 20 broadcasts and returns the last one', async () => {
    const first = Array.from({ length: 20 }, (_, index) => ({
      id: `broadcast-${index + 1}`, title: `Notice ${index + 1}`, retracted_at: null,
      published_at: stamp(200 - index), total_count: 21,
    }));
    backend.rpc.mockResolvedValueOnce({ data: first, error: null });
    const page = await loadStewardBroadcasts();
    expect(page.rows).toHaveLength(20);
    expect(page.total).toBe(21);
    expect(page.nextCursor).toEqual({ publishedAt: first[19]?.published_at, id: 'broadcast-20' });
    backend.rpc.mockResolvedValueOnce({
      data: [{ id: 'broadcast-21', title: 'Final notice', retracted_at: null, published_at: stamp(1), total_count: 21 }],
      error: null,
    });
    const rest = await loadStewardBroadcasts(page.nextCursor);
    expect(rest.rows).toEqual([{ id: 'broadcast-21', title: 'Final notice', publishedAt: stamp(1), retracted: false }]);
    expect(backend.rpc).toHaveBeenLastCalledWith('list_steward_broadcasts', {
      p_filter: 'all', p_search: null,
      p_after_published: first[19]?.published_at, p_after_id: 'broadcast-20', p_limit: 20,
    });
    const seen = new Set([...page.rows, ...rest.rows].map((row) => row.id));
    expect(seen.size).toBe(21);
    expect(rest.nextCursor).toBeNull();
  });

  it('keeps an empty later page from pretending the total is zero', async () => {
    backend.rpc.mockResolvedValueOnce({ data: [], error: null });
    const page = await loadStewardRequests({ createdAt: stamp(1), id: 'request-50' });
    expect(page).toEqual({ rows: [], total: null, nextCursor: null });
  });
});
