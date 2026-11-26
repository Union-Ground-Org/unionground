// Sign-out refuses to report a completed sign-out it cannot prove, so every
// failure on this path ends in the same fail-closed outcome. What differs is
// the diagnosis the member reads, and that difference matters: a dropped
// connection is worth retrying on a better network, while a server that refuses
// the call shape cannot be fixed by the member at all. Attributing a server
// rejection to connectivity sends a well-connected member into an unbounded
// retry loop and points an operator away from the real cause during an
// incident. See FIX-UG-MOBILE-SIGNOUT-FAILURE-COPY-20260905.
//
// This module classifies and phrases the failure. It deliberately does not
// change what the sign-out path does about it.

// The provenance of a sign-out failure, decided by the operation that failed
// and not by the shape of whatever it threw:
//   * `service`  — a PostgREST/RPC answer. Any errored response the service
//                  actually answered (including a positive HTTP status and a
//                  non-JSON 200) is a service problem, never the connection.
//   * `local`    — a SecureStore/native/client-side step on the device failed.
//                  It is neither the service's fault nor a reachability problem.
//   * `transport`— the request never reached the service (network unreachable).
// A failing operation tags itself at its throw/return site; classification only
// falls back to a status/shape heuristic when the provenance is genuinely
// unknown, and an arbitrary local error code is never taken as service proof.
export type SignOutFailureKind = 'transport' | 'service' | 'local';

/**
 * Which sessions the attempt was for. `local` closes this device's session;
 * `global` closes every session of the account, the Account > Sessions "Sign
 * out everywhere" action (REQ-UG-NATIVE-SESSION-MANAGEMENT-20261009).
 * The two need different copy on failure: a member who asked to sign out
 * everywhere has to be told their other devices may still be signed in, which
 * the local wording does not say.
 */
export type SignOutScope = 'local' | 'global';

/** The non-enumerable property a tagged failure carries its provenance in. */
const PROVENANCE_TAG = 'signOutFailureKind';

/**
 * The `prepare_my_signout` answer exactly as `@supabase/postgrest-js` returns
 * it. The HTTP facts sit on the response *beside* `error`, never inside it:
 * `PostgrestBuilder.processResponse` parses a JSON error body into `error`, but
 * a non-JSON 4xx/5xx body becomes `error: { message }` with no `code` and no
 * `status`, and the real status survives only as the response-level `status`
 * and `statusText`. Destructuring `{ data, error }` therefore discards the one
 * fact that proves the service answered, and a code-less 502 would be read as a
 * dropped connection. Every caller passes the whole response.
 */
export interface SignOutRpcResponse {
  data?: unknown;
  error?: unknown;
  status?: unknown;
  statusText?: unknown;
}

// PostgREST separates the two cases for us. A client-side network failure is
// normalized to `status: 0` with an empty `code`, because those fields are
// reserved for what the upstream service actually said (see
// `@supabase/postgrest-js` `PostgrestBuilder`). Anything the service answered —
// `PGRST202` for a call shape it does not expose, `42883` for an undefined
// function, any 4xx or 5xx — is a service problem and never the member's
// network.
const SERVICE_REJECTION_STATUS_FLOOR = 400;

// The exceptions to "a code means the service answered": transport failures
// that still arrive carrying a code, from the platform fetch stack rather than
// from PostgREST. They must not be mistaken for a service answer.
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

// The only codes read as positive proof the *service* answered. This is a
// closed allowlist, not the complement of the transport denylist: an arbitrary
// or member-/device-owned code (`E_SECURESTORE`, a vendor SDK code) matches
// nothing here and is never mistaken for a server rejection. PostgREST error
// codes all carry the `PGRST` prefix; the two Postgres SQLSTATEs are the
// undefined-function and insufficient-privilege answers the hosted
// `prepare_my_signout` overload drift and RLS refusals produce.
const SERVICE_ERROR_CODES: ReadonlySet<string> = new Set([
  '42883', // undefined_function
  '42501', // insufficient_privilege
]);

/** Whether a code positively identifies a server answer (never a local code). */
function isServiceCode(code: string): boolean {
  const upper = code.toUpperCase();
  if (upper.startsWith('PGRST')) return true;
  return SERVICE_ERROR_CODES.has(upper);
}

