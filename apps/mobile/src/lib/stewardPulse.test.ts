import { describe, expect, it, beforeEach, vi } from 'vitest';
import { nextStewardDeadline, normalizePulsePeople, pulseCount, pulseDate, pulseDeadlineLabel, pulseObject, pulseRows, pulseText, pulseTier, pulseUpdated } from './pulseCatalog';
import { loadPulsePeople, loadPulseScorePreference, loadStewardPulse, savePulseScorePreference } from '../services/stewardPulse';
import { pulsePalette } from '../theme/pulsePalette';
import { resolveTheme } from '../theme/tokens';

const backend = vi.hoisted(() => ({ configured: true, from: vi.fn(), rpc: vi.fn() }));
vi.mock('../services/supabase', () => ({ getSupabaseClient: () => backend.configured ? backend : null }));
type Read = { data: unknown; error: unknown };

function query(result: Read) {
  const chain: Record<string, ReturnType<typeof vi.fn>> = {};
  for (const method of ['select', 'eq', 'neq', 'is', 'lte', 'in', 'order', 'limit', 'abortSignal', 'update']) chain[method] = vi.fn(() => chain);
  chain.single = vi.fn(() => Promise.resolve(result));
  chain.then = vi.fn((resolve: (result: Read) => unknown) => Promise.resolve(result).then(resolve));
  return chain;
}
const signal = () => new AbortController().signal;

describe('committee member Pulse values and privacy', () => {
  it('shows timestamp deadlines in Eastern time and keeps a date-only deadline on its calendar date', () => {
    expect(pulseDeadlineLabel('2027-01-06T02:00:00+00:00')).toBe('Jan 5, 2027 · 9:00 PM ET');
    expect(pulseDeadlineLabel('2027-07-06T02:00:00+00:00')).toBe('Jul 5, 2027 · 10:00 PM ET');
    expect(pulseDeadlineLabel('2027-01-06')).toBe('Jan 6, 2027');
    expect(pulseDeadlineLabel('bad')).toBe('Deadline unavailable');
  });
  it('takes chart series from the active theme tokens', () => {
    const theme = { ...resolveTheme('union-ground', true), chartSeries1: '#123456', chartSeries2: '#654321', chartSeries3: '#abcdef' };
    expect(pulsePalette(theme).series).toEqual(['#123456', '#654321', '#abcdef']);
  });
  it('rejects malformed values without inventing zero counts', () => {
    for (const value of [null, '', -1, NaN, Infinity, 'bad', {}, 1.5]) expect(pulseCount(value)).toBeNull();
    expect(pulseCount('0')).toBe(0); expect(pulseCount(4)).toBe(4);
    expect(pulseObject(null)).toEqual({}); expect(pulseObject([])).toEqual({});
    expect(pulseRows(null)).toEqual([]); expect(pulseRows([null, { id: 'a' }])).toEqual([{}, { id: 'a' }]);
    expect(pulseText(null)).toBe(''); expect(pulseText('name')).toBe('name');
    expect(pulseDate('bad')).toBeNull(); expect(pulseDate('2026-10-31')).toBe('2026-10-31');
  });
  it('enforces hidden scores and anonymous aggregate views even for malformed payloads', () => {
    const payload = { level: 'steward', floor: 1, members: [{ id: 'a', name: 'A', score: 88, scoreHidden: true, lastActivity: '2026-10-31' }, { id: 'b', name: 'B', scoreHidden: false, score: 63, lastActivity: '2026-10-31' }, { id: 'bad', name: '', scoreHidden: false }], groups: [] };
    expect(normalizePulsePeople(payload, 'steward')).toMatchObject({ floor: 10, members: [{ score: null, scoreHidden: true, lastActivity: null }, { score: 63, scoreHidden: false }] });
    expect(() => normalizePulsePeople(null, 'steward')).toThrow('verified');
    expect(() => normalizePulsePeople(payload, 'local')).toThrow('verified');
    const aggregate = normalizePulsePeople({ ...payload, level: 'chapter', groups: [{ id: 'a', name: 'A', count: 9, score: 70, withheld: false }, { id: 'b', name: 'B', count: 10, score: 101, withheld: false }, { id: 'c', name: 'C', count: 10, score: 50, withheld: false }] }, 'chapter');
    expect(aggregate.members).toEqual([]);
    expect(aggregate.groups).toMatchObject([{ count: null, score: null, withheld: true }, { count: 10, score: null }, { score: 50 }]);
    expect(normalizePulsePeople({ ...payload, members: [{ id: 'b', name: 'B', score: 101, scoreHidden: false, lastActivity: 'bad' }] }, 'steward').members[0]).toMatchObject({ score: null, lastActivity: null });
  });
  it('labels every tier boundary and rejects missing or invalid scores', () => {
    for (const value of [null, NaN, -1, 101]) expect(pulseTier(value).label).toBe('Not enough activity');
    for (const [score, label] of [[0, 'Critical'], [24, 'Critical'], [25, 'Concerning'], [44, 'Concerning'], [45, 'Moderate'], [64, 'Moderate'], [65, 'Healthy'], [84, 'Healthy'], [85, 'Excellent'], [100, 'Excellent']] as const) expect(pulseTier(score).label).toBe(label);
  });
  it('ranks active issue and step deadlines, keeps overdue work, and ignores invalid, resolved and distant work', () => {
    const cases = [{ id: 'b', reference: 'B', title: 'B', deadline: '2026-11-04', status: 'active' }, { id: 'a', reference: 'A', title: 'A', deadline: '2026-11-02', status: 'active' }, { id: 'x', reference: 'X', title: 'X', deadline: '2026-10-01', status: 'resolved' }];
    const now = Date.parse('2026-10-31T15:00:00-04:00');
    expect(nextStewardDeadline(cases, [{ caseID: 'b', label: 'Step response', dueAt: '2026-10-30T12:00:00-04:00' }], now)?.item.id).toBe('b');
    expect(nextStewardDeadline(cases, [], now)?.item.id).toBe('a');
    expect(nextStewardDeadline([{ ...cases[0]!, deadline: null }], [], now)).toBeNull();
    expect(nextStewardDeadline([{ ...cases[0]!, deadline: 'invalid' }], [], now)).toBeNull();
    expect(nextStewardDeadline([{ ...cases[0]!, deadline: '2027-01-01' }], [], now)).toBeNull();
    expect(nextStewardDeadline([{ ...cases[0]!, deadline: '2026-12-10' }], [], Date.parse('2026-12-09T12:00:00-05:00'))?.item.id).toBe('b');
    expect(pulseUpdated(new Date('2026-10-31T18:40:00-04:00'))).toBe('Updated 6:40 PM ET');
    expect(pulseUpdated(new Date('bad'))).toBe('Update time unavailable');
  });
});

