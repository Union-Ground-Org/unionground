import type { Session } from '@supabase/supabase-js';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const captured = vi.hoisted(() => ({ create: vi.fn() }));
vi.mock('./supabase', () => ({ createCapturedSessionRpcClient: captured.create }));

import { LEARNING_EDITABLE_FIELDS, LearningContractError, emptyLearningDraftForm, learningDraftFormFromItem, normalizeLearningItem, type LearningItem } from '../lib/learningContentModel';
import {
  LearningRequestError,
  LearningValidationError,
  createLearningContentApi,
  learningApiForSession,
  learningFailureKind,
} from './learningContent';

const ID = 'a1b2c3d4-0000-4000-8000-000000000001';
const NOW = Date.UTC(2026, 8, 29, 12, 0, 0);

function row(patch: Record<string, unknown> = {}) {
  return {
    id: ID, scope: 'chapter', organization_id: 'org-a', chapter_id: 'chapter-a', kind: 'quote', locale: 'en', locale_state: 'reviewed',
    title: 'Showing up', body: 'Solidarity is a practice.', attribution: 'Dana Whitfield', source: 'Campaign minutes', rights_note: 'Own words',
    review_note: 'Reviewed', bullets: [], direction: '', topics: [], audience: 'all', tone: '', learning_outcome: '', factual_claims: false,
    priority: 0, is_default: false, status: 'draft', starts_at: null, ends_at: null, revision: 2, provenance: {}, ...patch,
  };
}

function savedItem(patch: Record<string, unknown> = {}): LearningItem {
  const item = normalizeLearningItem(row(patch));
  if (!item) throw new Error('fixture did not normalize');
  return item;
}

const policyRow = { organizationId: 'org-a', chapterId: 'chapter-a', quotesEnabled: true, lessonsEnabled: true, homeHidden: false, canManage: true, isPlatformOwner: false, version: '3:1:0:false' };

function session(token: string): Session {
  return {
    access_token: token,
    refresh_token: `redacted-refresh-${token}`,
    expires_in: 3_600,
    token_type: 'bearer',
    user: { id: 'user-a', app_metadata: {}, user_metadata: {}, aud: 'authenticated', created_at: '2026-09-28T12:00:00.000Z' },
  };
}

function fakeClient(data: unknown, error: unknown = null) {
  return { rpc: vi.fn(async (_name: string, _args: Record<string, unknown>) => ({ data, error })) };
}

beforeEach(() => {
  captured.create.mockReset();
});

describe('learning policy', () => {
  it('asks for the selected campaign and returns the verified policy', async () => {
    const client = fakeClient(policyRow);
    await expect(createLearningContentApi(client).getPolicy('chapter-a')).resolves.toMatchObject({ quotesEnabled: true, version: '3:1:0:false' });
    expect(client.rpc).toHaveBeenCalledWith('get_learning_policy', { p_chapter_id: 'chapter-a' });
  });

  it('fails closed on another campaign, a malformed flag, or a refusal', async () => {
    await expect(createLearningContentApi(fakeClient({ ...policyRow, chapterId: 'chapter-b' })).getPolicy('chapter-a')).rejects.toBeInstanceOf(LearningContractError);
    await expect(createLearningContentApi(fakeClient({ ...policyRow, homeHidden: 'false' })).getPolicy('chapter-a')).rejects.toBeInstanceOf(LearningContractError);
    const refused = createLearningContentApi(fakeClient(null, { code: '42501', message: 'mfa required' })).getPolicy('chapter-a');
    await expect(refused).rejects.toMatchObject({ kind: 'forbidden' });
  });
});

