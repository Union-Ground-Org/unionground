import type { MobileSessionWriter } from './supabase';
import type { SupabaseClient } from '@supabase/supabase-js';

import { mobileConfig } from '../lib/config';
import { trustedPortalForBackend, type MobileConfig } from '../lib/configPolicy';

// Native twin of src/lib/privateFileAccess.js. Same two operations, same
// refusal to let a caller name what it is asking about:
//
//   requestPrivateFileInspection posts exactly `{kind, fileId}` to the portal.
//     No bucket, no object name, no signed URL, no digest, no verdict — the
//     server derives all of those from the caller's own authorization.
//   downloadPrivateObjectToFile reads bytes with the member's own access token
//     so Storage re-evaluates the restrictive quarantine policy on every
//     request. Signed URLs are refused for these four buckets by design: a
//     signed URL is decided once and honoured afterwards, which is exactly
//     what a later quarantine must be able to revoke.
//
// Two rules this module exists to keep: the bearer never reaches a message,
// and bytes only ever land directly inside the real attachment cache
// directory — canonicalized against the actual cache root, not matched by
// name anywhere in the URI.

export type PrivateFileKind = 'case' | 'task' | 'form' | 'knowledge';

export type PrivateFileErrorCode =
  | 'rejected'
  | 'busy'
  | 'rate-limited'
  | 'unavailable'
  // The endpoint refused this SESSION: a stale MFA session, decided before the
  // server looks at the file at all.
  | 'reauth-required'
  // The endpoint refused this ROW, and deliberately will not say why: unknown,
  // foreign, removed and unauthorized are one indistinguishable answer, so the
  // endpoint cannot be used to enumerate file ids. A caller that holds its own
  // durable record of an upload resolves the ambiguity through the idempotent
  // abort/status RPC instead, which is authorized by its existing scope.
  | 'not-authorized'
  | 'invalid';

const PRIVATE_FILE_KINDS = new Set<string>(['case', 'task', 'form', 'knowledge']);
const PRIVATE_FILE_BUCKETS = new Set<string>([
  'case-files',
  'chapter-task-files',
  'member-form-files',
  'organization-knowledge',
]);
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// The twin of attachments.ts's ATTACHMENT_CACHE_DIRECTORY. Declared here rather
// than imported so this module stays free of the attachment service that will
// import it.
const ATTACHMENT_CACHE_DIRECTORY = 'ug-attachment-cache-v1';
const MAX_PRIVATE_FILE_BYTES = 10 * 1024 * 1024;
const RETRYABLE_CODES = new Set<PrivateFileErrorCode>(['busy', 'unavailable']);
const BACKOFF_MS = [1000, 3000];
// `busy` and `unavailable` are both retryable and they are not the same wait.
//
// `unavailable` is a server that could not answer; two quick retries either
// find it back or they do not. `busy` is a CONCURRENT INSPECTION HOLDING THE
// ATTEMPT LEASE, and that lease runs for 60 seconds
// (authorize_private_upload_inspection), long enough for a 10 s privileged
// download and a scan bounded at 20 s. Spending the same three attempts on it
// meant giving up about five seconds into somebody else's legitimate scan.
//
// A busy caller therefore polls until the lease it is waiting on cannot still
// be alive, rather than counting attempts. Polling is free: the server answers
// `busy` before it charges the hourly quota. The web twin
// (src/lib/privateFileAccess.js) holds the same two numbers.
export const BUSY_POLL_MS = 5000;
export const BUSY_DEADLINE_MS = 65000;
const ENDPOINT_PATH = '/api/private-files';
// This origin receives a live member access token. It is deliberately not
// runtime-configurable from the public Expo manifest: each admitted backend
// has exactly one portal, fixed in configPolicy, and the request goes to the
// portal of the backend that issued the token. Nothing falls back.

const CODE_BY_STATUS: Record<number, PrivateFileErrorCode> = {
  400: 'invalid',
  401: 'reauth-required',
  403: 'not-authorized',
  404: 'unavailable',
  405: 'invalid',
  409: 'busy',
  422: 'rejected',
  429: 'rate-limited',
  503: 'unavailable',
};

// Messages are generic on purpose. They are shown to a member and written to a
// crash report, so they never carry a token, a path, a filename or a scanner
// detail.
const MESSAGE_BY_CODE: Record<PrivateFileErrorCode, string> = {
  invalid: 'This file cannot be checked.',
  'not-authorized': 'You are not able to check this file.',
  'reauth-required': 'Verify it is you before this file can be checked.',
  rejected: 'This file was rejected by the safety check.',
  busy: 'This file is already being checked.',
  'rate-limited': 'Too many file checks. Try again later.',
  unavailable: 'The file check could not be completed. Try again.',
};

