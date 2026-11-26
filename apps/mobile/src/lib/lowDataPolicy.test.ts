import { describe, expect, it } from 'vitest';

import {
  DEFAULT_LOW_DATA_MODE,
  LOW_DATA_MODES,
  LOW_DATA_POLL_INTERVAL_MS,
  LOW_DATA_REASONS,
  NORMAL_POLL_INTERVAL_MS,
  UNKNOWN_NETWORK_SIGNALS,
  allowsLowDataWork,
  lowDataPolicyEquals,
  normalizeLowDataMode,
  normalizeNetworkSignals,
  pollIntervalMsFor,
  resolveLowDataPolicy,
  suppressesOptionalMedia,
  type LowDataMode,
  type NetworkSignals,
} from './lowDataPolicy';

function reading(overrides: Partial<NetworkSignals> = {}): NetworkSignals {
  return { supported: true, connected: true, expensive: false, constrained: false, ...overrides };
}

const UNMETERED_WIFI = reading();
const METERED_CELLULAR = reading({ expensive: true });
const LOW_DATA_MODE_PATH = reading({ constrained: true });
const DISCONNECTED = reading({ connected: false, expensive: null, constrained: null });
const NO_READING_YET: NetworkSignals = { supported: true, connected: null, expensive: null, constrained: null };

describe('low data mode preference', () => {
  it('offers exactly Auto, On, and Off, and defaults to Auto', () => {
    expect(LOW_DATA_MODES).toEqual(['auto', 'on', 'off']);
    expect(DEFAULT_LOW_DATA_MODE).toBe('auto');
  });

  it('keeps a stored choice and falls back to Auto for anything else', () => {
    expect(normalizeLowDataMode('auto')).toBe('auto');
    expect(normalizeLowDataMode('on')).toBe('on');
    expect(normalizeLowDataMode('off')).toBe('off');
    for (const junk of [null, undefined, '', 'ON', 'Off', 'low', 1, true, {}, ['on']]) {
      expect(normalizeLowDataMode(junk)).toBe('auto');
    }
  });
});

describe('network reading normalization', () => {
  it('collapses a missing, malformed, or unsupported reading to an explicit unknown', () => {
    for (const absent of [null, undefined, '', 'supported', 7, true, [], () => true]) {
      expect(normalizeNetworkSignals(absent)).toEqual(UNKNOWN_NETWORK_SIGNALS);
    }
    expect(normalizeNetworkSignals({ connected: true, expensive: false, constrained: false }))
      .toEqual(UNKNOWN_NETWORK_SIGNALS);
    // An unsupported reading cannot smuggle values through: a platform that
    // says it does not report the network is not trusted for the rest.
    expect(normalizeNetworkSignals({ supported: false, connected: true, expensive: false, constrained: false }))
      .toEqual(UNKNOWN_NETWORK_SIGNALS);
    expect(normalizeNetworkSignals({ supported: 'yes', connected: true }))
      .toEqual(UNKNOWN_NETWORK_SIGNALS);
  });

  it('keeps every reported boolean and reports the rest as not known', () => {
    expect(normalizeNetworkSignals({ supported: true, connected: false, expensive: true, constrained: true }))
      .toEqual({ supported: true, connected: false, expensive: true, constrained: true });
    // A partial payload becomes nulls, never false: "not reported" and
    // "reported as unmetered" must not read the same.
    expect(normalizeNetworkSignals({ supported: true, connected: true }))
      .toEqual({ supported: true, connected: true, expensive: null, constrained: null });
    expect(normalizeNetworkSignals({ supported: true, connected: 1, expensive: 'no', constrained: null }))
      .toEqual({ supported: true, connected: null, expensive: null, constrained: null });
  });
});

describe('explicit low data choices', () => {
  it('honours On and Off without consulting the network at all', () => {
    for (const signals of [UNMETERED_WIFI, METERED_CELLULAR, DISCONNECTED, UNKNOWN_NETWORK_SIGNALS]) {
      const on = resolveLowDataPolicy('on', signals);
      expect(on).toEqual({ mode: 'on', enabled: true, reason: LOW_DATA_REASONS.userOn, signals });
      const off = resolveLowDataPolicy('off', signals);
      expect(off).toEqual({ mode: 'off', enabled: false, reason: LOW_DATA_REASONS.userOff, signals });
    }
  });

  it('carries the reading through every mode so offline handling can read it', () => {
    for (const mode of LOW_DATA_MODES) {
      expect(resolveLowDataPolicy(mode, DISCONNECTED).signals.connected).toBe(false);
    }
  });
});