describe('worker delivery reads', () => {
  it('sends the exact bounded list query', async () => {
    const client = fakeClient({ items: [], hasMore: false });
    const api = createLearningContentApi(client);
    await api.listContent({ chapterId: 'chapter-a', locale: 'es', kind: null, offset: 0, limit: 100 });
    await api.listContent({ chapterId: 'chapter-a', locale: 'es', kind: 'mini_lesson', offset: 40, limit: 40 });
    expect(client.rpc.mock.calls).toEqual([
      ['list_learning_content', { p_chapter_id: 'chapter-a', p_locale: 'es', p_kind: null, p_offset: 0, p_limit: 100 }],
      ['list_learning_content', { p_chapter_id: 'chapter-a', p_locale: 'es', p_kind: 'mini_lesson', p_offset: 40, p_limit: 40 }],
    ]);
  });

  it('refuses an unbounded query before any request', async () => {
    const client = fakeClient({ items: [], hasMore: false });
    const api = createLearningContentApi(client);
    await expect(api.listContent({ chapterId: 'chapter-a', locale: 'en', kind: null, offset: 0, limit: 101 })).rejects.toBeInstanceOf(LearningRequestError);
    await expect(api.listContent({ chapterId: 'chapter-a', locale: 'en', kind: null, offset: -1, limit: 40 })).rejects.toBeInstanceOf(LearningRequestError);
    await expect(api.listContent({ chapterId: 'chapter-a', locale: 'en', kind: null, offset: 10_001, limit: 40 })).rejects.toBeInstanceOf(LearningRequestError);
    expect(client.rpc).not.toHaveBeenCalled();
  });

  it('never hands a Spanish reader English content or another kind', async () => {
    const english = row({ status: 'published', starts_at: '2026-09-01T00:00:00Z' });
    const spanish = row({ id: 'a1b2c3d4-0000-4000-8000-000000000002', locale: 'es', status: 'published', starts_at: '2026-09-01T00:00:00Z' });
    const lesson = row({ id: 'a1b2c3d4-0000-4000-8000-000000000003', locale: 'es', kind: 'mini_lesson', status: 'published', starts_at: '2026-09-01T00:00:00Z' });
    const api = createLearningContentApi(fakeClient({ items: [english, spanish, lesson], hasMore: false }));
    const page = await api.listContent({ chapterId: 'chapter-a', locale: 'es', kind: 'quote', offset: 0, limit: 100 });
    expect(page.items.map((item) => item.id)).toEqual([spanish.id]);
  });

  it('refuses a page larger than it asked for', async () => {
    const items = Array.from({ length: 41 }, (_, index) => row({ id: `a1b2c3d4-0000-4000-8000-${String(index).padStart(12, '0')}` }));
    await expect(createLearningContentApi(fakeClient({ items, hasMore: true })).listContent({ chapterId: 'chapter-a', locale: 'en', kind: 'mini_lesson', offset: 0, limit: 40 }))
      .rejects.toBeInstanceOf(LearningContractError);
  });
});

describe('manager reads', () => {
  it('reads choices and the workspace for the exact scope', async () => {
    const client = fakeClient({ items: [row()], hasMore: false, policy: { quotes_enabled: true, lessons_enabled: false, selected_ids: null }, canManage: true, isPlatformOwner: false });
    const api = createLearningContentApi(client);
    await api.listChoices({ chapterId: 'chapter-a', scope: 'organization', offset: 40 });
    const workspace = await api.getWorkspace({ chapterId: 'chapter-a', scope: 'chapter', offset: 0 });
    expect(workspace.policy).toMatchObject({ quotesEnabled: true, lessonsEnabled: false, selectedIds: null });
    expect(client.rpc.mock.calls).toEqual([
      ['list_learning_choices', { p_chapter_id: 'chapter-a', p_scope: 'organization', p_offset: 40 }],
      ['get_learning_workspace', { p_chapter_id: 'chapter-a', p_scope: 'chapter', p_offset: 0 }],
    ]);
  });

  it('refuses a workspace that includes another scope or cannot be managed', async () => {
    const policy = { quotes_enabled: true, lessons_enabled: true, selected_ids: null };
    await expect(createLearningContentApi(fakeClient({ items: [row({ scope: 'organization', chapter_id: null })], hasMore: false, policy, canManage: true, isPlatformOwner: false }))
      .getWorkspace({ chapterId: 'chapter-a', scope: 'chapter', offset: 0 })).rejects.toBeInstanceOf(LearningContractError);
    await expect(createLearningContentApi(fakeClient({ items: [], hasMore: false, policy, canManage: false, isPlatformOwner: false }))
      .getWorkspace({ chapterId: 'chapter-a', scope: 'chapter', offset: 0 })).rejects.toBeInstanceOf(LearningContractError);
  });
});

describe('policy writes', () => {
  it('sends null to inherit, [] for none, and a de-duplicated list to narrow', async () => {
    const client = fakeClient({ quotes_enabled: false, lessons_enabled: true, selected_ids: [ID], revision: 4 });
    const api = createLearningContentApi(client);
    await api.savePolicy({ expectedRevision: 0, chapterId: 'chapter-a', scope: 'chapter', quotesEnabled: false, lessonsEnabled: true, selectedIds: [ID, ID] });
    expect(client.rpc).toHaveBeenCalledWith('save_learning_policy', { p_chapter_id: 'chapter-a', p_scope: 'chapter', p_quotes_enabled: false, p_lessons_enabled: true, p_selected_ids: [ID], p_expected_revision: 0 });
  });

  it('refuses a platform selection or more than 500 ids before any request', async () => {
    const client = fakeClient({ quotes_enabled: true, lessons_enabled: true, selected_ids: null });
    const api = createLearningContentApi(client);
    await expect(api.savePolicy({ expectedRevision: 0, chapterId: 'chapter-a', scope: 'platform', quotesEnabled: true, lessonsEnabled: true, selectedIds: [] })).rejects.toBeInstanceOf(LearningRequestError);
    const many = Array.from({ length: 501 }, (_, index) => `a1b2c3d4-0000-4000-8000-${String(index).padStart(12, '0')}`);
    await expect(api.savePolicy({ expectedRevision: 0, chapterId: 'chapter-a', scope: 'organization', quotesEnabled: true, lessonsEnabled: true, selectedIds: many })).rejects.toBeInstanceOf(LearningRequestError);
    expect(client.rpc).not.toHaveBeenCalled();
  });

  it('refuses a saved policy that does not match the switches it sent', async () => {
    await expect(createLearningContentApi(fakeClient({ quotes_enabled: true, lessons_enabled: true, selected_ids: null }))
      .savePolicy({ expectedRevision: 0, chapterId: 'chapter-a', scope: 'chapter', quotesEnabled: false, lessonsEnabled: true, selectedIds: null })).rejects.toBeInstanceOf(LearningContractError);
  });
});

