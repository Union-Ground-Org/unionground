import { readableRecordKey } from '../lib/nativeUiCopy';
import { caseRowLine, loadCaseRowTitles } from '../lib/caseRowLine';
import { getSupabaseClient } from './supabase';
import { normalizePulsePeople, PULSE_WORKLOAD_LABELS, pulseCount, pulseDate, pulseObject, pulseRows, pulseText, type PulseCard, type PulseCase, type PulseDeadline, type PulsePeople } from '../lib/pulseCatalog';

type Read = { data: unknown; error: unknown };
export type StewardPulse = {
  cards: PulseCard[];
  cases: PulseCase[];
  deadlines: PulseDeadline[];
  deadlinesAvailable: boolean;
  casesTruncated: boolean;
  updatedAt: Date;
};

async function settled(request: PromiseLike<Read>): Promise<Read> {
  try { return await request; } catch (error) { return { data: null, error }; }
}

export async function loadStewardPulse(userID: string, signal: AbortSignal): Promise<StewardPulse> {
  const client = getSupabaseClient();
  if (!client) throw new Error('The secure mobile backend is not configured.');
  const now = new Date();
  const rpc = (name: string, args: Record<string, unknown> = {}) => settled(client.rpc(name, args).abortSignal(signal));
  const [casesRead, kpis, forms, unassigned, workload, events] = await Promise.all([
    settled(client.from('member_cases').select('id,reference,case_type,step,deadline,status').eq('steward_user_id', userID).neq('user_id', userID).eq('status', 'active').order('deadline', { ascending: true, nullsFirst: false }).order('id').limit(201).abortSignal(signal)),
    rpc('get_steward_desk_kpis'),
    rpc('list_steward_forms', { p_status: 'all', p_sort: 'oldest', p_limit: 1 }),
    rpc('list_unassigned_chapter_cases'),
    rpc('get_steward_workload_intelligence', { p_weeks: 12 }),
    settled(client.from('member_events').select('id,title,starts_at').eq('event_kind', 'meeting').is('cancelled_at', null)
      .lte('starts_at', now.toISOString()).order('starts_at', { ascending: false }).limit(4).abortSignal(signal)),
  ]);
  const neutralCases = pulseRows(casesRead.data).slice(0, 200).map((row) => ({ id: pulseText(row.id), reference: pulseText(row.reference), title: caseRowLine(row.case_type, row.step), status: pulseText(row.status), deadline: pulseDate(row.deadline) }));
  const eventRows = pulseRows(events.data);
  const [steps, quorum, titles] = await Promise.all([
    neutralCases.length ? settled(client.from('casework_deadlines').select('case_id,label,due_at').in('case_id', neutralCases.map((row) => row.id)).in('status', ['active', 'extended', 'missed']).order('due_at').limit(1001).abortSignal(signal)) : Promise.resolve({ data: [], error: null }),
    events.error ? Promise.resolve({ data: null, error: events.error }) : rpc('get_member_event_quorum', { p_event_ids: eventRows.map((row) => row.id) }),
    // The case topic only where the chapter or this steward turned it on (#7043).
    loadCaseRowTitles((ids) => client.rpc('list_case_row_titles', { p_case_ids: ids }).abortSignal(signal), neutralCases.map((row) => row.id)),
  ]);
  const cases = neutralCases.map((row) => ({ ...row, title: titles.get(row.id) ?? row.title }));
  const deadlines = pulseRows(steps.data).slice(0, 1000).map((row) => ({ caseID: pulseText(row.case_id), label: pulseText(row.label), dueAt: pulseText(row.due_at) }));
  const kpi = pulseRows(kpis.data)[0] ?? {};
  const categories = pulseRows(pulseObject(workload.data).categories);
  const workloadRows = categories
    .filter((row) => typeof row.latest === 'number' && Number.isFinite(row.latest) && row.latest >= 0)
    .map((row) => {
      const key = pulseText(row.key);
      return { label: Object.hasOwn(PULSE_WORKLOAD_LABELS, key) ? PULSE_WORKLOAD_LABELS[key]! : readableRecordKey(key) || 'Other workload', value: Number(row.latest) };
    });
  const quorumRows = pulseRows(quorum.data);
  const safeQuorum = quorumRows.length > 0 && quorumRows.every((row) => (pulseCount(row.checkedIn) ?? 0) >= 10);
  // A failed read says so (CardFigures' could-not-be-loaded line); the
  // eligibility and privacy-floor messages are for reads that succeeded
  // (BUG-UG-STEWARD-PULSE-READ-FAILURE-SHOWN-AS-PRIVACY-FLOOR-20261102).
  const workloadUnavailable = Boolean(workload.error) || workload.data === null || typeof workload.data !== 'object';
  const quorumUnavailable = Boolean(quorum.error) || !Array.isArray(quorum.data);
  const totalForms = pulseRows(forms.data)[0]?.total_count ?? (Array.isArray(forms.data) && forms.data.length === 0 ? 0 : null);
  const counts = (values: [string, unknown][]) => values.flatMap(([label, value]) => { const count = pulseCount(value); return count === null ? [] : [{ label, value: count }]; });
  const caseBound = pulseRows(casesRead.data).length > 200;
  const casesUnavailable = Boolean(casesRead.error) || !Array.isArray(casesRead.data);
  const stepsUnavailable = Boolean(steps.error) || !Array.isArray(steps.data);
  return {
    cases, deadlines, casesTruncated: caseBound,
    deadlinesAvailable: !casesUnavailable && !stepsUnavailable && pulseRows(steps.data).length <= 1000 && !caseBound,
    updatedAt: new Date(),
    cards: [
      { id: 'caseload', number: '01', title: 'Your caseload', category: 'cases', period: 'Today', countedFrom: 'Active issues assigned to you, through the issue permissions.', notCounted: 'Your own worker issues, resolved issues and issues assigned to another committee member are excluded.', rows: casesUnavailable ? [] : [{ label: caseBound ? 'At least this many active issues' : 'Active issues', value: cases.length }], unavailable: casesUnavailable, message: caseBound ? 'The first 200 active issues, ordered by issue deadline. Open Issue work for the full queue.' : undefined },
      { id: 'requests', number: '02', title: 'Worker requests and replies', category: 'chapter', period: 'Today', countedFrom: 'Committee desk KPIs, under the same permissions as Issue work.', notCounted: 'Closed requests and conversations whose last message came from staff are excluded.', rows: counts([['Open requests', kpi.open_requests], ['Awaiting reply', kpi.awaiting_reply]]), unavailable: Boolean(kpis.error) || pulseCount(kpi.open_requests) === null || pulseCount(kpi.awaiting_reply) === null },
      { id: 'forms', number: '03', title: 'Forms waiting', category: 'chapter', period: 'Today', countedFrom: 'The total on the submitted and in-review forms queue.', notCounted: 'Worker drafts and forms outside your authorized scope are never counted or read.', rows: counts([['Waiting for review', totalForms]]), unavailable: Boolean(forms.error) || pulseCount(totalForms) === null },
      { id: 'unassigned', number: '04', title: 'Issues waiting for a committee member', category: 'cases', period: 'Today', countedFrom: 'The unassigned campaign issues read.', notCounted: 'Restricted issues and issues outside the committee permissions are excluded. This read returns at most 50 issues.', rows: [{ label: pulseRows(unassigned.data).length >= 50 ? 'At least this many unassigned issues' : 'Unassigned issues', value: pulseRows(unassigned.data).length }], unavailable: Boolean(unassigned.error) || !Array.isArray(unassigned.data) },
      { id: 'workload', number: '05', title: 'Workload signals', category: 'chapter', period: '12 weeks · latest eligible week', countedFrom: 'Committee workload intelligence; the latest recorded weekly category averages.', notCounted: 'These are workload reports, not worker engagement scores or product analytics. Missing weeks are never filled in.', privacy: 'The existing server floor of 25 people per week and at least two eligible weeks stays in force.', rows: workloadRows, unavailable: workloadUnavailable, message: !workloadUnavailable && pulseObject(workload.data).available !== true ? 'Not enough eligible weekly reports to show workload signals.' : undefined },
      { id: 'quorum', number: '06', title: 'Meeting quorum', category: 'meetings', period: 'Four most recent meeting records', countedFrom: 'Meeting quorum and check-in totals from the worker meeting quorum read.', notCounted: 'RSVPs do not count as attendance. Meetings without a configured quorum are excluded.', privacy: 'Check-in figures are withheld as a whole when any meeting has fewer than ten check-ins.', rows: safeQuorum ? quorumRows.flatMap((row) => {
        const event = eventRows.find((candidate) => candidate.id === row.eventId);
        return counts([[`${pulseText(event?.title)} · checked in`, row.checkedIn], [`${pulseText(event?.title)} · quorum target`, row.quorum]]);
      }) : [], unavailable: quorumUnavailable, message: quorumUnavailable || safeQuorum ? undefined : 'No meeting figures clear the privacy floor yet.' },
    ],
  };
}

