import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

import { emailAuthExitHref, emailAuthExitStep } from './emailAuthExit';

// Gate rounds on #5036 (Grok r1g1, Sol final): the callback must not leave
// for sign-in while a member is still signed in, must not lose a successful
// sign-out that settles in the same commit as the signedOut mode, and must
// start the sign-out once a cold boot restores a live session.
describe('leaving the secure email screen for sign-in', () => {
  it('builds the plain and the reset=1 destinations', () => {
    expect(emailAuthExitHref({ reset: false })).toBe('/sign-in');
    expect(emailAuthExitHref({ reset: true })).toEqual({ pathname: '/sign-in', params: { reset: '1' } });
  });

  const exit = { reset: true };

  it('does nothing without a requested exit', () => {
    for (const mode of ['signedOut', 'booting', 'authenticated']) expect(emailAuthExitStep(mode, null, 'idle')).toBe('none');
  });

  it('navigates only once the committed mode is signedOut, whatever the sign-out promise did', () => {
    expect(emailAuthExitStep('signedOut', exit, 'idle')).toBe('navigate');
    expect(emailAuthExitStep('signedOut', exit, 'in-flight')).toBe('navigate');
    // The promise settled in the same commit as the signedOut mode: still an exit, never a refusal.
    expect(emailAuthExitStep('signedOut', exit, 'settled')).toBe('navigate');
  });

  it('waits through a cold boot, then starts the sign-out once a live session is restored', () => {
    expect(emailAuthExitStep('booting', exit, 'idle')).toBe('wait');
    for (const mode of ['authenticated', 'mfaRequired', 'preview']) expect(emailAuthExitStep(mode, exit, 'idle')).toBe('start-sign-out');
  });

  it('waits while the sign-out is in flight and reports a refusal only when it settled with the worker still signed in', () => {
    for (const mode of ['authenticated', 'mfaRequired', 'preview']) {
      expect(emailAuthExitStep(mode, exit, 'in-flight')).toBe('wait');
      expect(emailAuthExitStep(mode, exit, 'settled')).toBe('refused');
    }
    // A boot that settled the promise early is not a refusal: keep waiting.
    expect(emailAuthExitStep('booting', exit, 'settled')).toBe('wait');
  });

  it('is what the auth callback follows from committed state, with the sign-out diagnosis shown while the worker stays', () => {
    const callback = readFileSync(resolve(process.cwd(), 'app/auth/callback.tsx'), 'utf8');
    expect(callback).toContain('const step = emailAuthExitStep(mode, exit, signOutState);');
    expect(callback).toContain("if (step === 'navigate' && exit)");
    expect(callback).toContain("if (step === 'start-sign-out')");
    expect(callback).toContain("if (step === 'refused')");
    expect(callback).not.toMatch(/modeRef/);
    expect(callback).not.toMatch(/signOut\(\)\.then\(\(\) => router\.replace/);
    expect(callback).toContain('notice={signOutError}');
  });
});