export class PrivateFileError extends Error {
  readonly code: PrivateFileErrorCode;
  readonly retryable: boolean;
  readonly retryAfterMs: number | null;
  readonly staleVerdict: boolean;

  constructor(
    code: PrivateFileErrorCode,
    details: { retryAfterMs?: number | null; staleVerdict?: boolean } = {},
  ) {
    super(MESSAGE_BY_CODE[code]);
    this.name = 'PrivateFileError';
    this.code = code;
    this.retryable = RETRYABLE_CODES.has(code);
    this.retryAfterMs = details.retryAfterMs ?? null;
    this.staleVerdict = details.staleVerdict === true;
  }
}

/**
 * The portal origin that inspects files for the configured backend.
 *
 * Admits only a configured build whose backend and portal are exactly one of
 * the known pairs, compared as whole strings: a mismatched pair, an unknown
 * host, credentials, a path, a query, a fragment or even a trailing slash is a
 * different string and is refused. Callers run this before reading the session,
 * so a refused configuration never touches the member's token.
 */
export function privateFileApiOrigin(
  config: Pick<MobileConfig, 'backendConfigured' | 'supabaseUrl' | 'portalBaseUrl'> = mobileConfig,
): string {
  const portal = config.backendConfigured && typeof config.supabaseUrl === 'string'
    ? trustedPortalForBackend(config.supabaseUrl)
    : undefined;
  if (!portal || config.portalBaseUrl !== portal) throw new PrivateFileError('unavailable');
  return portal;
}

// Retry-After is seconds or an HTTP date. Anything unreadable is "unknown",
// never zero: a zero would invite an immediate retry of a wait the server just
// asked for.
function retryAfterMs(response: Response): number | null {
  const header = response.headers.get('Retry-After');
  if (!header) return null;
  const seconds = Number(header.trim());
  if (Number.isFinite(seconds)) return seconds >= 0 ? Math.round(seconds * 1000) : null;
  const at = Date.parse(header);
  if (!Number.isFinite(at)) return null;
  return Math.max(0, at - Date.now());
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new PrivateFileError('unavailable'));
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    function onAbort() {
      clearTimeout(timer);
      reject(new PrivateFileError('unavailable'));
    }
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

async function inspectOnce(
  client: SupabaseClient,
  kind: PrivateFileKind,
  fileID: string,
  signal?: AbortSignal,
  writer?: MobileSessionWriter,
): Promise<{ fileID: string; status: 'clean' }> {
  const origin = privateFileApiOrigin();
  if (!writer) throw new PrivateFileError('reauth-required');
  const token = (await writer.session()).access_token;
  let response: Response;
  try {
    response = await fetch(`${origin}${ENDPOINT_PATH}`, {
      method: 'POST',
      // No Origin, cookie or Sec-Fetch header: the shared mutation boundary
      // admits a native caller only as a bearer-only request.
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ kind, fileId: fileID }),
      signal,
    });
  } catch {
    // The request carried the bearer, so the thrown error — abort, TLS or
    // transport — is never re-surfaced or logged.
    throw new PrivateFileError('unavailable');
  }
  let payload: { fileId?: unknown; status?: unknown } | null = null;
  try {
    payload = await response.json() as { fileId?: unknown; status?: unknown };
  } catch {
    payload = null;
  }
  if (response.ok) {
    // A 2xx alone proves nothing. The server must name this file and call it
    // clean; anything else is an unavailable check, not a pass.
    if (payload?.status === 'clean' && payload?.fileId === fileID) {
      return { fileID, status: 'clean' };
    }
    throw new PrivateFileError('unavailable');
  }
  throw new PrivateFileError(CODE_BY_STATUS[response.status] ?? 'unavailable', {
    retryAfterMs: retryAfterMs(response),
  });
}

/**
 * Ask the portal to inspect an uploaded private file.
 *
 * Resolves only on an explicit clean verdict for this exact file; every other
 * outcome throws a PrivateFileError. A caller may confirm an upload only on
 * the resolved path.
 */
