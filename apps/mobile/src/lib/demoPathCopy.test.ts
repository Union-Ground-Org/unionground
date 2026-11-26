import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// rulings on the P5 copy inventory (Nov 6, 2026), H2-H10: the iOS
// demo signs in as fictional SAMPLE accounts, and these live lines spoke of a
// retired preview mode or in access-control terms. Same meaning, plain words.
const read = (path: string) => readFileSync(fileURLToPath(new URL(path, import.meta.url)), 'utf8');

const retired: Record<string, readonly string[]> = {
  '../components/WorkWidgets.tsx': ['Changes stay in this preview session', 'Desk widgets for this hat'],
  '../features/HapticPreferencesCard.tsx': ['across accounts and PREVIEW'],
  '../components/ChapterRail.tsx': ['Search authorized campaigns', "'Authorized campaign'"],
  '../components/AttachmentPanel.tsx': [
    'deletes the authorized file', 'Authorized attachments', 'current authorization. Camera scans are re-encoded',
    'You can open authorized files', 'No authorized attachments yet',
  ],
  '../features/WorkScreen.tsx': ['view authorized issue work'],
  '../features/StewardPulseScreen.tsx': ['your authorized campaigns', 'committee member scope', 'Authorized groups only', 'leave the server'],
  './leadershipPulse.ts': [
    'current authorized audience', 'The server requires', 'Authorized issue flow', 'Latest 200 authorized records',
    'latest authorized issue rows', 'leadership scope', 'beyond the read limit', 'protect their complements', 'user agents',
    'screen model', 'verified population', 'Authorized current campaign meeting register', 'for authorized follow-up',
    'Private, protected or unavailable', 'for each authorized campaign',
    'Protected cohorts below ten', 'absent or malformed snapshots', 'creator/reviser names', 'population checked against', 'uncapped open-report count',
  ],
  './memberPulse.ts': ['authorized collective-action sign-ups', 'the authorized campaign poll tally'],
  '../../app/mfa-challenge.tsx': ['before protected worker data is loaded'],
  './notificationCopy.ts': ['protected notification registration'],
};

describe('demo-path copy reads like a product (H2-H10)', () => {
  it.each(Object.entries(retired))('keeps the retired wording out of %s', (path, phrases) => {
    const source = read(path);
    for (const phrase of phrases) expect(source, phrase).not.toContain(phrase);
  });

  it('says the staff desk layout is fixed instead of offering a preview session', () => {
    const widgets = read('../components/WorkWidgets.tsx');
    expect(widgets).toContain('This desk layout is fixed for now, so changes made here are not kept.');
    expect(widgets).toContain('Your desk widgets. The layout is fixed for now.');
  });

  it('keeps "protected activity", the labor-law term, in committee member Pulse', () => {
    const steward = read('../features/StewardPulseScreen.tsx');
    expect(steward).toContain('Counted from protected activities');
    expect(steward).toContain('No protected activity recorded');
  });
});
