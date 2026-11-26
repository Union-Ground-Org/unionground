export const SAMPLE_REQUEST_TIMEOUT_MS = 10_000;
export const SAMPLE_REST_REQUEST_TIMEOUT_MS = 30_000;

// The Fetch standard forbids response bodies on these statuses. Supplying
// even a zero-byte ArrayBuffer to the Response constructor throws, so retain
// the status while rebuilding the buffered response with a null body.
const BODY_FORBIDDEN_RESPONSE_STATUSES = new Set([204, 205, 304]);

function timeoutError() {
  // Keep transport errors neutral: the SAMPLE origin is the demo boundary,
  // but user-visible error copy must never expose an internal SAMPLE label.
  const message = "Request timed out";
  if (typeof DOMException === "function") return new DOMException(message, "TimeoutError");
  const error = new Error(message);
  error.name = "TimeoutError";
  return error;
}

function boundedJsonRequestKind(input) {
  const requestUrl = typeof input === "string" || input instanceof URL
    ? String(input)
    : input?.url;
  if (!requestUrl) return null;
  try {
    const path = new URL(requestUrl, "https://sample.invalid").pathname;
    if (path === "/api/demo-session" || path.startsWith("/auth/v1/")) return "identity";
    if (path.startsWith("/rest/v1/")) return "rest";
    return null;
  } catch {
    return null;
  }
}

// SAMPLE is a real remote Supabase surface. Bound every request so a lost
// response cannot pin straight-in entry or a cross-persona hat switch behind
// the full-screen loading surface forever. Preserve any caller cancellation
// while giving the timeout its own controller, which also prevents a stalled
// fetch or response body from completing later after the UI has recovered.
export async function boundedSampleFetch(input, init = {}, timeoutMs = null) {
  // Keep ordinary fetch semantics for Storage uploads/downloads and any other
  // non-JSON transport. In particular, do not buffer a member document or
  // impose the short persona/session deadline on a legitimate file transfer.
  const requestKind = boundedJsonRequestKind(input);
  if (!requestKind) return globalThis.fetch(input, init);
  const deadlineMs = timeoutMs ?? (requestKind === "rest"
    ? SAMPLE_REST_REQUEST_TIMEOUT_MS
    : SAMPLE_REQUEST_TIMEOUT_MS);

  const controller = new AbortController();
  const requestSignal = init.signal
    ?? (typeof Request === "function" && input instanceof Request ? input.signal : null);
  const abortFromCaller = () => controller.abort(requestSignal?.reason);

  if (requestSignal?.aborted) abortFromCaller();
  else requestSignal?.addEventListener("abort", abortFromCaller, { once: true });

  const timeout = globalThis.setTimeout(() => controller.abort(timeoutError()), deadlineMs);
  try {
    const response = await globalThis.fetch(input, { ...init, signal: controller.signal });
    // fetch resolves as soon as response headers arrive. Buffer real Response
    // bodies before clearing the deadline so a peer that sends headers and
    // then stalls cannot leave Supabase's later json()/text() read pending
    // forever. SAMPLE payloads are deliberately bounded seeded data; realtime
    // remains on its WebSocket transport rather than this fetch adapter.
    if (typeof Response !== "function" || !(response instanceof Response) || response.body === null) {
      return response;
    }
    const body = await response.arrayBuffer();
    const buffered = new Response(
      BODY_FORBIDDEN_RESPONSE_STATUSES.has(response.status) ? null : body,
      {
        headers: response.headers,
        status: response.status,
        statusText: response.statusText,
      },
    );
    // These fetch metadata fields are otherwise lost when reconstructing the
    // consumed response. Shadowing their prototype getters keeps the adapter's
    // result faithful for callers that inspect redirects or the final URL.
    Object.defineProperties(buffered, {
      redirected: { configurable: true, value: response.redirected },
      type: { configurable: true, value: response.type },
      url: { configurable: true, value: response.url },
    });
    return buffered;
  } finally {
    globalThis.clearTimeout(timeout);
    requestSignal?.removeEventListener("abort", abortFromCaller);
  }
}
