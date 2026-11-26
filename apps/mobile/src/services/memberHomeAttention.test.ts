import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import type { Session } from '@supabase/supabase-js';
import { beforeEach, describe, expect, it, vi } from 'vitest';

type Query = Record<string, (...args: unknown[]) => Query> & { then: (resolve: (value: unknown) => void) => void };

const backend = vi.hoisted(() => ({
  create: vi.fn(),
  ballots: vi.fn(),
  calls: [] as { table: string; method: string; args: unknown[] }[],
  results: new Map<string, unknown>(),
  client: null as unknown,
}));

vi.mock('./supabase', () => ({
  createCapturedSessionRpcClient: backend.create,
  getSupabaseClient: () => backend.client,
  loadMobileBallots: backend.ballots,
}));

import { whatMattersCopy } from '../lib/whatMattersCopy';
import { WHAT_MATTERS_SWITCH, rankWhatMattersNow } from '../lib/whatMattersShared';
import { loadWhatMattersBallots, loadWhatMattersEvents, loadWhatMattersNotices, loadWhatMattersSurveys, loadWhatMattersSwitch } from './memberHomeAttention';

function query(table: string): Query {
  const chain = {} as Query;
  for (const method of ['select', 'gte', 'lte', 'is', 'not', 'order', 'limit', 'eq', 'in']) {
    chain[method] = (...args: unknown[]) => { backend.calls.push({ table, method, args }); return chain; };
  }
  chain.then = (resolve) => resolve(backend.results.get(table));
  return chain;
}

function session(): Session {
  return {
    access_token: 'token-a',
    refresh_token: 'redacted',
    expires_in: 3_600,
    token_type: 'bearer',
    user: { id: 'user-a', app_metadata: {}, user_metadata: {}, aud: 'authenticated', created_at: '2026-09-28T12:00:00.000Z' },
  };
}

const NOW = Date.UTC(2026, 9, 1, 12);

beforeEach(() => {
  backend.calls = [];
  backend.results = new Map();
  backend.create.mockReset();
  backend.ballots.mockReset();
  backend.client = { from: (table: string) => query(table) };
});

