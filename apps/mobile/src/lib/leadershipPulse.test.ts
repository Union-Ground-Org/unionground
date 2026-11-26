import { describe, expect, it } from 'vitest';
import { leadershipHat, leadershipPulse, leadershipPulseForDisplay, organizationFloor, type LeadershipHat, type LeadershipInput, type LeadershipRead } from './leadershipPulse';
const read = (data: unknown): LeadershipRead => ({ data, error: null });
const now = new Date('2026-11-01T12:00:00-05:00');
// The organization floors the server reports in the staff scope (never below 25).
const floors = { privacy: 25, chapterHealth: 25 };
function vp(): LeadershipInput { return { floors, overview: read({ memberCount: 100, newThisYear: 30, turnout: { totalVotes: 50, quorumTarget: 40 }, attention: [{ memberName: 'PRIVATE PERSON', title: 'PRIVATE CASE' }] }), events: read([{ id: 'm', title: 'Campaign meeting' }]), quorum: read([{ eventId: 'm', checkedIn: 40, quorum: 50 }]), notices: read([{ id: 'n', title: 'Campaign notice' }]), receipts: read([{ id: 'n', readCount: 60, audienceCount: 100, readers: ['PRIVATE READER'] }]) }; }
function coordinator(): LeadershipInput {
  const cases = Array.from({ length: 75 }, (_, index) => ({ id: `case-${index}`, user_id: `person-${index}`, status: index < 50 ? 'active' : 'resolved', chapter_id: 'chapter-a', steward_user_id: index < 25 ? null : 'assigned' }));
  return { floors, workload: read({ enoughData: true, submittersBand: '25-49', period: '2026-Q3', categories: [{ key: 'pending', avg: 4, p90: 20 }, { key: 'todos', avg: 10, p90: 12 }] }), cases: read(cases), unassigned: read(cases.slice(0, 25)) };
}
function admin(): LeadershipInput { return { floors, overview: read({ memberCount: 100 }), mfa: read({ staffTotal: 100, staffEnrolled: 70 }), logins: read({ openCount: 15, verifiedSubjects: 25 }), events: read([{}, {}]), forms: read({ withheld: false, states: [{ status: 'approved', count: 25 }, { status: 'submitted', count: 30 }], privacyFloor: 25 }) }; }
const byID = (input: ReturnType<typeof leadershipPulse>, id: string) => input.cards.find((row) => row.id === id)!;

