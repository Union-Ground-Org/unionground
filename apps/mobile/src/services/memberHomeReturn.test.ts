import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import type { Session } from '@supabase/supabase-js';
import { beforeEach, describe, expect, it, vi } from 'vitest';

type Query = Record<string, (...args: unknown[]) => Query> & { then: (resolve: (value: unknown) => void) => void };

const backend = vi.hoisted(() => ({
  create: vi.fn(),
  ballots: vi.fn(),
  calls: [] as { method: string; args: unknown[] }[],
  events: null as unknown,
  client: null as unknown,
}));

vi.mock('./supabase', () => ({
  createCapturedSessionRpcClient: backend.create,
  getSupabaseClient: () => backend.client,
  loadMobileBallots: backend.ballots,
}));

import { welcomeBackStepCopy } from '../lib/welcomeBackCopy';
import { WELCOME_BACK_RPC, resolveWelcomeBackStep } from '../lib/welcomeBackShared';
import { dismissHomeReturn, forgetHomeReturnDecisions, homeReturnDecision, loadWelcomeBackExtras, recordMemberHomeReturn } from './memberHomeReturn';

function session(id = 'user-a'): Session {
  return {
    access_token: `token-${id}`,
    refresh_token: 'redacted',
    expires_in: 3_600,
    token_type: 'bearer',
    user: { id, app_metadata: {}, user_metadata: {}, aud: 'authenticated', created_at: '2026-09-28T12:00:00.000Z' },
  };
}

function query(): Query {
  const chain = {} as Query;
  for (const method of ['select', 'gte', 'lte', 'is', 'order', 'limit']) {
    chain[method] = (...args: unknown[]) => { backend.calls.push({ method, args }); return chain; };
  }
  chain.then = (resolve) => resolve(backend.events);
  return chain;
}

beforeEach(() => {
  forgetHomeReturnDecisions();
  backend.calls = [];
  backend.create.mockReset();
  backend.ballots.mockReset();
  backend.client = { from: () => query() };
});

