import { ageRuleFor } from '../../../../src/lib/residenceRegions.js';

// The app store's age signal (REQ-UG-MOBILE-STORE-AGE-SIGNAL-20261016):
// Apple Declared Age Range on iOS and Play Age Signals on Android, read through
// modules/store-age-signal. This is the data layer only: it validates what the
// native module reports and says whether account creation must stop. It shows
// nothing and records nothing.
//
// The one rule it applies is the record's: an account the store reports as
// under 18 in an app-store age-law state (src/lib/residenceRegions.js, the same
// list the server records) cannot finish account creation. Every other outcome
// (declined, verification required, not eligible, unavailable, or a range that
// does not settle the 18 question) leaves the existing self-attested 18-or-older
// rule in charge; what to do beyond that is an owner decision, not this module's.

export type StoreAgeSignalPlatform = 'ios' | 'android';

export type StoreAgeSignal =
  | { kind: 'adult'; platform: StoreAgeSignalPlatform; lower: number; upper: number | null; source: string | null }
  | { kind: 'minor'; platform: StoreAgeSignalPlatform; lower: number | null; upper: number; source: string | null }
  | { kind: 'indeterminate'; platform: StoreAgeSignalPlatform; lower: number | null; upper: number | null; source: string | null }
  | { kind: 'declined'; platform: StoreAgeSignalPlatform }
  | { kind: 'verification-required'; platform: StoreAgeSignalPlatform }
  | { kind: 'not-eligible'; platform: StoreAgeSignalPlatform }
  | { kind: 'unavailable'; platform: StoreAgeSignalPlatform | null; reason: string };

export type StoreAgeSignalDecision = 'block-minor' | 'store-adult' | 'self-attestation';

const ADULT_AGE = 18;
const ERROR_CODE = /^[a-z][a-z-]{0,39}$/;
const SOURCE = /^[A-Za-z][A-Za-z0-9-]{0,39}$/;

type StoreAgeSignalNative = { requestAgeSignalAsync(): Promise<unknown> };

function age(value: unknown): number | null | undefined {
  if (value === null || value === undefined) return null;
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= 150 ? value : undefined;
}

function unavailable(platform: StoreAgeSignalPlatform | null, reason: string): StoreAgeSignal {
  return { kind: 'unavailable', platform, reason };
}

/** Validates one native result; anything malformed is an unavailable signal, never an adult. */
export function normalizeStoreAgeSignal(raw: unknown): StoreAgeSignal {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return unavailable(null, 'malformed');
  const value = raw as Record<string, unknown>;
  const platform = value.platform === 'ios' || value.platform === 'android' ? value.platform : null;
  if (!platform) return unavailable(null, 'malformed');
  switch (value.status) {
    case 'declined':
    case 'verification-required':
    case 'not-eligible':
      return { kind: value.status, platform };
    case 'unavailable':
      return unavailable(platform, typeof value.error === 'string' && ERROR_CODE.test(value.error) ? value.error : 'unknown-error');
    case 'shared': {
      const lower = age(value.lower);
      const upper = age(value.upper);
      if (lower === undefined || upper === undefined || (lower !== null && upper !== null && lower > upper)) {
        return unavailable(platform, 'malformed');
      }
      const source = typeof value.source === 'string' && SOURCE.test(value.source) ? value.source : null;
      // A range starting at 18 or above is an adult. Below that, the two
      // stores bound a minor differently: Apple's upperBound is the lowest
      // requested gate that exceeds the declared age (with the single gate 18,
      // a person under 18 is reported as lower nil, upper 18), while Play's
      // ageUpper is inclusive (an under-18 band ends at 17). So an Apple upper
      // bound at or below the gate, or a Play upper bound below it, is a
      // minor; both bounds missing or a range across 18 settles nothing.
      if (lower !== null && lower >= ADULT_AGE) return { kind: 'adult', platform, lower, upper, source };
      const minorUpperBound = platform === 'ios' ? ADULT_AGE : ADULT_AGE - 1;
      if (upper !== null && upper <= minorUpperBound) return { kind: 'minor', platform, lower, upper, source };
      return { kind: 'indeterminate', platform, lower, upper, source };
    }
    default:
      return unavailable(platform, 'malformed');
  }
}

/** Asks the store once. A missing module or a rejected call is an unavailable signal. */
export async function readStoreAgeSignal(native: StoreAgeSignalNative | null): Promise<StoreAgeSignal> {
  if (!native) return unavailable(null, 'module-missing');
  try {
    return normalizeStoreAgeSignal(await native.requestAgeSignalAsync());
  } catch {
    return unavailable(null, 'request-failed');
  }
}

/**
 * Whether account creation may finish for a person who says they live in
 * `residence`. Only a store-reported minor in an app-store age-law state stops
 * it. A store-reported adult there is reported as such, but the existing
 * self-attested 18-or-older rule still applies to every outcome that is not a
 * block; the caller never skips it.
 */
export function storeAgeSignalDecision(signal: StoreAgeSignal, residence: string): StoreAgeSignalDecision {
  if (ageRuleFor(residence) !== 'adult') return 'self-attestation';
  if (signal.kind === 'minor') return 'block-minor';
  if (signal.kind === 'adult') return 'store-adult';
  return 'self-attestation';
}
