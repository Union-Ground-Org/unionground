// The one web-side contract for the private-upload boundary.
//
// Two operations, and deliberately nothing else:
//
//   requestPrivateFileInspection — ask the server to inspect an already
//     uploaded object. The request body is exactly `{kind, fileId}`. It carries
//     no bucket, no object name, no signed URL, no digest and no verdict: the
//     server derives every one of those from the caller's own authorization,
//     and a client that could name a path could name someone else's.
//   downloadPrivateFileBlob — read bytes back with the caller's own JWT, so
//     Storage re-evaluates the restrictive quarantine policy on every single
//     request. Signed URLs are refused for these four buckets by design: a
//     signed URL is a decision made once and honoured afterwards, which is
//     exactly what a later quarantine has to be able to revoke.
//
// Nothing here ever turns an ambiguous answer into success. The only resolved
// state is an explicit `{status: "clean"}` from the server for the file that
// was asked about; everything else throws.

export const PRIVATE_FILE_KINDS = ["case", "task", "form", "knowledge"];
const KINDS = new Set(PRIVATE_FILE_KINDS);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ENDPOINT = "/api/private-files";

// Retry only what a later attempt can plausibly change: an attempt lease held
// by a concurrent caller, and a server that could not answer. A rejection is a
// decision about these bytes and a quota refusal is a decision about this
// actor; repeating either only spends the hourly allowance.
const RETRYABLE = new Set(["busy", "unavailable"]);
export const PRIVATE_FILE_BACKOFF_MS = [1000, 3000];

// `busy` and `unavailable` are both retryable and they are not the same wait.
//
// `unavailable` is a server that could not answer; two quick retries either
// find it back or they do not. `busy` is a CONCURRENT INSPECTION HOLDING THE
// ATTEMPT LEASE, and that lease runs for 60 seconds
// (authorize_private_upload_inspection), long enough for a 10 s privileged
// download and a scan bounded at 20 s. Spending the same three attempts on it
// meant giving up about five seconds into somebody else's legitimate scan and
// telling the member their file was not attached.
//
// So a busy caller polls instead of counting attempts: every
// PRIVATE_FILE_BUSY_POLL_MS (or the server's longer Retry-After) until the
// lease it is waiting on cannot still be alive. The deadline is the lease plus
// one poll, so the last request lands after any lease that existed when the
// wait began has expired. Polling is free: the server answers `busy` before it
// charges the hourly quota, so nothing here spends the member's allowance.
export const PRIVATE_FILE_BUSY_POLL_MS = 5000;
export const PRIVATE_FILE_BUSY_DEADLINE_MS = 65000;

// Bound the entire attempt, including session refresh, response headers and
// JSON consumption. The server budgets 10 s for download and 20 s for scanning;
// 45 s leaves room for authentication and transport without waiting forever.
// Expiry is ambiguous and spends an ordinary unavailable attempt, never a
// clean verdict or a permanent rejection of the registered file.
export const PRIVATE_FILE_REQUEST_TIMEOUT_MS = 45000;

// One code per server response class. Anything unrecognised — including a
// transport failure, an unreadable body, or a 200 that does not say `clean` —
// lands on `unavailable`, never on success.
// 401 and 403 are deliberately NOT the same code. 401 is the endpoint saying
// "your MFA session is stale" — a fact about this caller's session, decided
// before the server looks at the file at all. 403 is the merged, deliberately
// indistinguishable answer for unknown, foreign, removed and unauthorized
// rows, so the endpoint cannot be used to enumerate file ids.
const CODE_BY_STATUS = {
  400: "invalid",
  401: "reauth-required",
  403: "not-authorized",
  404: "unavailable",
  405: "invalid",
  409: "busy",
  422: "rejected",
  429: "rate-limited",
  503: "unavailable",
};

// User-facing wording lives in the callers' i18n; these messages exist so a
// thrown error is legible in a log or a stack trace. They never name a bucket,
// an object, a parser or a scanner.
const MESSAGE_BY_CODE = {
  invalid: "This file cannot be checked.",
  "not-authorized": "You are not able to check this file.",
  "reauth-required": "Verify it is you before this file can be checked.",
  rejected: "This file was rejected by the safety check.",
  busy: "This file is already being checked.",
  "rate-limited": "Too many file checks. Try again later.",
  unavailable: "The file check could not be completed. Try again.",
};

