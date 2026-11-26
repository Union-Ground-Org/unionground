// REQ-UG-ENGAGEMENT-EMAIL-RESEND-BRIDGE-20261121: the entry check of
// an endpoint that only this deployment's own server code calls with a bearer
// (api/engagement-email-bridge.js, called by api/engagement-delivery.js).
//
// The shared validateMutationOrigin (api/_lib/http.js) treats Sec-Fetch-Mode as
// a browser signal, and Node's fetch sends Sec-Fetch-Mode: cors on every
// request, so it refuses every real server-to-server call (R-9410). A browser
// always sends Sec-Fetch-Site on a fetch or form post, and Node's fetch never
// does. So a request carrying Origin, Cookie, Referer or Sec-Fetch-Site,
// present at all and even empty, is a browser and is refused.
//
// scripts/lib/api-origin-contract.mjs accepts this check as the first handler
// statement only for files listed there as "bearer-only-server-webhook".
const BROWSER_HEADERS = Object.freeze(["origin", "cookie", "referer", "sec-fetch-site"]);

export function serverCaller(request) {
  const headers = request?.headers;
  if (!headers || typeof headers !== "object") return false;
  return BROWSER_HEADERS.every((name) => headers[name] === undefined);
}
