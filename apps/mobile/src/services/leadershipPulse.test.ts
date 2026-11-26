import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { LeadershipHat } from '../lib/leadershipPulse';
const runtime = vi.hoisted(() => ({ rpc: vi.fn(), from: vi.fn(), queries: new Map<string, ReturnType<typeof vi.fn>>(), selections: new Map<string, ReturnType<typeof vi.fn>>(), filters: new Map<string, ReturnType<typeof vi.fn>>(), orders: new Map<string, ReturnType<typeof vi.fn>>(), limits: new Map<string, ReturnType<typeof vi.fn>>(), tables: new Map<string, unknown>(), tableErrors: new Map<string, unknown>(), signals: [] as [string, AbortSignal][], hat: 'vp', scopeCall: 0, revoke: false, selection: [] as string[], floors: [] as unknown[], serverFloor: 25 as unknown, formsFloor: [] as unknown[] }));
// The client's rpc returns an awaitable builder, as Supabase's does; the signal it is given is recorded.
vi.mock('./supabase', () => ({ createCapturedSessionRpcClient: () => ({
  rpc: (name: string, args: Record<string, unknown>) => {
    const answer = Promise.resolve(runtime.rpc(name, args) as unknown);
    return { then: answer.then.bind(answer), abortSignal: (signal: AbortSignal) => { runtime.signals.push([name, signal]); return answer; } };
  },
  from: runtime.from,
}) }));
import { loadLeadershipPulse } from './leadershipPulse';
const session = { access_token: 'captured', user: { id: 'fictional-person' } } as never;
const okay = (data: unknown) => ({ data, error: null });
const load = (hat: LeadershipHat = 'vp', signal = new AbortController().signal) => { runtime.hat = hat; return loadLeadershipPulse(session, hat, 'org-a', 'chapter-a', signal); };
beforeEach(() => {
  vi.resetAllMocks(); runtime.queries.clear(); runtime.selections.clear(); runtime.filters.clear(); runtime.orders.clear(); runtime.limits.clear(); runtime.tables.clear(); runtime.tableErrors.clear(); runtime.signals = []; runtime.hat = 'vp'; runtime.scopeCall = 0; runtime.revoke = false; runtime.selection = []; runtime.floors = []; runtime.serverFloor = 25; runtime.formsFloor = [];
  runtime.rpc.mockImplementation(async (name: string, args: Record<string, unknown>) => {
    if (name === 'get_my_mobile_staff_scope') { const floor = runtime.floors.length ? runtime.floors.shift() : 25; runtime.serverFloor = floor; return okay({ staffAuthorized: !(runtime.revoke && ++runtime.scopeCall > 1), organizationId: 'org-a', roles: [runtime.hat], chapterRoles: [], privacyFloor: floor, chapterHealthFloor: floor }); }
    if (name === 'get_my_chapter_memberships') { const chapter = runtime.selection.shift() ?? 'chapter-a'; return okay([{ chapterId: 'chapter-a', organizationId: 'org-a', selected: chapter === 'chapter-a' }, { chapterId: 'chapter-b', organizationId: 'org-a', selected: chapter === 'chapter-b' }]); }
    if (name === 'get_vp_overview') return okay({ memberCount: 100, newThisYear: 20, turnout: { totalVotes: 50, quorumTarget: 40 }, attention: ['PRIVATE CASE'] });
    if (name === 'get_admin_events') return okay([
      { id: 'current', chapterId: 'chapter-a', eventKind: 'meeting', startsAt: '2026-10-31T20:00:00-04:00', title: 'Campaign meeting', checkInCode: 'PRIVATE CODE' },
      { id: 'cancelled', chapterId: 'chapter-a', eventKind: 'meeting', startsAt: '2026-10-31T20:00:00-04:00', cancelledAt: '2026-10-30' },
      { id: 'foreign', chapterId: 'chapter-b', eventKind: 'meeting', startsAt: '2026-10-31T20:00:00-04:00' },
      { id: 'future', chapterId: 'chapter-a', eventKind: 'meeting', startsAt: '2099-01-01' },
    ]);
    if (name === 'get_member_event_quorum') return okay([{ eventId: 'current', checkedIn: 40, quorum: 50 }]);
    if (name === 'list_my_member_notices') return okay({ notices: [{ id: 'notice-a', chapterId: 'chapter-a', publishedAt: '2026-10-31', title: 'Campaign notice' }, { id: 'foreign', chapterId: 'chapter-b', publishedAt: '2026-10-31', title: 'PRIVATE FOREIGN' }, { id: 'retracted', chapterId: 'chapter-a', publishedAt: '2026-10-31', retractedAt: '2026-11-01' }] });
    if (name === 'get_member_notice_receipts') return okay({ id: args.p_broadcast_id, readCount: 60, audienceCount: 100, readers: ['PRIVATE READER'] });
    if (name === 'get_chapter_health_portfolio') return okay([{ chapterName: 'Tamarack East', measuredOn: '2026-10-31', score: 50, memberCount: 25, cohortProtected: false, coaching: ['PRIVATE COACHING'] }]);
    if (name === 'get_workload_stats') return okay({ enoughData: true, submittersBand: '25-49', period: '2026-Q3', categories: [{ key: 'pending', avg: 4, p90: 20 }] });
    if (name === 'list_coordinator_cases') return okay(runtime.tables.get('member_cases'));
    if (name === 'get_staff_mfa_policy') return okay({ staffTotal: 100, staffEnrolled: 70 });
    if (name === 'get_admin_chapter_form_states') {
      if (runtime.tableErrors.has('form_states')) return { data: null, error: runtime.tableErrors.get('form_states') };
      const summary = runtime.tables.has('form_states') ? runtime.tables.get('form_states') : { withheld: false, states: [{ status: 'submitted', count: 25 }] };
      // Like the server, the summary names the floor it applied: the
      // organization floor at the moment of this read, never below 25, unless a
      // test sets one.
      const held = typeof runtime.serverFloor === 'number' ? Math.max(25, runtime.serverFloor) : null;
      const applied = runtime.formsFloor.length ? runtime.formsFloor.shift() : held;
      return okay(summary !== null && typeof summary === 'object' && !Array.isArray(summary) && !('privacyFloor' in summary) ? { ...summary, privacyFloor: applied } : summary);
    }
    if (name === 'list_failed_login_operations_inbox') return okay({ openCount: 25, items: Array.from({ length: 25 }, (_, index) => ({ status: 'open', memberName: `PRIVATE PERSON ${index}`, memberReference: 'PRIVATE REF' })) });
    return okay(null);
  });
  runtime.from.mockImplementation((table: string) => {
    const query = { select: vi.fn().mockReturnThis(), eq: vi.fn().mockReturnThis(), in: vi.fn().mockReturnThis(), order: vi.fn().mockReturnThis(), limit: vi.fn().mockReturnThis(), abortSignal: vi.fn().mockImplementation(async () => ({ data: runtime.tables.has(table) ? runtime.tables.get(table) : [], error: runtime.tableErrors.get(table) ?? null })) };
    runtime.queries.set(table, query.in); runtime.selections.set(table, query.select); runtime.filters.set(table, query.eq); runtime.orders.set(table, query.order); runtime.limits.set(table, query.limit); return query;
  });
  runtime.tables.set('member_cases', Array.from({ length: 25 }, (_, index) => ({ id: `case-${index}`, user_id: `person-${index}`, organization_id: 'org-a', chapter_id: 'chapter-a', steward_user_id: null, status: 'active' })));
});
afterEach(() => vi.restoreAllMocks());
describe('leadership read contracts and scope checks', () => {
  it.each<LeadershipHat>(['vp', 'president'])('loads %s readiness with the actual notice/quorum signatures and drops every person field', async (hat) => {
    const result = await load(hat);
    expect(runtime.rpc).toHaveBeenCalledWith('get_member_event_quorum', { p_event_ids: ['current'] });
    expect(runtime.rpc).toHaveBeenCalledWith('get_member_notice_receipts', { p_broadcast_id: 'notice-a' });
    expect(runtime.rpc).not.toHaveBeenCalledWith('get_member_notice_receipts', { p_broadcast_id: 'foreign' });
    expect(JSON.stringify(result)).not.toContain('PRIVATE'); expect(result.week.detail).toContain('40');
  });
  it('uses only the protected portfolio for advisors', async () => {
    const result = await load('advisor'); expect(result.week.title).toContain('Tamarack East'); expect(JSON.stringify(result)).not.toContain('PRIVATE');
    expect(runtime.rpc.mock.calls.map((row: unknown[]) => row[0])).toEqual(['get_my_mobile_staff_scope', 'get_chapter_health_portfolio', 'get_my_mobile_staff_scope']);
  });
  it('loads the advisor portfolio without a campaign and refuses every chapter-bound hat before any read', async () => {
    runtime.hat = 'advisor'; expect((await loadLeadershipPulse(session, 'advisor', 'org-a', null, new AbortController().signal)).week.title).toContain('Tamarack East');
    for (const hat of ['president', 'vp', 'coordinator', 'admin'] satisfies LeadershipHat[]) {
      runtime.rpc.mockClear(); runtime.from.mockClear(); runtime.hat = hat;
      await expect(loadLeadershipPulse(session, hat, 'org-a', null, new AbortController().signal)).rejects.toThrow('selected campaign');
      expect(runtime.rpc).not.toHaveBeenCalled(); expect(runtime.from).not.toHaveBeenCalled();
    }
  });
  it('builds issue flow from current RLS issue statuses without a separate snapshot RPC', async () => {
    const result = await load('coordinator'); expect(runtime.rpc).toHaveBeenCalledWith('list_coordinator_cases', { p_focus: 'all', p_limit: 200 });
    expect(runtime.rpc.mock.calls.map((row: unknown[]) => row[0])).toEqual(['get_my_mobile_staff_scope', 'get_my_chapter_memberships', 'get_workload_stats', 'list_coordinator_cases', 'get_my_mobile_staff_scope', 'get_my_chapter_memberships']);
    expect(runtime.selections.get('member_cases')).toHaveBeenCalledWith('id,status,user_id,steward_user_id,chapter_id');
    expect(runtime.filters.get('member_cases')).toHaveBeenCalledWith('organization_id', 'org-a');
    expect(runtime.orders.get('member_cases')?.mock.calls).toEqual([['updated_at', { ascending: false }], ['id']]);
    expect(runtime.limits.get('member_cases')).toHaveBeenCalledWith(200);
    expect(result.cards.find((row) => row.id === 'flow')).toMatchObject({ rows: [{ label: 'active', value: 25 }], unavailable: false });
    expect(JSON.stringify(result)).not.toMatch(/person-\d|case-\d/);
    expect(result.cards.find((row) => row.id === 'unassigned')?.rows[0]?.value).toBe(25);
  });
  it('bounds the unassigned queue intersection to the current campaign, organization and RLS issue page', async () => {
    const cases = Array.from({ length: 50 }, (_, index) => ({ id: `case-${index}`, user_id: `person-${index}`, organization_id: 'org-a', chapter_id: 'chapter-a', steward_user_id: null, status: 'active' }));
    runtime.tables.set('member_cases', cases);
    const base = runtime.rpc.getMockImplementation()!;
    runtime.rpc.mockImplementation(async (name: string, args: Record<string, unknown>) => name === 'list_coordinator_cases' ? okay([
      ...cases.slice(0, 25),
      ...cases.slice(25, 30).map((row) => ({ ...row, organization_id: 'foreign' })),
      ...cases.slice(30, 35).map((row) => ({ ...row, chapter_id: 'foreign' })),
      ...cases.slice(35, 40).map((row) => ({ ...row, steward_user_id: 'assigned' })),
      { ...cases[0], id: 'outside-rls-page' },
    ]) : base(name, args));
    const result = await load('coordinator');
    expect(result.cards.find((row) => row.id === 'flow')?.rows).toEqual([{ label: 'active', value: 50 }]);
    expect(result.cards.find((row) => row.id === 'unassigned')?.rows).toEqual([{ label: 'Issues without a committee member in this bounded view', value: 25 }]);
  });
  it('does not turn failed or malformed issue reads into zero issue charts', async () => {
    runtime.tableErrors.set('member_cases', new Error('forbidden'));
    const failed = await load('coordinator');
    expect(failed.cards.filter((row) => ['flow', 'unassigned'].includes(row.id)).every((row) => row.unavailable && !row.rows.length)).toBe(true);
    runtime.tableErrors.clear(); runtime.tables.set('member_cases', null);
    const malformed = await load('coordinator'); expect(malformed.cards.find((row) => row.id === 'flow')?.unavailable).toBe(true);
    runtime.tables.set('member_cases', Array.from({ length: 25 }, (_, index) => ({ id: `case-${index}`, user_id: `person-${index}`, chapter_id: 'chapter-a', steward_user_id: null })));
    const missingStatus = await load('coordinator'); expect(missingStatus.cards.find((row) => row.id === 'flow')?.unavailable).toBe(true);
    expect(missingStatus.cards.find((row) => row.id === 'unassigned')?.rows).toEqual([]);
  });
  it('uses the existing admin attention count and reads forms only from the server aggregate for the captured campaign', async () => {
    const result = await load('admin'); expect(result.week.title).toBe('Review access reports'); expect(JSON.stringify(result)).not.toContain('PRIVATE');
    expect(runtime.rpc).toHaveBeenCalledWith('get_admin_chapter_form_states', { p_chapter_id: 'chapter-a' });
    // Row access has no admin branch; the profile and form tables are never read directly.
    expect(runtime.from).not.toHaveBeenCalledWith('member_profiles'); expect(runtime.from).not.toHaveBeenCalledWith('member_forms');
    expect(result.cards.find((row) => row.id === 'forms')).toMatchObject({ rows: [{ label: 'submitted', value: 25 }], unavailable: false });
    runtime.tables.set('form_states', { withheld: false, states: [] });
    expect((await load('admin')).cards.find((row) => row.id === 'forms')).toMatchObject({ rows: [], unavailable: false, message: 'No recorded figures in this view.' });
  });
  it('shows the withheld message when the server applies its privacy rule', async () => {
    runtime.tables.set('form_states', { withheld: true, states: null });
    const card = (await load('admin')).cards.find((row) => row.id === 'forms');
    expect(card).toMatchObject({ rows: [], unavailable: false }); expect(card?.message).toContain('too small to share safely');
  });
  it('marks a failed or malformed form aggregate unavailable, never an empty campaign', async () => {
    runtime.tableErrors.set('form_states', new Error('admin role required'));
    expect((await load('admin')).cards.find((row) => row.id === 'forms')?.unavailable).toBe(true);
    runtime.tableErrors.clear();
    for (const malformed of [null, [], {}, { withheld: false }, { withheld: false, states: [{ status: 'submitted' }] }, { withheld: false, states: [{ count: 25 }] }]) {
      runtime.tables.set('form_states', malformed);
      const card = (await load('admin')).cards.find((row) => row.id === 'forms');
      expect(card?.unavailable, JSON.stringify(malformed)).toBe(true); expect(card?.message).not.toContain('No recorded figures');
    }
  });
  it('refuses initial or mid-read role/organization loss and cancelled reads', async () => {
    runtime.revoke = true; await expect(load()).rejects.toThrow('current role');
    runtime.revoke = false; runtime.rpc.mockResolvedValueOnce(okay({ staffAuthorized: true, organizationId: 'foreign', roles: ['vp'] }));
    await expect(load()).rejects.toThrow('current role');
    const controller = new AbortController(); controller.abort(); await expect(load('vp', controller.signal)).rejects.toThrow('current role');
    runtime.rpc.mockRejectedValueOnce(new Error('offline')); await expect(load()).rejects.toThrow('current role');
  });
  it.each<LeadershipHat>(['vp', 'president', 'coordinator', 'admin'])('refuses %s figures when the server-selected campaign is not the captured one', async (hat) => {
    expect(Array.isArray((await load(hat)).cards)).toBe(true);
    runtime.selection = ['chapter-b']; runtime.rpc.mockClear(); runtime.from.mockClear(); await expect(load(hat)).rejects.toThrow('current role');
    expect(runtime.rpc.mock.calls.map((row: unknown[]) => row[0])).toEqual(['get_my_mobile_staff_scope', 'get_my_chapter_memberships']); expect(runtime.from).not.toHaveBeenCalled();
    runtime.selection = ['chapter-a', 'chapter-b']; await expect(load(hat)).rejects.toThrow('current role');
    const base = runtime.rpc.getMockImplementation()!;
    runtime.rpc.mockImplementation(async (name: string, args: Record<string, unknown>) => name === 'get_my_chapter_memberships' ? { data: null, error: new Error('offline') } : base(name, args));
    await expect(load(hat)).rejects.toThrow('current role');
    runtime.rpc.mockImplementation(async (name: string, args: Record<string, unknown>) => name === 'get_my_chapter_memberships' ? okay([{ chapterId: 'chapter-a', organizationId: 'org-b', selected: true }]) : base(name, args));
    await expect(load(hat)).rejects.toThrow('current role');
  });
  it('keeps the organization-wide advisor portfolio independent of the campaign selection', async () => {
    runtime.selection = ['chapter-b', 'chapter-b'];
    expect(Array.isArray((await load('advisor')).cards)).toBe(true);
    expect(runtime.rpc).not.toHaveBeenCalledWith('get_my_chapter_memberships', expect.anything());
  });
  it('marks failed and malformed meeting/notice sources unavailable and never requests a failed meeting tally', async () => {
    const base = runtime.rpc.getMockImplementation()!;
    runtime.rpc.mockImplementation(async (name: string, args: Record<string, unknown>) => ['get_admin_events', 'list_my_member_notices'].includes(name) ? { data: null, error: new Error('offline') } : base(name, args));
    const failed = await load(); expect(failed.cards.find((row) => row.id === 'meetings')?.unavailable).toBe(true); expect(failed.cards.find((row) => row.id === 'reach')?.unavailable).toBe(true);
    expect(runtime.rpc.mock.calls.some((row: unknown[]) => row[0] === 'get_member_event_quorum')).toBe(false);
    runtime.rpc.mockImplementation(async (name: string, args: Record<string, unknown>) => ['get_admin_events', 'list_my_member_notices', 'list_coordinator_cases'].includes(name) ? okay({}) : base(name, args));
    expect((await load()).cards.find((row) => row.id === 'meetings')?.unavailable).toBe(true);
    expect((await load('coordinator')).cards.find((row) => row.id === 'unassigned')?.unavailable).toBe(true);
    expect((await load('admin')).cards.find((row) => row.id === 'events')?.unavailable).toBe(true);
  });
  it('sorts real meeting dates before selecting the latest four', async () => {
    const base = runtime.rpc.getMockImplementation()!;
    runtime.rpc.mockImplementation(async (name: string, args: Record<string, unknown>) => name === 'get_admin_events' ? okay([{ id: 'older', chapterId: 'chapter-a', eventKind: 'meeting', startsAt: '2026-10-01', title: 'Older' }, { id: 'newer', chapterId: 'chapter-a', eventKind: 'meeting', startsAt: '2026-10-31', title: 'Newer' }]) : base(name, args));
    await load(); expect(runtime.rpc).toHaveBeenCalledWith('get_member_event_quorum', { p_event_ids: ['newer', 'older'] });
  });
  // SEC-UG-NATIVE-LEADER-GATES-USE-TEN-WHERE-THE-ORGANIZATION-FLOOR-IS-25-20261115 (#8768).
  it('takes the privacy floor from the server staff scope and withholds when the two scope reads disagree', async () => {
    const forms = async () => (await load('admin')).cards.find((row) => row.id === 'forms')!;
    expect((await forms()).rows).toEqual([{ label: 'submitted', value: 25 }]);
    runtime.floors = [30, 30]; expect(await forms()).toMatchObject({ rows: [], message: 'Withheld: a reporting group is too small to share safely, or its size is not known.' });
    runtime.floors = [25, 30]; expect((await forms()).rows).toEqual([]);
    runtime.floors = [30, 25]; expect((await forms()).rows).toEqual([]);
    // A floor under 25 is held at 25; a missing floor withholds every figure.
    runtime.floors = [10, 10]; expect((await forms()).rows).toEqual([{ label: 'submitted', value: 25 }]);
    runtime.tables.set('form_states', { withheld: false, states: [{ status: 'submitted', count: 24 }] });
    runtime.floors = [10, 10]; expect((await forms()).rows).toEqual([]);
    runtime.tables.delete('form_states');
    // Gate round 1 on #8820 (r2s1): the server counted 50 forms from 25 people
    // at floor 25; the floor rose to 30 before the second scope read. The form
    // total cannot be rechecked against a person floor, so the card withholds.
    runtime.tables.set('form_states', { withheld: false, states: [{ status: 'submitted', count: 50 }] });
    runtime.floors = [25, 30]; expect(await forms()).toMatchObject({ rows: [], message: 'Withheld: a reporting group is too small to share safely, or its size is not known.' });
    runtime.floors = [30, 25]; expect((await forms()).rows).toEqual([]);
    runtime.floors = [30, 30]; expect((await forms()).rows).toEqual([{ label: 'submitted', value: 50 }]);
    // The floor read 30, changed to 25
    // while the server counted the forms, and was back at 30 for the second
    // read. Both scope reads agree, but the server says it applied 25, so the
    // card withholds. It shows when the server applied the floor the scope
    // reported, and withholds when the summary names no floor.
    runtime.floors = [30, 30]; runtime.formsFloor = [25];
    expect(await forms()).toMatchObject({ rows: [], message: 'Withheld: a reporting group is too small to share safely, or its size is not known.' });
    runtime.floors = [30, 30]; runtime.formsFloor = [30]; expect((await forms()).rows).toEqual([{ label: 'submitted', value: 50 }]);
    runtime.floors = [30, 30]; runtime.formsFloor = [null]; expect((await forms()).rows).toEqual([]);
    runtime.tables.set('form_states', { withheld: false, states: [{ status: 'submitted', count: 50 }], privacyFloor: undefined });
    runtime.floors = [30, 30]; expect((await forms()).rows).toEqual([]);
    runtime.tables.delete('form_states');
    for (const hat of ['vp', 'advisor', 'coordinator', 'admin'] satisfies LeadershipHat[]) {
      // A floor that changed between the two reads withholds every card.
      runtime.floors = [25, 26];
      expect((await load(hat)).cards.every((row) => !row.rows.length), hat).toBe(true);
      runtime.floors = [null, null];
      expect((await load(hat)).cards.every((row) => !row.rows.length), hat).toBe(true);
      runtime.floors = [25, null];
      expect((await load(hat)).cards.every((row) => !row.rows.length), hat).toBe(true);
    }
  });
});

