export const NATIVE_DEEP_LINK_PROOF_SEGMENT = '%FF'.repeat(128);
export const NATIVE_DEEP_LINK_PROOF_BUDGET_MS = 25;
export const NATIVE_DEEP_LINK_PROOF_URL = `unionground://messages?returnTo=${NATIVE_DEEP_LINK_PROOF_SEGMENT}`;

type ParsedLink = {
  hostname?: string | null;
  path?: string | null;
  queryParams?: Record<string, unknown> | null;
  scheme?: string | null;
};

export type NativeDeepLinkMeasurement = Readonly<{
  budgetMs: number;
  elapsedMs: number;
  route: 'messages';
}>;

export type NativeDeepLinkProofState =
  | { status: 'ready' }
  | { status: 'passed'; measurement: NativeDeepLinkMeasurement; responsive: boolean }
  | { status: 'failed' };

export function nativeDeepLinkProofLabel(state: NativeDeepLinkProofState): string {
  if (state.status === 'ready') return 'Native malformed deep-link proof ready';
  if (state.status === 'failed') return 'Native malformed deep-link proof failed';
  const timing = `${state.measurement.elapsedMs.toFixed(3)} ms of ${state.measurement.budgetMs} ms`;
  return state.responsive
    ? `Native malformed deep-link proof passed in ${timing}; app responsive`
    : `Native malformed deep-link proof passed in ${timing}; responsiveness pending`;
}

export function isNativeDeepLinkProofEnabled(value = process.env.EXPO_PUBLIC_NATIVE_DEEP_LINK_PROOF): boolean {
  return value === '1';
}

/**
 * Measures the decoder that Expo Linking actually runs inside Hermes.
 *
 * The proof URL is exact and source-owned so an arbitrary inbound URL can
 * never turn this development-only probe into a diagnostic data surface.
 * The result deliberately contains no URL or decoded query value.
 */
export function measureNativeDeepLinkProbe({
  url,
  parse,
  now,
}: {
  url: string;
  parse: (value: string) => ParsedLink;
  now: () => number;
}): NativeDeepLinkMeasurement | null {
  if (url !== NATIVE_DEEP_LINK_PROOF_URL) return null;

  const startedAt = now();
  const parsed = parse(url);
  const elapsedMs = now() - startedAt;
  const returnTo = parsed.queryParams?.returnTo;

  if (parsed.scheme !== 'unionground'
    || parsed.hostname !== 'messages'
    || typeof returnTo !== 'string'
    || returnTo.length === 0
    || returnTo.length > 512) {
    throw new Error('Native malformed deep link did not produce a bounded route.');
  }
  if (!Number.isFinite(elapsedMs) || elapsedMs < 0 || elapsedMs >= NATIVE_DEEP_LINK_PROOF_BUDGET_MS) {
    throw new Error('Native malformed deep-link decode exceeded its runtime budget.');
  }

  return Object.freeze({
    budgetMs: NATIVE_DEEP_LINK_PROOF_BUDGET_MS,
    elapsedMs,
    route: 'messages',
  });
}