describe('leadership aggregates and the reporting floor', () => {
  it('keeps privacy descriptions accurate without a fixed group-size claim', () => {
    const views = [leadershipPulse('vp', vp()), leadershipPulse('president', vp()),
      leadershipPulse('advisor', { floors, health: read([]) }), leadershipPulse('coordinator', coordinator()), leadershipPulse('admin', admin())];
    for (const view of views) {
      for (const item of view.cards) {
        expect([item.message, item.privacy, item.notCounted, item.period].join(' ')).not.toMatch(/fewer than ten|under ten|at least ten|ten-person/);
      }
    }
  });
  it('selects one explicit leadership hat without adding a treasurer surface', () => {
    for (const hat of ['president', 'vp', 'advisor', 'coordinator', 'admin']) expect(leadershipHat([hat])).toBe(hat);
    for (const roles of [[], ['member'], ['treasurer'], ['vp', 'admin'], ['vp', 'unknown']]) expect(leadershipHat(roles)).toBeNull();
  });
  it.each(['vp', 'president'] as const)('uses recorded readiness and notice counts for %s, never people or issue details', (hat) => {
    const result = leadershipPulse(hat, vp(), now);
    expect(result.week).toMatchObject({ title: 'Can the campaign act?', href: '/feature/events-desk' });
    expect(result.week.detail).toContain('40'); expect(result.week.detail).toContain('50');
    expect(result.cards.map((row) => row.number)).toEqual(['01', '02', '03', '04']);
    expect(byID(result, 'reach').rows.map((row) => row.value)).toEqual([60, 100]);
    expect(JSON.stringify(result)).not.toContain('PRIVATE');
  });
  it('withholds membership when the workers who joined before this year fall below the floor', () => {
    for (const [members, joined] of [[40, 25], [49, 25], [25, 26], [100, 91], [100, 24]]) {
      const input = vp(); input.overview = read({ memberCount: members, newThisYear: joined, turnout: { totalVotes: 50, quorumTarget: 40 } });
      expect(byID(leadershipPulse('vp', input), 'membership')).toMatchObject({ rows: [], unavailable: false });
    }
    for (const [members, joined] of [[50, 25], [100, 0], [25, 25], [100, 30]]) {
      const input = vp(); input.overview = read({ memberCount: members, newThisYear: joined, turnout: { totalVotes: 50, quorumTarget: 40 } });
      expect(byID(leadershipPulse('vp', input), 'membership').rows).toEqual([{ label: 'Campaign workers', value: members }, { label: 'Joined this year', value: joined }]);
    }
  });
  it('protects membership, turnout, attendance and both notice complements; malformed or failed reads never become zero', () => {
    const input = vp();
    input.overview = read({ memberCount: 24, newThisYear: 24, turnout: { totalVotes: 24, quorumTarget: 10 } });
    expect(leadershipPulse('vp', input).cards.every((row) => row.rows.length === 0)).toBe(true);
    for (const count of [1, 24, 76, 99, 101, null]) {
      const next = vp(); next.receipts = read([{ id: 'n', readCount: count, audienceCount: 100 }]);
      expect(byID(leadershipPulse('vp', next), 'reach').rows).toEqual([]);
    }
    const zero = vp(); zero.receipts = read([{ id: 'n', readCount: 0, audienceCount: 100 }]);
    expect(byID(leadershipPulse('vp', zero), 'reach').rows[0]?.value).toBe(0);
    const small = vp(); small.quorum = read([{ eventId: 'm', checkedIn: 24, quorum: 50 }]);
    expect(byID(leadershipPulse('vp', small), 'meetings').rows).toEqual([]);
    small.quorum = read([{ eventId: 'm', checkedIn: null, quorum: 50 }]); expect(byID(leadershipPulse('vp', small), 'meetings').rows).toEqual([]);
    const noTurnout = vp(); noTurnout.overview = read({ memberCount: 100, newThisYear: 20 }); expect(byID(leadershipPulse('vp', noTurnout), 'turnout').unavailable).toBe(true);
    for (const key of ['overview', 'events', 'quorum', 'notices', 'receipts'] as const) {
      const next = vp(); next[key] = { data: null, error: new Error('offline') };
      const result = leadershipPulse('vp', next); expect(JSON.stringify(result)).not.toContain('NaN');
      expect(result.cards.some((row) => row.unavailable || !row.rows.length)).toBe(true);
    }
    expect(leadershipPulse('vp', {}).cards.every((row) => !row.rows.length)).toBe(true);
    expect(leadershipPulse('vp', { ...vp(), floors: undefined }).cards.every((row) => !row.rows.length)).toBe(true);
  });
  it('chooses a protected dated health snapshot and detects worsening only across distinct ordered dates', () => {
    const healthy = { chapterName: 'Tamarack East', memberCount: 50, cohortProtected: false, measuredOn: '2026-10-31', score: 70, recordedBy: 'PRIVATE AUTHOR', coaching: ['PRIVATE NOTE'] };
    const declining = { ...healthy, chapterName: 'Tamarack West', score: 60, trend: [{ measuredOn: '2026-10-01', score: 80 }, { measuredOn: '2026-10-31', score: 60 }, { measuredOn: '2099-01-01', score: 0 }] };
    const protectedRow = { ...healthy, chapterName: 'PROTECTED CAMPAIGN', cohortProtected: true, memberCount: null, score: null };
    const result = leadershipPulse('advisor', { floors, health: read([healthy, declining, protectedRow]) });
    expect(result.week.title).toContain('Worsening recorded trend: Tamarack West'); expect(result.week.detail).toContain('Moderate');
    expect(result.cards[0]?.rows).toHaveLength(2); expect(JSON.stringify(result)).not.toMatch(/PRIVATE|PROTECTED CHAPTER/);
    const english = leadershipPulseForDisplay(result, 'en');
    expect(english?.week.detail).toContain('measured Oct 31, 2026');
    expect(english?.cards[0]?.rows.map((row) => row.label)).toEqual([
      'Tamarack West · Moderate · Oct 31, 2026',
      'Tamarack East · Healthy · Oct 31, 2026',
    ]);
    const spanish = leadershipPulseForDisplay(result, 'es');
    expect(spanish?.week.detail).toMatch(/^Moderado · 60\/100 · /);
    expect(spanish?.week.detail).toContain('Medición del 31 oct 2026. La puntuación corresponde a esa fecha y no se actualiza en tiempo real.');
    expect(spanish?.cards[0]?.rows.map((row) => row.label)).toEqual([
      'Tamarack West · Moderado · 31 oct 2026',
      'Tamarack East · Saludable · 31 oct 2026',
    ]);
    expect(result.cards[0]?.message).toContain("hidden by the organization's privacy rule");
    expect(result.cards[0]?.notCounted).toContain('Privacy-protected campaigns');
    expect(result.cards[0]?.privacy).toContain('Groups that do not meet the privacy rule stay hidden.');
    expect(JSON.stringify(result)).not.toMatch(/fewer than ten|ten-person|at least ten/);
    const tied = { ...declining, trend: [{ measuredOn: '2026-10-31', score: 80 }, { measuredOn: '2026-10-31', score: 60 }] };
    expect(leadershipPulse('advisor', { floors, health: read([healthy, tied]) }).week.title).toContain('Lowest recorded health');
    expect(leadershipPulse('advisor', { floors, health: read([]) }).cards[0]?.message).toContain('No recorded');
    expect(leadershipPulse('advisor', { floors }).cards[0]?.unavailable).toBe(true);
  });
  it('formats portfolio dates even when the weekly callout has no measurement day', () => {
    const first = { chapterName: 'Tamarack East', memberCount: 50, cohortProtected: false, measuredOn: '2026-10-31', score: 70 };
    const second = { ...first, chapterName: 'Tamarack West', measuredOn: '2026-02-30' };
    const result = leadershipPulse('advisor', { floors, health: read([first, second]) });
    const { title, detail, href } = result.week;
    const week = { title, detail, href };
    const formatted = leadershipPulseForDisplay({ ...result, week }, 'en');
    expect(formatted?.week).toEqual(week);
    expect(formatted?.cards[0]?.rows.map((row) => row.label)).toEqual([
      'Tamarack East · Healthy · Oct 31, 2026',
      'Tamarack West · Healthy · Date unavailable',
    ]);
  });
  it('uses protected workload averages and distinct-person issue cells, including assignment complements', () => {
    const input = coordinator(), result = leadershipPulse('coordinator', input);
    expect(result.week.title).toBe('Rebalance pending work'); expect(byID(result, 'workload').rows[0]?.value).toBe(4);
    expect(byID(result, 'flow').rows.map((row) => row.value)).toEqual([50, 25]); expect(byID(result, 'unassigned').rows[0]?.value).toBe(25);
    const crowded = coordinator(); crowded.cases = read((crowded.cases!.data as Record<string, unknown>[]).map((row, index) => index < 25 ? { ...row, user_id: 'one-person' } : row));
    expect(byID(leadershipPulse('coordinator', crowded), 'flow').rows).toEqual([]); expect(byID(leadershipPulse('coordinator', crowded), 'unassigned').rows).toEqual([]);
    const missing = coordinator(); missing.cases = read([]); expect(byID(leadershipPulse('coordinator', missing), 'flow').rows).toEqual([]);
    const none = coordinator(); none.unassigned = read([]); expect(byID(leadershipPulse('coordinator', none), 'unassigned').rows[0]?.value).toBe(0);
    none.cases = read([{ id: 'bad' }]); expect(byID(leadershipPulse('coordinator', none), 'unassigned').rows).toEqual([]);
    none.unassigned = read([{ id: 'bad' }]); expect(byID(leadershipPulse('coordinator', none), 'unassigned').rows).toEqual([]);
    const locked = coordinator(); locked.workload = read({ enoughData: false, locked: true }); expect(byID(leadershipPulse('coordinator', locked), 'workload').rows).toEqual([]);
    const bad = coordinator(); bad.workload = read({ enoughData: true, submittersBand: '1-9', categories: [{ key: 'private', avg: 1, p90: 2 }] }); expect(byID(leadershipPulse('coordinator', bad), 'workload').rows).toEqual([]);
    for (const key of ['workload', 'cases', 'unassigned'] as const) { const next = coordinator(); next[key] = { data: null, error: {} }; expect(leadershipPulse('coordinator', next).cards.some((row) => row.unavailable)).toBe(true); }
  });
  it('withholds both issue charts for small campaign/assignment complements or unverifiable metadata', () => {
    for (const change of [
      { chapter_id: 'small-chapter' }, { steward_user_id: null }, { steward_user_id: '' },
      { steward_user_id: undefined }, { chapter_id: '' }, { user_id: '' },
    ]) {
      const input = coordinator();
      const rows = input.cases!.data as Record<string, unknown>[];
      input.cases = read([...rows.slice(0, 25), ...rows.slice(25, 50)].map((row, index) => index === 25 ? { ...row, ...change } : row));
      const result = leadershipPulse('coordinator', input);
      expect(byID(result, 'flow').rows).toEqual([]); expect(byID(result, 'unassigned').rows).toEqual([]);
    }
    const missing = coordinator(); missing.cases = read([{ id: 'bad', status: 'active', user_id: 'one', chapter_id: 'chapter-a' }]);
    expect(byID(leadershipPulse('coordinator', missing), 'flow').rows).toEqual([]);
    const empty = coordinator(); empty.cases = read([]); empty.unassigned = read([]);
    expect(byID(leadershipPulse('coordinator', empty), 'flow')).toMatchObject({ rows: [], unavailable: false, message: 'No recorded figures in this view.' });
    expect(byID(leadershipPulse('coordinator', empty), 'unassigned').rows).toEqual([]);
  });
  it('uses the admin attention count only with a verified population and withholds small form states whole', () => {
    const input = admin(), result = leadershipPulse('admin', input);
    expect(result.week.title).toBe('Review access reports'); expect(byID(result, 'forms').rows).toHaveLength(2);
    expect(byID(result, 'events').rows[0]?.value).toBe(2);
    input.logins = read({ openCount: 100, verifiedSubjects: 1 });
    expect(byID(leadershipPulse('admin', input), 'attention').rows).toEqual([]); expect(leadershipPulse('admin', input).week.title).toBe('Check two-step enrollment');
    // The server applies the floor; a withheld summary carries no counts and shows the withheld message.
    input.forms = read({ withheld: true, states: null });
    const protectedForms = byID(leadershipPulse('admin', input), 'forms');
    expect(protectedForms).toMatchObject({ rows: [], unavailable: false, message: 'Withheld: a reporting group is too small to share safely, or its size is not known.' });
    expect(protectedForms.notCounted).toContain('states that do not meet the privacy rule');
    // A count under the floor that reached the client anyway is still withheld, never shown.
    input.forms = read({ withheld: false, states: [{ status: 'approved', count: 25 }, { status: 'submitted', count: 24 }], privacyFloor: 25 });
    expect(byID(leadershipPulse('admin', input), 'forms').rows).toEqual([]);
    // Ledger 367: the counts show only when the server applied the floor both
    // scope reads reported. Counts checked against 25 while the scope says 30
    // stay withheld even though each meets 30; so does a missing or other floor.
    const thirty = { ...input, floors: { privacy: 30, chapterHealth: 30 } };
    const counts = [{ status: 'approved', count: 30 }, { status: 'submitted', count: 31 }];
    expect(byID(leadershipPulse('admin', { ...thirty, forms: read({ withheld: false, states: counts, privacyFloor: 30 }) }), 'forms').rows).toHaveLength(2);
    for (const privacyFloor of [25, 40, null, undefined, 'many']) {
      const forms = byID(leadershipPulse('admin', { ...thirty, forms: read({ withheld: false, states: counts, privacyFloor }) }), 'forms');
      expect(forms, String(privacyFloor)).toMatchObject({ rows: [], unavailable: false });
    }
    input.mfa = read({ staffTotal: 20, staffEnrolled: 19 }); expect(byID(leadershipPulse('admin', input), 'access').rows).toEqual([]); expect(leadershipPulse('admin', input).week.detail).toContain('not treat them as zero');
    input.forms = read([{ user_id: 'one' }]); expect(byID(leadershipPulse('admin', input), 'forms').unavailable).toBe(true);
    input.forms = read({ withheld: false, states: [{ status: 'approved' }] }); expect(byID(leadershipPulse('admin', input), 'forms').unavailable).toBe(true);
    expect(leadershipPulse('admin', {}).cards.every((row) => row.unavailable)).toBe(true);
  });
  it('sets the access-report floor from the organization inbox, not the selected campaign register', () => {
    const input = admin(); input.overview = read({ memberCount: 3 });
    expect(byID(leadershipPulse('admin', input), 'attention').rows).toEqual([{ label: 'Open sign-in reports', value: 15 }]);
    input.overview = { data: null, error: new Error('offline') }; input.logins = read({ openCount: 0, verifiedSubjects: 0 });
    expect(byID(leadershipPulse('admin', input), 'attention')).toMatchObject({ rows: [{ label: 'Open sign-in reports', value: 0 }], message: undefined });
    input.logins = read({ openCount: 4, verifiedSubjects: 4 }); expect(byID(leadershipPulse('admin', input), 'attention').rows).toEqual([]);
  });
});