describe('REQ-UG-MEMBER-WHAT-MATTERS-NOW-20261001 native inputs', () => {
  it('reads the member-visible switch and keeps the default on when the read fails', async () => {
    backend.create.mockReturnValue({ rpc: vi.fn(async () => ({ data: { switches: { [WHAT_MATTERS_SWITCH]: false } }, error: null })) });
    expect(await loadWhatMattersSwitch(session())).toBe(false);
    backend.create.mockReturnValue({ rpc: vi.fn(async () => ({ data: null, error: { code: '42501' } })) });
    expect(await loadWhatMattersSwitch(session())).toBe(true);
  });

  it('maps votes to cast/uncast without reading choices', async () => {
    backend.ballots.mockResolvedValue([
      { id: 'b1', title: 'Ratify', closesAt: '2026-10-03T00:00:00Z', closed: false, receiptCode: null, options: [] },
      { id: 'b2', title: 'Done', closesAt: '2026-10-02T00:00:00Z', closed: false, receiptCode: 'SG-1', options: [] },
    ]);
    expect(await loadWhatMattersBallots()).toEqual([
      { id: 'b1', title: 'Ratify', closed: false, voted: false, closesAt: '2026-10-03T00:00:00Z' },
      { id: 'b2', title: 'Done', closed: false, voted: true, closesAt: '2026-10-02T00:00:00Z' },
    ]);
  });

  it("bounds meetings to this week, keeps the worker's campaign and public meetings, and self-scopes RSVPs", async () => {
    backend.results.set('member_events', { data: [
      { id: 'mine', title: 'Campaign meeting', starts_at: '2026-10-02T18:00:00Z', chapter_id: 'ch-1', is_public_across_agencies: false, cancelled_at: null },
      { id: 'other', title: 'Other campaign', starts_at: '2026-10-02T18:00:00Z', chapter_id: 'ch-9', is_public_across_agencies: false, cancelled_at: null },
      { id: 'public', title: 'Statewide rally', starts_at: '2026-10-03T18:00:00Z', chapter_id: 'ch-9', is_public_across_agencies: true, cancelled_at: null },
    ], error: null });
    backend.results.set('member_event_rsvps', { data: [{ event_id: 'public', status: 'going' }], error: null });
    const events = await loadWhatMattersEvents('user-a', 'ch-1', NOW);
    expect(events).toEqual([
      { id: 'mine', title: 'Campaign meeting', startsAt: '2026-10-02T18:00:00Z', cancelled: false, responded: false },
      { id: 'public', title: 'Statewide rally', startsAt: '2026-10-03T18:00:00Z', cancelled: false, responded: true },
    ]);
    const eventCalls = backend.calls.filter((call) => call.table === 'member_events');
    expect(eventCalls).toContainEqual({ table: 'member_events', method: 'gte', args: ['starts_at', new Date(NOW).toISOString()] });
    expect(eventCalls).toContainEqual({ table: 'member_events', method: 'lte', args: ['starts_at', new Date(NOW + 7 * 86_400_000).toISOString()] });
    expect(eventCalls).toContainEqual({ table: 'member_events', method: 'is', args: ['cancelled_at', null] });
    expect(backend.calls).toContainEqual({ table: 'member_event_rsvps', method: 'eq', args: ['user_id', 'user-a'] });
  });

  it('skips the RSVP read when no meeting is relevant', async () => {
    backend.results.set('member_events', { data: [], error: null });
    expect(await loadWhatMattersEvents('user-a', 'ch-1', NOW)).toEqual([]);
    expect(backend.calls.some((call) => call.table === 'member_event_rsvps')).toBe(false);
  });

  // BUG-UG-PULSE-THIS-WEEK-CAUGHT-UP-WITH-OPEN-ITEMS-20261103.
  it("reads the worker's surveys on the captured session and fails loudly", async () => {
    const rpc = vi.fn(async () => ({ data: { surveys: [{ id: 's1', title: 'Seasonal check-in', closesAt: null, session: { id: 'x', status: 'submitted' } }] }, error: null }));
    backend.create.mockReturnValue({ rpc });
    expect(await loadWhatMattersSurveys(session())).toEqual([{ id: 's1', title: 'Seasonal check-in', closesAt: null, answered: true }]);
    expect(backend.create).toHaveBeenCalledWith(session());
    expect(rpc).toHaveBeenCalledWith('get_member_engagement_snapshot');
    backend.create.mockReturnValue({ rpc: vi.fn(async () => ({ data: null, error: { code: '42501' } })) });
    await expect(loadWhatMattersSurveys(session())).rejects.toEqual({ code: '42501' });
  });

  it('marks the latest twenty notices unread from self-scoped receipts', async () => {
    backend.results.set('member_broadcasts', { data: [{ id: 'n1', title: 'Crew meeting' }, { id: 'n2', title: null }, { id: 3 }], error: null });
    backend.results.set('member_broadcast_receipts', { data: [{ broadcast_id: 'n1' }, { broadcast_id: 9 }], error: null });
    expect(await loadWhatMattersNotices('user-a')).toEqual([
      { id: 'n1', title: 'Crew meeting', unread: false },
      { id: 'n2', title: '', unread: true },
    ]);
    expect(backend.calls).toContainEqual({ table: 'member_broadcasts', method: 'limit', args: [20] });
    expect(backend.calls).toContainEqual({ table: 'member_broadcasts', method: 'is', args: ['retracted_at', null] });
    expect(backend.calls).toContainEqual({ table: 'member_broadcast_receipts', method: 'eq', args: ['user_id', 'user-a'] });
  });

  it('skips the receipt read with no notices and throws on failed or unconfigured reads', async () => {
    backend.results.set('member_broadcasts', { data: null, error: null });
    expect(await loadWhatMattersNotices('user-a')).toEqual([]);
    expect(backend.calls.some((call) => call.table === 'member_broadcast_receipts')).toBe(false);
    backend.results.set('member_broadcasts', { data: [{ id: 'n1', title: 'A' }], error: null });
    backend.results.set('member_broadcast_receipts', { data: null, error: null });
    expect(await loadWhatMattersNotices('user-a')).toEqual([{ id: 'n1', title: 'A', unread: true }]);
    backend.results.set('member_broadcast_receipts', { data: null, error: new Error('offline') });
    await expect(loadWhatMattersNotices('user-a')).rejects.toThrow('offline');
    backend.results.set('member_broadcasts', { data: null, error: new Error('down') });
    await expect(loadWhatMattersNotices('user-a')).rejects.toThrow('down');
    backend.client = null;
    await expect(loadWhatMattersNotices('user-a')).rejects.toThrow('not configured');
  });

  it('ranks with the shared module and routes each action to a real native destination', () => {
    const now = new Date(2026, 9, 1, 12);
    const urgent = rankWhatMattersNow({ cases: [{ id: 'c1', reference: 'GR-1', status: 'active', step: 'Step 2', deadline: '2026-10-02' }], ballots: [], events: [], now });
    expect(whatMattersCopy(urgent)).toMatchObject({ reason: 'Issue follow-up coming up', line: 'A follow-up is due tomorrow on GR-1.', action: 'Review issue', href: '/issue/c1' });
    // Union Ground has no ULP deadline or retaliation rule: a summary that
    // still carries Union Ground's legacy fields ranks as the issue it is,
    // with no legal label and no deadline taken from those fields.
    const legacyCase = { id: 'c1', status: 'active', deadline: '2026-11-30', ulpDeadline: '2026-10-01', retaliationFlagged: true };
    const ulp = rankWhatMattersNow({ cases: [legacyCase], ballots: [], events: [], now });
    expect(ulp.kind).toBe('case_in_progress');
    expect(whatMattersCopy(ulp)).toMatchObject({ reason: 'Issue in progress', action: 'Review issue', href: '/issue/c1', meta: 'Follow up Nov 30' });
    expect(JSON.stringify(whatMattersCopy(ulp))).not.toMatch(/unfair labor practice|ULP|steward|retaliation|Oct 1\b/i);
    const copySource = readFileSync(join(__dirname, '../lib/whatMattersCopy.ts'), 'utf8');
    expect(copySource).not.toMatch(/'ulp_deadline'|'retaliation'/);
    const vote = rankWhatMattersNow({ cases: [], ballots: [{ id: 'b', title: 'Ratify', closed: false, voted: false, closesAt: null }], events: [], now });
    expect(whatMattersCopy(vote)).toMatchObject({ line: 'Ratify', action: 'Cast my vote', href: '/feature/voting' });
    const calm = rankWhatMattersNow({ cases: [], ballots: [], events: [], now });
    expect(whatMattersCopy(calm)).toMatchObject({ action: null, href: null });
  });

  it('ranks live Home with the same surveys and notices Pulse lists', () => {
    const hook = readFileSync(join(__dirname, '../features/home/WhatMattersNow.tsx'), 'utf8');
    expect(hook).toContain('loadWhatMattersSurveys(session),');
    expect(hook).toContain('loadWhatMattersNotices(userID),');
    expect(hook).toContain('surveys: settled.surveys?.value ?? [],');
    expect(hook).toContain('const notices = settled.notices?.value ?? [];');
    expect(hook).toContain('notices: isBroadcastDismissed ? notices.filter((notice) => !isBroadcastDismissed(notice.id)) : notices,');
  });

  it('ranks personal issues on worker Home and keeps the worker fallback behind the switch', () => {
    const home = readFileSync(join(__dirname, '../../app/(tabs)/home.tsx'), 'utf8');
    const live = home.slice(home.indexOf('function AuthenticatedHome'));
    const rank = 'const whatMatters = useWhatMattersNow({ includePersonalCases: deskRole === null });';
    expect(live).toContain(rank);
    expect(live.indexOf(rank)).toBeLessThan(live.indexOf('if (!dashboard)'));
    expect(live).toContain('whatMatters.rank(isBroadcastDismissed)');
    expect(live).toContain('whatMatters.enabled && !duplicateBroadcast');
    expect(live).toContain(': !deskRole && !whatMatters.enabled ? (');
    expect(live).toContain('<Heading level={2}>{t("Next up")}</Heading>');
  });
});
