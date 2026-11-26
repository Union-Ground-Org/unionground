// BUG-UG-MOBILE-IOS-SWITCH-DISABLED-STATE-NOT-EXPOSED-20260918, acceptance
// items 4 and 5 (Android window 7b/7d, iPhone windows 2/8/9, 2026-09-27): on
// SAMPLE the Account "Biometric re-lock" row read "Unavailable — no enrolled
// device biometrics detected." with the Switch disabled, warm and after a cold
// start, on phones with fingerprints and Face ID enrolled, while the fictional
// PREVIEW on the same build showed an operable switch. Mechanism: the provider
// read availability exactly once, inside the cold-restore promise, and applied
// it only when no session transition had happened in the meantime. A restored
// session raises auth events during that window (token refresh, sign-in), so
// the read was discarded and the flag kept its `false` initial value for the
// life of the process. The landing → Open the demo path restores no session, so
// nothing raced the read there and the switch was operable — the IPHONE2
// observation.
//
// The availability of device biometrics is a device fact, not a session fact.
// It is read independently of the session transition, re-read on every
// foreground and when Account mounts, and the persisted lock preference is
// resolved against the fresh reading each time.

export type BiometricAvailabilitySnapshot = {
  available: boolean;
  lockEnabled: boolean;
};

export async function readBiometricAvailability(
  probeAvailable: () => Promise<boolean>,
  readLockPreference: () => Promise<boolean>,
): Promise<BiometricAvailabilitySnapshot> {
  const [available, preferred] = await Promise.all([probeAvailable(), readLockPreference()]);
  // A stored preference is only honoured while the device can still verify a
  // biometric; a device that lost its enrollment must not lock the member out.
  return { available: available === true, lockEnabled: available === true && preferred === true };
}

// The re-read happens on the transition INTO the foreground, once per
// backgrounding; 'inactive' → 'active' (an iOS control-centre bounce) counts
// because Settings can change enrollment on either side of it.
export function biometricAvailabilityRefreshDue(previous: string, next: string): boolean {
  return next === 'active' && previous !== 'active';
}

// After a foreground refresh the re-lock decision is taken again on the fresh
// reading: a device that lost its enrollment cannot be unlocked (nothing to
// authenticate against), so a lock taken on the stale flag is released; a
// device that gained enrollment while a stored preference was waiting locks
// now if the background threshold has passed.
export type ForegroundLockDecision = 'lock' | 'release' | 'keep';

export function foregroundLockAfterRefresh(
  snapshot: BiometricAvailabilitySnapshot,
  lockDue: boolean,
): ForegroundLockDecision {
  if (!snapshot.available) return 'release';
  return snapshot.lockEnabled && lockDue ? 'lock' : 'keep';
}
