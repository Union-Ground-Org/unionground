// Three open G6 drill findings — the blank unknown-scheme route, the silent
// attachment selection, and the offline-lock sign-out abort — all ended the
// same way: "the originating exception was never captured". A device dump can
// show what the screen rendered, but not which branch produced it, so the next
// drill has to be able to read the lifecycle out of the device log.
//
// This is that channel, and its whole design is the redaction contract, because
// device logs end up inside evidence bundles. The contract is a closed
// allowlist, enforced at runtime rather than asserted in prose:
//
//   * Every token that can reach the log is either a member of an enumerated
//     set declared in this module (`scope`, `step`, `outcome`, `reason`, the
//     detail keys, and on the dedicated Apple provider-failure step the
//     provider code and error class name) or a finite number. A value outside
//     its set is replaced by `unsupported` or dropped before reaching the ring.
//   * There is no free-text channel at all. A caught exception is reduced to an
//     enumerated reason code and numeric HTTP status; an Apple provider
//     exception to a code and a class name that must each be a member of a
//     fixed list. Its message, and everything a message can carry — member
//     names, file names, paths, content URIs, deep-link payloads, credentials —
//     is dropped before anything is formatted, so no denylist has to be right.
//
// A regex denylist was the earlier design and was wrong: it can only remove the
// shapes it anticipated, so an unanticipated filename or member identifier
// passed through it unchanged. Nothing here inspects untrusted text.
//
// Non-closing groundwork for BUG-UG-MOBILE-UNKNOWN-SCHEME-ROUTE-DEAD-END-20260905,
// BUG-UG-MOBILE-ATTACHMENT-UPLOAD-SILENT-FAILURE-20260905, and
// BUG-UG-MOBILE-SIGNOUT-CACHE-PURGE-ABORT-20260905. It observes; it changes
// no behaviour.

export const LIFECYCLE_LOG_TAG = '[ug-lifecycle]';

/** Substituted for any value that is not a member of its enumerated set. */
export const UNSUPPORTED_TOKEN = 'unsupported';

// Every code expo-apple-authentication 57 can raise from `signInAsync`. Its
// native exception classes (ios/AppleAuthenticationExceptions.swift) map
// ASAuthorizationError onto exactly these names, expo-modules-core derives the
// code from the class name, and `@unknown default` folds anything newer into
// ERR_REQUEST_UNKNOWN; the JavaScript wrapper adds ERR_REQUEST_FAILED and
// ERR_UNAVAILABLE. A code outside this list is not carried: it becomes
// `unsupported`, which still says "none of the module's codes".
export type LifecycleProviderCode =
  | 'ERR_REQUEST_UNKNOWN'
  | 'ERR_REQUEST_CANCELED'
  | 'ERR_INVALID_RESPONSE'
  | 'ERR_REQUEST_NOT_HANDLED'
  | 'ERR_REQUEST_FAILED'
  | 'ERR_REQUEST_NOT_INTERACTIVE'
  | 'ERR_REQUEST_MATCHED_EXCLUDED_CREDENTIAL'
  | 'ERR_INVALID_SCOPE'
  | 'ERR_INVALID_OPERATION'
  | 'ERR_UNAVAILABLE';

export const LIFECYCLE_PROVIDER_CODES: readonly LifecycleProviderCode[] = [
  'ERR_REQUEST_UNKNOWN',
  'ERR_REQUEST_CANCELED',
  'ERR_INVALID_RESPONSE',
  'ERR_REQUEST_NOT_HANDLED',
  'ERR_REQUEST_FAILED',
  'ERR_REQUEST_NOT_INTERACTIVE',
  'ERR_REQUEST_MATCHED_EXCLUDED_CREDENTIAL',
  'ERR_INVALID_SCOPE',
  'ERR_INVALID_OPERATION',
  'ERR_UNAVAILABLE',
];

export type LifecycleProviderName = 'Error' | 'CodedError' | 'CodedException';

