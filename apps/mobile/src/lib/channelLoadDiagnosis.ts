// Classifies live chapter-channel load failures so an authorized empty
// result is not presented as a secure-load error, and so authentication,
// schema, transport, and unknown faults stay distinct for the member and
// the operator.
//
// The operator signal is credential-free: one closed classification code and
// one operation name. The caught value's message, details, and payload never
// leave this module.

export const CHANNEL_LOAD_LOG_TAG = '[ug-channels]';

export type ChannelLoadClassification =
  | 'authorized-empty'
  | 'authentication'
  | 'request'
  | 'schema'
  | 'transport'
  | 'unknown';

export type ChannelLoadFault = Exclude<ChannelLoadClassification, 'authorized-empty'>;

export const CHANNEL_LOAD_CLASSES: readonly ChannelLoadClassification[] = [
  'authorized-empty',
  'authentication',
  'request',
  'schema',
  'transport',
  'unknown',
];

export type ChannelLoadDiagnosisOp =
  | 'load'
  | 'poll-tally'
  | 'mark_read'
  | 'send'
  | 'reaction'
  | 'vote';

export const CHANNEL_LOAD_OPS: readonly ChannelLoadDiagnosisOp[] = [
  'load',
  'poll-tally',
  'mark_read',
  'send',
  'reaction',
  'vote',
];

export type ChannelLoadDiagnosis = {
  class: ChannelLoadClassification;
  op: ChannelLoadDiagnosisOp;
  /** Present when `op` is `mark_read` so the notice stays on that channel. */
  spaceId?: string;
};

const TRANSPORT_ERROR_CODES: ReadonlySet<string> = new Set([
  'ABORT_ERR',
  'EAI_AGAIN',
  'ECONNABORTED',
  'ECONNREFUSED',
  'ECONNRESET',
  'EHOSTUNREACH',
  'ENETDOWN',
  'ENETUNREACH',
  'ENOTFOUND',
  'EPIPE',
  'ERR_NETWORK',
  'ETIMEDOUT',
  'UND_ERR_CONNECT_TIMEOUT',
  'UND_ERR_HEADERS_TIMEOUT',
  'UND_ERR_SOCKET',
]);

const AUTHENTICATION_CODES: ReadonlySet<string> = new Set([
  'PGRST301',
  'PGRST302',
]);

const AUTHORIZATION_CODES: ReadonlySet<string> = new Set([
  '42501',
]);

const SCHEMA_SQLSTATES: ReadonlySet<string> = new Set([
  '42P01',
  '42P02',
  '42703',
  '42704',
  '42883',
]);

const TRANSPORT_POSTGREST_CODES: ReadonlySet<string> = new Set([
  'PGRST000',
  'PGRST001',
  'PGRST002',
  'PGRST003',
]);

const TRANSPORT_ERROR_NAMES: ReadonlySet<string> = new Set([
  'AbortError',
  'TimeoutError',
  'TypeError',
]);

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

function diagnosticStatus(error: unknown): number | null {
  const status = finiteNumber(readField(error, 'status'))
    ?? finiteNumber(readField(error, 'statusCode'));
  if (status === null || status < 0 || status > 599) return null;
  return Math.trunc(status);
}

function codeToken(error: unknown): string | null {
  const code = readField(error, 'code');
  if (typeof code === 'string' && code.trim()) return code.trim().toUpperCase();
  if (typeof code === 'number' && Number.isFinite(code)) return String(code);
  return null;
}

/**
 * PostgREST keeps HTTP status on the response beside `error`, never inside
 * the parsed body. A client-side unreachable fetch is `{ error: { code: '' },
 * status: 0 }`. Callers pass the whole response so classification can see
 * that status; throwing only `result.error` would make the primary offline
 * case `unknown`.
 */
function classificationInput(value: unknown): { error: unknown; status: number | null } {
  if (typeof value !== 'object' || value === null) {
    return { error: value, status: null };
  }
  const nestedError = readField(value, 'error');
  const looksLikeResponse = nestedError !== undefined
    && (readField(value, 'status') !== undefined
      || readField(value, 'statusText') !== undefined
      || readField(value, 'data') !== undefined);
  if (looksLikeResponse) {
    return {
      error: nestedError,
      status: diagnosticStatus(nestedError) ?? diagnosticStatus(value),
    };
  }
  return { error: value, status: diagnosticStatus(value) };
}