export class PrivateFileError extends Error {
  constructor(code, details = {}) {
    super(MESSAGE_BY_CODE[code] || MESSAGE_BY_CODE.unavailable);
    this.name = "PrivateFileError";
    this.code = code;
    this.retryable = RETRYABLE.has(code);
    this.retryAfterMs = details.retryAfterMs ?? null;
    // Set by the download path: the bytes exist and the caller is authorized,
    // but the clean verdict aged out. The recovery is one re-inspection, not a
    // blind retry of the download.
    this.staleVerdict = details.staleVerdict === true;
  }
}

// Retry-After is seconds or an HTTP date. An unparseable or negative value is
// simply "unknown", never zero — a zero would invite an immediate retry.
function retryAfterMs(response) {
  const header = response?.headers?.get?.("Retry-After");
  if (!header) return null;
  const seconds = Number(header.trim());
  if (Number.isFinite(seconds)) return seconds >= 0 ? Math.round(seconds * 1000) : null;
  const at = Date.parse(header);
  if (!Number.isFinite(at)) return null;
  return Math.max(0, at - Date.now());
}

function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason ?? new DOMException("Aborted", "AbortError"));
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener?.("abort", onAbort);
      resolve();
    }, ms);
    function onAbort() {
      clearTimeout(timer);
      reject(signal.reason ?? new DOMException("Aborted", "AbortError"));
    }
    signal?.addEventListener?.("abort", onAbort, { once: true });
  });
}

function isAbort(error) {
  return error?.name === "AbortError" || error?.code === "ABORT_ERR";
}

async function inspectResponse(client, kind, fileId, signal, fetchImpl) {
  // Session resolution can include refresh. If it finishes after abandonment,
  // it must not start a request for an upload the caller is no longer checking.
  const { data, error } = await client.auth.getSession();
  if (signal.aborted) throw signal.reason;
  const token = data?.session?.access_token;
  if (error || !token) throw new PrivateFileError("reauth-required");

  let response;
  try {
    response = await fetchImpl(ENDPOINT, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      // The whole request. A reviewer can read this object and see that no
      // path, URL, digest or verdict crosses the boundary.
      body: JSON.stringify({ kind, fileId }),
      // The endpoint authenticates the bearer alone. Sending cookies would add
      // a second, ambient credential to a mutation and make it CSRF-shaped.
      credentials: "omit",
      signal,
    });
  } catch (transportError) {
    if (signal.aborted) throw signal.reason;
    if (isAbort(transportError)) throw transportError;
    throw new PrivateFileError("unavailable");
  }

  if (signal.aborted) throw signal.reason;
  const payload = await response.json().catch(() => null);
  if (signal.aborted) throw signal.reason;
  if (response.ok) {
    // A 2xx alone proves nothing. The server must name this file and call it
    // clean; a truncated or rewritten response falls through to `unavailable`.
    if (payload?.status === "clean" && payload?.fileId === fileId) {
      return { fileId, status: "clean" };
    }
    throw new PrivateFileError("unavailable");
  }
  throw new PrivateFileError(CODE_BY_STATUS[response.status] || "unavailable",
    { retryAfterMs: retryAfterMs(response) });
}

async function inspectOnce(client, kind, fileId, signal, fetchImpl) {
  if (signal?.aborted) throw signal.reason ?? new DOMException("Aborted", "AbortError");
  const controller = new AbortController();
  let timer;
  let onAbort;
  const interrupted = new Promise((_, reject) => {
    const interrupt = (reason) => {
      reject(reason);
      controller.abort(reason);
    };
    onAbort = () => interrupt(signal.reason ?? new DOMException("Aborted", "AbortError"));
    signal?.addEventListener?.("abort", onAbort, { once: true });
    timer = setTimeout(() => interrupt(new PrivateFileError("unavailable")), PRIVATE_FILE_REQUEST_TIMEOUT_MS);
  });
  try {
    // Also race the wait: auth and injected transports may ignore cancellation.
    // Late results remain handled but cannot settle this attempt a second time.
    return await Promise.race([inspectResponse(client, kind, fileId, controller.signal, fetchImpl), interrupted]);
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener?.("abort", onAbort);
  }
}

