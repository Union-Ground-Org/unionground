import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// UB-UG-NATIVE-PULSE-AND-ANALYTICS-VERIFICATION-COPY-20261106 (#7247):
// the iOS demo signs in as fictional SAMPLE accounts, so a first-time viewer
// reads these loading, empty, error and analytics lines. They keep their
// meaning (a failed read is never shown as zero; small groups stay withheld)
// without verification, protection or access-control jargon.
const read = (path: string) => readFileSync(fileURLToPath(new URL(path, import.meta.url)), 'utf8');

const retired: Record<string, readonly string[]> = {
  './activityCopy.ts': ['Checking your current authorization before showing protected updates.', 'New authorized updates will appear here'],
  './messageInboxCopy.ts': [
    'Checking your current authorization before showing conversations.', 'Checking your campaign channel access',
    'this session is no longer authorized', 'the workspace refused this request', 'this app no longer matches the workspace',
    'could not reach the workspace', 'could not load securely', 'an authorized conversation or channel',
  ],
  './messageWorkflow.ts': ['Delivery-status metadata'],
  './memberPulse.ts': ['Your survey gate and statistics could not be verified'],
  './leadershipPulse.ts': [
    'its population could not be verified', 'These figures could not be verified', 'server-protected trends',
    'no verifiable snapshot', 'current RLS issue rows', 'RLS-protected form metadata',
  ],
  '../components/SavedChartGraphic.tsx': ['Figures could not be verified'],
  '../components/AccountUnavailable.tsx': ['Your secure session is still active'],
  '../features/MemberPulseScreen.tsx': ['Your next action could not be verified'],
  '../features/mi1/AnalyticsCoreScreen.tsx': [
    'No authorized worker signals', 'Protected comparison', 'Protected grievance cells', 'Protected solidarity cells',
    'Protected engagement cohort', 'protected worker workspace', 'protected chart workspace', "'Protected cohort'",
    "'Protected'", 'authorized records exist', 'protected layouts', 'authorized staff save', 'see protected totals',
    'grouped and protected', 'current protected totals', 'Current protected analytics',
  ],
  '../../app/(tabs)/account.tsx': ['no enrolled device biometrics detected'],
  '../../app/_layout.tsx': ['return to your protected session'],
  '../../app/conversation/[id].tsx': ['reply in this authorized conversation'],
};

describe('native demo-path copy reads like a product', () => {
  it.each(Object.entries(retired))('keeps the retired jargon out of %s', (path, phrases) => {
    const source = read(path);
    for (const phrase of phrases) expect(source, phrase).not.toContain(phrase);
  });

  it('keeps the privacy meaning of the withheld and failed-read lines', () => {
    expect(read('./leadershipPulse.ts')).toContain('Withheld: a reporting group is too small to share safely, or its size is not known.');
    expect(read('../features/mi1/AnalyticsCoreScreen.tsx')).toContain('Insights stay hidden until at least 25 observations can be compared safely.');
    expect(read('../features/MemberPulseScreen.tsx')).toContain('Try again before treating the week as caught up.');
  });
});

// Critic P7 C2 and C5 (Nov 6, 2026): the Pulse privacy and counting notes and
// the SMS line spoke in cells, floors, populations and servers. The promise
// is unchanged (ten or twenty-five people per count, small parts hide the
// whole breakdown, no list of people, only the last four digits on the phone).
describe('Pulse privacy notes say the same promise in plain words', () => {
  const retiredNotes: Record<string, readonly string[]> = {
    './leadershipPulse.ts': ['local aggregates only', 'reporting population needs', 'no person roster', 'recorded aggregates',
      'Missing identities, smaller status/assignment populations', 'records beyond either page', 'unenrolled populations meet the floor',
      'profiles/rows beyond', 'One small state withholds'],
    './memberPulse.ts': ['nonzero cell', 'A small cell withholds', 'does not meet the ${floor}-person floor'],
    '../features/SavedPulseCharts.tsx': ['in each nonzero cell', 'A small cell withholds', 'contains a reference, not a copy', 'quarterly survey gate and privacy floor'],
    '../components/SavedChartGraphic.tsx': ['per nonzero cell', 'small breakdowns withheld whole', 'Floor: ${figures.floor} people'],
    '../../app/(tabs)/account.tsx': ['The full number stays on the server'],
  };
  it.each(Object.entries(retiredNotes))('keeps the retired note wording out of %s', (path, phrases) => {
    const source = read(path);
    for (const phrase of phrases) expect(source, phrase).not.toContain(phrase);
  });

  it('keeps every floor and the whole-breakdown rule in the new notes', () => {
    expect(read('./leadershipPulse.ts')).toContain('Groups that do not meet the privacy rule stay hidden. No list of individual people and no product analytics.');
    // #8926 moved the member notes into the native catalogue: the floor is the {floor} the server returns.
    expect(read('./memberPulse.ts')).toContain("t('Every count shown covers at least {floor} different people. If one part of a breakdown is smaller, the whole breakdown is hidden.', { floor })");
    expect(read('./memberPulse.ts')).toContain("t('Published only when every month counts at least {floor} people.', { floor })");
    expect(read('../components/SavedChartGraphic.tsx')).toContain("t('Each count covers at least {floor} people · a breakdown with a smaller part is hidden', { floor: figures.floor })");
    expect(read('../../app/(tabs)/account.tsx')).toContain('This phone shows only the last four digits.');
  });
});
