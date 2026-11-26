// BUG-UG-PULSE-THIS-WEEK-CAUGHT-UP-WITH-OPEN-ITEMS-20261103: native
// Home and Pulse rank open surveys and unread notices through the shared web
// module, so neither says caught up while one is waiting.
import { describe, expect, it } from 'vitest';

import { whatMattersCopy } from './whatMattersCopy';
import { rankWhatMattersNow, surveysToAnswer, whatMattersSurveys } from './whatMattersShared';

const now = new Date(2026, 10, 3, 2, 12);
const at = (offsetDays: number) => new Date(now.getTime() + offsetDays * 86_400_000).toISOString();
const base = { cases: [], ballots: [], events: [], now };
const survey = { id: 's1', title: 'Seasonal check-in', closesAt: at(4), answered: false };
const notice = { id: 'n1', title: 'Crew meeting moved', unread: true };
const caughtUp = 'Nothing needs your attention right now.';

describe('native caught-up decision', () => {
  it('names an open survey and routes it to the surveys', () => {
    const item = rankWhatMattersNow({ ...base, surveys: [survey] });
    expect(item.kind).toBe('open_survey');
    const copy = whatMattersCopy(item);
    expect(copy).toMatchObject({ reason: 'A survey is waiting for your answer', line: 'Seasonal check-in', action: 'Answer the survey', href: '/feature/voting' });
    expect(copy.meta).toMatch(/^Closes Nov \d+$/);
    expect(whatMattersCopy(rankWhatMattersNow({ ...base, surveys: [{ ...survey, closesAt: null }] })).meta).toBeNull();
  });

  it('names unread notices and routes them to Messages', () => {
    expect(whatMattersCopy(rankWhatMattersNow({ ...base, notices: [notice] }))).toEqual({
      reason: 'You have an unread notice', line: 'Crew meeting moved', meta: null, action: 'Open notices', href: '/messages',
    });
    expect(whatMattersCopy(rankWhatMattersNow({ ...base, notices: [notice, { id: 'n2', title: 'Older', unread: true }] })).reason).toBe('You have 2 unread notices');
  });

  it('puts the survey first when both wait, and is caught up only when neither does', () => {
    expect(rankWhatMattersNow({ ...base, surveys: [survey], notices: [notice] }).kind).toBe('open_survey');
    expect(whatMattersCopy(rankWhatMattersNow(base)).line).toBe(caughtUp);
    const neither = rankWhatMattersNow({ ...base, surveys: [{ ...survey, answered: true }, { ...survey, id: 's2', closesAt: at(-3) }], notices: [{ ...notice, unread: false }] });
    expect(whatMattersCopy(neither).line).toBe(caughtUp);
  });

  it('never lists a survey past its answer deadline as one to answer', () => {
    const past = { id: 'past', title: 'Seasonal check-in before October 31', closesAt: '2026-10-31T23:59:00-04:00', answered: false };
    expect(surveysToAnswer([past, survey], now)).toEqual([survey]);
  });

  it('reads surveys from the engagement snapshot, a submitted session as answered', () => {
    expect(whatMattersSurveys({ surveys: [
      { id: 's1', title: 'Open', closesAt: '2026-11-07T00:00:00Z', session: null },
      { id: 's2', title: 'Draft', session: { id: 'x', status: 'in_progress' } },
      { id: 's3', title: 'Sent', session: { id: 'y', status: 'submitted' } },
    ] })).toEqual([
      { id: 's1', title: 'Open', closesAt: '2026-11-07T00:00:00Z', answered: false },
      { id: 's2', title: 'Draft', closesAt: null, answered: false },
      { id: 's3', title: 'Sent', closesAt: null, answered: true },
    ]);
    expect(whatMattersSurveys(null)).toEqual([]);
  });
});
