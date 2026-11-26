import type { ChannelPoll } from '../data/demoChannels';
import type { ChannelLoadStatus } from '../data/liveChannels';
import { caseOutcomeLabel } from './caseOutcomeCopy';
import { nativeCatalogLabel, nativeUiText, type NativeLanguage } from './nativeUiCopy';
import { pulseCount, pulseObject, pulseRows, pulseText, type PulseCard, type PulseRow, type PulseTrend } from './pulseCatalog';

const MONTH = /^(\d{4})-(0[1-9]|1[0-2])$/;

// The server's months are Eastern calendar months written YYYY-MM. Noon UTC
// on the 15th names the same month in every zone.
function monthMarks(rows: readonly PulseRow[], language: NativeLanguage): PulseTrend['marks'] {
  const locale = language === 'es' ? 'es-US' : 'en-US';
  const month = new Intl.DateTimeFormat(locale, { timeZone: 'UTC', month: 'long' });
  const monthYear = new Intl.DateTimeFormat(locale, { timeZone: 'UTC', month: 'long', year: 'numeric' });
  const capital = (value: string) => value.charAt(0).toLocaleUpperCase(locale) + value.slice(1);
  return rows.map((row) => {
    const at = new Date(`${row.label}-15T12:00:00Z`);
    const name = capital(month.format(at));
    return { axis: name.charAt(0), name, spoken: capital(monthYear.format(at)) };
  });
}

export function memberStatisticsCards(value: unknown, gate: 'open' | 'locked' | 'error', language: NativeLanguage = 'en'): PulseCard[] {
  const t = nativeUiText(language);
  const root = pulseObject(value);
  // The floor the server returned, kept apart and checked: null when it
  // returned none (a locked survey gate, a failed read, a missing or invalid
  // floor). The words never name a number the server did not give (#8768);
  // with no floor the card shows no privacy sentence at all.
  const returned = pulseCount(root.privacyFloor);
  const serverFloor = returned !== null && returned >= 10 ? returned : null;
  const locked = gate === 'locked' || root.locked === true;
  const available = gate === 'open' && root.available === true && serverFloor !== null;
  function card(id: 'actions' | 'outcomes', number: string, title: string): PulseCard {
    const group = pulseObject(root[id]);
    const actions = id === 'actions';
    const base = { id, number, title, category: actions ? 'chapter' as const : 'cases' as const,
      period: t('Last twelve calendar months · ET'),
      ...(actions ? { subtitle: t('actions by month · 12 months') } : {}),
      countedFrom: actions ? t('collective-action sign-ups you can see, grouped by month.') : t('recorded issue outcomes in your organization.'),
      notCounted: actions ? t('Page views, product analytics and privately held activity are excluded. Sign-ups are actions, not unique workers across months.') : t('Open issues, other organizations and unrecorded outcomes are excluded.'), rows: [] as PulseRow[] };
    if (locked) return { ...base, message: t('Complete the quarterly survey to see these statistics.') };
    if (!available || serverFloor === null) return { ...base, unavailable: true, message: t('Your survey status and statistics didn’t load. Try again.') };
    const floor = serverFloor;
    // Card 01 is the Pulse design's Mock A, word for word (#8926).
    const privacy = actions
      ? t('Published only when every month counts at least {floor} people.', { floor })
      : t('Every count shown covers at least {floor} different people. If one part of a breakdown is smaller, the whole breakdown is hidden.', { floor });
    const open = { ...base, privacy };
    if (group.withheld === true) return { ...open, message: t('Withheld: at least one part of this breakdown has fewer than {floor} people.', { floor }) };
    const source = actions ? group.months : group.rows;
    if (group.withheld !== false || !Array.isArray(source)) return { ...open, unavailable: true };
    const rows = pulseRows(source).map((row) => ({ label: pulseText(actions ? row.month : row.outcome), value: pulseCount(row.count) }));
    if (rows.some((row) => !row.label || row.value === null || (actions && !MONTH.test(row.label)))) return { ...open, unavailable: true };
    if (rows.some((row) => row.value! > 0 && row.value! < floor)) return { ...open, message: t('Withheld: one part of this breakdown has fewer than {floor} people.', { floor }) };
    const published = rows.map((row) => ({
      label: actions ? row.label : nativeCatalogLabel(language, caseOutcomeLabel(row.label)),
      value: row.value!,
    }));
    if (!published.length) return { ...open, message: t('No published figures in this period.') };
    const trend = actions ? { trend: { series: t('actions'), latest: t('this month'), marks: monthMarks(published, language) } } : {};
    return { ...open, ...trend, rows: published };
  }
  return [card('actions', '01', t('Workers taking action')), card('outcomes', '04', t('How issues end'))];
}

export function memberPollCard(poll: ChannelPoll | null, status: ChannelLoadStatus, language: NativeLanguage = 'en'): PulseCard {
  const t = nativeUiText(language);
  // The chapter poll is a voice card (#8926: the Voice filter).
  const base: PulseCard = { id: 'poll', number: '05', title: poll?.question || t('Live campaign poll'), category: 'voice', period: t('Latest poll · live'),
    countedFrom: t('the campaign poll tally.'), notCounted: t('Individual votes, other channels and product analytics are excluded.'), privacy: t('Results follow the poll’s disclosure rules; a hidden tally stays hidden.'), rows: [] };
  if (status === 'error') return { ...base, unavailable: true };
  if (status !== 'ready') return { ...base, message: t('Campaign polls are loading.') };
  if (!poll || !poll.options.length) return { ...base, message: t('No campaign poll is open.') };
  if (poll.options.some((row) => pulseCount(row.votes) === null)) return { ...base, message: t('Results are not published for this poll yet.') };
  return { ...base, rows: poll.options.map((row) => ({ label: row.label, value: row.votes! })), message: poll.mine === null ? t('You have not voted in this poll.') : t('Your answer: {answer}.', { answer: poll.options[poll.mine]?.label ?? t('recorded') }) };
}