describe('committee member Pulse reads and failures', () => {
  beforeEach(() => { backend.configured = true; backend.from.mockReset(); backend.rpc.mockReset(); });
  function configure(fail: string | null = null) {
    const chains = new Map<string, ReturnType<typeof query>>();
    backend.from.mockImplementation((table: string) => {
      const data = table === 'member_cases' ? [{ id: 'case-a', reference: 'GR-1', case_type: 'Scheduling', step: 'Step 1', status: 'active', deadline: '2026-11-02' }] : table === 'member_events' ? [{ id: 'event-a', title: 'Campaign meeting' }] : [];
      const chain = query({ data: table === fail ? null : data, error: table === fail ? new Error('read refused') : null });
      chains.set(table, chain); return chain;
    });
    backend.rpc.mockImplementation((name: string) => {
      const data = name === 'get_steward_desk_kpis' ? [{ open_requests: 3, awaiting_reply: 2 }] : name === 'list_steward_forms' ? [{ total_count: 14 }] : name === 'get_steward_workload_intelligence' ? { available: true, categories: [{ key: 'pending', latest: 3.5 }] } : name === 'get_member_event_quorum' ? [{ eventId: 'event-a', checkedIn: 12, quorum: 10 }] : [];
      return query({ data: name === fail ? null : data, error: name === fail ? new Error('read refused') : null });
    });
    return chains;
  }
  it('scopes operational issues to the assignee and uses server totals and existing privacy floors', async () => {
    const chains = configure();
    const result = await loadStewardPulse('steward-a', signal());
    expect(chains.get('member_cases')?.eq).toHaveBeenCalledWith('steward_user_id', 'steward-a');
    expect(chains.get('member_cases')?.neq).toHaveBeenCalledWith('user_id', 'steward-a');
    // #7015: the caseload row names the case by type and step; the topic is never read.
    expect(chains.get('member_cases')?.select).toHaveBeenCalledWith('id,reference,case_type,step,deadline,status');
    expect(result.cases).toEqual([expect.objectContaining({ id: 'case-a', reference: 'GR-1', title: 'Scheduling · Step 1' })]);
    expect(chains.get('casework_deadlines')?.in).toHaveBeenCalledWith('status', ['active', 'extended', 'missed']);
    expect(result.cards.find((card) => card.id === 'forms')?.rows).toEqual([{ label: 'Waiting for review', value: 14 }]);
    expect(result.cards.find((card) => card.id === 'requests')?.rows.map((row) => row.value)).toEqual([3, 2]);
    expect(result.cards.find((card) => card.id === 'workload')?.rows).toEqual([{ label: 'Pending work', value: 3.5 }]);
    expect(result.cards.find((card) => card.id === 'workload')?.privacy).toContain('25');
    expect(result.cards.find((card) => card.id === 'quorum')?.rows.map((row) => row.value)).toEqual([12, 10]);
    expect(result.deadlinesAvailable).toBe(true);
  });
  it('names a caseload row by its topic only where the server says a switch shows it (#7043)', async () => {
    configure();
    const original = backend.rpc.getMockImplementation()!;
    backend.rpc.mockImplementation((name: string, ...args: unknown[]) => name === 'list_case_row_titles'
      ? query({ data: [{ id: 'case-a', title: 'Overtime withheld', topicShown: true }, { id: 'other', title: 'Not mine', topicShown: true }], error: null })
      : original(name, ...args));
    const result = await loadStewardPulse('steward-a', signal());
    expect(backend.rpc).toHaveBeenCalledWith('list_case_row_titles', { p_case_ids: ['case-a'] });
    expect(result.cases).toEqual([expect.objectContaining({ id: 'case-a', title: 'Overtime withheld' })]);
    backend.rpc.mockImplementation((name: string, ...args: unknown[]) => name === 'list_case_row_titles' ? query({ data: null, error: new Error('refused') }) : original(name, ...args));
    expect((await loadStewardPulse('steward-a', signal())).cases[0]?.title).toBe('Scheduling · Step 1');
  });
  it('keeps distinct labels for workload categories the client has not seen before', async () => {
    configure();
    const original = backend.rpc.getMockImplementation()!;
    backend.rpc.mockImplementation((name: string, ...args: unknown[]) => name === 'get_steward_workload_intelligence'
      ? query({ data: { available: true, categories: [{ key: 'new_assignments', latest: 3 }, { key: 'late-handoffs', latest: 5 }] }, error: null })
      : original(name, ...args));
    const result = await loadStewardPulse('steward-a', signal());
    expect(result.cards.find((card) => card.id === 'workload')?.rows).toEqual([
      { label: 'New assignments', value: 3 },
      { label: 'Late handoffs', value: 5 },
    ]);
  });
  it('counts completed non-cancelled meetings before the four-meeting limit, leaving future and other meetings out of quorum', async () => {
    configure();
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-11-01T12:00:00-05:00'));
    try {
      const past = { id: 'past', title: 'Eligible meeting', starts_at: '2026-10-31T12:00:00-04:00', event_kind: 'meeting', cancelled_at: null, checkedIn: 12 };
      const fixtures = [past, ...Array.from({ length: 4 }, (_, index) => ({ ...past, id: `future-${index}`, starts_at: `2026-11-0${index + 2}T12:00:00-05:00`, checkedIn: 0 })),
        { ...past, id: 'cancelled', starts_at: '2026-11-01T10:00:00-05:00', cancelled_at: '2026-10-30', checkedIn: 0 },
        { ...past, id: 'action', starts_at: '2026-11-01T11:00:00-05:00', event_kind: 'action', checkedIn: 0 }];
      const read: Read = { data: fixtures, error: null }, events = query(read);
      let selected = fixtures;
      const filter = (column: string, value: unknown) => { selected = selected.filter(row => row[column as keyof typeof row] === value); read.data = selected; return events; };
      events.eq = vi.fn(filter); events.is = vi.fn(filter);
      events.lte = vi.fn((_column: string, value: string) => { selected = selected.filter(row => Date.parse(row.starts_at) <= Date.parse(value)); read.data = selected; return events; });
      events.order = vi.fn(() => { selected = [...selected].sort((a, b) => Date.parse(b.starts_at) - Date.parse(a.starts_at)); read.data = selected; return events; });
      events.limit = vi.fn((count: number) => { selected = selected.slice(0, count); read.data = selected; return events; });
      const originalFrom = backend.from.getMockImplementation()!, originalRPC = backend.rpc.getMockImplementation()!;
      backend.from.mockImplementation((table: string) => table === 'member_events' ? events : originalFrom(table));
      backend.rpc.mockImplementation((name: string, args: Record<string, unknown>) => name === 'get_member_event_quorum'
        ? query({ data: fixtures.filter(row => (args.p_event_ids as string[]).includes(row.id)).map(row => ({ eventId: row.id, checkedIn: row.checkedIn, quorum: 10 })), error: null }) : originalRPC(name, args));
      const card = (await loadStewardPulse('steward-a', signal())).cards.find(card => card.id === 'quorum');
      expect(card?.rows).toEqual([{ label: 'Eligible meeting · checked in', value: 12 }, { label: 'Eligible meeting · quorum target', value: 10 }]);
    } finally { vi.useRealTimers(); }
  });
  it.each(['member_cases', 'casework_deadlines', 'get_steward_desk_kpis', 'list_steward_forms', 'list_unassigned_chapter_cases', 'get_steward_workload_intelligence', 'member_events', 'get_member_event_quorum'])('reports a failed %s read without a caught-up assertion', async (failed) => {
    configure(failed);
    const data = await loadStewardPulse('steward-a', signal());
    expect(data.cards.some((card) => card.unavailable) || !data.deadlinesAvailable).toBe(true);
    if (failed === 'member_cases' || failed === 'casework_deadlines') expect(data.deadlinesAvailable).toBe(false);
  });
  it.each(['get_steward_workload_intelligence', 'get_member_event_quorum', 'member_events'])('calls a failed %s read a load failure, not an eligibility or privacy result', async (failed) => {
    // BUG-UG-STEWARD-PULSE-READ-FAILURE-SHOWN-AS-PRIVACY-FLOOR-20261102
    configure(failed);
    const cards = (await loadStewardPulse('steward-a', signal())).cards;
    const card = cards.find((row) => row.id === (failed === 'get_steward_workload_intelligence' ? 'workload' : 'quorum'));
    expect(card?.unavailable).toBe(true);
    expect(card?.message).toBeUndefined();
  });
  it('keeps the eligibility and privacy-floor messages for reads that succeeded', async () => {
    configure();
    const original = backend.rpc.getMockImplementation()!;
    backend.rpc.mockImplementation((name: string, ...args: unknown[]) => name === 'get_steward_workload_intelligence' ? query({ data: { available: false, categories: [] }, error: null })
      : name === 'get_member_event_quorum' ? query({ data: [{ eventId: 'event-a', checkedIn: 4, quorum: 10 }], error: null }) : original(name, ...args));
    const cards = (await loadStewardPulse('steward-a', signal())).cards;
    expect(cards.find((row) => row.id === 'workload')).toMatchObject({ unavailable: false, message: 'Not enough eligible weekly reports to show workload signals.' });
    expect(cards.find((row) => row.id === 'quorum')).toMatchObject({ unavailable: false, message: 'No meeting figures clear the privacy floor yet.' });
  });
  it('masks meeting figures below ten and discloses proven truncation', async () => {
    configure();
    const original = backend.rpc.getMockImplementation()!;
    backend.rpc.mockImplementation((name: string, ...args: unknown[]) => name === 'get_member_event_quorum' ? query({ data: [{ eventId: 'event-a', checkedIn: 9, quorum: 10 }], error: null }) : original(name, ...args));
    expect((await loadStewardPulse('steward-a', signal())).cards.find((card) => card.id === 'quorum')?.rows).toEqual([]);
    backend.from.mockImplementation((table: string) => query({ data: table === 'member_cases' ? Array.from({ length: 201 }, (_, index) => ({ id: String(index), status: 'active' })) : [], error: null }));
    const result = await loadStewardPulse('steward-a', signal());
    expect(result.cases.length).toBe(200); expect(result.casesTruncated).toBe(true); expect(result.deadlinesAvailable).toBe(false);
  });
  it('does not interpret a malformed successful response as an empty queue', async () => {
    backend.from.mockReturnValue(query({ data: null, error: null }));
    backend.rpc.mockReturnValue(query({ data: null, error: null }));
    const result = await loadStewardPulse('steward-a', signal());
    expect(result.deadlinesAvailable).toBe(false);
    for (const id of ['caseload', 'requests', 'forms', 'unassigned', 'quorum']) expect(result.cards.find((card) => card.id === id)?.unavailable).toBe(true);
  });
  it('uses the server projection for People and persists only the caller score preference', async () => {
    backend.rpc.mockReturnValue(query({ data: { level: 'steward', floor: 10, members: [], groups: [] }, error: null }));
    expect((await loadPulsePeople('steward', signal())).members).toEqual([]);
    expect(backend.rpc).toHaveBeenCalledWith('get_steward_pulse_people', { p_level: 'steward' });
    const chain = query({ data: { pulse_score_visible: false }, error: null }); backend.from.mockReturnValue(chain);
    expect(await loadPulseScorePreference('member-a')).toBe(false);
    backend.rpc.mockReturnValue(query({ data: { updated: true }, error: null }));
    expect(await savePulseScorePreference('member-a', false)).toBe(false);
    expect(backend.rpc).toHaveBeenLastCalledWith('update_my_member_profile', { p_expected_user_id: 'member-a', p_fields: { pulse_score_visible: false } });
    expect(chain.eq).toHaveBeenCalledWith('id', 'member-a'); expect(chain.update).not.toHaveBeenCalled();
    await expect(savePulseScorePreference('member-a', true)).rejects.toThrow('not saved');
    backend.rpc.mockReturnValue(query({ data: null, error: new Error('save refused') })); await expect(savePulseScorePreference('member-a', true)).rejects.toThrow('save refused');
    backend.rpc.mockReturnValue(query({ data: { updated: true }, error: null }));
    backend.from.mockReturnValue(query({ data: {}, error: null })); await expect(loadPulseScorePreference('member-a')).rejects.toThrow('verified');
    backend.from.mockReturnValue(query({ data: null, error: new Error('refused') }));
    await expect(loadPulseScorePreference('member-a')).rejects.toThrow('refused'); await expect(savePulseScorePreference('member-a', false)).rejects.toThrow('refused');
    backend.rpc.mockReturnValue(query({ data: null, error: new Error('refused') })); await expect(loadPulsePeople('steward', signal())).rejects.toThrow('refused');
    backend.configured = false;
    await expect(loadStewardPulse('a', signal())).rejects.toThrow('configured'); await expect(loadPulsePeople('steward', signal())).rejects.toThrow('configured');
    await expect(loadPulseScorePreference('a')).rejects.toThrow('configured'); await expect(savePulseScorePreference('a', true)).rejects.toThrow('configured');
  });
});

