import { stubSessionWriter } from '../testing/stubSessionWriter';
import { getSupabaseClient as protocolTestClient } from './supabase';
const testWriter = stubSessionWriter(protocolTestClient);
import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const backend = vi.hoisted(() => ({ from: vi.fn(), rpc: vi.fn() }));
vi.mock('react-native-url-polyfill/auto', () => ({}));
vi.mock('@supabase/supabase-js', () => ({ createClient: () => backend, processLock: vi.fn() }));
vi.mock('../lib/config', () => ({ mobileConfig: { backendConfigured: true, supabaseUrl: 'http://localhost', supabasePublishableKey: 'test' } }));
vi.mock('../lib/secureSessionStorage', () => ({ createBackendScopedSessionStorage: () => ({}) }));

import { loadConversationSummaries, loadConversationThread, sendStewardReply } from './supabase';
import {
  isStewardRoleRefusal,
  mapStewardDirectConversation,
  nativeDirectAudience,
  projectStewardDirectInbox,
  replaceDirectRows,
  setNativeDirectAudience,
} from './stewardDirectInbox';

// The stub stands in for the server visibility rule. The client must show
// exactly the rows the stub returns and must not add a signed-in-user filter.
const catalog = [
  { id: 'marcus-thread', user_id: 'marcus', organization_id: 'tamarack', chapter_id: 'north', unit_id: 'floor', member_name: 'Marcus Greene', member_initials: 'MG', updated_at: '2026-11-09T15:00:00.000Z', last_body: 'Can you call me?', last_sender_kind: 'member' },
  { id: 'other-org-thread', user_id: 'pat', organization_id: 'other-org', chapter_id: 'north', unit_id: 'floor', member_name: 'Pat Other', member_initials: 'PO', updated_at: '2026-11-09T15:01:00.000Z', last_body: 'Other organization', last_sender_kind: 'member' },
  { id: 'other-chapter-thread', user_id: 'quinn', organization_id: 'tamarack', chapter_id: 'south', unit_id: 'floor', member_name: 'Quinn South', member_initials: 'QS', updated_at: '2026-11-09T15:02:00.000Z', last_body: 'Other campaign', last_sender_kind: 'member' },
  { id: 'other-unit-thread', user_id: 'rory', organization_id: 'tamarack', chapter_id: 'north', unit_id: 'other-unit', member_name: 'Rory Unit', member_initials: 'RU', updated_at: '2026-11-09T15:03:00.000Z', last_body: 'Other unit', last_sender_kind: 'member' },
];

type Scope = { organizationID: string; chapterID: string; unitID: string; steward: boolean; fail: 'other' | null };
let scope: Scope;
let memberUnread: number;
let memberLatest: string;

function visibleCatalog() {
  return catalog.filter((row) => row.organization_id === scope.organizationID && row.chapter_id === scope.chapterID && row.unit_id === scope.unitID);
}