export const LIFECYCLE_PROVIDER_NAMES: readonly LifecycleProviderName[] = ['Error', 'CodedError', 'CodedException'];

export const LIFECYCLE_SCOPES = [
  'deep-link',
  'boot',
  'root-layout',
  'attachment-selection',
  'attachment-cache',
  'sign-out',
  'auth-callback',
  'native-auth',
] as const;

export type LifecycleScope = (typeof LIFECYCLE_SCOPES)[number];

export const LIFECYCLE_STEPS = [
  // deep-link
  'redirect-system-path',
  // boot
  'index-redirect',
  // root-layout
  'mount',
  'unmount',
  'render-gate',
  // attachment-selection
  'handoff-started',
  'handoff-settled',
  'handoff-invalidated',
  'handoff-taken',
  'handoff-phase',
  'panel-mounted',
  'panel-unmounted',
  'capture',
  'busy-set',
  'busy-cleared',
  'picker-result',
  'consume',
  'failed',
  // sign-out
  'cleanup-step-start',
  'cleanup-step-done',
  'cleanup-failed',
  'cache-purge-failed',
  'server-cleanup-failed',
  'server-barrier-skipped',
  // auth-callback: the recovery state shown; the outcome is the app mode
  'missing-code',
  'link-rejected',
  'exchange-failed',
  'exchange-stalled',
  'session-rejected',
  'preview-active',
  'session-stalled',
  'apple-provider-failed',
] as const;

export type LifecycleStep = (typeof LIFECYCLE_STEPS)[number];

export const LIFECYCLE_OUTCOMES = [
  // deep-link resolution
  'quick-action',
  'auth-callback',
  'refused-auth-callback',
  'app-route',
  'home-fallback',
  // app modes, for the boot redirect, the root-layout render gate and the
  // auth-callback recovery states
  'booting',
  'signedOut',
  'mfaRequired',
  'authenticated',
  'preview',
  // attachment selection
  'document',
  'scan',
  'preparing',
  'converting',
  'identity-changed',
  'chapter-changed',
  'access-denied',
  'task-unavailable',
  'panel-closed',
  'list-failed',
  'route-exit',
  'session-end',
  'camera-permission-denied',
  'producer-failed',
  'pick',
  'cancelled',
  'selected',
  'discarded',
  'uploaded',
  // sign-out cleanup steps
  'purge-attachment-cache',
  'retained-cache-cleanup',
  'cache-directory-list',
  'cache-entry-delete',
  'pending-camera-result',
  'pending-share-upload',
  'pending-share-staging',
  // sign-out failure classes
  'transport',
  'service',
  'local',
] as const;

export type LifecycleOutcome = (typeof LIFECYCLE_OUTCOMES)[number];

/**
 * The complete set of detail keys this channel will ever print. A key is part
 * of the contract exactly as much as a value is: an arbitrary-key record let a
 * filename or a member identifier be used as a computed key and printed
 * verbatim. Adding a key here is the deliberate act that widens the contract.
 */
export const LIFECYCLE_DETAIL_KEYS = [
  /** Whether a deep link arrived as the app's initial intent. */
  'initial',
  /** Root-layout render gate. */
  'locked',
  'privacyCovered',
  'signedIn',
  /** Attachment-selection generation counters and mount state. */
  'hasCandidate',
  'isScan',
  'matched',
  'generation',
  'currentGeneration',
  'mounted',
  /** Whether the sign-out prepare transaction had already completed. */
  'serverSignOutPrepared',
] as const;

export type LifecycleDetailKey = (typeof LIFECYCLE_DETAIL_KEYS)[number];

/**
 * Structured detail carried alongside an event. Allowlisted keys, and booleans
 * or finite numbers only: the type rejects anything else at compile time and
 * `recordLifecycleEvent` drops it again at runtime, so a cast or an untyped
 * call site cannot widen it.
 */