function luminance(hex: string) {
  const rgb = [1, 3, 5].map((at) => parseInt(hex.slice(at, at + 2), 16) / 255).map((part) => part <= 0.04045 ? part / 12.92 : ((part + 0.055) / 1.055) ** 2.4);
  return rgb[0]! * 0.2126 + rgb[1]! * 0.7152 + rgb[2]! * 0.0722;
}
function contrast(a: string, b: string) { const x = luminance(a), y = luminance(b); return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05); }
describe('Pulse computed light and dark contrast', () => {
  it.each(['union-ground', 'union-ground-dark'] as const)('keeps text and meaningful marks readable in %s', (key) => {
    const theme = resolveTheme('union-ground', key === 'union-ground-dark'), colors = pulsePalette(theme);
    for (const surface of [theme.card, theme.background]) {
      for (const text of [theme.foreground, theme.mutedForeground]) expect(contrast(text, surface)).toBeGreaterThanOrEqual(4.5);
      for (const mark of [...colors.series, ...colors.tiers]) expect(contrast(mark, surface)).toBeGreaterThanOrEqual(3);
    }
    expect(contrast(theme.primary, theme.primaryForeground)).toBeGreaterThanOrEqual(4.5);
    expect(contrast(theme.secondary, theme.secondaryForeground)).toBeGreaterThanOrEqual(4.5);
  });
});
