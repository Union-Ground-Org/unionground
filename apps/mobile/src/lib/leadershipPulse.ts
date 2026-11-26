import { PULSE_HEALTH_BANDS, PULSE_WORKLOAD_LABELS, pulseCount, pulseObject, pulseRows, pulseText, pulseTier, type PulseCard, type PulseRow } from './pulseCatalog';

import { deviceDay } from './evidenceTimestamp';
import type { NativeLanguage } from './nativeUiCopy';

export const LEADERSHIP_HATS = ['president', 'vp', 'advisor', 'coordinator', 'admin'] as const;
export type LeadershipHat = typeof LEADERSHIP_HATS[number];
export type LeadershipRead = { data: unknown; error: unknown };
// The organization's privacy floors, read from the server's staff scope
// (privacyFloor and chapterHealthFloor). A floor the server did not report
// is unknown, and an unknown floor withholds every figure that depends on it.
export type LeadershipFloors = { privacy: number | null; chapterHealth: number | null };
export type LeadershipInput = Partial<Record<'overview' | 'health' | 'workload' | 'cases' | 'unassigned' | 'events' | 'quorum' | 'notices' | 'receipts' | 'mfa' | 'logins' | 'forms', LeadershipRead>> & { floors?: LeadershipFloors };
type LeadershipWeek = { title: string; detail: string; href: string; measuredOn?: string; healthScore?: number };
type LeadershipRow = PulseRow & { measuredOn?: string };
type LeadershipCard = Omit<PulseCard, 'rows'> & { rows: LeadershipRow[] };
export type LeadershipPulse = { cards: LeadershipCard[]; week: LeadershipWeek; updatedAt: Date };

function healthScoreLine(score: number, language: NativeLanguage) {
  return `${pulseTier(score, language).label} · ${score}/100`;
}

function healthExclusions(language: NativeLanguage) {
  const [critical, concerning, moderate, healthy, excellent] = PULSE_HEALTH_BANDS.map(({ label }) => label[language]);
  return language === 'es'
    ? `Se excluyen las campañas protegidos por privacidad, las mediciones que faltan o no se pueden leer, los nombres de quienes las crearon o editaron y las notas privadas de asesoría. Las puntuaciones se agrupan en los niveles ${critical}, ${concerning}, ${moderate}, ${healthy} y ${excellent}.`
    : `Privacy-protected campaigns, missing or unreadable snapshots, the names of whoever created or edited them, and private coaching notes are excluded. Scores use ${critical}, ${concerning}, ${moderate}, ${healthy} and ${excellent} bands.`;
}