export type LifecycleDetail = Readonly<Partial<Record<LifecycleDetailKey, boolean | number>>>;

/**
 * Why an operation failed, in content-free terms. This is the whole vocabulary
 * available for a caught exception: the reason locates the class of fault, the
 * numeric HTTP status locates a service answer, and nothing else survives.
 */
export const LIFECYCLE_REASONS = [
  /** The operation was aborted or cancelled locally. */
  'aborted',
  /** The device could not reach the service at all. */
  'network-unavailable',
  /** The request or operation ran out of time. */
  'timeout',
  /** The service does not expose the call shape this client sent. */
  'service-contract-mismatch',
  /** The service refused on authentication or authorization grounds. */
  'service-unauthorized',
  /** Any other answer from the service that refused the work. */
  'service-rejected',
  /** The operating system denied access to a resource. */
  'permission-denied',
  /** A local resource the operation needed does not exist. */
  'not-found',
  /** The device is out of storage or over quota. */
  'storage-full',
  /** Any other local file-system or device I/O failure. */
  'io-failure',
  /** The client reached a state it does not accept — a bug, not an answer. */
  'invalid-state',
  /** Nothing in the value identified the fault. */
  'unknown',
] as const;

export type LifecycleReason = (typeof LIFECYCLE_REASONS)[number];

export interface LifecycleEventInput {
  scope: LifecycleScope;
  step: LifecycleStep;
  outcome?: LifecycleOutcome;
  detail?: LifecycleDetail;
  /**
   * A caught value. It is reduced to a `LifecycleReason` and a numeric status
   * before anything is retained; the value itself is never stored or printed.
   */
  error?: unknown;
}

export interface LifecycleEvent {
  scope: LifecycleScope | typeof UNSUPPORTED_TOKEN;
  step: LifecycleStep | typeof UNSUPPORTED_TOKEN;
  outcome: LifecycleOutcome | typeof UNSUPPORTED_TOKEN | null;
  detail: Readonly<Partial<Record<LifecycleDetailKey, boolean | number>>>;
  reason: LifecycleReason | null;
  status: number | null;
  providerCode?: LifecycleProviderCode | typeof UNSUPPORTED_TOKEN;
  providerName?: LifecycleProviderName | typeof UNSUPPORTED_TOKEN;
}

export type LifecycleSink = (line: string) => void;

// Bounded on purpose. The buffer exists so a drill can read the recent
// lifecycle back out of a running app without a debugger; it is not a log
// store, and it must not grow without limit on a member's device.
const RING_LIMIT = 64;

const SCOPES: ReadonlySet<string> = new Set(LIFECYCLE_SCOPES);
const STEPS: ReadonlySet<string> = new Set(LIFECYCLE_STEPS);
const OUTCOMES: ReadonlySet<string> = new Set(LIFECYCLE_OUTCOMES);
const DETAIL_KEYS: ReadonlySet<string> = new Set(LIFECYCLE_DETAIL_KEYS);
const PROVIDER_CODES: ReadonlySet<string> = new Set(LIFECYCLE_PROVIDER_CODES);
const PROVIDER_NAMES: ReadonlySet<string> = new Set(LIFECYCLE_PROVIDER_NAMES);

const ring: LifecycleEvent[] = [];

function consoleSink(line: string): void {
  // The one console call in the mobile source, deliberately funnelled through a
  // single choke point so the contract has exactly one exit.
  // `console.log` rather than `console.warn`: this is routine instrumentation
  // and must not raise a LogBox overlay over the screen a drill is capturing.
  if (typeof console !== 'undefined' && typeof console.log === 'function') console.log(line);
}

let sink: LifecycleSink = consoleSink;

/** Replace the emit sink. Tests use this; production never calls it. */
export function setLifecycleDiagnosticsSink(next: LifecycleSink | null): void {
  sink = next ?? consoleSink;
}