/**
 * Ask the server to inspect an uploaded private file.
 *
 * Resolves `{fileId, status: "clean"}` or throws a PrivateFileError. It never
 * resolves for any other verdict, so a caller may confirm an upload only on
 * the resolved path.
 *
 * @param {object} client Supabase client (used only for the caller's session).
 * @param {"case"|"task"|"form"|"knowledge"} kind
 * @param {string} fileId Feature row id — never a bucket or object name.
 * @param {{signal?: AbortSignal, attempts?: number, backoffMs?: number[],
 *   busyDeadlineMs?: number, fetchImpl?: Function}} [options]
 */
export async function requestPrivateFileInspection(client, kind, fileId, options = {}) {
  const {
    signal, attempts = 3, backoffMs = PRIVATE_FILE_BACKOFF_MS,
    busyDeadlineMs = PRIVATE_FILE_BUSY_DEADLINE_MS, fetchImpl = fetch,
  } = options;
  if (!KINDS.has(kind) || typeof fileId !== "string" || !UUID.test(fileId)) {
    throw new PrivateFileError("invalid");
  }
  const total = Number.isInteger(attempts) && attempts > 0 ? attempts : 1;
  // A caller that explicitly asked for one attempt gets one request, busy or
  // not; polling is only for the ordinary multi-attempt contract.
  const busyDeadlineAt = total > 1 && Number.isFinite(busyDeadlineMs) && busyDeadlineMs > 0
    ? busyDeadlineMs
    : 0;
  let busyUntil = null;
  let spent = 0;
  let lastError;
  for (;;) {
    try {
      return await inspectOnce(client, kind, fileId, signal, fetchImpl);
    } catch (error) {
      if (signal?.aborted) throw signal.reason ?? error;
      if (isAbort(error)) throw error;
      if (!(error instanceof PrivateFileError) || !error.retryable) throw error;
      lastError = error;
    }
    // Honour a server-stated wait when it is longer than ours: it knows how
    // long its own lease or quota window has left to run.
    if (lastError.code === "busy") {
      // The budget starts at the first refusal, not at the call, so a slow
      // round trip does not eat the lease this caller is waiting out.
      busyUntil ??= Date.now() + busyDeadlineAt;
      const wait = Math.max(PRIVATE_FILE_BUSY_POLL_MS, lastError.retryAfterMs ?? 0);
      // Stop only when the next poll would land after any lease that was alive
      // when the waiting began — never merely because attempts ran out.
      if (Date.now() + wait > busyUntil) throw lastError;
      await sleep(wait, signal);
      continue;
    }
    spent += 1;
    if (spent >= total) throw lastError;
    const wait = backoffMs[spent - 1] ?? backoffMs[backoffMs.length - 1] ?? 0;
    await sleep(Math.max(wait, lastError.retryAfterMs ?? 0), signal);
  }
}

/**
 * Read a private object's bytes with the caller's own JWT.
 *
 * `bucketId` and `objectName` come from a row the server already handed this
 * caller; they are not user input, and Storage re-checks the quarantine policy
 * for this request regardless of what is passed.
 */
export async function downloadPrivateFileBlob(client, { bucketId, objectName } = {}) {
  if (typeof bucketId !== "string" || !bucketId || typeof objectName !== "string" || !objectName) {
    throw new PrivateFileError("invalid");
  }
  let result;
  try {
    result = await client.storage.from(bucketId).download(objectName);
  } catch {
    throw new PrivateFileError("unavailable");
  }
  if (result?.error || !result?.data) {
    // A 4xx here is the restrictive policy answering, which for an authorized
    // caller means the clean verdict expired or was superseded. Surfacing that
    // as `staleVerdict` is what lets a view offer "re-check this file" instead
    // of an unexplained failure. A 5xx is a genuine outage and offers nothing.
    const status = Number(result?.error?.status ?? result?.error?.statusCode);
    throw new PrivateFileError("unavailable", { staleVerdict: status >= 400 && status < 500 });
  }
  return result.data;
}

/**
 * Hand a blob to `consume` as an object URL and revoke it later.
 *
 * The revoke is deferred rather than immediate because the consumer is usually
 * a just-opened tab or an <img> that has not fetched the URL yet; revoking in
 * the same turn produces a blank viewer. The delay is a cleanup deadline, not
 * an access-control boundary — an object URL is same-origin and dies with the
 * document either way.
 */
export function withObjectUrl(blob, consume, { revokeAfterMs = 60000 } = {}) {
  const url = URL.createObjectURL(blob);
  try {
    return consume(url);
  } finally {
    setTimeout(() => URL.revokeObjectURL(url), revokeAfterMs);
  }
}