export function leadershipPulseForDisplay(data: LeadershipPulse | null, language: NativeLanguage): LeadershipPulse | null {
  if (!data) return data;
  const spanish = language === 'es';
  const formatter = new Intl.DateTimeFormat(spanish ? 'es-US' : 'en-US', { month: 'short', day: 'numeric', year: 'numeric' });
  const day = (value: string | undefined) => {
    const parsed = deviceDay(value);
    return parsed ? formatter.format(parsed) : spanish ? 'Fecha no disponible' : 'Date unavailable';
  };
  const { week } = data;
  let detail = week.healthScore === undefined ? week.detail : healthScoreLine(week.healthScore, language);
  if (week.measuredOn) {
    const measured = day(week.measuredOn);
    detail = spanish
      ? `${detail} · Medición del ${measured}. La puntuación corresponde a esa fecha y no se actualiza en tiempo real.`
      : `${detail} · measured ${measured}. A dated snapshot, not a live score.`;
  }
  return {
    ...data,
    week: { ...week, detail },
    cards: data.cards.map((card) => card.id === 'health' ? {
      ...card,
      notCounted: healthExclusions(language),
      rows: card.rows.map((row) => ({ ...row, label: `${row.label} · ${pulseTier(row.value, language).label} · ${day(row.measuredOn)}` })),
    } : card),
  };
}
export function leadershipHat(roles: readonly string[]): LeadershipHat | null {
  return roles.length === 1 && LEADERSHIP_HATS.includes(roles[0] as LeadershipHat) ? roles[0] as LeadershipHat : null;
}
function data(read: LeadershipRead | undefined): unknown { return read && !read.error ? read.data : null; }
function list(read: LeadershipRead | undefined): Record<string, unknown>[] | null { const value = data(read); return Array.isArray(value) ? pulseRows(value) : null; }
const protectedMessage = 'Withheld: a reporting group is too small to share safely, or its size is not known.';
// The server never applies a floor below 25 (20261104073000), so neither does the phone.
const FLOOR_MINIMUM = 25;
export function organizationFloor(value: unknown): number | null { const count = pulseCount(value); return count === null ? null : Math.max(FLOOR_MINIMUM, count); }
const meets = (count: number | null | undefined, floor: number | null) => floor !== null && count !== null && count !== undefined && count >= floor;
const cellSafe = (count: number | null, floor: number | null) => floor !== null && count !== null && (count === 0 || count >= floor);
function card(id: string, title: string, category: PulseCard['category'], period: string, source: string, rows: LeadershipRow[] | null, safe: boolean, notCounted: string): LeadershipCard {
  return { id, number: '', title, category, period, countedFrom: source, notCounted,
    privacy: 'Campaign or local totals only. Groups that do not meet the privacy rule stay hidden. No list of individual people and no product analytics.',
    rows: rows && safe ? rows : [], unavailable: rows === null,
    message: rows === null ? 'These figures didn’t load. Refresh to try again.' : !safe ? protectedMessage : !rows.length ? 'No recorded figures in this view.' : undefined };
}
function measuredRows(value: unknown, fields: readonly (readonly [string, string])[]): PulseRow[] | null {
  const row = pulseObject(value), result: PulseRow[] = [];
  for (const [key, label] of fields) { const count = pulseCount(row[key]); if (count === null) return null; result.push({ label, value: count }); }
  return result;
}
function numbered(cards: PulseCard[]): PulseCard[] { return cards.map((item, index) => ({ ...item, number: String(index + 1).padStart(2, '0') })); }
function uniquePeople(rows: readonly Record<string, unknown>[]): number | null {
  const people = rows.map((row) => pulseText(row.user_id));
  return people.some((id) => !id) ? null : new Set(people).size;
}
function groupedRecords(rows: Record<string, unknown>[] | null, field: string, floor: number | null): { rows: PulseRow[] | null; safe: boolean } {
  if (!rows) return { rows: null, safe: false };
  const groups = new Map<string, Record<string, unknown>[]>();
  for (const row of rows) { const key = pulseText(row[field]); if (!key) return { rows: null, safe: false }; groups.set(key, [...(groups.get(key) ?? []), row]); }
  const safe = floor !== null && [...groups.values()].every((group) => meets(uniquePeople(group), floor));
  return { rows: [...groups].map(([label, group]) => ({ label, value: group.length })), safe };
}

// The admin form summary is counted on the server, which also applies the
// floor: a withheld result carries no counts at all. Anything else malformed
// is unavailable, never zero. The server also says which floor it applied;
// the counts show only when that is the floor both scope reads reported, so
// a floor changed and changed back between those reads (30, 25, 30) cannot
// show counts checked against 25.
function formStates(read: LeadershipRead | undefined, floor: number | null): { rows: PulseRow[] | null; safe: boolean } {
  const value = data(read);
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return { rows: null, safe: false };
  const summary = pulseObject(value);
  if (summary.withheld === true) return { rows: [], safe: false };
  if (summary.withheld !== false || !Array.isArray(summary.states)) return { rows: null, safe: false };
  const rows: PulseRow[] = [];
  for (const state of pulseRows(summary.states)) {
    const label = pulseText(state.status), count = pulseCount(state.count);
    if (!label || count === null) return { rows: null, safe: false };
    rows.push({ label, value: count });
  }
  const applied = pulseCount(summary.privacyFloor);
  return { rows, safe: floor !== null && applied === floor && rows.every((row) => meets(row.value, floor)) };
}