/** Drop the retained ring buffer. Tests use this to isolate cases. */
export function resetLifecycleDiagnostics(): void {
  ring.length = 0;
}

/** A copy of the retained ring buffer, oldest first. */
export function readLifecycleDiagnostics(): readonly LifecycleEvent[] {
  return ring.map((event) => ({ ...event, detail: { ...event.detail } }));
}

function allowlisted<T extends string>(
  value: unknown,
  allowed: ReadonlySet<string>,
): T | typeof UNSUPPORTED_TOKEN {
  return typeof value === 'string' && allowed.has(value) ? (value as T) : UNSUPPORTED_TOKEN;
}

// Diagnostics observe the failure path; they must never disturb it. A caught
// value can be a proxy or carry a throwing getter, so every read off it is
// guarded: a read that throws yields `undefined`, exactly as a missing field
// would, and never propagates into the path being instrumented.
function readField(value: unknown, field: string): unknown {
  if (typeof value !== 'object' || value === null) return undefined;
  try {
    return (value as Record<string, unknown>)[field];
  } catch {
    return undefined;
  }
}

function finiteNumber(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && /^\d{1,5}$/.test(value)) return Number.parseInt(value, 10);
  return null;
}

/**
 * The HTTP status a caught value carries, when it carries one. A status is a
 * bounded integer the service chose, so it is content-free by construction and
 * is the one numeric fact worth keeping.
 */
export function diagnosticStatus(error: unknown): number | null {
  const status = finiteNumber(readField(error, 'status'));
  if (status === null || status < 100 || status > 599) return null;
  return Math.trunc(status);
}

// Closed maps from the machine-generated identifiers a platform or a service
// produces onto the reason vocabulary. Only the identifier is consulted; the
// value is never carried forward, so an unlisted identifier degrades to a
// coarser reason rather than leaking itself.
const CODE_REASONS: ReadonlyMap<string, LifecycleReason> = new Map([
  // PostgREST / Postgres
  ['PGRST202', 'service-contract-mismatch'],
  ['PGRST203', 'service-contract-mismatch'],
  ['42883', 'service-contract-mismatch'],
  ['PGRST301', 'service-unauthorized'],
  ['PGRST302', 'service-unauthorized'],
  ['42501', 'service-unauthorized'],
  // Platform fetch stack
  ['ABORT_ERR', 'aborted'],
  ['ECONNABORTED', 'aborted'],
  ['ETIMEDOUT', 'timeout'],
  ['UND_ERR_CONNECT_TIMEOUT', 'timeout'],
  ['UND_ERR_HEADERS_TIMEOUT', 'timeout'],
  ['EAI_AGAIN', 'network-unavailable'],
  ['ECONNREFUSED', 'network-unavailable'],
  ['ECONNRESET', 'network-unavailable'],
  ['EHOSTUNREACH', 'network-unavailable'],
  ['ENETDOWN', 'network-unavailable'],
  ['ENETUNREACH', 'network-unavailable'],
  ['ENOTFOUND', 'network-unavailable'],
  ['EPIPE', 'network-unavailable'],
  ['ERR_NETWORK', 'network-unavailable'],
  ['UND_ERR_SOCKET', 'network-unavailable'],
  // Expo CodedException.inferCode derives these from native class names.
  ['ERR_UNABLE_TO_DELETE', 'io-failure'],
  ['ERR_UNABLE_TO_CREATE', 'io-failure'],
  ['ERR_FAILED_TO_PICK_MEDIA', 'io-failure'],
  ['ERR_INVALID_PERMISSION', 'permission-denied'],
  ['ERR_NO_PERMISSION', 'permission-denied'],
  ['ERR_DESTINATION_DOES_NOT_EXIST', 'not-found'],
  ['ERR_FILE_NOT_FOUND', 'not-found'],
  ['ERR_MISSING_ACTIVITY', 'invalid-state'],
  ['ERR_MISSING_APP_CONTEXT', 'invalid-state'],
  // File system and device
  ['EACCES', 'permission-denied'],
  ['EPERM', 'permission-denied'],
  ['ENOENT', 'not-found'],
  ['ENOSPC', 'storage-full'],
  ['EDQUOT', 'storage-full'],
  ['EBUSY', 'io-failure'],
  ['EEXIST', 'io-failure'],
  ['EIO', 'io-failure'],
  ['EISDIR', 'io-failure'],
  ['EMFILE', 'io-failure'],
  ['ENOTDIR', 'io-failure'],
  ['EROFS', 'io-failure'],
  ['EXDEV', 'io-failure'],
]);

