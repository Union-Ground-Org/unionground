import { describe, expect, it } from 'vitest';

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { workSurfaceState } from './workSurfaceState';

describe('workSurfaceState', () => {
  it('resolves authenticated and preview sessions with no dashboard to loading while refreshing', () => {
    for (const mode of ['authenticated', 'preview'] as const) {
      expect(workSurfaceState({ mode, hasDashboard: false, refreshing: true })).toBe('loading');
    }
  });

  it('resolves authenticated and preview sessions with no dashboard and no refresh in flight to refreshFailed', () => {
    for (const mode of ['authenticated', 'preview'] as const) {
      expect(workSurfaceState({ mode, hasDashboard: false, refreshing: false })).toBe('refreshFailed');
    }
  });

  it('keeps signed-out sessions on sign-in guidance regardless of dashboard or refresh state', () => {
    for (const hasDashboard of [true, false]) {
      for (const refreshing of [true, false]) {
        expect(workSurfaceState({ mode: 'signedOut', hasDashboard, refreshing })).toBe('signedOut');
      }
    }
  });

  it('keeps two-step-required sessions on verification guidance regardless of dashboard or refresh state', () => {
    for (const hasDashboard of [true, false]) {
      for (const refreshing of [true, false]) {
        expect(workSurfaceState({ mode: 'mfaRequired', hasDashboard, refreshing })).toBe('mfaRequired');
      }
    }
  });

  it('treats a booting session with no dashboard as still loading, never as a failure', () => {
    expect(workSurfaceState({ mode: 'booting', hasDashboard: false, refreshing: false })).toBe('loading');
    expect(workSurfaceState({ mode: 'booting', hasDashboard: false, refreshing: true })).toBe('loading');
  });

  it('resolves a loaded dashboard to ready for session modes without an authentication gate', () => {
    for (const mode of ['booting', 'authenticated', 'preview'] as const) {
      expect(workSurfaceState({ mode, hasDashboard: true, refreshing: false })).toBe('ready');
      expect(workSurfaceState({ mode, hasDashboard: true, refreshing: true })).toBe('ready');
    }
  });
});

describe('WorkScreen null-dashboard source contract', () => {
  const workScreenSource = readFileSync(fileURLToPath(new URL('../features/WorkScreen.tsx', import.meta.url)), 'utf8');

  it('routes the null-dashboard branch through workSurfaceState instead of unconditional sign-in copy', () => {
    expect(workScreenSource).toContain("from '../lib/workSurfaceState'");
    expect(workScreenSource).toContain('workSurfaceState({ mode, hasDashboard: false, refreshing })');
    expect(workScreenSource).not.toContain('Sign in to see your issues." /></Screen>');
  });

  it('keeps sign-in copy out of the authenticated loading and refresh-failure guidance', () => {
    expect(workScreenSource).toContain("{ title: t(\"Loading your work\"), body: t(\"Your issues are on their way.\") }");
    expect(workScreenSource).toContain("{ title: t(\"Work could not load\"), body: t(\"Your issues did not load. Check your connection and try again.\") }");
    const recoveryBodies = [
      'Your issues are on their way.',
      'Your issues did not load. Check your connection and try again.',
    ];
    for (const body of recoveryBodies) {
      expect(body.toLowerCase()).not.toContain('sign in');
    }
    // Sign-in copy survives only on the signed-out branch of the same ternary.
    const recoveryStart = workScreenSource.indexOf('const recoveryMessage');
    const recoveryEnd = workScreenSource.indexOf('const showRecovery');
    expect(recoveryStart).toBeGreaterThan(-1);
    expect(recoveryEnd).toBeGreaterThan(recoveryStart);
    const recoveryBlock = workScreenSource.slice(recoveryStart, recoveryEnd);
    expect(recoveryBlock).toContain('Sign in to see your issues.');
  });

  it('wires the visible Try again recovery control itself to refresh and disables it while refreshing', () => {
    const actionStart = workScreenSource.indexOf('action={showRecovery ? <Button');
    const actionEnd = workScreenSource.indexOf('/> : undefined}', actionStart);
    expect(actionStart).toBeGreaterThan(-1);
    expect(actionEnd).toBeGreaterThan(actionStart);

    // Scope these assertions to StateMessage.action's Button. Screen also has
    // an onRefresh callback, and that unrelated callback must not be able to
    // keep this interaction contract green if Try again stops refreshing.
    const recoveryAction = workScreenSource.slice(actionStart, actionEnd);
    expect(recoveryAction).toContain("label={t(\"Try again\")}");
    expect(recoveryAction).toContain('onPress={() => { void refresh(); }}');
    expect(recoveryAction).toContain('disabled={refreshing}');
  });

  it('withholds the recovery action while bootstrap is still running, when refresh() is a no-op', () => {
    // AppProvider.refresh() only acts on a preview session or an established
    // session; a cold-launch restore has neither, so the booting window must
    // not render a dead Try again control or pull-to-refresh.
    expect(workScreenSource).toContain("mode !== 'booting'");
    expect(workScreenSource).toMatch(/const showRecovery = mode !== 'booting' && \(surfaceState === 'loading' \|\| surfaceState === 'refreshFailed'\)/);
  });

  it('keeps authentication-appropriate guidance for signed-out and two-step-required sessions', () => {
    expect(workScreenSource).toContain('Sign in to see your issues.');
    expect(workScreenSource).toContain('Two-step verification is required');
  });
});
