import { describe, expect, it } from 'vitest';
import { memberPollCard, memberStatisticsCards } from './memberPulse';

const statistics = { available: true, privacyFloor: 25, actions: { withheld: false, months: [{ month: '2026-10', count: 32 }] }, outcomes: { withheld: false, rows: [{ outcome: 'settled', count: 25 }] } };
describe('worker Pulse privacy and live values', () => {
  it('ignores figures on every locked, failed or malformed gate answer', () => {
    for (const gate of ['locked', 'error'] as const) for (const card of memberStatisticsCards(statistics, gate)) expect(card.rows).toEqual([]);
    expect(memberStatisticsCards({ ...statistics, locked: true }, 'open')[0]?.message).toContain('quarterly survey');
    for (const value of [null, {}, { ...statistics, privacyFloor: null }, { ...statistics, actions: { withheld: false, months: [{ month: 'bad', count: -1 }] } }]) expect(memberStatisticsCards(value, 'open')[0]?.unavailable).toBe(true);
    expect(memberStatisticsCards({ ...statistics, actions: { withheld: true, months: [{ count: 1 }] } }, 'open')[0]).toMatchObject({ rows: [], message: expect.stringContaining('25') });
    expect(memberStatisticsCards({ ...statistics, privacyFloor: 1 }, 'open')[0]?.unavailable).toBe(true);
    expect(memberStatisticsCards({ ...statistics, actions: { withheld: false, months: [{ month: '2026-10', count: 3 }] } }, 'open')[0]).toMatchObject({ rows: [], message: expect.stringContaining('fewer than 25 people') });
  });
  it('uses the published series and whole-breakdown floor, including explicit zero periods', () => {
    const cards = memberStatisticsCards(statistics, 'open');
    expect(cards.map((card) => card.number)).toEqual(['01', '04']);
    // Card 01 is Mock A's (#8926): its privacy line states the server's floor.
    expect(cards[0]).toMatchObject({ title: 'Workers taking action', subtitle: 'actions by month · 12 months', rows: [{ label: '2026-10', value: 32 }], privacy: 'Published only when every month counts at least 25 people.' });
    expect(cards[0]?.trend).toEqual({ series: 'actions', latest: 'this month', marks: [{ axis: 'O', name: 'October', spoken: 'October 2026' }] });
    expect(cards[1]).toMatchObject({ privacy: expect.stringContaining('at least 25 different people') });
    expect(cards[1]?.trend).toBeUndefined();
    expect(cards[1]?.rows).toEqual([{ label: 'Settled', value: 25 }]);
    expect(memberStatisticsCards({ ...statistics, actions: { withheld: false, months: [] } }, 'open')[0]?.message).toContain('No published');
    expect(memberStatisticsCards({ ...statistics, actions: { withheld: false, months: [{ month: '2026-10', count: 0 }] } }, 'open')[0]?.rows[0]?.value).toBe(0);
  });
  it('keeps no privacy sentence when the server returned no valid floor (#8945 review)', () => {
    const reads: [unknown, 'open' | 'locked' | 'error'][] = [[{ available: false, locked: true }, 'locked'], [{ ...statistics, locked: true }, 'open'], [null, 'error'], [{ ...statistics, privacyFloor: null }, 'open'], [{ ...statistics, privacyFloor: 9 }, 'open'], [{ ...statistics, privacyFloor: 'ten' }, 'open']];
    for (const [value, gate] of reads) {
      for (const card of memberStatisticsCards(value, gate)) expect(card.privacy, JSON.stringify(value)).toBeUndefined();
    }
    // A withheld breakdown still states the floor the server gave.
    expect(memberStatisticsCards({ ...statistics, actions: { withheld: true } }, 'open')[0]).toMatchObject({ privacy: 'Published only when every month counts at least 25 people.', message: expect.stringContaining('fewer than 25 people') });
  });
  it('names the months in either language and refuses a month it cannot read', () => {
    const spanish = memberStatisticsCards({ ...statistics, privacyFloor: 30, actions: { withheld: false, months: [{ month: '2025-12', count: 30 }, { month: '2026-01', count: 0 }] } }, 'open', 'es');
    expect(spanish[0]).toMatchObject({ title: 'Trabajadores que actúan', privacy: 'Se publica solo cuando cada mes cuenta al menos 30 personas.' });
    expect(spanish[0]?.trend?.marks).toEqual([{ axis: 'D', name: 'Diciembre', spoken: 'Diciembre de 2025' }, { axis: 'E', name: 'Enero', spoken: 'Enero de 2026' }]);
    expect(memberStatisticsCards(statistics, 'open', 'es')[1]?.rows).toEqual([{ label: 'Resuelto', value: 25 }]);
    for (const month of ['2026-13', 'October', '2026-1']) expect(memberStatisticsCards({ ...statistics, actions: { withheld: false, months: [{ month, count: 30 }] } }, 'open')[0]?.unavailable, month).toBe(true);
  });
  it('never turns hidden poll totals or a failed live read into zero votes', () => {
    expect(memberPollCard(null, 'error').unavailable).toBe(true);
    expect(memberPollCard(null, 'loading').message).toContain('loading');
    expect(memberPollCard(null, 'ready').message).toContain('No campaign poll');
    const poll = { question: 'Meeting night', options: [{ label: 'Tuesday', votes: null }], mine: null };
    expect(memberPollCard(poll, 'ready')).toMatchObject({ rows: [], message: expect.stringContaining('not published') });
    expect(memberPollCard({ ...poll, options: [{ label: 'Tuesday', votes: 14 }], mine: 0 }, 'ready')).toMatchObject({ rows: [{ label: 'Tuesday', value: 14 }], message: 'Your answer: Tuesday.' });
    expect(memberPollCard({ ...poll, options: [{ label: 'Tuesday', votes: 0 }] }, 'ready').message).toContain('not voted');
    expect(memberPollCard({ ...poll, options: [{ label: 'Tuesday', votes: 0 }], mine: 99 }, 'ready').message).toBe('Your answer: recorded.');
    // The poll is the member's voice card (#8926).
    expect(memberPollCard(poll, 'ready').category).toBe('voice');
    expect(memberPollCard({ ...poll, options: [{ label: 'Tuesday', votes: 14 }], mine: 0 }, 'ready', 'es').message).toBe('Tu respuesta: Tuesday.');
  });
});