export async function loadPulsePeople(level: PulsePeople['level'], signal: AbortSignal): Promise<PulsePeople> {
  const client = getSupabaseClient();
  if (!client) throw new Error('The secure mobile backend is not configured.');
  const { data, error } = await client.rpc('get_steward_pulse_people', { p_level: level }).abortSignal(signal);
  if (error) throw error;
  return normalizePulsePeople(data, level);
}

export async function loadPulseScorePreference(userID: string): Promise<boolean> {
  const client = getSupabaseClient();
  if (!client) throw new Error('The secure mobile backend is not configured.');
  const { data, error } = await client.from('member_profiles').select('pulse_score_visible').eq('id', userID).single();
  if (error) throw error;
  if (typeof data?.pulse_score_visible !== 'boolean') throw new Error('Your score preference could not be verified.');
  return data.pulse_score_visible;
}

export async function savePulseScorePreference(userID: string, visible: boolean): Promise<boolean> {
  const client = getSupabaseClient();
  if (!client) throw new Error('The secure mobile backend is not configured.');
  // Saved through update_my_member_profile like every native profile write (supabase.ts updateMemberProfile).
  const saved = await client.rpc('update_my_member_profile', { p_expected_user_id: userID, p_fields: { pulse_score_visible: visible } });
  if (saved.error) throw saved.error;
  const { data, error } = await client.from('member_profiles').select('pulse_score_visible').eq('id', userID).single();
  if (error) throw error;
  if (data?.pulse_score_visible !== visible) throw new Error('Your score preference was not saved.');
  return visible;
}