beforeEach(() => {
  setNativeDirectAudience('member');
  scope = { organizationID: 'tamarack', chapterID: 'north', unitID: 'floor', steward: true, fail: null };
  memberUnread = 0;
  memberLatest = 'Can you call me?';
  backend.rpc.mockReset().mockImplementation((name: string) => {
    if (name === 'list_steward_conversations') {
      if (!scope.steward) return Promise.resolve({ data: null, error: { code: '42501', message: 'committee member role required' } });
      if (scope.fail === 'other') return Promise.resolve({ data: null, error: { code: 'XX000', message: 'database detail the phone must not show' } });
      return Promise.resolve({ data: visibleCatalog(), error: null });
    }
    if (name === 'send_steward_reply') {
      memberUnread = 1;
      memberLatest = 'On my way.';
      const marcus = catalog[0]!;
      marcus.last_sender_kind = 'steward';
      marcus.last_body = 'On my way.';
      return Promise.resolve({ data: { ok: true }, error: null });
    }
    return Promise.resolve({ data: { available: true, state: 'active' }, error: null });
  });
  backend.from.mockReset().mockImplementation((table: string) => {
    const filters: [string, unknown][] = [];
    let single = false;
    const builder = {
      select: () => builder,
      eq: (column: string, value: unknown) => { filters.push([column, value]); return builder; },
      order: () => builder,
      limit: () => builder,
      in: () => builder,
      gte: () => builder,
      is: () => builder,
      maybeSingle: () => { single = true; return builder; },
      single: () => { single = true; return builder; },
      then: (resolve: (value: unknown) => unknown) => {
        const userFilter = filters.find(([key]) => key === 'user_id');
        const idFilter = filters.find(([key]) => key === 'id');
        let data: unknown = [];
        if (table === 'member_conversations') {
          const owned = [
            { id: 'dylan-own', user_id: 'dylan', steward_user_id: null, title: 'My committee member', initials: 'MS', created_at: '2026-11-01T00:00:00.000Z', updated_at: '2026-11-08T00:00:00.000Z' },
            { id: 'marcus-thread', user_id: 'marcus', steward_user_id: 'dylan', title: 'Schedule', initials: 'SC', created_at: '2026-11-01T00:00:00.000Z', updated_at: '2026-11-09T15:00:00.000Z' },
          ];
          let rows = owned;
          if (userFilter) rows = rows.filter((row) => row.user_id === userFilter[1]);
          if (idFilter) rows = rows.filter((row) => row.id === idFilter[1]);
          data = single ? rows[0] ?? null : rows;
        } else if (table === 'member_conversation_summaries') {
          data = [
            { conversation_id: 'dylan-own', latest_message: 'Thanks', unread_count: 0 },
            { conversation_id: 'marcus-thread', latest_message: memberLatest, unread_count: memberUnread },
          ];
        } else if (table === 'member_messages') {
          const messages = [
            { id: 'msg-1', user_id: 'marcus', conversation_id: 'marcus-thread', sender_kind: 'member', sender_name: 'Marcus Greene', body: 'Can you call me?', read_at: null, created_at: '2026-11-09T15:00:00.000Z', redacted_at: null },
          ];
          let rows = messages;
          if (userFilter) rows = rows.filter((row) => row.user_id === userFilter[1]);
          if (idFilter) rows = rows.filter((row) => row.id === idFilter[1]);
          data = single ? rows[0] ?? null : rows;
        } else {
          data = single ? null : [];
        }
        return Promise.resolve({ data, error: null }).then(resolve);
      },
    };
    return builder;
  });
});

afterEach(() => {
  setNativeDirectAudience('member');
  catalog[0]!.last_sender_kind = 'member';
  catalog[0]!.last_body = 'Can you call me?';
});

describe('native direct audience', () => {
  it('uses the committee member projection only for an explicit committee member hat or a sole committee member role', () => {
    expect(nativeDirectAudience({ previewHat: 'steward' })).toBe('steward');
    expect(nativeDirectAudience({ previewHat: 'coordinator', authorizedRoles: ['steward'] })).toBe('member');
    expect(nativeDirectAudience({ sampleHat: 'steward' })).toBe('steward');
    expect(nativeDirectAudience({ sampleHat: 'member', authorizedRoles: ['steward'] })).toBe('member');
    expect(nativeDirectAudience({ chosenStaffRole: 'steward', authorizedRoles: ['steward'] })).toBe('steward');
    expect(nativeDirectAudience({ chosenStaffRole: 'coordinator', authorizedRoles: ['coordinator'] })).toBe('member');
    expect(nativeDirectAudience({ authorizedRoles: ['steward'] })).toBe('steward');
    expect(nativeDirectAudience({ authorizedRoles: ['steward', 'admin'] })).toBe('member');
    expect(nativeDirectAudience({ authorizedRoles: [] })).toBe('member');
  });
});

describe('committee member direct rows', () => {
  it('labels the row with the worker and preserves its owner for inbox grouping', () => {
    const row = mapStewardDirectConversation(catalog[0]!);
    expect(row).toMatchObject({ id: 'marcus-thread', ownerUserId: 'marcus', title: 'Marcus Greene', initials: 'MG', unreadCount: 1, latestMessage: 'Can you call me?' });
    expect(row).not.toHaveProperty('counterpartRole');
    expect(mapStewardDirectConversation({ ...catalog[0]!, last_sender_kind: 'steward' })?.unreadCount).toBe(0);
    expect(mapStewardDirectConversation({ id: 'bare', updated_at: '2026-11-09T00:00:00.000Z', member_name: '  ' })?.title).toBe('Worker');
  });

  it('replaces the previous role, campaign and organization rows instead of keeping them', () => {
    const previous = projectStewardDirectInbox([catalog[1]]);
    scope.organizationID = 'tamarack';
    const next = projectStewardDirectInbox(visibleCatalog());
    const replaced = replaceDirectRows(previous, next);
    expect(replaced.map((row) => row.id)).toEqual(['marcus-thread']);
    expect(replaced.some((row) => row.id === 'other-org-thread')).toBe(false);
    expect(isStewardRoleRefusal({ code: '42501' })).toBe(true);
    expect(isStewardRoleRefusal({ code: 'XX000' })).toBe(false);
    expect(isStewardRoleRefusal(new Error('42501'))).toBe(false);
  });
});

