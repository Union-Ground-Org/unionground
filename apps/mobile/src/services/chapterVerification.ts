import { resolvePortalApiOrigin } from '../lib/portalApiOrigin';
import type { MobileBindingVerification, MobileConnectionVerification } from '../lib/chapterAdministration';

const CHAPTER_LIFECYCLE_PATH = '/api/chapter-lifecycle-verification';

// `verify_chapter_union_org_binding` and `verify_chapter_connection_setup` are
// granted to the service role only, so a native caller reaches them the same
// way the web desk does: through the portal boundary, which resolves the
// named reviewer from this very token before it forwards anything. The native
// request carries a bearer token and no cookie; the boundary admits that
// exact shape (api/_lib/http.js validateMutationOrigin) and refuses a caller
// whose organization scope does not cover the chapter.
//
// The origin is the one trusted portal origin native checkout already posts a
// token to. There is deliberately no second API-origin knob.
export function chapterVerificationEndpoint(origin: string = resolvePortalApiOrigin()): string {
  return `${origin}${CHAPTER_LIFECYCLE_PATH}`;
}

// `outcome-unconfirmed` is every failure after the request may have left the
// device: a timeout, a lost response, a stalled or malformed body, a 5xx. The
// server may have committed before its answer was lost, so this reason never
// means "nothing was recorded"; the screen re-reads the request instead.
export type ChapterVerificationFailure =
  | 'session-expired'
  | 'not-permitted'
  | 'request-changed'
  | 'outcome-unconfirmed';

export class ChapterVerificationError extends Error {
  readonly reason: ChapterVerificationFailure;

  constructor(reason: ChapterVerificationFailure) {
    super(reason);
    this.name = 'ChapterVerificationError';
    this.reason = reason;
  }
}

function failureFor(status: number, code: string): ChapterVerificationFailure {
  if (status === 401) return 'session-expired';
  if (status === 403 || code === 'not-permitted') return 'not-permitted';
  if (status === 409 || code === 'request-changed') return 'request-changed';
  return 'outcome-unconfirmed';
}

// The seam the tests drive: exactly the two arguments this module sends, so a
// fake can be written without asserting its way into `typeof fetch`.
export type ChapterVerificationFetch = (url: string, init: RequestInit) => Promise<Response>;

// A transport that opens and then never answers would otherwise leave the
// await pending for the life of the screen: the controls stay disabled and
// the unavailable path that is meant to report it never runs. The bound is
// generous enough for the boundary's own 8s scope-oracle timeout plus the
// RPC behind it.
export const CHAPTER_VERIFICATION_TIMEOUT_MS = 20000;

// The boundary answers a recorded decision with `{ accepted: true, result }`.
// Any other 2xx body — a proxy's fallback page, an HTML redirect, malformed
// JSON — is a response that did not come from the RPC, and treating it as
// success would show an operator an audited decision that was never written.
function acknowledged(payload: unknown): boolean {
  return typeof payload === 'object' && payload !== null
    && (payload as { accepted?: unknown }).accepted === true;
}

export async function postChapterVerification(
  request: MobileBindingVerification | MobileConnectionVerification,
  accessToken: string | null,
  fetchImpl: ChapterVerificationFetch = fetch,
  timeoutMs: number = CHAPTER_VERIFICATION_TIMEOUT_MS,
): Promise<void> {
  if (!accessToken) throw new ChapterVerificationError('session-expired');
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | null = null;
  // The bound covers the WHOLE exchange, request and body, as one race. Its
  // rejection is handled the moment it is created, so a transport that
  // settles a task after the abort, or never settles at all, can neither
  // surface an unhandled rejection nor hold the controls busy.
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => { controller.abort(); reject(new Error('timeout')); }, timeoutMs);
  });
  timeout.catch(() => undefined);
  const exchange = (async () => {
    const response = await fetchImpl(chapterVerificationEndpoint(), {
      method: 'POST',
      cache: 'no-store',
      headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(request),
      signal: controller.signal,
    });
    let payload: unknown = null;
    let bodyReadable = true;
    try { payload = await response.json(); } catch { bodyReadable = false; }
    return { response, payload, bodyReadable };
  })();
  // Whichever side loses the race settles later, or never; its outcome is
  // already decided and must not become an unhandled rejection.
  exchange.catch(() => undefined);
  let settled: { response: Response; payload: unknown; bodyReadable: boolean };
  try {
    settled = await Promise.race([exchange, timeout]);
  } catch {
    // The request may have reached the boundary before the transport failed
    // or the bound elapsed; the outcome is unknown, not refused and not absent.
    throw new ChapterVerificationError('outcome-unconfirmed');
  } finally {
    if (timer !== null) clearTimeout(timer);
  }
  const { response, payload, bodyReadable } = settled;
  if (response.ok) {
    if (bodyReadable && acknowledged(payload)) return;
    throw new ChapterVerificationError('outcome-unconfirmed');
  }
  const code = bodyReadable && typeof payload === 'object' && payload !== null && 'error' in payload
    && typeof payload.error === 'string' ? payload.error : '';
  throw new ChapterVerificationError(failureFor(response.status, code));
}