/**
 * Attach an explicit failure provenance to a thrown value at its throw site.
 * The tag is non-enumerable so it never widens a diagnostics detail record, and
 * `classifySignOutFailure` reads it in preference to any status/shape guess. A
 * frozen or exotic value that refuses the property degrades to the heuristic.
 */
export function tagSignOutProvenance<T>(error: T, kind: SignOutFailureKind): T {
  if (typeof error === 'object' && error !== null) {
    try {
      Object.defineProperty(error, PROVENANCE_TAG, {
        value: kind,
        enumerable: false,
        configurable: true,
        writable: false,
      });
    } catch {
      // A frozen or exotic value cannot carry the tag; the heuristic still
      // refuses to blame the service for it.
    }
  }
  return error;
}

/**
 * Run a local/native sign-out cleanup step (SecureStore, native modules,
 * client-side state) and tag any thrown value with `local` provenance. A native
 * error code such as `E_SECURESTORE` therefore stays a device problem and is
 * never read as a service answer.
 */
export async function runLocalSignOutStep<T>(step: () => Promise<T> | T): Promise<T> {
  try {
    return await step();
  } catch (error) {
    const declared = readField(error, PROVENANCE_TAG);
    // Composite operations may already have identified a remote failure.
    if (declared === 'service' || declared === 'transport' || declared === 'local') throw error;
    throw tagSignOutProvenance(error, 'local');
  }
}

/**
 * A server answer that did not perform the sign-out preparation. Raised for the
 * rejections PostgREST does not encode as an error object — most importantly a
 * success status whose payload never confirms the cleanup, which is still the
 * service failing to do the work rather than the member's connection failing to
 * reach it.
 */
export class SignOutServiceRejectionError extends Error {
  readonly signOutFailureKind: SignOutFailureKind = 'service';

  constructor(message: string) {
    super(message);
    this.name = 'SignOutServiceRejectionError';
  }
}

/**
 * A `prepare_my_signout` call the service answered with an error. It exists so
 * the response-level HTTP facts travel with the PostgREST error object instead
 * of being dropped at the destructuring: PostgREST leaves a non-JSON 4xx/5xx as
 * `error: { message }` with no code and no status, so the response `status` is
 * the only evidence that a server — not the member's network — refused the
 * call. The verdict is computed once, here, from both sources.
 */
export class SignOutRpcRejectionError extends Error {
  readonly signOutFailureKind: SignOutFailureKind;
  /** The PostgREST error object this wraps, retained for diagnosis. */
  readonly rejection: unknown;
  /** The code the service issued, when it issued one. */
  readonly code: string | null;
  /** The HTTP status, taken from the error object or the response beside it. */
  readonly status: number | null;
  readonly statusText: string | null;

  constructor(response: SignOutRpcResponse) {
    const rejection = response.error;
    const message = readField(rejection, 'message');
    super(typeof message === 'string' && message.trim()
      ? message.trim()
      : 'The sign-out preparation call was rejected.');
    this.name = 'SignOutRpcRejectionError';
    this.rejection = rejection;
    this.code = rawCode(rejection);
    this.status = numericStatus(rejection) ?? numericValue(response.status);
    const statusText = response.statusText;
    this.statusText = typeof statusText === 'string' && statusText.trim() ? statusText.trim() : null;
    // Provenance is the operation, not the shape: this value *is* a PostgREST
    // answer, so any real HTTP status the response carries (a non-JSON 200
    // included) is the service refusing the work. Only postgrest-js's `status: 0`
    // marker — a fetch that never reached the service — keeps the transport
    // diagnosis.
    this.signOutFailureKind = classifyAnsweredResponse(this.status, this.code);
  }
}

// Reading a field must never throw, even for a proxy or a value with a throwing
// getter: this classifier runs inside the sign-out catch, before the member
// message and the warning haptic, so a throw here would suppress the very
// failure UI it is diagnosing.
function readField(error: unknown, field: string): unknown {
  if (typeof error !== 'object' || error === null) return undefined;
  try {
    return (error as Record<string, unknown>)[field];
  } catch {
    return undefined;
  }
}