// #9482 gate round 1 (r1s1, r2s1): the screen's 20-second deadline aborts the
// read's signal; the service must hand that signal to every call and send no
// call after it, so a hung call does not run on beside Retry.
describe('a leadership read stopped by its signal', () => {
  it('hands the signal to every call, sends nothing after the abort, and rejects', async () => {
    const controller = new AbortController();
    let answerEvents!: (value: unknown) => void;
    const scope = runtime.rpc.getMockImplementation()!;
    runtime.rpc.mockImplementation((name: string, args: Record<string, unknown>) => name === 'get_admin_events'
      ? new Promise((done) => { answerEvents = done; }) : scope(name, args));
    const read = load('vp', controller.signal);
    await vi.waitFor(() => expect(runtime.rpc).toHaveBeenCalledWith('get_admin_events', {}));
    controller.abort();
    answerEvents(okay([{ id: 'current', chapterId: 'chapter-a', eventKind: 'meeting', startsAt: '2026-10-31T20:00:00-04:00' }]));
    await expect(read).rejects.toThrow();
    expect(runtime.rpc).not.toHaveBeenCalledWith('get_member_event_quorum', expect.anything());
    expect(runtime.rpc).not.toHaveBeenCalledWith('get_member_notice_receipts', expect.anything());
    const sent = runtime.rpc.mock.calls.map((call: unknown[]) => call[0]);
    expect(runtime.signals.map(([name]) => name)).toEqual(sent);
    expect(runtime.signals.every(([, signal]) => signal === controller.signal)).toBe(true);
  });

  it('sends no call at all for a read aborted before it starts', async () => {
    const controller = new AbortController(); controller.abort();
    await expect(load('advisor', controller.signal)).rejects.toThrow();
    expect(runtime.rpc).not.toHaveBeenCalled();
  });
});