export async function requestPrivateFileInspection(
  client: SupabaseClient,
  kind: PrivateFileKind,
  fileID: string,
  options: { writer?: MobileSessionWriter; attempts?: number; signal?: AbortSignal; busyDeadlineMs?: number } = {},
): Promise<{ fileID: string; status: 'clean' }> {
  if (!PRIVATE_FILE_KINDS.has(kind) || typeof fileID !== 'string' || !UUID_PATTERN.test(fileID)) {
    throw new PrivateFileError('invalid');
  }
  const requested = options.attempts;
  const total = Number.isInteger(requested) && (requested as number) > 0 ? requested as number : 3;
  const requestedDeadline = options.busyDeadlineMs ?? BUSY_DEADLINE_MS;
  // A caller that explicitly asked for one attempt gets one request, busy or
  // not; polling is only for the ordinary multi-attempt contract.
  const busyBudgetMs = total > 1 && Number.isFinite(requestedDeadline) && requestedDeadline > 0
    ? requestedDeadline
    : 0;
  let busyUntil: number | null = null;
  let spent = 0;
  let lastError: PrivateFileError | null = null;
  for (;;) {
    try {
      return await inspectOnce(client, kind, fileID, options.signal, options.writer);
    } catch (error) {
      // Only a lease held by another caller and a server that could not answer
      // can change on a retry. A rejection is about these bytes and a quota
      // refusal is about this actor; repeating either only spends quota.
      if (!(error instanceof PrivateFileError) || !error.retryable) throw error;
      lastError = error;
    }
    if (lastError.code === 'busy') {
      // The budget is measured from the first refusal, so a slow round trip
      // does not eat the lease this caller is waiting out.
      if (busyUntil === null) busyUntil = Date.now() + busyBudgetMs;
      const wait = Math.max(BUSY_POLL_MS, lastError.retryAfterMs ?? 0);
      if (Date.now() + wait > busyUntil) throw lastError;
      await sleep(wait, options.signal);
      continue;
    }
    spent += 1;
    if (spent >= total) throw lastError;
    const planned = BACKOFF_MS[spent - 1] ?? BACKOFF_MS[BACKOFF_MS.length - 1] ?? 0;
    await sleep(Math.max(planned, lastError.retryAfterMs ?? 0), options.signal);
  }
}