describe('committee member direct inbox reads', () => {
  it('keeps a worker read on conversations that worker owns', async () => {
    const rows = await loadConversationSummaries('dylan');
    expect(rows.map((row) => row.id)).toEqual(['dylan-own']);
    expect(rows.some((row) => row.id === 'marcus-thread')).toBe(false);
    expect(backend.rpc).not.toHaveBeenCalledWith('list_steward_conversations', expect.anything());
    expect(backend.from).toHaveBeenCalledWith('member_conversations');
  });

  it('asks the server for the committee member list and shows the authorized worker', async () => {
    setNativeDirectAudience('steward');
    backend.from.mockClear();
    const rows = await loadConversationSummaries('dylan');
    expect(backend.rpc).toHaveBeenCalledWith('list_steward_conversations', {
      p_filter: 'all',
      p_search: null,
      p_after_updated: null,
      p_after_id: null,
      p_limit: 100,
    });
    expect(backend.from).not.toHaveBeenCalledWith('member_conversations');
    expect(rows.map((row) => row.title)).toEqual(['Marcus Greene']);
    expect(rows[0]).toMatchObject({ unreadCount: 1 });
    expect(rows[0]).not.toHaveProperty('counterpartRole');
  });

  it('shows only the stub rows for another organization, campaign or unit', async () => {
    setNativeDirectAudience('steward');
    scope = { ...scope, organizationID: 'other-org' };
    expect((await loadConversationSummaries('dylan')).map((row) => row.id)).toEqual(['other-org-thread']);
    scope = { ...scope, organizationID: 'tamarack', chapterID: 'south' };
    expect((await loadConversationSummaries('dylan')).map((row) => row.id)).toEqual(['other-chapter-thread']);
    scope = { ...scope, chapterID: 'north', unitID: 'other-unit' };
    expect((await loadConversationSummaries('dylan')).map((row) => row.id)).toEqual(['other-unit-thread']);
  });

  it('clears the list when the committee member role is refused and does not keep the previous rows', async () => {
    setNativeDirectAudience('steward');
    const previous = await loadConversationSummaries('dylan');
    expect(previous.map((row) => row.id)).toEqual(['marcus-thread']);
    scope.steward = false;
    const cleared = await loadConversationSummaries('dylan');
    expect(cleared).toEqual([]);
    expect(replaceDirectRows(previous, cleared)).toEqual([]);
  });

  it('fails closed on any other read error without repeating the server text', async () => {
    setNativeDirectAudience('steward');
    scope.fail = 'other';
    await expect(loadConversationSummaries('dylan')).rejects.toThrow('Worker conversations did not load. Try again.');
    await expect(loadConversationSummaries('dylan')).rejects.not.toThrow('database detail');
  });

  it('opens an authorized worker thread without a record-link id and refuses a worker read of it', async () => {
    const staff = await loadConversationThread('dylan', 'marcus-thread', { staff: true });
    expect(staff?.readerIsStaff).toBe(true);
    expect(staff?.messages.map((message) => message.body)).toEqual(['Can you call me?']);
    expect(await loadConversationThread('dylan', 'marcus-thread')).toBeNull();
    expect((await loadConversationThread('marcus', 'marcus-thread'))?.readerIsStaff).toBeFalsy();
  });

  it('keeps a reply composer on a committee member read of a worker thread', () => {
    const screen = readFileSync(new URL('../../app/conversation/[id].tsx', import.meta.url), 'utf8');
    expect(screen).toContain("!thread.readerIsStaff || composeAction || directAudience === 'steward'");
    expect(screen).toContain('if (thread.readerIsStaff) await sendStewardReply(writer, id, cleanDraft);');
  });

  it('sends the committee member reply through the existing server action and the worker then has it unread', async () => {
    setNativeDirectAudience('steward');
    await sendStewardReply(testWriter, 'marcus-thread', '  On my way. ');
    expect(backend.rpc).toHaveBeenCalledWith('send_steward_reply', {
      p_conversation_id: 'marcus-thread',
      p_body: 'On my way.',
    });
    setNativeDirectAudience('member');
    const memberRows = await loadConversationSummaries('marcus');
    expect(memberRows.map((row) => row.id)).toEqual(['marcus-thread']);
    expect(memberRows[0]).toMatchObject({ unreadCount: 1, latestMessage: 'On my way.' });
    const stewardRows = replaceDirectRows(memberRows, projectStewardDirectInbox(visibleCatalog()));
    expect(stewardRows.map((row) => row.id)).toEqual(['marcus-thread']);
    expect(stewardRows[0]?.unreadCount).toBe(0);
  });
});
