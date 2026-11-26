import { describe, expect, it } from 'vitest';
import { pulseHistoryCards, weekLabel } from './pulseHistory';

const point = (week: string, value: number | null, withheld = false, recorded = true) => ({ week, value, withheld, recorded });
const history = {
  locked: false, privacyFloor: 25, since: '2026-11-02', complete: false, weeks: ['2026-11-02', '2026-11-09'],
  series: [
    { level: 'chapter', measure: 'meeting_checkins', direction: 'up', points: [point('2026-11-02', 27), point('2026-11-09', 31)] },
    { level: 'chapter', measure: 'meeting_checkins', direction: null, points: [point('2026-11-02', null, true), point('2026-11-09', 40)] },
    { level: 'local', measure: 'meeting_checkins', direction: 'flat', points: [point('2026-11-02', 0), { ...point('2026-11-09', null), pending: true }] },
  ],
};
describe('Pulse weekly history', () => {
  it('draws only stored published weeks and the server direction', () => {
    const cards = pulseHistoryCards(history);
    expect(cards.map((card) => card.id)).toEqual(['history-chapter-meeting_checkins', 'history-chapter-meeting_checkins', 'history-local-meeting_checkins']);
    expect(cards[0]).toMatchObject({ rows: [{ label: 'Nov 2', value: 27 }, { label: 'Nov 9', value: 31 }], message: 'Up from the week before.', period: 'Since the week of Nov 2 · ET', category: 'meetings' });
    expect(cards[1]).toMatchObject({ rows: [{ label: 'Nov 9', value: 40 }], message: '1 week was withheld: fewer than 25 people.', category: 'meetings' });
    expect(cards[2]).toMatchObject({ title: 'Meeting check-ins by week · whole local', rows: [{ label: 'Nov 2', value: 0 }],
      message: 'Unchanged from the week before. 1 week will show once its calendar months close with every week recorded.' });
    expect(pulseHistoryCards({ ...history, complete: true })[0]?.period).toBe('Last twelve weeks · ET');
  });
  it('never invents a trend or a zero', () => {
    const [card] = pulseHistoryCards({ ...history, series: [{ level: 'chapter', measure: 'meeting_checkins', direction: 'sideways', points: [point('2026-11-02', 30, false, false), point('bad', 5)] }] });
    expect(card).toMatchObject({ rows: [], message: undefined });
    expect(pulseHistoryCards({ ...history, since: null, weeks: [], series: [{ level: 'chapter', measure: 'meeting_checkins', direction: null, points: [] }] })[0])
      .toMatchObject({ period: 'Weekly history starts after the first recorded week', message: 'No week has been recorded yet.' });
    expect(pulseHistoryCards({ ...history, series: [{ level: 'unit', measure: 'meeting_checkins', points: [] }, { level: 'chapter', measure: 'action_signups', points: [] }] })).toEqual([]);
  });
  it('shows nothing when locked and refuses malformed answers', () => {
    expect(pulseHistoryCards({ locked: true, series: history.series })).toEqual([]);
    for (const value of [null, {}, { ...history, privacyFloor: 3 }, { ...history, series: null }, { ...history, locked: undefined }]) expect(() => pulseHistoryCards(value)).toThrow();
    expect(weekLabel('2026-12-28')).toBe('Dec 28');
  });
});