/**
 * Reduce a caught chapter-channel failure to one closed classification.
 *
 * JWT rejection (expired, invalid, or absent) is an authentication fault, not
 * an authorized empty inbox. Row-level-security denials remain authorized-empty
 * only when they carry SQLSTATE 42501; a genuinely authorized member with no
 * chapter membership already reaches `spaces: []` through RLS. A 403 that
 * carries no PostgREST/Postgres code is a gateway refusal (`request`), not an
 * authorized empty inbox. Schema/relation faults cover PostgREST PGRST*
 * answers and the Postgres undefined-relation SQLSTATEs. Transport covers
 * network, abort, timeout, and 5xx, including response-level `status: 0`.
 *
 * Any remaining answer that still carries an HTTP status is a `request` fault:
 * the workspace refused the request itself. A reachable backend can answer
 * ahead of PostgREST and therefore without a PostgREST code at all — the
 * gateway refused an over-long request line with a plain-text `400 Bad
 * Request` on both phones at 7afda61a6, which is how a load whose backend was
 * reachable within 30 ms reported the catch-all class
 * (BUG-UG-MOBILE-CHAPTER-CHANNELS-CLASS-UNKNOWN-ON-DEVICE-20260918).
 * `unknown` is therefore reserved for a caught value with no status at all.
 * The value's message is never read.
 */
export function classifyChannelLoadError(error: unknown): ChannelLoadClassification {
  try {
    const source = classificationInput(error);
    const code = codeToken(source.error);
    const status = source.status;
    const name = readField(source.error, 'name');

    if (status === 401) return 'authentication';
    if (code !== null && AUTHENTICATION_CODES.has(code)) return 'authentication';

    // Authorization is the SQLSTATE, not the HTTP status. PR #2058 classified
    // every 403 as authorized-empty; a codeless 403 is a gateway refusal and
    // must fall through to the status-bearing `request` class, while a 403
    // that carries any other code still reaches the schema/transport checks.
    if (code !== null && AUTHORIZATION_CODES.has(code)) return 'authorized-empty';

    if (status === 0 || status === 408 || status === 504 || (status !== null && status >= 500)) {
      return 'transport';
    }
    if (code !== null && TRANSPORT_ERROR_CODES.has(code)) return 'transport';
    if (code !== null && TRANSPORT_POSTGREST_CODES.has(code)) return 'transport';
    if (typeof name === 'string' && TRANSPORT_ERROR_NAMES.has(name)) return 'transport';

    if (code !== null && code.startsWith('PGRST')) return 'schema';
    if (code !== null && SCHEMA_SQLSTATES.has(code)) return 'schema';

    // The backend answered, so the failure is attributable even when the
    // answer carries no PostgREST code.
    if (status !== null && status >= 400) return 'request';

    return 'unknown';
  } catch {
    return 'unknown';
  }
}

/**
 * Classify a member-initiated chapter-channel write RPC:
 * `mark_chapter_space_read`, `toggle_member_message_reaction`, and
 * `cast_channel_poll_vote`. All three open with the same guard and raise
 * SQLSTATE 42501 when the caller is absent or `private.mfa_satisfied()` is
 * false — an authentication fault, not an authorized-empty inbox, which is
 * what the load classifier would call it. SQLSTATE 22023 is those same
 * functions' "space/message/poll unavailable" (and "poll closed") raise: the
 * workspace refused the write, so it is a request fault rather than an
 * unknown catch-all. Other answers reuse the load classifier.
 */
export function classifyChannelActionError(error: unknown): ChannelLoadClassification {
  try {
    const source = classificationInput(error);
    const code = codeToken(source.error);
    if (code !== null && AUTHORIZATION_CODES.has(code)) return 'authentication';
    if (code === '22023') return 'request';
  } catch {
    // A thrown classifier still falls through to the shared load classes.
  }
  return classifyChannelLoadError(error);
}

/** `mark_chapter_space_read` follows the shared channel-write convention. */
export const classifyMarkReadError = classifyChannelActionError;

/**
 * `mark_chapter_space_read` raises SQLSTATE 22023 when the space is missing or
 * `private.can_read_chapter_space` is false. Cached posts for that space must
 * not stay rendered as ready.
 */
export function isMarkReadSpaceUnavailable(error: unknown): boolean {
  try {
    const source = classificationInput(error);
    return codeToken(source.error) === '22023';
  } catch {
    return false;
  }
}

let lastDiagnosis: ChannelLoadDiagnosis | null = null;

function consoleWarn(line: string): void {
  if (typeof console !== 'undefined' && typeof console.warn === 'function') console.warn(line);
}

/**
 * Retain the last classified failure and emit one credential-free warning
 * an operator can read from a device log. Never prints the caught payload.
 */
export function recordChannelLoadDiagnosis(diagnosis: ChannelLoadDiagnosis): ChannelLoadDiagnosis {
  lastDiagnosis = diagnosis;
  try {
    consoleWarn(`${CHANNEL_LOAD_LOG_TAG} class=${diagnosis.class} op=${diagnosis.op}`);
  } catch {
    // A sink that throws is a diagnostics failure, not a reason to fail load.
  }
  return diagnosis;
}

/** Last classified chapter-channel failure, or null when none has been recorded. */
export function readLastChannelLoadDiagnosis(): ChannelLoadDiagnosis | null {
  return lastDiagnosis;
}

/** Drop the retained diagnosis. Tests use this; session reset also calls it. */
export function resetChannelLoadDiagnosis(): void {
  lastDiagnosis = null;
}
