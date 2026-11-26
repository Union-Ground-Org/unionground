// Low data policy. Pure: this module reads no storage, calls no native module,
// and touches no network, so every decision below is reproducible from a mode
// and one network reading.
//
// The honest-unknown rule runs through all of it. A phone that does not report
// its network, or has not reported it yet, produces `supported: false` or null
// values, and Auto then leaves low data off with a reason that says so. The
// application never opens a request to find out what the system would not say.

export type LowDataMode = 'auto' | 'on' | 'off';

export const LOW_DATA_MODES: readonly LowDataMode[] = Object.freeze(['auto', 'on', 'off'] as const);

export const DEFAULT_LOW_DATA_MODE: LowDataMode = 'auto';

/**
 * Foreground poll spacing. Low data keeps optional polling alive at a quarter
 * of the request rate instead of stopping it, so a conversation still settles
 * without an explicit refresh.
 */
export const NORMAL_POLL_INTERVAL_MS = 30_000;
export const LOW_DATA_POLL_INTERVAL_MS = 120_000;

/**
 * One reading of the operating system's own view of the current path.
 *
 * - `supported`: the platform reported a reading at all.
 * - `connected`: a network that can actually carry a request.
 * - `expensive`: cellular, a personal hotspot, or a metered network.
 * - `constrained`: iOS Low Data Mode, or Android Data Saver restricting this app.
 *
 * `null` is a value, not a placeholder: it means the system did not say.
 */
export type NetworkSignals = {
  supported: boolean;
  connected: boolean | null;
  expensive: boolean | null;
  constrained: boolean | null;
};

export const UNKNOWN_NETWORK_SIGNALS: NetworkSignals = Object.freeze({
  supported: false,
  connected: null,
  expensive: null,
  constrained: null,
});

/**
 * Reasons are shown to the worker under the Low data control, so each one
 * names what decided the outcome and never blames the phone for a choice the
 * worker made.
 */
export const LOW_DATA_REASONS = Object.freeze({
  userOff: 'You chose Off, so Union Ground uses data normally.',
  userOn: 'You chose On, so Union Ground is saving data.',
  unsupported: 'This phone does not report its network to the app, so Auto leaves low data off.',
  noReading: 'Auto has no network reading yet, so low data stays off.',
  offline: 'Auto turned low data on: this phone reports no usable connection.',
  constrained: 'Auto turned low data on: this phone is set to save data.',
  expensive: 'Auto turned low data on: this connection is metered.',
  unrestricted: 'Auto left low data off: this connection is unmetered and unrestricted.',
} as const);

export type LowDataReason = (typeof LOW_DATA_REASONS)[keyof typeof LOW_DATA_REASONS];

export type LowDataPolicy = {
  mode: LowDataMode;
  enabled: boolean;
  reason: LowDataReason;
  signals: NetworkSignals;
};

/** Optional work low data defers, and the work it must never defer. */
export type LowDataWork =
  | 'optional-media'
  | 'optional-refresh'
  | 'explicit-refresh'
  | 'authorization';

export function normalizeLowDataMode(value: unknown): LowDataMode {
  return value === 'auto' || value === 'on' || value === 'off' ? value : DEFAULT_LOW_DATA_MODE;
}

function readOptionalBoolean(source: Record<string, unknown>, key: string): boolean | null {
  const value = source[key];
  return typeof value === 'boolean' ? value : null;
}

/**
 * Accepts one native reading. Anything that is not an explicitly supported
 * reading collapses to unknown, so a partly missing payload can never be read
 * as "connected, unmetered, unconstrained".
 */
export function normalizeNetworkSignals(value: unknown): NetworkSignals {
  if (typeof value !== 'object' || value === null) return UNKNOWN_NETWORK_SIGNALS;
  const source = value as Record<string, unknown>;
  if (source.supported !== true) return UNKNOWN_NETWORK_SIGNALS;
  return {
    supported: true,
    connected: readOptionalBoolean(source, 'connected'),
    expensive: readOptionalBoolean(source, 'expensive'),
    constrained: readOptionalBoolean(source, 'constrained'),
  };
}

function resolveAuto(signals: NetworkSignals): { enabled: boolean; reason: LowDataReason } {
  if (!signals.supported) return { enabled: false, reason: LOW_DATA_REASONS.unsupported };
  // An unusable network is stated before metering: it is the fact the member
  // can act on, and suppressing optional media avoids a burst on reconnect.
  if (signals.connected === false) return { enabled: true, reason: LOW_DATA_REASONS.offline };
  if (signals.constrained === true) return { enabled: true, reason: LOW_DATA_REASONS.constrained };
  if (signals.expensive === true) return { enabled: true, reason: LOW_DATA_REASONS.expensive };
  // Only a complete reading can conclude the connection is unrestricted.
  if (signals.constrained === false && signals.expensive === false) {
    return { enabled: false, reason: LOW_DATA_REASONS.unrestricted };
  }
  return { enabled: false, reason: LOW_DATA_REASONS.noReading };
}

/** The whole decision. Explicit On and Off never consult the network. */
export function resolveLowDataPolicy(mode: LowDataMode, signals: NetworkSignals): LowDataPolicy {
  if (mode === 'on') return { mode, enabled: true, reason: LOW_DATA_REASONS.userOn, signals };
  if (mode === 'off') return { mode, enabled: false, reason: LOW_DATA_REASONS.userOff, signals };
  const { enabled, reason } = resolveAuto(signals);
  return { mode, enabled, reason, signals };
}

/**
 * Low data defers work nobody asked for. A tapped refresh and anything on the
 * authorization path — sign-in, MFA, session refresh, a fresh authorization
 * before opening a file — always proceed, because a member who is waiting on
 * the screen is not background traffic.
 */
export function allowsLowDataWork(policy: LowDataPolicy, work: LowDataWork): boolean {
  if (work === 'explicit-refresh' || work === 'authorization') return true;
  return !policy.enabled;
}

/** Photos and other decorative media are optional; captions and text are not. */
export function suppressesOptionalMedia(policy: LowDataPolicy): boolean {
  return !allowsLowDataWork(policy, 'optional-media');
}

export function pollIntervalMsFor(policy: LowDataPolicy): number {
  return policy.enabled ? LOW_DATA_POLL_INTERVAL_MS : NORMAL_POLL_INTERVAL_MS;
}

/**
 * Value equality, so a store can hand React the same snapshot object when a
 * repeated reading changed nothing.
 */
export function lowDataPolicyEquals(left: LowDataPolicy, right: LowDataPolicy): boolean {
  return left.mode === right.mode
    && left.enabled === right.enabled
    && left.reason === right.reason
    && left.signals.supported === right.signals.supported
    && left.signals.connected === right.signals.connected
    && left.signals.expensive === right.signals.expensive
    && left.signals.constrained === right.signals.constrained;
}
