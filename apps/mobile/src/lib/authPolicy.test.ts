import { describe, expect, it } from 'vitest';

import { sessionRequiresTotp } from './authPolicy';

describe('mobile authentication policy', () => {
  it('requires the authoritative next AAL2 challenge only while the session remains at AAL1', () => {
    expect(sessionRequiresTotp({ currentLevel: 'aal1', nextLevel: 'aal2' })).toBe(true);
    expect(sessionRequiresTotp({ currentLevel: 'aal2', nextLevel: 'aal2' })).toBe(false);
    expect(sessionRequiresTotp({ currentLevel: 'aal1', nextLevel: 'aal1' })).toBe(false);
  });

  it('never demands a step-up when the assurance payload itself is missing', () => {
    expect(sessionRequiresTotp(null)).toBe(false);
    expect(sessionRequiresTotp({})).toBe(false);
    expect(sessionRequiresTotp({ currentLevel: null, nextLevel: null })).toBe(false);
  });

  it('ignores an absent next level and still steps up when only the current level is absent', () => {
    expect(sessionRequiresTotp({ currentLevel: 'aal1' })).toBe(false);
    expect(sessionRequiresTotp({ currentLevel: 'aal2', nextLevel: null })).toBe(false);
    expect(sessionRequiresTotp({ nextLevel: 'aal2' })).toBe(true);
    expect(sessionRequiresTotp({ currentLevel: null, nextLevel: 'aal2' })).toBe(true);
  });
});