function objectUrl(bucketID: string, objectName: string): string {
  const supabaseUrl = mobileConfig.supabaseUrl;
  if (!supabaseUrl || !mobileConfig.supabasePublishableKey
    || !PRIVATE_FILE_BUCKETS.has(bucketID)) {
    throw new PrivateFileError('invalid');
  }
  if (typeof objectName !== 'string' || !objectName || objectName.length > 1024
    || objectName.includes('\\')
    || [...objectName].some((character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127)
    || objectName.split('/').some((part) => !part || part === '.' || part === '..')) {
    throw new PrivateFileError('invalid');
  }
  // The same URL shape storage-js `download()` builds — `/object/<bucket>/
  // <path>`, with no `authenticated` segment — because that is the shape whose
  // Storage operation label (`object.get_authenticated`) the quarantine policy
  // was proven against. Segments are percent-encoded exactly as
  // api/_lib/privateFileDownload.js does.
  const path = objectName.split('/').map(encodeURIComponent).join('/');
  return `${supabaseUrl}/storage/v1/object/${bucketID}/${path}`;
}

// One canonical, absolute path for a file: URI, or null when it is not one
// this module is willing to reason about.
//
// `..` is REJECTED rather than resolved. Resolving it would mean deciding what
// `/a/../../b` means, and the only safe answer here is "not a path we wrote".
// Percent-encoding is decoded first, so `%2e%2e` cannot smuggle a segment past
// the check, and a trailing slash, `.` segments and empty segments collapse so
// a directory URI and its path form compare equal.
function canonicalFilePath(uri: string): string | null {
  if (typeof uri !== 'string' || !uri || uri.length > 4096 || uri.includes('\\')) return null;
  let parsed: URL;
  try {
    parsed = new URL(uri);
  } catch {
    return null;
  }
  if (parsed.protocol !== 'file:' || parsed.search || parsed.hash) return null;
  let decoded: string;
  try {
    decoded = decodeURIComponent(parsed.pathname);
  } catch {
    return null;
  }
  if (decoded.includes('\\')
    || [...decoded].some((character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127)) {
    return null;
  }
  const segments: string[] = [];
  for (const segment of decoded.split('/')) {
    if (segment === '' || segment === '.') continue;
    if (segment === '..') return null;
    segments.push(segment);
  }
  if (segments.length === 0) return null;
  return `/${segments.join('/')}`;
}

// The REAL cache root, built exactly the way attachments.ts builds it, rather
// than a name matched anywhere in the URI. `.../ug-attachment-cache-v1x/a.pdf`
// and `.../Documents/ug-attachment-cache-v1/a.pdf` both contained the right
// word and neither is the directory `purgeAttachmentCachePass` sweeps.
async function attachmentCacheRoot(): Promise<string | null> {
  try {
    const { Directory, Paths } = await import('expo-file-system');
    return canonicalFilePath(new Directory(Paths.cache, ATTACHMENT_CACHE_DIRECTORY).uri);
  } catch {
    return null;
  }
}

/**
 * Download an authorized private object to a local cache file.
 *
 * The destination must already be an opaque file directly inside the attachment
 * cache directory: bytes that the sharing sheet will hand to another
 * application must never land somewhere the cache purge does not sweep.
 *
 * Nothing this function throws contains the access token, the URL or the
 * object name.
 */
export async function downloadPrivateObjectToFile(
  _client: SupabaseClient,
  target: { bucketID: string; objectName: string },
  destinationURI: string,
  writer?: MobileSessionWriter,
): Promise<void> {
  const url = objectUrl(target?.bucketID, target?.objectName);
  // Canonicalize both sides and require a DIRECT child of the real cache root:
  // that is the only shape createOpaqueAttachmentCacheFile ever produces, and
  // anything deeper would be a directory the purge pass does not walk.
  const root = await attachmentCacheRoot();
  const destination = canonicalFilePath(destinationURI);
  if (!root || !destination
    || !destination.startsWith(`${root}/`)
    || destination.slice(root.length + 1).includes('/')) {
    throw new PrivateFileError('invalid');
  }
  if (!writer) throw new PrivateFileError('reauth-required');
  const token = (await writer.session()).access_token;

  let response: Response;
  try {
    // expo-file-system@57.0.6 was checked directly: `File.downloadFileAsync`
    // does accept `{ headers }` (build/NetworkTasks.types.d.ts DownloadOptions),
    // so the bearer could be handed to it. It is still not used here, for two
    // reasons that both cut towards failing closed:
    //   * it has no `redirect: 'error'`. A 30x from the Storage host would make
    //     URLSession/OkHttp replay the member's Authorization header at whatever
    //     host the redirect names; `fetch` refuses instead.
    //   * it collapses the HTTP status into a localized message string
    //     ("response has status 403" on iOS, "response has status: 403" on
    //     Android), so the 4xx that means "the clean verdict is gone" could only
    //     be recovered by parsing prose. Here it is read from the response.
    // The buffered body is bounded by the same 10 MiB ceiling the upload path
    // enforces, so holding it briefly is affordable.
    response = await fetch(url, {
      method: 'GET',
      redirect: 'error',
      headers: {
        apikey: mobileConfig.supabasePublishableKey,
        Authorization: `Bearer ${token}`,
      },
    });
  } catch {
    throw new PrivateFileError('unavailable');
  }
  if (!response.ok) {
    // A 4xx from Storage for an otherwise authorized member is the restrictive
    // quarantine policy answering: the clean verdict expired or was
    // superseded. That is recoverable with one re-inspection, which is what
    // `staleVerdict` tells the caller to offer.
    throw new PrivateFileError('unavailable', {
      staleVerdict: response.status >= 400 && response.status < 500,
    });
  }
  const buffer = await response.arrayBuffer().catch(() => null);
  if (!buffer || buffer.byteLength < 1 || buffer.byteLength > MAX_PRIVATE_FILE_BYTES) {
    throw new PrivateFileError('unavailable');
  }
  try {
    // Both calls are checked against expo-file-system@57.0.6:
    // `create(options?: FileCreateOptions)` takes `{ intermediates, overwrite }`
    // and `write(content: string | Uint8Array, options?: FileWriteOptions)`
    // accepts the byte array directly (build/internal/NativeFileSystem.types.d.ts).
    const { File } = await import('expo-file-system');
    const destination = new File(destinationURI);
    destination.create({ overwrite: true });
    destination.write(new Uint8Array(buffer));
    // A short write leaves a truncated file that the viewer would happily open.
    if (!destination.exists || destination.size !== buffer.byteLength) {
      throw new Error('incomplete write');
    }
  } catch {
    throw new PrivateFileError('unavailable');
  }
}
