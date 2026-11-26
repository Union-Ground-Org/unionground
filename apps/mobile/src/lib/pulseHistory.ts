import { pulseCount, pulseObject, pulseRows, pulseText, type PulseCard, type PulseRow } from './pulseCatalog';

// #6694: weekly trends come from stored server snapshots (get_pulse_history).
// The direction is the server's comparison of the last two shown weeks;
// this module only labels it and never derives a trend from figures. Only
// meeting check-ins are stored (#6741 ruling): action sign-ups have published
// lifetime totals a weekly series could be subtracted from.
const MEASURES = {
  meeting_checkins: { title: 'Meeting check-ins by week', category: 'meetings', countedFrom: 'recorded check-ins at non-cancelled meetings that started that week, stored once per completed Eastern week.', notCounted: 'RSVPs, unrecorded attendance and cancelled meetings are excluded. Check-ins recorded after the week was stored are not added later.' },
} as const;
type Measure = keyof typeof MEASURES;
const DIRECTION = { up: 'Up from the week before.', down: 'Down from the week before.', flat: 'Unchanged from the week before.' } as const;

export function weekLabel(week: string): string {
  return new Intl.DateTimeFormat('en-US', { timeZone: 'UTC', month: 'short', day: 'numeric' }).format(new Date(`${week}T00:00:00Z`));
}
const isWeek = (value: string) => /^\d{4}-\d{2}-\d{2}$/.test(value) && Number.isFinite(Date.parse(`${value}T00:00:00Z`));

export function pulseHistoryCards(value: unknown): PulseCard[] {
  const root = pulseObject(value);
  if (root.locked === true) return [];
  const floor = pulseCount(root.privacyFloor);
  const since = pulseText(root.since);
  if (root.locked !== false || floor === null || floor < 10 || !Array.isArray(root.series)) throw new Error('Weekly history could not be verified.');
  const period = root.complete === true ? 'Last twelve weeks · ET' : isWeek(since) ? `Since the week of ${weekLabel(since)} · ET` : 'Weekly history starts after the first recorded week';
  return pulseRows(root.series).flatMap((series, index): PulseCard[] => {
    const measure = pulseText(series.measure) as Measure;
    const level = pulseText(series.level);
    if (!(measure in MEASURES) || (level !== 'chapter' && level !== 'local')) return [];
    const copy = MEASURES[measure];
    const points = pulseRows(series.points).filter((point) => isWeek(pulseText(point.week)));
    const rows: PulseRow[] = [];
    let withheld = 0, pending = 0;
    for (const point of points) {
      const count = pulseCount(point.value);
      if (point.withheld === true) withheld += 1;
      else if (point.pending === true) pending += 1;
      else if (point.recorded === true && count !== null) rows.push({ label: weekLabel(pulseText(point.week)), value: count });
    }
    const direction = pulseText(series.direction);
    const notes = [
      direction in DIRECTION ? DIRECTION[direction as keyof typeof DIRECTION] : '',
      withheld ? `${withheld} week${withheld === 1 ? ' was' : 's were'} withheld: fewer than ${floor} people.` : '',
      pending ? `${pending} week${pending === 1 ? '' : 's'} will show once ${pending === 1 ? 'its' : 'their'} calendar months close with every week recorded.` : '',
      points.length ? '' : 'No week has been recorded yet.',
    ].filter(Boolean).join(' ');
    return [{
      id: `history-${level}-${measure}`, number: `W${index + 1}`,
      title: `${copy.title}${level === 'local' ? ' · whole local' : ''}`, category: copy.category, period,
      countedFrom: copy.countedFrom, notCounted: copy.notCounted,
      privacy: `Each stored week needed at least ${floor} distinct people in every group, including each meeting and the part of a week that falls in another month; a small group withheld that whole week before it was stored.`,
      rows, message: notes || undefined,
    }];
  });
}
