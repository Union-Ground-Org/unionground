import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import { describe, expect, it, vi } from 'vitest';

import { biometricAvailabilityRefreshDue, foregroundLockAfterRefresh, readBiometricAvailability } from './biometricAvailability';

// BUG-UG-MOBILE-IOS-SWITCH-DISABLED-STATE-NOT-EXPOSED-20260918, acceptance
// item 5: "A unit assertion fails if the biometric row stops tracking
// availability." The 2026-09-27 device windows (Android 7b/7d, iPhone 9) found
// the SAMPLE Account row stuck on "Unavailable" with biometrics enrolled: the
// provider read availability once inside the cold-restore promise and dropped
// the reading whenever an auth event moved the session transition first. The
// helper is exercised directly, the provider's refresh callback is run through
// the same vm extraction biometricLockHandler.test.ts uses, and the three
// wiring points (cold restore, foreground, Account mount) are pinned by source.

const provider = readFileSync(new URL('../state/AppProvider.tsx', import.meta.url), 'utf8');
const account = readFileSync(new URL('../../app/(tabs)/account.tsx', import.meta.url), 'utf8');

describe('readBiometricAvailability', () => {
  it('reports enrolled biometrics and honours the stored preference only while they are available', async () => {
    await expect(readBiometricAvailability(async () => true, async () => true)).resolves.toEqual({ available: true, lockEnabled: true });
    await expect(readBiometricAvailability(async () => true, async () => false)).resolves.toEqual({ available: true, lockEnabled: false });
    await expect(readBiometricAvailability(async () => false, async () => true)).resolves.toEqual({ available: false, lockEnabled: false });
  });

  it('propagates a probe failure instead of guessing', async () => {
    await expect(readBiometricAvailability(async () => { throw new Error('probe'); }, async () => true)).rejects.toThrow('probe');
  });
});

describe('biometricAvailabilityRefreshDue', () => {
  it('fires on every transition into the foreground and nowhere else', () => {
    expect(biometricAvailabilityRefreshDue('background', 'active')).toBe(true);
    expect(biometricAvailabilityRefreshDue('inactive', 'active')).toBe(true);
    expect(biometricAvailabilityRefreshDue('unknown', 'active')).toBe(true);
    expect(biometricAvailabilityRefreshDue('active', 'active')).toBe(false);
    expect(biometricAvailabilityRefreshDue('active', 'background')).toBe(false);
    expect(biometricAvailabilityRefreshDue('active', 'inactive')).toBe(false);
  });
});

describe('foregroundLockAfterRefresh', () => {
  it('releases a lock nothing can open, locks a newly honourable preference, otherwise keeps', () => {
    expect(foregroundLockAfterRefresh({ available: false, lockEnabled: false }, true)).toBe('release');
    expect(foregroundLockAfterRefresh({ available: false, lockEnabled: false }, false)).toBe('release');
    expect(foregroundLockAfterRefresh({ available: true, lockEnabled: true }, true)).toBe('lock');
    expect(foregroundLockAfterRefresh({ available: true, lockEnabled: true }, false)).toBe('keep');
    expect(foregroundLockAfterRefresh({ available: true, lockEnabled: false }, true)).toBe('keep');
  });
});

describe('AppProvider.refreshBiometricAvailability', () => {
  const callback = provider.match(/const refreshBiometricAvailability = useCallback\((async[\s\S]*?), \[\]\);/)?.[1];
  if (!callback) throw new Error('Provider refreshBiometricAvailability callback was not found');
  const executable = ts.transpile(`const handler = ${callback}; handler;`, { target: ts.ScriptTarget.ES2022 });

  function run(options: { available: boolean; preferred: boolean }) {
    const biometricsAvailable = vi.fn(async () => options.available);
    const readBiometricLockPreference = vi.fn(async () => options.preferred);
    const setBiometricAvailable = vi.fn();
    const setBiometricLockEnabled = vi.fn();
    const biometricLockEnabledRef = { current: !options.preferred };
    const handler = runInNewContext(executable, {
      readBiometricAvailability, biometricsAvailable, readBiometricLockPreference,
      setBiometricAvailable, setBiometricLockEnabled, biometricLockEnabledRef,
    }) as () => Promise<{ available: boolean; lockEnabled: boolean }>;
    return { handler, biometricsAvailable, setBiometricAvailable, setBiometricLockEnabled, biometricLockEnabledRef };
  }

  it('re-reads the device and publishes an operable switch when biometrics are enrolled', async () => {
    const enrolled = run({ available: true, preferred: true });
    await expect(enrolled.handler()).resolves.toEqual({ available: true, lockEnabled: true });
    expect(enrolled.biometricsAvailable).toHaveBeenCalledTimes(1);
    expect(enrolled.setBiometricAvailable).toHaveBeenCalledWith(true);
    expect(enrolled.setBiometricLockEnabled).toHaveBeenCalledWith(true);
    expect(enrolled.biometricLockEnabledRef.current).toBe(true);
  });

  it('publishes the unavailable state and drops the stored lock when enrollment is gone', async () => {
    const gone = run({ available: false, preferred: true });
    await expect(gone.handler()).resolves.toEqual({ available: false, lockEnabled: false });
    expect(gone.setBiometricAvailable).toHaveBeenCalledWith(false);
    expect(gone.setBiometricLockEnabled).toHaveBeenCalledWith(false);
    expect(gone.biometricLockEnabledRef.current).toBe(false);
  });
});

describe('the biometric row tracks availability', () => {
  it('applies the cold-restore reading before the session-transition guard can discard it', () => {
    const restore = provider.indexOf('if (active) setBiometricAvailable(available);');
    const guard = provider.indexOf('if (!active || sessionTransition.current !== coldRestoreTransition) return;');
    expect(restore).toBeGreaterThan(-1);
    expect(guard).toBeGreaterThan(restore);
  });

  it('re-reads the device on every transition into the foreground and re-takes the re-lock decision on the fresh reading', () => {
    expect(provider).toContain('if (biometricAvailabilityRefreshDue(previous, next)) {');
    expect(provider).toContain('void refreshBiometricAvailability().then((snapshot) => {\n            if (deletionReceipt.current) return;\n            const decision = foregroundLockAfterRefresh(snapshot, lockDue);\n            if (decision === \'release\') setLocked(false);\n            else if (decision === \'lock\') setLocked(true);');
    // The synchronous decision on the last known state still runs first, so
    // a slow probe never delays a lock that was already due.
    expect(provider.indexOf('if (biometricLockEnabled && lockDue) setLocked(true);')).toBeLessThan(provider.indexOf('foregroundLockAfterRefresh(snapshot, lockDue)'));
  });

  it('re-reads the device when the Account screen mounts and exposes the callback to it', () => {
    expect(provider).toContain('refreshBiometricAvailability: () => Promise<BiometricAvailabilitySnapshot>;');
    expect(account).toContain('void refreshBiometricAvailability().catch(() => undefined);\n  }, [refreshBiometricAvailability]);');
    // The row itself still keys every copy and state off the live flag.
    expect(account).toContain("body={biometricAvailable ? t(\"Lock after the app has been backgrounded.\") : t(\"Unavailable: this phone has no Face ID, Touch ID or fingerprint set up.\")}");
    expect(account).toContain('disabled={!biometricAvailable}');
  });
});
