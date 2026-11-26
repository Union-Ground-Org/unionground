import { describe, expect, it } from 'vitest';

import { shouldCoverOnAppState } from './appStatePrivacyCover';

describe('shouldCoverOnAppState', () => {
  it('covers a protected surface when the app goes inactive or to the background', () => {
    expect(shouldCoverOnAppState('inactive', true, false)).toBe(true);
    expect(shouldCoverOnAppState('background', true, false)).toBe(true);
  });

  it('leaves an open native sign-in sheet visible while the app is only inactive', () => {
    // Physical iPhone, October 1, 2026: Google's in-app sheet went blank under the cover.
    expect(shouldCoverOnAppState('inactive', true, true)).toBe(false);
  });

  it('still covers when the app is backgrounded during a sign-in prompt', () => {
    expect(shouldCoverOnAppState('background', true, true)).toBe(true);
  });

  it('never covers an unprotected surface or an active app', () => {
    expect(shouldCoverOnAppState('inactive', false, false)).toBe(false);
    expect(shouldCoverOnAppState('background', false, true)).toBe(false);
    expect(shouldCoverOnAppState('active', true, false)).toBe(false);
  });
});