describe('content writes', () => {
  it('refuses an invalid draft locally, before any request', async () => {
    const client = fakeClient(row());
    const draft = { ...emptyLearningDraftForm('quote', 'en', 'chapter'), title: 'x'.repeat(101), body: 'Body' };
    await expect(createLearningContentApi(client).saveContent({ chapterId: 'chapter-a', form: draft })).rejects.toBeInstanceOf(LearningValidationError);
    expect(client.rpc).not.toHaveBeenCalled();
  });

  it('creates with only the editable fields and no expected revision', async () => {
    const client = fakeClient(row({ revision: 1 }));
    const draft = { ...emptyLearningDraftForm('quote', 'en', 'chapter'), title: 'Showing up', body: 'Solidarity is a practice.' };
    await createLearningContentApi(client).saveContent({ chapterId: 'chapter-a', form: draft });
    const [name, args] = client.rpc.mock.calls[0] ?? [];
    expect(name).toBe('save_learning_content');
    expect(args).toMatchObject({ p_chapter_id: 'chapter-a', p_scope: 'chapter', p_expected_revision: null });
    expect(Object.keys((args as { p_item: Record<string, unknown> }).p_item).sort()).toEqual([...LEARNING_EDITABLE_FIELDS].sort());
  });

  it('updates with the id and the exact revision, and accepts only a returned draft', async () => {
    const client = fakeClient(row({ revision: 3 }));
    const draft = learningDraftFormFromItem(savedItem({ status: 'published', starts_at: '2026-09-01T00:00:00Z' }));
    await createLearningContentApi(client).saveContent({ chapterId: 'chapter-a', form: draft });
    expect(client.rpc.mock.calls[0]?.[1]).toMatchObject({ p_expected_revision: 2, p_item: { id: ID } });
    const published = fakeClient(row({ status: 'published', starts_at: '2026-09-01T00:00:00Z', revision: 3 }));
    await expect(createLearningContentApi(published).saveContent({ chapterId: 'chapter-a', form: draft })).rejects.toBeInstanceOf(LearningContractError);
  });

  it('reports a stale revision as a conflict', async () => {
    const draft = learningDraftFormFromItem(savedItem());
    const failure = await createLearningContentApi(fakeClient(null, { code: 'PT409', message: 'revision conflict' }))
      .saveContent({ chapterId: 'chapter-a', form: draft }).catch((error: unknown) => error);
    expect(learningFailureKind(failure)).toBe('conflict');
  });
});

