import type { Session } from '@supabase/supabase-js';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { MemberDashboard } from '../models/member';

type Read = { data: unknown; error: unknown };
const backend = vi.hoisted(() => ({ configured: true, rpc: vi.fn(), ballots: vi.fn(), events: vi.fn(), captured: vi.fn(), tables: new Map<string, Read>(), calls: [] as { table: string; method: string; args: unknown[] }[] }));
function query(table: string) {
  const chain: Record<string, ReturnType<typeof vi.fn>> = {};
  for (const method of ['select', 'eq', 'is', 'not', 'lte', 'order', 'limit', 'abortSignal', 'in']) chain[method] = vi.fn((...args: unknown[]) => { backend.calls.push({ table, method, args }); return chain; });
  chain.then = vi.fn((resolve: (result: Read) => unknown) => Promise.resolve(backend.tables.get(table) ?? { data: [], error: null }).then(resolve));
  return chain;
}
vi.mock('./supabase', () => ({ getSupabaseClient: () => backend.configured ? { from: query } : null, createCapturedSessionRpcClient: (session: Session) => { backend.captured(session); return { rpc: backend.rpc }; } }));
vi.mock('./memberHomeAttention', () => ({ loadWhatMattersBallots: backend.ballots, loadWhatMattersEvents: backend.events }));
import { loadMemberPulse } from './memberPulse';