function numericValue(status: unknown): number | null {
  if (typeof status === 'number' && Number.isFinite(status)) return status;
  if (typeof status === 'string' && /^\d+$/.test(status)) return Number.parseInt(status, 10);
  return null;
}

function numericStatus(error: unknown): number | null {
  return numericValue(readField(error, 'status'));
}

function rawCode(error: unknown): string | null {
  const code = readField(error, 'code');
  if (typeof code !== 'string') return null;
  const trimmed = code.trim();
  return trimmed ? trimmed : null;
}

/**
 * The verdict for a value that came back *from the RPC*. postgrest-js reports a
 * client-side fetch failure as `status: 0`; any other HTTP status means the
 * service answered, so a real status (a non-JSON 200 included) is a service
 * problem. A known service code proves the same thing when no status survives.
 */
function classifyAnsweredResponse(status: number | null, code: string | null): SignOutFailureKind {
  if (status === 0) return 'transport';
  if (status !== null && status >= 100) return 'service';
  // This boundary is a returned RPC envelope, unlike an arbitrary local error.
  if (code !== null && !TRANSPORT_ERROR_CODES.has(code.toUpperCase())) return 'service';
  return 'transport';
}

/**
 * The heuristic for a value whose provenance was never tagged. It refuses to
 * blame the service without positive proof — a status the service answered
 * with, or a code only the service issues — so an arbitrary local error code is
 * never taken as server evidence, and everything unproven keeps the existing
 * connectivity diagnosis.
 */
function classifyUntaggedShape(error: unknown): SignOutFailureKind {
  const status = numericStatus(error);
  if (status !== null && status >= SERVICE_REJECTION_STATUS_FLOOR) return 'service';
  const code = rawCode(error);
  if (code !== null && isServiceCode(code)) return 'service';
  return 'transport';
}

/**
 * Classify a thrown sign-out failure. An explicit provenance tag from the
 * failing operation wins; only a genuinely untagged value falls back to the
 * status/shape heuristic, and even then a positively identified server answer
 * is the only thing that acquires service copy. Reads never throw, so a hostile
 * error can never suppress the failure UI this feeds.
 */
export function classifySignOutFailure(error: unknown): SignOutFailureKind {
  try {
    if (error instanceof SignOutServiceRejectionError) return 'service';
    const declared = readField(error, PROVENANCE_TAG);
    if (declared === 'service' || declared === 'transport' || declared === 'local') return declared;
    return classifyUntaggedShape(error);
  } catch {
    // No read here is allowed to abort the sign-out catch; an unclassifiable
    // value keeps the conservative connectivity diagnosis rather than throwing.
    return 'transport';
  }
}

/**
 * The fail-closed decision for the `prepare_my_signout` response: returns the
 * value to throw, or `null` when the server confirmed the cleanup. An errored
 * call is wrapped so the response-level HTTP status survives alongside the
 * PostgREST error object; a call that answered without confirming is a service
 * rejection in its own right.
 */
export function signOutCleanupRejection(response: SignOutRpcResponse): unknown | null {
  if (response.error) return new SignOutRpcRejectionError(response);
  const confirmed = (response.data as { serverCleanupComplete?: boolean } | null | undefined)?.serverCleanupComplete;
  if (confirmed !== true) return new SignOutServiceRejectionError('Server cleanup was not confirmed.');
  return null;
}

/**
 * Worker-facing copy for a sign-out that did not complete. Every variant opens
 * by stating the sign-out is incomplete, because none of them may imply the
 * session was cleared. `serverSignOutPrepared` distinguishes a prepare
 * transaction that already closed the notification barrier (paused) from one
 * that may not have run (may be paused).
 */