export function leadershipPulse(hat: LeadershipHat, input: LeadershipInput, now = new Date()): LeadershipPulse {
  const cards: LeadershipCard[] = [];
  let week: LeadershipWeek = { title: 'Figures need a current check', detail: 'Refresh to check your current role and the latest totals. Small groups stay private.', href: `/feature/${hat === 'president' ? 'vp' : hat}` };
  const overview = pulseObject(data(input.overview));
  const population = pulseCount(overview.memberCount);
  const floor = organizationFloor(input.floors?.privacy), healthFloor = organizationFloor(input.floors?.chapterHealth);
  const cohortSafe = meets(population, floor);
  if (hat === 'vp' || hat === 'president') {
    const membership = measuredRows(data(input.overview), [['memberCount', 'Campaign workers'], ['newThisYear', 'Joined this year']]);
    // Both counts come from one register scan, so the members who joined
    // earlier are exactly their difference and must meet the floor too.
    const earlier = membership ? membership[0]!.value - membership[1]!.value : null;
    cards.push(card('membership', 'Campaign membership', 'chapter', 'Current selected campaign', 'the leadership overview’s campaign worker register.', membership, cohortSafe && earlier !== null && earlier >= 0 && cellSafe(earlier, floor) && Boolean(membership?.every((row) => cellSafe(row.value, floor))), 'Other campaigns, individual names, issue details and unpublished campaign content are excluded.'));
    const events = list(input.events), quorums = list(input.quorum);
    const meetingRows: PulseRow[] = []; let meetingsSafe = cohortSafe;
    for (const event of events ?? []) {
      const quorum = quorums?.find((row) => row.eventId === event.id);
      const checked = pulseCount(quorum?.checkedIn), target = pulseCount(quorum?.quorum);
      if (!quorum) continue;
      if (checked === null || target === null || !pulseText(event.title)) { meetingsSafe = false; continue; }
      meetingsSafe = meetingsSafe && cellSafe(checked, floor);
      meetingRows.push({ label: `${pulseText(event.title)} · checked in`, value: checked }, { label: `${pulseText(event.title)} · quorum target`, value: target });
    }
    const meetings = card('meetings', 'Can the campaign act?', 'meetings', 'Latest four campaign meetings that have started', 'recorded check-ins and the configured meeting quorum.', events && quorums ? meetingRows : null, meetingsSafe, 'Future or cancelled meetings, meetings with no configured quorum, RSVP intentions and unrecorded attendance are excluded. A quorum target is a configured rule, not an attendance count.');
    cards.push(meetings);
    const turnout = measuredRows(overview.turnout, [['totalVotes', 'Votes cast'], ['quorumTarget', 'Vote quorum target']]);
    cards.push(card('turnout', 'Latest vote turnout', 'chapter', 'Latest completed published vote', 'the leadership overview’s recorded vote totals.', turnout, cohortSafe && cellSafe(turnout?.[0]?.value ?? null, floor), 'Individual choices, drafts and other organizations are excluded. A quorum target is not the number eligible to vote.'));
    const notices = list(input.notices), receipts = list(input.receipts); let noticeSafe = cohortSafe;
    const noticeRows: PulseRow[] = [];
    for (const notice of notices ?? []) {
      const receipt = receipts?.find((row) => row.id === notice.id);
      const read = pulseCount(receipt?.readCount), audience = pulseCount(receipt?.audienceCount);
      if (read === null || audience === null || read > audience || !pulseText(notice.title)) { noticeSafe = false; continue; }
      noticeSafe = noticeSafe && meets(audience, floor) && cellSafe(read, floor) && cellSafe(audience - read, floor);
      noticeRows.push({ label: `${pulseText(notice.title)} · read`, value: read }, { label: `${pulseText(notice.title)} · audience`, value: audience });
    }
    cards.push(card('reach', 'Your published notice reach', 'chapter', 'Latest three of your unretracted campaign notices', 'the publisher’s current audience and notice receipt counts.', notices && receipts ? noticeRows : null, noticeSafe, 'Other publishers, retracted notices, reader names, individual read times and people outside the notice’s current audience are excluded. Read and unread groups both meet the floor.'));
    if (meetings.rows.length) week = { title: 'Can the campaign act?', detail: `${meetings.rows[0]!.label}: ${meetings.rows[0]!.value}. ${meetings.rows[1]!.label}: ${meetings.rows[1]!.value}. These are the latest recorded meeting figures, not a forecast.`, href: '/feature/events-desk' };
  } else if (hat === 'advisor') {
    const portfolio = list(input.health);
    const visible = (portfolio ?? []).filter((row) => row.cohortProtected === false && meets(pulseCount(row.memberCount), healthFloor) && pulseCount(row.score) !== null && Number(row.score) <= 100 && pulseText(row.chapterName) && /^\d{4}-\d{2}-\d{2}$/.test(pulseText(row.measuredOn)));
    visible.sort((a, b) => Number(a.score) - Number(b.score) || pulseText(a.chapterName).localeCompare(pulseText(b.chapterName)));
    const worsening = visible.filter((row) => {
      const trend = pulseRows(row.trend).filter((point) => /^\d{4}-\d{2}-\d{2}$/.test(pulseText(point.measuredOn)) && pulseText(point.measuredOn) <= pulseText(row.measuredOn) && pulseCount(point.score) !== null && Number(point.score) <= 100).sort((a, b) => pulseText(a.measuredOn).localeCompare(pulseText(b.measuredOn)));
      return trend.length >= 2 && pulseText(trend.at(-1)?.measuredOn) > pulseText(trend.at(-2)?.measuredOn) && Number(trend.at(-1)?.score) < Number(trend.at(-2)?.score);
    });
    const target = worsening[0] ?? visible[0];
    if (target) week = { title: `${worsening.length ? 'Worsening recorded trend' : 'Lowest recorded health'}: ${pulseText(target.chapterName)}`, detail: healthScoreLine(Number(target.score), 'en'), healthScore: Number(target.score), measuredOn: pulseText(target.measuredOn), href: '/feature/chapter-health' };
    cards.push(card('health', 'Campaign health portfolio', 'chapter', 'Latest dated snapshot for each campaign you can see', 'recorded campaign-health snapshots and their trends.', portfolio ? visible.map((row) => ({ label: pulseText(row.chapterName), value: Number(row.score), measuredOn: pulseText(row.measuredOn) })) : null, portfolio !== null && healthFloor !== null, healthExclusions('en')));
    if (portfolio && healthFloor !== null && visible.length < portfolio.length) cards[0]!.message = "Some campaigns have no dated snapshot yet or are hidden by the organization's privacy rule.";
  } else if (hat === 'coordinator') {
    const workload = pulseObject(data(input.workload));
    const categories = pulseRows(workload.categories);
    const safeWorkload = floor !== null && workload.enoughData === true && ['25-49', '50-99', '100+'].includes(pulseText(workload.submittersBand));
    const labels = PULSE_WORKLOAD_LABELS;
    const valid = categories.every((row) => Object.hasOwn(labels, pulseText(row.key)) && pulseCount(row.avg) !== null && pulseCount(row.p90) !== null);
    const rows = categories.map((row) => ({ label: labels[pulseText(row.key)]!, value: Number(row.avg) }));
    cards.push(card('workload', 'Collective workload', 'chapter', pulseText(workload.period) || 'Previous completed quarter', 'the campaign’s latest workload submission per person in the completed quarter.', data(input.workload) && valid ? rows : null, safeWorkload, 'Current-quarter entries, non-submitters and individual workloads are excluded. At least twenty-five distinct people must have submitted; bars are averages over that population.'));
    if (workload.locked === true) cards.at(-1)!.message = 'Complete the quarterly survey to see collective workload figures.';
    const widest = [...categories].sort((a, b) => Number(b.p90) - Number(b.avg) - (Number(a.p90) - Number(a.avg)))[0];
    if (safeWorkload && valid && widest) week = { title: `Rebalance ${labels[pulseText(widest.key)]!.toLowerCase()}`, detail: `Recorded campaign average ${widest.avg}; 90th percentile ${widest.p90}, in ${pulseText(workload.period)}. This names a workload category, never a person.`, href: '/feature/coordinator' };
    const identities = list(input.cases);
    const source = identities?.map((row) => ({ status: row.status,
      user_id: Object.hasOwn(row, 'steward_user_id') ? row.user_id : undefined,
      cell: pulseText(row.status) && pulseText(row.chapter_id) && (row.steward_user_id === null || pulseText(row.steward_user_id))
        ? `${pulseText(row.status)} · ${row.steward_user_id === null ? 'unassigned' : 'assigned'} · ${pulseText(row.chapter_id)}` : '' })) ?? null;
    const cases = groupedRecords(source, 'status', floor);
    const cube = groupedRecords(source, 'cell', floor);
    cards.push(card('flow', 'Issue flow', 'cases', 'Latest 200 issue records you can see', 'current statuses in the latest issue records you can see.', cases.rows, cases.safe && cube.safe, 'Issues your current role cannot see and records older than the latest 200 are excluded. Small or unconfirmed status, assignment or campaign groups withhold both charts, so no one can be worked out from the rest.'));
    const unassigned = list(input.unassigned);
    const openIDs = new Set(unassigned?.map((row) => pulseText(row.id)));
    const open = identities?.filter((row) => openIDs.has(pulseText(row.id))) ?? null;
    const people = open ? uniquePeople(open) : null;
    const reportingPeople = identities ? uniquePeople(identities) : null;
    cards.push(card('unassigned', 'Issues without a committee member', 'cases', 'Current campaign queue within the first 200 visible issues', 'the campaign lead’s active-case queue filtered to no assigned committee member, limited to the issue rows you can see.', unassigned && open ? [{ label: 'Issues without a committee member in this bounded view', value: open.length }] : null, Boolean(cube.safe && open && (open.length ? meets(people, floor) : meets(reportingPeople, floor))), 'This is not a total queue count. Issues with no recorded person, small status or assignment groups, restricted issues and records past either page limit are excluded.'));
  } else {
    const mfa = measuredRows(data(input.mfa), [['staffTotal', 'Staff accounts'], ['staffEnrolled', 'Two-step enrolled']]);
    const staff = mfa?.[0]?.value, enrolled = mfa?.[1]?.value;
    const access = mfa && staff !== undefined && enrolled !== undefined && enrolled <= staff ? [...mfa, { label: 'Two-step enrollment needed', value: staff - enrolled }] : null;
    cards.push(card('access', 'Staff access', 'chapter', 'Staff with access in this organization now', 'the administrator’s current two-step policy read.', access, Boolean(access && meets(staff, floor) && access.every((row) => cellSafe(row.value, floor))), 'Names, credentials, expired memberships and each person’s enrollment state are excluded. The enrolled and not-yet-enrolled groups must both meet the privacy rule.'));
    const inbox = pulseObject(data(input.logins)), open = pulseCount(inbox.openCount);
    // The inbox spans the organization, so its own subjects set the floor, not the selected chapter's register.
    const loginSafe = floor !== null && (open === 0 || meets(pulseCount(inbox.verifiedSubjects), floor));
    const attention = card('attention', 'Access reports needing attention', 'chapter', 'All open reports, with the privacy check run on the latest inbox page', 'the full count of open reports in the admin attention inbox.', open === null ? null : [{ label: 'Open sign-in reports', value: open }], loginSafe, 'Worker names and references, source details and device details are never shown. A nonzero count needs enough distinct current profiles on the page to meet the privacy rule; shared names only lower that count.');
    cards.push(attention);
    const events = list(input.events);
    cards.push(card('events', 'Campaign meetings', 'meetings', 'Current campaign meetings you can see', 'the meeting manager’s recorded, non-cancelled campaign meetings.', events ? [{ label: 'Recorded meetings', value: events.length }] : null, cohortSafe, 'Other campaigns, cancelled meetings, check-in codes, attendee names and RSVP intentions are excluded. This counts meetings, not participants.'));
    const forms = formStates(input.forms, floor);
    cards.push(card('forms', 'Forms by recorded state', 'chapter', 'Latest 100 forms of the selected campaign’s current workers', 'the administrator’s campaign form summary, counted by state on the server.', forms.rows, forms.safe, 'Form answers, names, other campaigns, older forms and states that do not meet the privacy rule are excluded. One small state hides the whole chart.'));
    if (attention.rows.length && open! > 0) week = { title: 'Review access reports', detail: `${open} open sign-in reports need an administrator. The count is uncapped and no individual is named here.`, href: '/feature/admin' };
    else if (access && meets(staff, floor) && meets(staff! - enrolled!, floor) && access.every((row) => cellSafe(row.value, floor))) week = { title: 'Check two-step enrollment', detail: `${staff! - enrolled!} staff accounts need enrollment. Open the admin desk to follow up.`, href: '/feature/admin' };
    else week = { title: 'Review the admin desk', detail: 'Private, hidden or unavailable lists may still need attention. Pulse does not treat them as zero.', href: '/feature/admin' };
  }
  return { cards: numbered(cards), week, updatedAt: now };
}
