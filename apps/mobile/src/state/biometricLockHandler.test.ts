import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import { describe, expect, it, vi } from 'vitest';

// SEC-UG-MOBILE-BIOMETRIC-LOCK-DISABLE-REAUTH-20260920: the provider used
// to gate both the enrollment probe and the authentication prompt on the
// `enabled` argument, so only arming the re-lock was challenged and turning it
// off reached SecureStore unanswered. Run the real callback with controlled
// native boundaries — the same extraction signOutHandler.test.ts uses — so the
// guard cannot be satisfied by a comment or a duplicated harness.
const provider = readFileSync(new URL('./AppProvider.tsx', import.meta.url), 'utf8');
const callback = provider.match(/const setBiometricLock = useCallback\((async[\s\S]*?), \[\]\);/)?.[1];
if (!callback) throw new Error('Provider biometric-lock callback was not found');
const executable = ts.transpile(`const handler = ${callback}; handler;`, { target: ts.ScriptTarget.ES2022 });

function runToggle(options: { available: boolean; prompt: boolean }) {
  const biometricsAvailable = vi.fn(async () => options.available);
  const authenticateForUnlock = vi.fn(async () => options.prompt);
  const saveBiometricLockPreference = vi.fn(async () => undefined);
  const setBiometricLockEnabled = vi.fn();
  const setLocked = vi.fn();
  const select = vi.fn(async () => undefined);
  const biometricLockEnabledRef = { current: true };
  const environment = {
    biometricsAvailable, authenticateForUnlock, saveBiometricLockPreference,
    biometricLockEnabledRef, setBiometricLockEnabled, setLocked,
    haptics: { select },
  };
  const handler = runInNewContext(executable, environment) as (enabled: boolean) => Promise<boolean>;
  return {
    handler, biometricsAvailable, authenticateForUnlock, saveBiometricLockPreference,
    biometricLockEnabledRef, setBiometricLockEnabled, setLocked, select,
  };
}

describe('provider biometric re-lock write boundary', () => {
  it('refuses to turn the lock off when the confirmation prompt is cancelled or fails', async () => {
    const run = runToggle({ available: true, prompt: false });
    await expect(run.handler(false)).resolves.toBe(false);
    expect(run.authenticateForUnlock).toHaveBeenCalledTimes(1);
    expect(run.saveBiometricLockPreference).not.toHaveBeenCalled();
    expect(run.setBiometricLockEnabled).not.toHaveBeenCalled();
    expect(run.setLocked).not.toHaveBeenCalled();
    expect(run.select).not.toHaveBeenCalled();
    expect(run.biometricLockEnabledRef.current).toBe(true);
  });

  it('turns the lock off once the confirmation prompt succeeds', async () => {
    const run = runToggle({ available: true, prompt: true });
    await expect(run.handler(false)).resolves.toBe(true);
    expect(run.authenticateForUnlock).toHaveBeenCalledTimes(1);
    expect(run.saveBiometricLockPreference).toHaveBeenCalledWith(false);
    expect(run.setBiometricLockEnabled).toHaveBeenCalledWith(false);
    expect(run.biometricLockEnabledRef.current).toBe(false);
    expect(run.select).toHaveBeenCalledTimes(1);
  });

  it('still requires the prompt to turn the lock on', async () => {
    const refused = runToggle({ available: true, prompt: false });
    await expect(refused.handler(true)).resolves.toBe(false);
    expect(refused.authenticateForUnlock).toHaveBeenCalledTimes(1);
    expect(refused.saveBiometricLockPreference).not.toHaveBeenCalled();

    const confirmed = runToggle({ available: true, prompt: true });
    await expect(confirmed.handler(true)).resolves.toBe(true);
    expect(confirmed.saveBiometricLockPreference).toHaveBeenCalledWith(true);
    expect(confirmed.biometricLockEnabledRef.current).toBe(true);
  });

  it('turns the lock off without a prompt on a device that has lost its enrollment', async () => {
    const run = runToggle({ available: false, prompt: false });
    await expect(run.handler(false)).resolves.toBe(true);
    expect(run.authenticateForUnlock).not.toHaveBeenCalled();
    expect(run.saveBiometricLockPreference).toHaveBeenCalledWith(false);
    expect(run.biometricLockEnabledRef.current).toBe(false);
  });

  it('still refuses to turn the lock on when the device has no enrolled biometric', async () => {
    const run = runToggle({ available: false, prompt: true });
    await expect(run.handler(true)).resolves.toBe(false);
    expect(run.authenticateForUnlock).not.toHaveBeenCalled();
    expect(run.saveBiometricLockPreference).not.toHaveBeenCalled();
  });
});