export function signOutFailureMessage(
  kind: SignOutFailureKind,
  options: { serverSignOutPrepared: boolean; scope?: SignOutScope },
): string {
  const notifications = options.serverSignOutPrepared
    ? 'Notifications are paused'
    : 'Notifications may be paused';
  // A failed "Sign out everywhere" must never leave a member believing their
  // other devices were signed out. The opening sentence names the outcome that
  // did not happen, and every variant keeps it.
  const opening = options.scope === 'global'
    ? 'Sign out everywhere is incomplete and your other devices may still be signed in'
    : 'Sign-out is incomplete';
  // When this device's own session is already gone (another device signed
  // out everywhere first), the account-wide request is refused every time;
  // the device's own Sign out still clears it, so the global copy names that
  // route instead of only asking for a retry of the same action.
  const thisDevice = options.scope === 'global'
    ? ' To sign out of this device alone, use Sign out near the top of Account, then Confirm sign out.'
    : '';
  if (kind === 'service') {
    return `${opening} because the service refused the request, not because of your connection. ${notifications}; try again shortly, and tell your campaign administrator if it keeps happening.${thisDevice}`;
  }
  if (kind === 'local') {
    // A device-side step failed. Reconnecting will not help, and it is not the
    // service's fault, so this copy blames neither — it asks for a retry.
    return `${opening} because this device could not finish clearing your session, not because of the service or your connection. ${notifications}; try again shortly.${thisDevice}`;
  }
  return `${opening}. ${notifications}; reconnect and finish signing out.${thisDevice}`;
}

/**
 * Copy for a "Sign out everywhere" that stopped before it finished with this
 * device still signed in. Nothing refused the request, so none of the three
 * failure diagnoses above fits: the attempt was cancelled mid-flight — the
 * observed case is the app being backgrounded, which ends the sign-out's
 * ownership of the session — after `prepare_my_signout('global')` may already
 * have closed the account's barriers and deleted every push row. Leaving that
 * silent is the one outcome this feature may never produce: the account can be
 * half signed out while the card returns to idle and this device still looks
 * signed in. So it says the account-wide action did not finish, does not claim
 * the other devices were signed out, and names both routes the member can take
 * (REQ-UG-NATIVE-SESSION-MANAGEMENT-20261009).
 */
export const GLOBAL_SIGN_OUT_INCOMPLETE_MESSAGE = 'Sign out everywhere is incomplete and your other devices may still be signed in. It stopped before it finished, and notifications may be paused. Try Sign out everywhere again in Account > Sessions, or use Sign out near the top of Account, then Confirm sign out to sign out of this device.';

/**
 * Copy for the same half-done "Sign out everywhere" once this device's own
 * session has turned out to be gone. The resume that follows a failed global
 * attempt can find the session definitively invalidated (it was revoked
 * elsewhere, or its refresh token is spent) and return the member to sign-in;
 * the refusal copy above belongs to the signed-in screen that no longer
 * exists, so it is cleared on that path. Nothing about that invalidation
 * proves the account's other devices were signed out, so the signed-out
 * surface says so and names the route that finishes it: this copy is written
 * instead of silence
 * (SEC-UG-FAILED-SIGN-OUT-EVERYWHERE-END-SIGN-SCREEN-WARNING-20261013).
 */
const GLOBAL_SIGN_OUT_INCOMPLETE_SIGNED_OUT_FOLLOW_UP = 'Sign out everywhere did not finish and your other devices may still be signed in. Sign back in and use Sign out everywhere in Account > Sessions to finish signing out of them.';
export const GLOBAL_SIGN_OUT_INCOMPLETE_SIGNED_OUT_MESSAGE = `This device is signed out, but ${GLOBAL_SIGN_OUT_INCOMPLETE_SIGNED_OUT_FOLLOW_UP}`;

/**
 * The signed-out surface shows one diagnosis. The cleanup that follows a
 * sign-out (account-local, offline, protected-share recovery) reports its own
 * pending state there and settles after the session is gone, so the global
 * warning is not a value those writers could overwrite: it is a condition the
 * provider holds separately and this function appends to whatever cleanup
 * notice is current. Nothing a cleanup retry writes or clears can drop it.
 */
export function globalSignOutIncompleteSignedOutMessage(cleanupNotice: string | null): string {
  return cleanupNotice
    ? `${cleanupNotice} ${GLOBAL_SIGN_OUT_INCOMPLETE_SIGNED_OUT_FOLLOW_UP}`
    : GLOBAL_SIGN_OUT_INCOMPLETE_SIGNED_OUT_MESSAGE;
}
