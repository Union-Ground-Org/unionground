export const DIAGNOSTICS_DISTINCT_ID: "diagnostics";
export interface PostHogSurfaceMetadata {
  surface?: "web" | "api" | "ios" | "android";
  environment?: "production" | "preview" | "development";
  release?: string;
  /** The product origin the relay expects on event posts from a non-browser runtime, e.g. https://app.example.org. */
  origin?: string;
  /** Read at send time: the member's pseudonymous identity, or null while product analytics is off or nobody is signed in (#6247). */
  analyticsIdentity?: () => PostHogAnalyticsIdentity | null;
}
export interface PostHogAnalyticsIdentity {
  /** Hex SHA-256 of ANALYTICS_PSEUDONYM_PREFIX + the user identifier. */
  distinctId: string;
  /** Hex SHA-256 of ANALYTICS_PSEUDONYM_PREFIX + the organization identifier. */
  organization?: string | null;
  /** Changes whenever the member, organization or consent changes; queued events from another generation are dropped. */
  generation: string;
}
export const ANALYTICS_ACTIONS: readonly ["save", "queued_offline"];
export const ANALYTICS_PSEUDONYM_PREFIX: "unionground-analytics:v1:";
export const COOKIELESS_DISTINCT_ID: "$posthog_cookieless";
export interface AnalyticsFlagDefinition { readonly default: string; readonly values: readonly string[] }
export const ANALYTICS_FLAGS: Readonly<{ "member-coach-mark": { readonly default: "control"; readonly values: readonly ["control", "test"] }; "member-default-view": { readonly default: "control"; readonly values: readonly ["control", "alt"] } }>;
export type AnalyticsFlagKey = keyof typeof ANALYTICS_FLAGS;
export type AnalyticsFlagValues = Partial<Record<AnalyticsFlagKey, string | boolean>>;
/** The flag's value from evaluated values, or its default (#6248). */
export function analyticsFlagValue(values: unknown, key: AnalyticsFlagKey): string;
/** The one /flags request body a client sends per identity: token, the two hashes and the flag keys, or null. */
export function analyticsFlagsRequest(token: unknown, identity: unknown): { token: string; distinct_id: string; geoip_disable: true; flag_keys_to_evaluate: string[]; groups?: { organization: string } } | null;
/** The allowlisted values of a /flags response; a degraded or malformed response yields none. */
export function analyticsFlagsFromResponse(response: unknown): AnalyticsFlagValues;
export function sanitizePostHogAnalyticsEvent(event: unknown, metadata?: PostHogSurfaceMetadata & { identity?: PostHogAnalyticsIdentity | null; cookieless?: boolean }): Record<string, unknown> | null;
export interface SanitizedPostHogException {
  event: "$exception";
  distinct_id: "diagnostics";
  uuid?: string;
  timestamp?: string;
  properties: Record<string, unknown>;
}
export function sanitizePostHogExceptionEvent(event: unknown, metadata?: PostHogSurfaceMetadata): SanitizedPostHogException | null;
export function sanitizePostHogDiagnosticsBatch(batch: unknown, metadata?: PostHogSurfaceMetadata): Array<SanitizedPostHogException | Record<string, unknown>>;
export interface PostHogFetchLikeOptions { method?: string; headers?: Record<string, string>; body?: unknown; signal?: AbortSignal; [key: string]: unknown }
export type PostHogFetchLike = (url: string, options?: PostHogFetchLikeOptions) => Promise<unknown>;
export function privatePostHogFetch(fetchImpl: PostHogFetchLike, metadata?: PostHogSurfaceMetadata): PostHogFetchLike;