const NAME_REASONS: ReadonlyMap<string, LifecycleReason> = new Map([
  ['AbortError', 'aborted'],
  ['TimeoutError', 'timeout'],
  ['NotAllowedError', 'permission-denied'],
  ['NotFoundError', 'not-found'],
  ['QuotaExceededError', 'storage-full'],
  ['RangeError', 'invalid-state'],
  ['ReferenceError', 'invalid-state'],
  ['SyntaxError', 'invalid-state'],
  ['TypeError', 'invalid-state'],
]);

function codeToken(error: unknown): string | null {
  const code = readField(error, 'code');
  if (typeof code === 'string' && code.trim()) return code.trim().toUpperCase();
  if (typeof code === 'number' && Number.isFinite(code)) return String(code);
  return null;
}

/**
 * Reduce a caught value to one enumerated, content-free reason code.
 *
 * The value's message is never read. Everything this returns comes from the
 * closed maps above, from the numeric HTTP status, or from the fixed fallbacks,
 * so no attacker-controlled or member-owned text can travel with it.
 */
export function diagnosticReason(error: unknown): LifecycleReason {
  const signOutKind = readField(error, 'signOutFailureKind');
  const code = codeToken(error);
  if (code !== null) {
    const mapped = CODE_REASONS.get(code);
    if (mapped) return mapped;
    // Collapse the SecureStore family to a fixed reason, never its suffix.
    if (code.startsWith('E_SECURESTORE_')) return 'io-failure';
    if (readField(error, 'name') === 'AttachmentError') {
      if (code === 'AUTHORIZATION') return 'aborted';
      if (code === 'CLEANUP') return 'io-failure';
    }
  }
  const status = diagnosticStatus(error);
  if (status !== null && status >= 400) {
    if (status === 401 || status === 403) return 'service-unauthorized';
    if (status === 408 || status === 504) return 'timeout';
    return 'service-rejected';
  }
  // A PostgREST code outside the map above is still, by construction, an answer
  // from the service.
  if (code !== null && code.startsWith('PGRST')) return 'service-rejected';
  if (signOutKind === 'service') return 'service-rejected';
  if (signOutKind === 'transport') return 'network-unavailable';
  const name = readField(error, 'name');
  if (typeof name === 'string') {
    const mapped = NAME_REASONS.get(name);
    if (mapped) return mapped;
  }
  // An identifier nobody mapped says nothing this channel is allowed to guess
  // at, and the identifier itself never travels.
  return 'unknown';
}

function formatDetail(detail: LifecycleEvent['detail']): string {
  return (Object.keys(detail) as LifecycleDetailKey[])
    .sort()
    .map((key) => {
      const value = detail[key];
      if (typeof value === 'boolean') return `${key}=${value ? 'true' : 'false'}`;
      if (typeof value === 'number' && Number.isFinite(value)) return `${key}=${String(value)}`;
      return null;
    })
    .filter((part): part is string => part !== null)
    .join(' ');
}

/**
 * A content-free event, emitted when even the allowlisting cannot run — an
 * exotic input, a malformed detail object, a proxy that throws on inspection.
 * It carries no token that was not already fixed in this module.
 */
function degradedEvent(): LifecycleEvent {
  return {
    scope: UNSUPPORTED_TOKEN,
    step: UNSUPPORTED_TOKEN,
    outcome: null,
    detail: {},
    reason: null,
    status: null,
  };
}