describe('automatic low data decisions', () => {
  it('falls back to off with an honest reason when the phone reports no network support', () => {
    expect(resolveLowDataPolicy('auto', UNKNOWN_NETWORK_SIGNALS)).toEqual({
      mode: 'auto',
      enabled: false,
      reason: LOW_DATA_REASONS.unsupported,
      signals: UNKNOWN_NETWORK_SIGNALS,
    });
  });

  it('falls back to off while a supported phone has not reported a reading yet', () => {
    const policy = resolveLowDataPolicy('auto', NO_READING_YET);
    expect(policy.enabled).toBe(false);
    expect(policy.reason).toBe(LOW_DATA_REASONS.noReading);
  });

  it('turns low data on for a metered connection', () => {
    const policy = resolveLowDataPolicy('auto', METERED_CELLULAR);
    expect(policy.enabled).toBe(true);
    expect(policy.reason).toBe(LOW_DATA_REASONS.expensive);
  });

  it('turns low data on for a constrained connection even when it is not metered', () => {
    const policy = resolveLowDataPolicy('auto', LOW_DATA_MODE_PATH);
    expect(policy.enabled).toBe(true);
    expect(policy.reason).toBe(LOW_DATA_REASONS.constrained);
    expect(policy.signals.expensive).toBe(false);
  });

  it('turns low data on when the phone reports no usable connection', () => {
    const policy = resolveLowDataPolicy('auto', DISCONNECTED);
    expect(policy.enabled).toBe(true);
    expect(policy.reason).toBe(LOW_DATA_REASONS.offline);
  });

  it('prefers the connection statement over metering when both are true', () => {
    const policy = resolveLowDataPolicy('auto', reading({ connected: false, expensive: true, constrained: true }));
    expect(policy.reason).toBe(LOW_DATA_REASONS.offline);
  });

  it('names data saver before metering, because that is what the worker changed', () => {
    const policy = resolveLowDataPolicy('auto', reading({ expensive: true, constrained: true }));
    expect(policy.reason).toBe(LOW_DATA_REASONS.constrained);
  });

  it('leaves low data off only on a complete unmetered, unrestricted reading', () => {
    const policy = resolveLowDataPolicy('auto', UNMETERED_WIFI);
    expect(policy.enabled).toBe(false);
    expect(policy.reason).toBe(LOW_DATA_REASONS.unrestricted);

    // Half a reading is not a conclusion.
    for (const partial of [
      reading({ expensive: null }),
      reading({ constrained: null }),
      reading({ connected: null, expensive: null }),
    ]) {
      const undecided = resolveLowDataPolicy('auto', partial);
      expect(undecided.enabled).toBe(false);
      expect(undecided.reason).toBe(LOW_DATA_REASONS.noReading);
    }
  });

  it('follows a full interruption and reconnect without leaving low data latched on', () => {
    const journey = [UNMETERED_WIFI, DISCONNECTED, METERED_CELLULAR, LOW_DATA_MODE_PATH, UNMETERED_WIFI]
      .map((signals) => resolveLowDataPolicy('auto', signals));
    expect(journey.map((policy) => policy.enabled)).toEqual([false, true, true, true, false]);
    expect(journey.map((policy) => policy.reason)).toEqual([
      LOW_DATA_REASONS.unrestricted,
      LOW_DATA_REASONS.offline,
      LOW_DATA_REASONS.expensive,
      LOW_DATA_REASONS.constrained,
      LOW_DATA_REASONS.unrestricted,
    ]);
  });
});

describe('what low data defers', () => {
  const active = resolveLowDataPolicy('on', UNMETERED_WIFI);
  const inactive = resolveLowDataPolicy('off', METERED_CELLULAR);

  it('defers optional media and optional refresh while low data is active', () => {
    expect(allowsLowDataWork(active, 'optional-media')).toBe(false);
    expect(allowsLowDataWork(active, 'optional-refresh')).toBe(false);
    expect(suppressesOptionalMedia(active)).toBe(true);
  });

  it('never defers an explicit refresh or anything on the authorization path', () => {
    for (const policy of [active, inactive]) {
      expect(allowsLowDataWork(policy, 'explicit-refresh')).toBe(true);
      expect(allowsLowDataWork(policy, 'authorization')).toBe(true);
    }
  });

  it('defers nothing while low data is off', () => {
    for (const work of ['optional-media', 'optional-refresh', 'explicit-refresh', 'authorization'] as const) {
      expect(allowsLowDataWork(inactive, work)).toBe(true);
    }
    expect(suppressesOptionalMedia(inactive)).toBe(false);
  });

  it('spaces optional polling four times further apart instead of stopping it', () => {
    expect(NORMAL_POLL_INTERVAL_MS).toBe(30_000);
    expect(LOW_DATA_POLL_INTERVAL_MS).toBe(120_000);
    expect(LOW_DATA_POLL_INTERVAL_MS / NORMAL_POLL_INTERVAL_MS).toBe(4);
    expect(pollIntervalMsFor(active)).toBe(LOW_DATA_POLL_INTERVAL_MS);
    expect(pollIntervalMsFor(inactive)).toBe(NORMAL_POLL_INTERVAL_MS);
  });
});

describe('policy value equality', () => {
  it('treats two separately built identical policies as equal', () => {
    const left = resolveLowDataPolicy('auto', reading({ expensive: true }));
    const right = resolveLowDataPolicy('auto', reading({ expensive: true }));
    expect(left).not.toBe(right);
    expect(lowDataPolicyEquals(left, right)).toBe(true);
  });

  it('separates policies that differ in the mode or in any one reading', () => {
    const base = resolveLowDataPolicy('auto', UNMETERED_WIFI);
    const others: readonly [LowDataMode, NetworkSignals][] = [
      ['off', UNMETERED_WIFI],
      ['auto', reading({ connected: false })],
      ['auto', reading({ expensive: true })],
      ['auto', reading({ constrained: true })],
      ['auto', UNKNOWN_NETWORK_SIGNALS],
      ['auto', reading({ expensive: null })],
    ];
    for (const [mode, signals] of others) {
      expect(lowDataPolicyEquals(base, resolveLowDataPolicy(mode, signals))).toBe(false);
    }
  });
});

describe('reason copy', () => {
  it('is member-facing prose, because the settings card renders it directly', () => {
    const reasons = Object.values(LOW_DATA_REASONS);
    expect(new Set(reasons).size).toBe(reasons.length);
    for (const reason of reasons) {
      expect(reason.endsWith('.')).toBe(true);
      expect(reason).toMatch(/^[A-Z]/);
      expect(reason).not.toMatch(/[_-]{1}[a-z]+-/);
    }
  });
});