const userID = '10000000-0000-4000-8000-000000000001';
const session: Session = { access_token: 'test-session-token', refresh_token: 'redacted', expires_in: 3600, token_type: 'bearer', user: { id: userID, aud: 'authenticated', app_metadata: {}, user_metadata: {}, created_at: '2026-11-01' } };
const dashboard: MemberDashboard = { member: { id: userID, firstName: 'Fictional', fullName: 'Fictional Worker', initials: 'FM', roleLine: 'Worker', memberSince: null, chapterID: 'test-chapter', language: 'en' }, cases: [], notifications: [], conversations: [], weeklyActions: [{ actionKey: 'a', actionKind: 'survey', occurredAt: '2026-11-01' }] };
const signal = () => new AbortController().signal;
beforeEach(() => {
  backend.configured = true; backend.calls = []; backend.tables.clear(); backend.captured.mockReset();
  backend.ballots.mockReset().mockResolvedValue([]); backend.events.mockReset().mockResolvedValue([]);
  backend.tables.set('member_events', { data: [{ id: 'e1', title: 'Campaign meeting' }], error: null });
  backend.tables.set('member_broadcasts', { data: [{ id: 'n1', title: 'Recorded notice' }], error: null });
  backend.rpc.mockReset().mockImplementation(async (name: string) => ({ error: null, data:
    name === 'get_member_engagement_snapshot' ? { quarterlyGate: { unlocked: true }, surveys: [{ id: 's', title: 'Scheduling', session: null }] } :
    name === 'get_member_rewards_summary' ? { weekStreak: 2, totalPoints: 40, actionsYtd: 8 } :
    name === 'get_member_event_quorum' ? [{ eventId: 'e1', checkedIn: 12, quorum: 10 }] :
    { available: true, privacyFloor: 10, actions: { withheld: false, months: [{ month: '2026-10', count: 12 }] }, outcomes: { withheld: false, rows: [{ outcome: 'settled', count: 10 }] } } }));
});
describe('worker Pulse bounded authorized reads', () => {
  it('assembles four cards, uses the captured session, self-scopes receipts, and reuses Home inputs', async () => {
    const result = await loadMemberPulse(session, dashboard, signal());
    expect(result.cards.map((card) => card.number)).toEqual(['01', '02', '03', '04']);
    expect(result.cards[1]?.rows).toEqual([{ label: 'Campaign meeting · checked in', value: 12 }, { label: 'Campaign meeting · quorum', value: 10 }]);
    expect(result.cards[2]?.rows).toContainEqual({ label: 'Actions this week', value: 1 });
    // BUG-UG-PULSE-THIS-WEEK-CAUGHT-UP-WITH-OPEN-ITEMS-20261103: never
    // caught up above the survey and notice the card lists.
    expect(result.next).toMatchObject({ kind: 'open_survey', survey: { title: 'Scheduling' } }); expect(result.nextAvailable).toBe(true);
    expect(result.surveys).toEqual(['Scheduling']); expect(result.notice).toMatchObject({ title: 'Recorded notice', unread: 1 });
    expect(backend.captured).toHaveBeenCalledWith(session);
    expect(backend.calls).toContainEqual({ table: 'member_broadcast_receipts', method: 'eq', args: ['user_id', userID] });
    expect(backend.events).toHaveBeenCalledWith(userID, 'test-chapter');
  });
  it('builds every card in the worker\'s language from the native catalogue (#8926)', async () => {
    const result = await loadMemberPulse(session, dashboard, signal(), 'es');
    expect(result.cards.map((card) => card.title)).toEqual(['Trabajadores que actúan', 'Asistencia a reuniones', 'Tu semana', 'Cómo terminan los asuntos']);
    expect(result.cards[1]?.rows).toEqual([{ label: 'Campaign meeting · registraron asistencia', value: 12 }, { label: 'Campaign meeting · quórum', value: 10 }]);
    expect(result.cards[2]?.rows).toContainEqual({ label: 'Acciones esta semana', value: 1 });
    expect(result.cards[0]?.trend?.marks).toEqual([{ axis: 'O', name: 'Octubre', spoken: 'Octubre de 2026' }]);
  });
  it.each([false, null, undefined])('never requests statistics without an explicit gate unlock (%s)', async (unlocked) => {
    const original = backend.rpc.getMockImplementation()!;
    backend.rpc.mockImplementation((name: string, ...args: unknown[]) => name === 'get_member_engagement_snapshot' ? Promise.resolve({ data: { quarterlyGate: { unlocked, surveyId: 's' } }, error: null }) : original(name, ...args));
    const result = await loadMemberPulse(session, dashboard, signal());
    expect(backend.rpc).not.toHaveBeenCalledWith('get_member_union_statistics', expect.anything());
    expect(result.cards[0]?.rows).toEqual([]); expect(result.cards[3]?.rows).toEqual([]);
    expect(result.statisticsLocked).toBe(unlocked === false);
  });
  it('honors a newer server lock even after the snapshot was unlocked', async () => {
    const original = backend.rpc.getMockImplementation()!;
    backend.rpc.mockImplementation((name: string, ...args: unknown[]) => name === 'get_member_union_statistics' ? Promise.resolve({ data: { locked: true, available: false, actions: { months: [{ count: 99 }] } }, error: null }) : original(name, ...args));
    expect(await loadMemberPulse(session, dashboard, signal())).toMatchObject({ statisticsLocked: true, cards: [{ rows: [] }, {}, {}, { rows: [] }] });
  });
  it.each(['get_member_engagement_snapshot', 'get_member_rewards_summary', 'get_member_event_quorum', 'get_member_union_statistics'])('keeps a failed %s read honest', async (failed) => {
    const original = backend.rpc.getMockImplementation()!;
    backend.rpc.mockImplementation((name: string, ...args: unknown[]) => name === failed ? Promise.reject(new Error('offline')) : original(name, ...args));
    const result = await loadMemberPulse(session, dashboard, signal());
    if (failed === 'get_member_event_quorum') expect(result.cards[1]).toMatchObject({ unavailable: true, rows: [] });
    else if (failed === 'get_member_rewards_summary') expect(result.cards[2]?.rows).toEqual([{ label: 'Actions this week', value: 1 }]);
    else expect(result.cards[0]).toMatchObject({ unavailable: true, rows: [] });
  });
  it('does not call a failed Home input caught up, and cancels before dependent reads', async () => {
    backend.ballots.mockRejectedValueOnce(new Error('offline'));
    expect(await loadMemberPulse(session, dashboard, signal())).toMatchObject({ nextAvailable: false, next: null });
    const controller = new AbortController(); controller.abort(); backend.rpc.mockClear();
    await expect(loadMemberPulse(session, dashboard, controller.signal)).rejects.toThrow('cancelled');
    expect(backend.rpc).not.toHaveBeenCalledWith('get_member_union_statistics', expect.anything());
    backend.configured = false;
    await expect(loadMemberPulse(session, dashboard, signal())).rejects.toThrow('not configured');
  });
  it.each<[string, boolean, boolean, string]>([
    ['an open survey', true, false, 'open_survey'],
    ['an unread notice', false, true, 'unread_notice'],
    ['both', true, true, 'open_survey'],
    ['neither', false, false, 'caught_up'],
  ])('ranks This week with %s', async (_label, open, unread, kind) => {
    const original = backend.rpc.getMockImplementation()!;
    backend.rpc.mockImplementation((name: string, ...args: unknown[]) => name === 'get_member_engagement_snapshot'
      ? Promise.resolve({ data: { quarterlyGate: { unlocked: true }, surveys: open ? [{ id: 's', title: 'Scheduling', session: null }] : [] }, error: null })
      : original(name, ...args));
    backend.tables.set('member_broadcast_receipts', { data: unread ? [] : [{ broadcast_id: 'n1' }], error: null });
    const result = await loadMemberPulse(session, dashboard, signal());
    expect(result.next?.kind).toBe(kind);
    expect(result.surveys).toEqual(open ? ['Scheduling'] : []);
    expect(result.notice === null).toBe(!unread);
  });
  it('drops a survey past its answer deadline and an answered one from This week', async () => {
    const original = backend.rpc.getMockImplementation()!;
    backend.rpc.mockImplementation((name: string, ...args: unknown[]) => name === 'get_member_engagement_snapshot'
      ? Promise.resolve({ data: { quarterlyGate: { unlocked: true }, surveys: [
        { id: 'past', title: 'Seasonal check-in before October 31', closesAt: '2020-10-31T23:59:00Z', session: null },
        { id: 'sent', title: 'Sent', session: { id: 'x', status: 'submitted' } },
      ] }, error: null })
      : original(name, ...args));
    backend.tables.set('member_broadcast_receipts', { data: [{ broadcast_id: 'n1' }], error: null });
    expect(await loadMemberPulse(session, dashboard, signal())).toMatchObject({ surveys: [], notice: null, next: { kind: 'caught_up' } });
  });
  it.each(['engagement', 'notices', 'receipts'])('does not call This week caught up when the %s read fails', async (failed) => {
    if (failed === 'engagement') {
      const original = backend.rpc.getMockImplementation()!;
      backend.rpc.mockImplementation((name: string, ...args: unknown[]) => name === 'get_member_engagement_snapshot' ? Promise.reject(new Error('offline')) : original(name, ...args));
    } else backend.tables.set(failed === 'notices' ? 'member_broadcasts' : 'member_broadcast_receipts', { data: null, error: new Error('offline') });
    expect(await loadMemberPulse(session, dashboard, signal())).toMatchObject({ nextAvailable: false, next: null });
  });
  it('bounds notices, removes read receipts from the unread list, and marks missing figures', async () => {
    backend.tables.set('member_events', { data: [], error: null });
    backend.tables.set('member_broadcasts', { data: Array.from({ length: 21 }, (_, index) => ({ id: `n${index}`, title: `Notice ${index}` })), error: null });
    backend.tables.set('member_broadcast_receipts', { data: [{ broadcast_id: 'n0' }], error: null });
    const result = await loadMemberPulse(session, dashboard, signal());
    expect(result.notice).toEqual({ title: 'Notice 1', unread: 19, limited: true });
    expect(result.cards[1]?.message).toContain('No recent meeting');
    backend.tables.set('member_broadcast_receipts', { data: null, error: new Error('offline') });
    expect((await loadMemberPulse(session, dashboard, signal())).notice).toBeNull();
  });
});