/**
 * Reduce an input to an allowlisted event. Every read is either already guarded
 * (`allowlisted`, `diagnosticReason`, `diagnosticStatus` all go through the
 * guarded `readField`) or wrapped here, so a malformed detail object degrades to
 * an empty detail rather than throwing.
 */
function buildLifecycleEvent(input: LifecycleEventInput): LifecycleEvent {
  const detail: Partial<Record<LifecycleDetailKey, boolean | number>> = {};
  try {
    for (const [key, value] of Object.entries(input.detail ?? {})) {
      // The runtime half of the contract: an unallowlisted key is dropped whole,
      // key and value together, so a computed key can never be printed.
      if (!DETAIL_KEYS.has(key)) continue;
      if (typeof value === 'boolean' || (typeof value === 'number' && Number.isFinite(value))) {
        detail[key as LifecycleDetailKey] = value;
      }
    }
  } catch {
    // A detail whose own enumeration throws (a hostile proxy) contributes
    // nothing rather than aborting the event.
  }
  const providerFailure = input.scope === 'native-auth' && input.step === 'apple-provider-failed';
  const code = providerFailure ? readField(input.error, 'code') : undefined;
  const name = providerFailure ? readField(input.error, 'name') : undefined;
  return {
    scope: allowlisted<LifecycleScope>(input.scope, SCOPES),
    step: allowlisted<LifecycleStep>(input.step, STEPS),
    outcome: input.outcome === undefined || input.outcome === null
      ? null
      : allowlisted<LifecycleOutcome>(input.outcome, OUTCOMES),
    detail,
    reason: providerFailure || input.error === undefined ? null : diagnosticReason(input.error),
    status: providerFailure || input.error === undefined ? null : diagnosticStatus(input.error),
    ...(providerFailure ? {
      providerCode: allowlisted<LifecycleProviderCode>(code, PROVIDER_CODES),
      providerName: allowlisted<LifecycleProviderName>(name, PROVIDER_NAMES),
    } : {}),
  };
}

function formatLifecycleLine(event: LifecycleEvent): string {
  const parts = [LIFECYCLE_LOG_TAG, `scope=${event.scope}`, `step=${event.step}`];
  if (event.outcome !== null) parts.push(`outcome=${event.outcome}`);
  const formattedDetail = formatDetail(event.detail);
  if (formattedDetail) parts.push(formattedDetail);
  if (event.reason !== null) parts.push(`reason=${event.reason}`);
  if (event.status !== null) parts.push(`status=${String(event.status)}`);
  if (event.providerCode !== undefined) parts.push(`providerCode=${event.providerCode}`);
  if (event.providerName !== undefined) parts.push(`providerName=${event.providerName}`);
  return parts.join(' ');
}

/**
 * Record one lifecycle event: retain it in the bounded ring and emit one line
 * to the device log. Every token in that line is an allowlisted identifier or a
 * finite number.
 *
 * This function is strictly non-throwing and behaviour-neutral. It runs before
 * the member-facing error handling in the sign-out and attachment paths, so a
 * throw here — from a hostile error value, a malformed detail, or a sink that
 * fails — would suppress the failure UI it is only meant to observe. Extraction
 * degrades to a content-free event and emission is isolated; neither escapes.
 */
export function recordLifecycleEvent(input: LifecycleEventInput): LifecycleEvent {
  let event: LifecycleEvent;
  try {
    event = buildLifecycleEvent(input);
  } catch {
    event = degradedEvent();
  }
  ring.push(event);
  if (ring.length > RING_LIMIT) ring.splice(0, ring.length - RING_LIMIT);

  try {
    sink(formatLifecycleLine(event));
  } catch {
    // A sink that throws is a diagnostics failure, not a reason to fail the
    // operation being instrumented. The event is still retained in the ring.
  }
  return event;
}
