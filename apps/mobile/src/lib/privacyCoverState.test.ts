import { describe, expect, it } from 'vitest';

import { PRIVACY_COVER_CHECKING_LABEL, PRIVACY_COVER_DEMO_LABEL, coverOpensDemo, privacyCoverContent } from './privacyCoverState';

describe('privacyCoverContent', () => {
  it('labels the cover while the app is in the foreground re-checking the session', () => {
    // Physical iPhone and Pixel, October 1, 2026: an offline open looked like a blank app.
    expect(privacyCoverContent(true)).toBe('checking');
    expect(PRIVACY_COVER_CHECKING_LABEL).toMatch(/Checking your secure session/);
  });

  it('keeps the background snapshot blank', () => {
    expect(privacyCoverContent(false)).toBe('blank');
  });
});

// After Explore the demo the whole screen showed the
// session-check words. On the SAMPLE host a cover that rises over a signed-out
// screen says it is opening the demo; the mode turns booting as it rises, so
// the decision reads the mode from before the cover.
describe('coverOpensDemo', () => {
  const opens = (covered: boolean, modeBeforeCover: string, liveSample = true) => coverOpensDemo({ covered, liveSample, modeBeforeCover });

  it('says the demo is opening when a signed-out SAMPLE screen signs in', () => {
    expect(PRIVACY_COVER_DEMO_LABEL).toBe('Opening the demo…');
    expect(opens(true, 'signedOut')).toBe(true);
    expect(opens(false, 'signedOut')).toBe(false);
  });

  it('keeps the session-check words for a restore, a return from the background and every other host', () => {
    expect(opens(true, 'booting')).toBe(false);
    expect(opens(true, 'authenticated')).toBe(false);
    expect(opens(true, 'mfaRequired')).toBe(false);
    expect(opens(true, 'signedOut', false)).toBe(false);
  });
});
