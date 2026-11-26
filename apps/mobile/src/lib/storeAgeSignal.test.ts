import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { normalizeStoreAgeSignal, readStoreAgeSignal, storeAgeSignalDecision, type StoreAgeSignal } from './storeAgeSignal';

const mobileRoot = join(import.meta.dirname, '../..');
const require = createRequire(import.meta.url);
const native = (platform: 'ios' | 'android', status: string, extra: Record<string, unknown> = {}) => ({
  platform, status, lower: null, upper: null, source: null, error: null, ...extra,
});

describe('store age signal (REQ-UG-MOBILE-STORE-AGE-SIGNAL-20261016)', () => {
  it.each(['ios', 'android'] as const)('reads each %s outcome the native module reports', (platform) => {
    expect(normalizeStoreAgeSignal(native(platform, 'shared', { lower: 18, upper: null, source: 'selfDeclared' })))
      .toEqual({ kind: 'adult', platform, lower: 18, upper: null, source: 'selfDeclared' });
    expect(normalizeStoreAgeSignal(native(platform, 'shared', { lower: 16, upper: 17, source: 'tier-b' })))
      .toEqual({ kind: 'minor', platform, lower: 16, upper: 17, source: 'tier-b' });
    expect(normalizeStoreAgeSignal(native(platform, 'shared', { lower: null, upper: 12 })))
      .toMatchObject({ kind: 'minor', upper: 12 });
    // Both bounds missing, or a regulatory range across 18, settles nothing.
    expect(normalizeStoreAgeSignal(native(platform, 'shared'))).toMatchObject({ kind: 'indeterminate' });
    expect(normalizeStoreAgeSignal(native(platform, 'shared', { lower: 16, upper: null }))).toMatchObject({ kind: 'indeterminate' });
    expect(normalizeStoreAgeSignal(native(platform, 'declined'))).toEqual({ kind: 'declined', platform });
    expect(normalizeStoreAgeSignal(native(platform, 'verification-required'))).toEqual({ kind: 'verification-required', platform });
    expect(normalizeStoreAgeSignal(native(platform, 'not-eligible'))).toEqual({ kind: 'not-eligible', platform });
    expect(normalizeStoreAgeSignal(native(platform, 'unavailable', { error: 'network' })))
      .toEqual({ kind: 'unavailable', platform, reason: 'network' });
  });

  it('reads each store\'s under-18 bound by its own convention', () => {
    //  on #4776. Apple: upperBound is the lowest requested gate that
    // exceeds the declared age, so with the single gate 18 a person under 18
    // arrives as lower nil, upper 18. Play: ageUpper is inclusive, so an
    // under-18 band ends at 17 and an upper bound of 18 could still be an adult.
    expect(normalizeStoreAgeSignal(native('ios', 'shared', { lower: null, upper: 18 }))).toMatchObject({ kind: 'minor', upper: 18 });
    expect(normalizeStoreAgeSignal(native('ios', 'shared', { lower: 13, upper: 18 }))).toMatchObject({ kind: 'minor' });
    expect(normalizeStoreAgeSignal(native('android', 'shared', { lower: null, upper: 18 }))).toMatchObject({ kind: 'indeterminate' });
    expect(normalizeStoreAgeSignal(native('android', 'shared', { lower: 16, upper: 17 }))).toMatchObject({ kind: 'minor' });
    // A lower bound at the gate is an adult on both, whatever the upper bound.
    expect(normalizeStoreAgeSignal(native('ios', 'shared', { lower: 18, upper: 18 }))).toMatchObject({ kind: 'adult' });
    expect(normalizeStoreAgeSignal(native('android', 'shared', { lower: 18, upper: 18 }))).toMatchObject({ kind: 'adult' });
    // The decision follows: an Apple-reported minor in Texas is blocked.
    expect(storeAgeSignalDecision(normalizeStoreAgeSignal(native('ios', 'shared', { lower: null, upper: 18 })), 'TX')).toBe('block-minor');
  });

  it('treats anything malformed as unavailable, never as an adult', () => {
    for (const raw of [
      null, 'adult', [], {}, { platform: 'web', status: 'shared', lower: 18 },
      native('ios', 'sharing', { lower: 18 }),
      native('ios', 'shared', { lower: '18' }),
      native('android', 'shared', { lower: 18.5 }),
      native('android', 'shared', { lower: -1 }),
      native('android', 'shared', { lower: 18, upper: 17 }),
    ]) {
      expect(normalizeStoreAgeSignal(raw), JSON.stringify(raw)).toMatchObject({ kind: 'unavailable', reason: 'malformed' });
    }
    // An error code or source that is not a plain short token is not echoed.
    expect(normalizeStoreAgeSignal(native('ios', 'unavailable', { error: 'Network <script>' }))).toMatchObject({ reason: 'unknown-error' });
    expect(normalizeStoreAgeSignal(native('ios', 'shared', { lower: 18, source: 'x'.repeat(80) }))).toMatchObject({ kind: 'adult', source: null });
  });

  it('reports an unavailable signal when the module is missing or the request rejects', async () => {
    await expect(readStoreAgeSignal(null)).resolves.toEqual({ kind: 'unavailable', platform: null, reason: 'module-missing' });
    await expect(readStoreAgeSignal({ requestAgeSignalAsync: () => Promise.reject(new Error('boom')) }))
      .resolves.toEqual({ kind: 'unavailable', platform: null, reason: 'request-failed' });
    await expect(readStoreAgeSignal({ requestAgeSignalAsync: async () => native('android', 'shared', { lower: 13, upper: 15 }) }))
      .resolves.toMatchObject({ kind: 'minor', platform: 'android' });
  });

  it('blocks account creation only for a store-reported minor in an app-store age-law state', () => {
    const minor = normalizeStoreAgeSignal(native('ios', 'shared', { lower: 13, upper: 15 }));
    const adult = normalizeStoreAgeSignal(native('android', 'shared', { lower: 18 }));
    const others: StoreAgeSignal[] = [
      normalizeStoreAgeSignal(native('ios', 'shared')),
      { kind: 'declined', platform: 'ios' },
      { kind: 'verification-required', platform: 'android' },
      { kind: 'not-eligible', platform: 'ios' },
      { kind: 'unavailable', platform: null, reason: 'module-missing' },
    ];
    for (const state of ['TX', 'CA', 'AL', 'UT', 'LA']) {
      expect(storeAgeSignalDecision(minor, state), state).toBe('block-minor');
      expect(storeAgeSignalDecision(adult, state), state).toBe('store-adult');
      for (const signal of others) expect(storeAgeSignalDecision(signal, state), `${state} ${signal.kind}`).toBe('self-attestation');
    }
    // Outside those states, and for an unknown answer, the store signal changes nothing.
    for (const residence of ['NY', 'outside-us', 'ZZ', '']) {
      expect(storeAgeSignalDecision(minor, residence), residence).toBe('self-attestation');
    }
  });

  it('adds the Declared Age Range entitlement and is registered in the app config', async () => {
    const plugin = require('../../modules/store-age-signal/app.plugin.js') as (config: Record<string, unknown>) => {
      mods: { ios: { entitlements: (config: Record<string, unknown>) => Promise<{ modResults: Record<string, unknown> }> } };
    };
    const configured = plugin({ name: 'Union Ground', slug: 'union-ground-mobile' });
    const result = await configured.mods.ios.entitlements({
      ...configured,
      modResults: { 'aps-environment': 'production' },
      modRequest: { platform: 'ios', modName: 'entitlements', projectRoot: mobileRoot, platformProjectRoot: mobileRoot, introspect: true },
    });
    expect(result.modResults).toEqual({ 'aps-environment': 'production', 'com.apple.developer.declared-age-range': true });
    const appConfig = readFileSync(join(mobileRoot, 'app.config.ts'), 'utf8');
    expect(appConfig).toContain("'./modules/store-age-signal/app.plugin.js',");
  });

  it('declares one optional module on both platforms with the pinned Play Age Signals library', () => {
    const moduleRoot = join(mobileRoot, 'modules/store-age-signal');
    expect(JSON.parse(readFileSync(join(moduleRoot, 'expo-module.config.json'), 'utf8'))).toEqual({
      platforms: ['android', 'ios'],
      apple: { modules: ['StoreAgeSignalModule'] },
      android: { modules: ['expo.modules.storeagesignal.StoreAgeSignalModule'] },
    });
    expect(readFileSync(join(moduleRoot, 'android/build.gradle'), 'utf8'))
      .toContain("implementation 'com.google.android.play:age-signals:0.0.4'");
    expect(readFileSync(join(moduleRoot, 'src/StoreAgeSignalModule.ts'), 'utf8'))
      .toContain("requireOptionalNativeModule<StoreAgeSignalModule>('StoreAgeSignal')");
    const swift = readFileSync(join(moduleRoot, 'ios/StoreAgeSignalModule.swift'), 'utf8');
    expect(swift).toContain('requestAgeRange(ageGates: 18, in: controller)');
    expect(swift).toContain('#if canImport(DeclaredAgeRange)');
  });
});