describe('REQ-UG-REACTIVATION-WELCOME-BACK-20261001 native', () => {
  it('asks once per app run on a session-captured client and remembers the answer', async () => {
    const rpc = vi.fn(async () => ({ data: { enabled: true, welcomeBack: true, afterDays: 21 }, error: null }));
    backend.create.mockReturnValue({ rpc });
    expect(await recordMemberHomeReturn(session())).toBe('welcome');
    expect(await recordMemberHomeReturn(session())).toBe('welcome');
    expect(rpc).toHaveBeenCalledTimes(1);
    expect(rpc).toHaveBeenCalledWith(WELCOME_BACK_RPC);
    expect(backend.create).toHaveBeenCalledWith(expect.objectContaining({ access_token: 'token-user-a' }));
    dismissHomeReturn('user-a');
    expect(homeReturnDecision('user-a')).toBe('seen');
    expect(await recordMemberHomeReturn(session())).toBe('seen');
  });

  it('records activity again on a later day of the same run and evaluates the return then (BUG-UG-WELCOME-BACK-ACTIVITY-CACHE-20261002)', async () => {
    const answers = [
      { data: { enabled: true, welcomeBack: false, afterDays: 21 }, error: null },
      { data: { enabled: true, welcomeBack: true, afterDays: 21 }, error: null },
    ];
    const rpc = vi.fn(async () => answers.shift() ?? { data: null, error: null });
    const client = { rpc };
    expect(await recordMemberHomeReturn(session('day'), client, '2026-10-02')).toBe('seen');
    // Same day, including a resume: nothing more is recorded.
    expect(await recordMemberHomeReturn(session('day'), client, '2026-10-02')).toBe('seen');
    expect(rpc).toHaveBeenCalledTimes(1);
    // A later day records again and shows that day's answer.
    expect(await recordMemberHomeReturn(session('day'), client, '2026-10-25')).toBe('welcome');
    expect(rpc).toHaveBeenCalledTimes(2);
    dismissHomeReturn('day');
    expect(await recordMemberHomeReturn(session('day'), client, '2026-10-25')).toBe('seen');
    expect(rpc).toHaveBeenCalledTimes(2);
  });

  it('ignores an older day\'s answer that settles after a later day\'s (BUG-UG-WELCOME-BACK-ACTIVITY-CACHE-20261002)', async () => {
    const settle: Record<string, (value: { data: unknown; error: unknown }) => void> = {};
    const client = (day: string) => ({ rpc: vi.fn(() => new Promise<{ data: unknown; error: unknown }>((resolve) => { settle[day] = resolve; })) });
    const dayD = client('2026-10-02');
    const dayD1 = client('2026-10-03');
    // Suspended with day D's read in flight, resumed on day D+1.
    const older = recordMemberHomeReturn(session('late'), dayD, '2026-10-02');
    const newer = recordMemberHomeReturn(session('late'), dayD1, '2026-10-03');
    expect(dayD1.rpc).toHaveBeenCalledTimes(1);
    settle['2026-10-03']!({ data: { enabled: true, welcomeBack: false, afterDays: 21 }, error: null });
    expect(await newer).toBe('seen');
    // Day D answers last with a welcome: stale, so neither the decision nor
    // the recorded day moves.
    settle['2026-10-02']!({ data: { enabled: true, welcomeBack: true, afterDays: 21 }, error: null });
    expect(await older).toBe('seen');
    expect(homeReturnDecision('late')).toBe('seen');
    // Day D+1 stays recorded: neither D+1 nor an earlier day asks again.
    expect(await recordMemberHomeReturn(session('late'), dayD1, '2026-10-03')).toBe('seen');
    expect(await recordMemberHomeReturn(session('late'), dayD, '2026-10-02')).toBe('seen');
    expect(dayD.rpc).toHaveBeenCalledTimes(1);
    expect(dayD1.rpc).toHaveBeenCalledTimes(1);
  });

  it('applies an older day\'s answer that settles first, then the later day\'s', async () => {
    const settle: Record<string, (value: { data: unknown; error: unknown }) => void> = {};
    const client = (day: string) => ({ rpc: vi.fn(() => new Promise<{ data: unknown; error: unknown }>((resolve) => { settle[day] = resolve; })) });
    const older = recordMemberHomeReturn(session('order'), client('2026-10-02'), '2026-10-02');
    const newer = recordMemberHomeReturn(session('order'), client('2026-10-03'), '2026-10-03');
    settle['2026-10-02']!({ data: { enabled: true, welcomeBack: false, afterDays: 21 }, error: null });
    expect(await older).toBe('seen');
    settle['2026-10-03']!({ data: { enabled: true, welcomeBack: true, afterDays: 21 }, error: null });
    expect(await newer).toBe('welcome');
    expect(homeReturnDecision('order')).toBe('welcome');
  });

  it('asks again when the app returns to the foreground', () => {
    const view = readFileSync(join(__dirname, '../features/home/WelcomeBack.tsx'), 'utf8');
    expect(view).toContain("AppState.addEventListener('change'");
    expect(view).toContain("if (next === 'active') setResumes((count) => count + 1);");
    expect(view).toContain('}, [userID, session, resumes]);');
  });

  it('keeps the full Home when the switch is off or the read fails, per account', async () => {
    expect(await recordMemberHomeReturn(session('b'), { rpc: async () => ({ data: { enabled: false, welcomeBack: false }, error: null }) })).toBe('seen');
    expect(await recordMemberHomeReturn(session('c'), { rpc: async () => ({ data: null, error: { code: '42501' } }) })).toBe('seen');
    expect(await recordMemberHomeReturn(session('d'), { rpc: () => Promise.reject(new Error('offline')) })).toBe('seen');
    expect(homeReturnDecision('e')).toBeNull();
  });

  it('reads open votes and two weeks of relevant, uncancelled meetings', async () => {
    backend.ballots.mockResolvedValue([
      { id: 'b1', title: 'Ratify', closesAt: '2026-10-05T00:00:00Z', closed: false, receiptCode: null, options: [] },
      { id: 'b2', title: 'Cast', closesAt: '2026-10-05T00:00:00Z', closed: false, receiptCode: 'SG-1', options: [] },
    ]);
    backend.events = { data: [
      { id: 'mine', title: 'Campaign meeting', starts_at: '2026-10-03T18:00:00Z', chapter_id: 'ch-1', is_public_across_agencies: false },
      { id: 'other', title: 'Other campaign', starts_at: '2026-10-03T18:00:00Z', chapter_id: 'ch-9', is_public_across_agencies: false },
    ], error: null };
    const now = Date.UTC(2026, 9, 1, 12);
    const extras = await loadWelcomeBackExtras('ch-1', now);
    expect(extras).toEqual({ openPolls: [{ id: 'b1', title: 'Ratify' }], events: [{ id: 'mine', title: 'Campaign meeting', startsAt: '2026-10-03T18:00:00Z' }] });
    expect(backend.calls).toContainEqual({ method: 'is', args: ['cancelled_at', null] });
    expect(backend.calls).toContainEqual({ method: 'lte', args: ['starts_at', new Date(now + 14 * 86_400_000).toISOString()] });
  });

  it('routes each picked step to a real native destination', () => {
    const now = new Date(2026, 9, 1, 12);
    const base = { unreadUpdates: 0, newestUpdateTitle: null, openPolls: [], events: [], activeCases: [], now };
    expect(welcomeBackStepCopy(resolveWelcomeBackStep({ ...base, unreadUpdates: 1 }))).toMatchObject({ label: 'Catch up on 1 update', href: '/notifications' });
    expect(welcomeBackStepCopy(resolveWelcomeBackStep({ ...base, openPolls: [{ id: 'p', title: 'Ratify' }] }))).toMatchObject({ label: 'Vote in the open poll', href: '/feature/voting' });
    expect(welcomeBackStepCopy(resolveWelcomeBackStep({ ...base, activeCases: [{ id: 'c1', reference: 'GR-1' }] }))).toMatchObject({ label: 'Review issue GR-1', href: '/issue/c1' });
    expect(welcomeBackStepCopy(resolveWelcomeBackStep(base))).toMatchObject({ label: 'Open organizing rights', href: '/feature/rights' });
  });

  it('shows the welcome view in place of live Home with a way to the full Home', () => {
    const home = readFileSync(join(__dirname, '../../app/(tabs)/home.tsx'), 'utf8');
    const liveStart = home.indexOf('function AuthenticatedHome');
    expect(liveStart, 'AuthenticatedHome must exist').toBeGreaterThanOrEqual(0);
    const live = home.slice(liveStart);
    const welcomeIndex = live.indexOf('const welcome = useNativeWelcomeBack();');
    const dashboardIndex = live.indexOf('if (!dashboard)');
    expect(welcomeIndex, 'useNativeWelcomeBack must run on live Home').toBeGreaterThanOrEqual(0);
    expect(dashboardIndex, 'The dashboard guard must exist on live Home').toBeGreaterThanOrEqual(0);
    expect(welcomeIndex).toBeLessThan(dashboardIndex);
    expect(live).toContain('<WelcomeBackView onDismiss={welcome.dismiss} />');
    const view = readFileSync(join(__dirname, '../features/home/WelcomeBack.tsx'), 'utf8');
    expect(view).toContain("label={tr('welcomeBack.showHome')}");
    expect(view).toContain('onPress={onDismiss}');
  });
});