describe('publication transitions', () => {
  const later = new Date(NOW + 86_400_000);
  const muchLater = new Date(NOW + 2 * 86_400_000);

  it('publishes now without a start, schedules with an ISO start, and withdraws without dates', async () => {
    const client = { rpc: vi.fn(async (_name: string, args: Record<string, unknown>) => ({
      data: row({ status: args.p_action === 'publish' ? 'published' : args.p_action === 'schedule' ? 'scheduled' : 'withdrawn', starts_at: args.p_action === 'withdraw' ? null : '2026-09-30T12:00:00Z', revision: 3 }),
      error: null,
    })) };
    const api = createLearningContentApi(client, () => NOW);
    await api.transition({ chapterId: 'chapter-a', id: ID, action: 'publish', expectedRevision: 2, startsAt: later, endsAt: muchLater });
    await api.transition({ chapterId: 'chapter-a', id: ID, action: 'schedule', expectedRevision: 2, startsAt: later, endsAt: null });
    await api.transition({ chapterId: 'chapter-a', id: ID, action: 'withdraw', expectedRevision: 2, startsAt: later, endsAt: muchLater });
    expect(client.rpc.mock.calls.map((call) => call[1])).toEqual([
      { p_chapter_id: 'chapter-a', p_id: ID, p_action: 'publish', p_expected_revision: 2, p_starts_at: null, p_ends_at: muchLater.toISOString() },
      { p_chapter_id: 'chapter-a', p_id: ID, p_action: 'schedule', p_expected_revision: 2, p_starts_at: later.toISOString(), p_ends_at: null },
      { p_chapter_id: 'chapter-a', p_id: ID, p_action: 'withdraw', p_expected_revision: 2, p_starts_at: null, p_ends_at: null },
    ]);
  });

  it('refuses a past schedule, a missing start, or an end before the start locally', async () => {
    const client = fakeClient(row());
    const api = createLearningContentApi(client, () => NOW);
    await expect(api.transition({ chapterId: 'chapter-a', id: ID, action: 'schedule', expectedRevision: 2, startsAt: new Date(NOW - 1000), endsAt: null })).rejects.toBeInstanceOf(LearningValidationError);
    await expect(api.transition({ chapterId: 'chapter-a', id: ID, action: 'schedule', expectedRevision: 2, startsAt: null, endsAt: null })).rejects.toBeInstanceOf(LearningValidationError);
    await expect(api.transition({ chapterId: 'chapter-a', id: ID, action: 'schedule', expectedRevision: 2, startsAt: muchLater, endsAt: later })).rejects.toBeInstanceOf(LearningValidationError);
    await expect(api.transition({ chapterId: 'chapter-a', id: ID, action: 'publish', expectedRevision: 2, startsAt: null, endsAt: new Date(NOW - 1) })).rejects.toBeInstanceOf(LearningValidationError);
    expect(client.rpc).not.toHaveBeenCalled();
  });

  it('refuses an answer in the wrong state or without a new revision', async () => {
    const api = createLearningContentApi(fakeClient(row({ status: 'draft', revision: 3 })), () => NOW);
    await expect(api.transition({ chapterId: 'chapter-a', id: ID, action: 'withdraw', expectedRevision: 2, startsAt: null, endsAt: null })).rejects.toBeInstanceOf(LearningContractError);
    const stale = createLearningContentApi(fakeClient(row({ status: 'withdrawn', revision: 2 })), () => NOW);
    await expect(stale.transition({ chapterId: 'chapter-a', id: ID, action: 'withdraw', expectedRevision: 2, startsAt: null, endsAt: null })).rejects.toBeInstanceOf(LearningContractError);
  });
});

describe('history and Home preference', () => {
  it('reads forty history rows at an offset and keeps the snapshot', async () => {
    const client = fakeClient({ items: [{ revision: 3, action: 'publish', changed_at: '2026-09-29T01:02:03.456789+00:00', changed_by: 'user-a', snapshot: { title: 'Showing up' } }], hasMore: true });
    const page = await createLearningContentApi(client).getHistory({ chapterId: 'chapter-a', id: ID, offset: 40 });
    expect(client.rpc).toHaveBeenCalledWith('get_learning_history', { p_chapter_id: 'chapter-a', p_id: ID, p_offset: 40 });
    expect(page).toMatchObject({ hasMore: true, items: [{ revision: 3, action: 'publish', changedBy: 'user-a', snapshot: { title: 'Showing up' } }] });
  });

  it('stores the worker Home preference durably and verifies the answer', async () => {
    const client = fakeClient({ homeHidden: true });
    await expect(createLearningContentApi(client).setHomeHidden({ chapterId: 'chapter-a', hidden: true })).resolves.toBe(true);
    expect(client.rpc).toHaveBeenCalledWith('set_learning_home_hidden', { p_chapter_id: 'chapter-a', p_hidden: true });
    await expect(createLearningContentApi(fakeClient({ homeHidden: true })).setHomeHidden({ chapterId: 'chapter-a', hidden: false })).rejects.toBeInstanceOf(LearningContractError);
  });
});

describe('captured-session client', () => {
  it('binds each Session object to its own captured JWT client, once', async () => {
    const first = session('token-a');
    const second = session('token-b');
    const rpcA = vi.fn(async () => ({ data: policyRow, error: null }));
    const rpcB = vi.fn(async () => ({ data: policyRow, error: null }));
    captured.create.mockImplementation((session: Session) => ({ rpc: session === first ? rpcA : rpcB }));
    const api = learningApiForSession(first);
    expect(learningApiForSession(first)).toBe(api);
    await api.getPolicy('chapter-a');
    await learningApiForSession(second).getPolicy('chapter-a');
    expect(captured.create.mock.calls.map((call) => call[0])).toEqual([first, second]);
    expect(rpcA).toHaveBeenCalledTimes(1);
    expect(rpcB).toHaveBeenCalledTimes(1);
  });
});