// SEC-UG-NATIVE-LEADER-GATES-USE-TEN-WHERE-THE-ORGANIZATION-FLOOR-IS-25-20261115 (#8768):
// every leader card follows the organization floor the server reports, never
// a fixed ten: a group of 24 is withheld and a group of 25 is shown.
describe('leader cards follow the organization privacy floor', () => {
  const cases = (people: number, unassigned: number) => Array.from({ length: people }, (_, index) => ({ id: `case-${index}`, user_id: `person-${index}`, status: 'active', chapter_id: 'chapter-a', steward_user_id: index < unassigned ? null : 'assigned' }));
  const groups: [string, string, (size: number) => [LeadershipHat, LeadershipInput]][] = [
    ['membership', 'campaign workers and the workers who joined earlier', (size) => ['vp', { ...vp(), overview: read({ memberCount: size + 25, newThisYear: 25, turnout: { totalVotes: 50, quorumTarget: 40 } }) }]],
    ['membership', 'the campaign cohort', (size) => ['president', { ...vp(), overview: read({ memberCount: size, newThisYear: 0, turnout: { totalVotes: 0, quorumTarget: 0 } }) }]],
    ['meetings', 'meeting check-ins', (size) => ['vp', { ...vp(), quorum: read([{ eventId: 'm', checkedIn: size, quorum: 50 }]) }]],
    ['turnout', 'vote votes', (size) => ['vp', { ...vp(), overview: read({ memberCount: 100, newThisYear: 30, turnout: { totalVotes: size, quorumTarget: 40 } }) }]],
    ['reach', 'notice readers', (size) => ['vp', { ...vp(), receipts: read([{ id: 'n', readCount: size, audienceCount: 100 }]) }]],
    ['reach', 'the notice audience', (size) => ['vp', { ...vp(), receipts: read([{ id: 'n', readCount: 0, audienceCount: size }]) }]],
    ['health', 'a campaign health cohort', (size) => ['advisor', { floors, health: read([{ chapterName: 'Tamarack East', memberCount: size, cohortProtected: false, measuredOn: '2026-10-31', score: 70 }]) }]],
    ['flow', 'an issue status group', (size) => ['coordinator', { ...coordinator(), cases: read(cases(size + 25, 25).map((row, index) => index >= 25 && index < 25 + size ? row : { ...row, status: index < 25 ? 'active' : 'resolved', steward_user_id: index < 25 ? null : 'assigned' })), unassigned: read([]) }]],
    ['unassigned', 'the people with unassigned issues', (size) => ['coordinator', { ...coordinator(), cases: read([...cases(size, size), ...cases(50, 0).map((row) => ({ ...row, id: `other-${row.id}`, user_id: `other-${row.user_id}` }))]), unassigned: read(cases(size, size)) }]],
    ['access', 'staff accounts', (size) => ['admin', { ...admin(), mfa: read({ staffTotal: size + 25, staffEnrolled: size }) }]],
    ['attention', 'the access-report subjects', (size) => ['admin', { ...admin(), logins: read({ openCount: 3, verifiedSubjects: size }) }]],
    ['events', 'the campaign cohort', (size) => ['admin', { ...admin(), overview: read({ memberCount: size }) }]],
    ['forms', 'a form state', (size) => ['admin', { ...admin(), forms: read({ withheld: false, states: [{ status: 'approved', count: 30 }, { status: 'submitted', count: size }], privacyFloor: 25 }) }]],
  ];
  it.each(groups)('%s: withholds %s at 24 and shows it at 25', (id, _group, build) => {
    const [hatAt24, at24] = build(24), [hatAt25, at25] = build(25);
    expect(byID(leadershipPulse(hatAt24, at24), id).rows).toEqual([]);
    // The portfolio hides one small chapter and says so; every other card withholds whole.
    expect(byID(leadershipPulse(hatAt24, at24), id).message).toBe(id === 'health' ? "Some campaigns have no dated snapshot yet or are hidden by the organization's privacy rule." : 'Withheld: a reporting group is too small to share safely, or its size is not known.');
    expect(byID(leadershipPulse(hatAt25, at25), id).rows.length).toBeGreaterThan(0);
  });
  it.each(groups)('%s: follows a higher organization floor for %s', (id, _group, build) => {
    const [hat, input] = build(25);
    const raised = { ...input, floors: { privacy: 26, chapterHealth: 26 } };
    expect(byID(leadershipPulse(hat, raised), id).rows).toEqual([]);
  });
  it.each(groups)('%s: withholds %s when the server reported no floor', (id, _group, build) => {
    const [hat, input] = build(25);
    expect(byID(leadershipPulse(hat, { ...input, floors: undefined }), id).rows).toEqual([]);
    expect(byID(leadershipPulse(hat, { ...input, floors: { privacy: null, chapterHealth: null } }), id).rows).toEqual([]);
  });
  it('never applies a floor below 25, whatever the server reports', () => {
    expect([organizationFloor(10), organizationFloor(0), organizationFloor(25), organizationFloor(40)]).toEqual([25, 25, 25, 40]);
    expect([organizationFloor(null), organizationFloor(undefined), organizationFloor('many'), organizationFloor(-1)]).toEqual([null, null, null, null]);
    const input = { ...admin(), floors: { privacy: 10, chapterHealth: 10 }, forms: read({ withheld: false, states: [{ status: 'submitted', count: 24 }], privacyFloor: 25 }) };
    expect(byID(leadershipPulse('admin', input), 'forms').rows).toEqual([]);
  });
});
