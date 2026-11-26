import { resolveSupabaseBackend } from "./_lib/backend.js";
import { json, methodGuard, requireEnv, supabaseHeaders, supabaseRpc } from "./_lib/http.js";
import { requestClientAddress, requestNetworkBucket } from "./_lib/networkAddress.js";

// Password grant proxy. The member response stays deliberately flat while a
// failed attempt that maps to a real tenant is recorded for that tenant's
// admin inbox. Unknown identities are not assigned to any organization.
// The native app signs in through this same route (it names its platform in
// `client`), so a native failure reaches the same telemetry as a web one.
//
// SEC-UG-PASSWORD-SIGNIN-THROTTLE-20261001: every well-formed attempt is
// first reserved in a durable, database-backed throttle (serverless instances
// share no memory): one bucket per network address and one per email
// address, with platform-wide hourly limits. The limits never depend on
// whether the address has an account, so a 429 says nothing about who is a
// member. Over either limit the route answers 429 `try-later` without
// contacting GoTrue. Successful grants refund their own reservation; failures
// and abandoned requests retain their charge. A success never clears failures.
export default async function handler(request, response) {
  if (methodGuard(request, ["POST"], () => json(response, 405, { error: "method-not-allowed" }))) return;
  const backend = resolveSupabaseBackend(request);
  if (requireEnv([backend.url, backend.publishableKey, backend.serviceRoleKey],
    () => json(response, 503, { error: "not-configured" }))) return;

  const body = typeof request.body === "string" ? safeParse(request.body) : request.body;
  const email = String(body?.email || "").trim().toLowerCase();
  const password = String(body?.password || "");
  if (!validEmail(email) || password.length === 0 || password.length > 256) {
    json(response, 401, { error: "sign-in-failed" });
    return;
  }

  let attempt;
  try {
    attempt = await reserveAttempt(backend, email, request);
  } catch {
    json(response, 503, { error: "sign-in-unavailable" });
    return;
  }
  if (!attempt.allowed) {
    json(response, 429, { error: "try-later" });
    return;
  }

  let upstream;
  try {
    upstream = await fetch(`${backend.url}/auth/v1/token?grant_type=password`, {
      method: "POST",
      headers: grantHeaders(backend, request),
      body: JSON.stringify({ email, password }),
      signal: AbortSignal.timeout(8000),
    });
  } catch {
    json(response, 503, { error: "sign-in-unavailable" });
    return;
  }

  if (!upstream.ok) {
    await logUpstreamRefusal(upstream);
    // BUG-UG-SIGNIN-AUTH-REFUSAL-SHOWN-AS-WRONG-PASSWORD-20261003:
    // Supabase Auth's own rate limit is not a credential failure. Without
    // client-IP forwarding every grant reaches Auth from this server's
    // address, so its per-address limit is shared by the whole site; showing
    // that as "check the email and password" told members with valid
    // passwords that they were wrong, and recorded them as failed sign-ins.
    // The 429 says nothing about the account, so passing it on is no oracle.
    if (upstream.status === 429) {
      json(response, 429, { error: "try-later" });
      return;
    }
    // BUG-UG-WEB-SIGNIN-OUTAGE-SHOWN-AS-WRONG-PASSWORD-20261018: an
    // upstream 5xx is NOT passed on as 503. The password-verification hook
    // runs only for an existing account,
    // so a hook failure surfaces as an Auth 5xx for a member and never for an
    // unknown address; a distinct reply would be an account oracle. The reply
    // stays the flat 401, and an outage is not recorded as a failed sign-in.
    // Only this route's own failures to reach Auth (a rejected or timed-out
    // fetch, a missing session in a 200) answer 503, which is the same for
    // every address.
    if (upstream.status >= 500) {
      json(response, 401, { error: "sign-in-failed" });
      return;
    }
    await recordFailure(backend, email, request, body?.client);
    json(response, 401, { error: "sign-in-failed" });
    return;
  }

  const payload = await upstream.json();
  if (!payload?.access_token || !payload?.refresh_token) {
    json(response, 503, { error: "sign-in-unavailable" });
    return;
  }
  if (attempt.reservation) {
    try {
      const refunded = await supabaseRpc(backend.url, backend.serviceRoleKey, backend.serviceRoleKey,
        "refund_password_signin_attempt", { p_reservation: attempt.reservation });
      if (typeof refunded !== "boolean") throw new Error("password-signin-refund-unexpected");
    } catch {
      // Auth already issued this session. An accounting outage must not
      // discard it or make a valid password appear wrong. Keep any unrefunded
      // reservation charged until its normal expiry; never clear other attempts.
      console.warn(JSON.stringify({ event: "password-signin-refund-unavailable" }));
    }
  }
  json(response, 200, {
    accessToken: payload.access_token,
    refreshToken: payload.refresh_token,
  });
}

function validEmail(email) {
  // Bound before scanning. The former domain regex could repeatedly divide
  // a dotted domain between overlapping quantifiers on a failing input.
  if (!email || email.length > 254 || /\s/.test(email)) return false;
  const at = email.indexOf("@");
  if (at < 1 || at !== email.lastIndexOf("@")) return false;
  // Preserve the existing grammar: at least one domain character on each
  // side of a dot (other dots are valid domain characters here).
  const dot = email.indexOf(".", at + 2);
  return dot !== -1 && dot < email.length - 1;
}

function safeParse(text) {
  try { return JSON.parse(text); } catch { return null; }
}

// Code can deploy ahead of the migration that creates the throttle RPC. Only
// PostgREST's "function not in the schema cache" answer is tolerated, and
// only by letting the attempt through to GoTrue (whose own limits still
// apply); every other throttle failure stops the attempt.
function rpcFunctionMissing(error) {
  return Number(error?.status) === 404 && String(error?.code ?? "") === "PGRST202";
}

async function reserveAttempt(backend, email, request) {
  let result;
  try {
    result = await supabaseRpc(backend.url, backend.serviceRoleKey, backend.serviceRoleKey,
      "reserve_password_signin_attempt", {
        p_email: email,
        p_network: requestNetworkBucket(request) || "unknown",
      });
  } catch (error) {
    if (!rpcFunctionMissing(error)) throw error;
    // Preserve the deployed limiter during a code-before-migration rollout.
    // Success refunds become active once the new reservation RPC is installed.
    return { allowed: await consumeAttempt(backend, email, request) };
  }
  if (result?.allowed === false) return { allowed: false };
  if (result?.allowed !== true || typeof result.reservation !== "string"
      || !/^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(result.reservation)) {
    throw new Error("password-signin-reservation-unexpected");
  }
  return result;
}

async function consumeAttempt(backend, email, request) {
  let result;
  try {
    result = await supabaseRpc(backend.url, backend.serviceRoleKey, backend.serviceRoleKey,
      "consume_password_signin_attempt", {
        p_email: email,
        // A request with no readable address shares one bucket rather than
        // escaping the network limit.
        p_network: requestNetworkBucket(request) || "unknown",
      });
  } catch (error) {
    if (!rpcFunctionMissing(error)) throw error;
    console.warn(JSON.stringify({
      event: "password-signin-throttle-unavailable",
      rpc: "consume_password_signin_attempt",
      migration: "20261002015000_survey_review_privacy_floor_and_signin_throttle",
      detail: "password sign-in ran without the durable throttle; apply the migration to the hosted database",
    }));
    return true;
  }
  if (typeof result !== "boolean") throw new Error("consume_password_signin_attempt-unexpected");
  return result;
}

// GoTrue rate-limits by the caller's address, which for this proxy is the
// server's. Supabase Auth honors an `Sb-Forwarded-For` end-user address only
// on requests made with a secret API key and only when the project has IP
// address forwarding switched on in its rate-limit settings. That switch is
// an operator activation, so forwarding stays off until
// SUPABASE_AUTH_FORWARD_CLIENT_IP (production) or
// SAMPLE_SUPABASE_AUTH_FORWARD_CLIENT_IP (SAMPLE) is "1"; until then the grant
// keeps using the publishable key with no forwarded address.
export function grantHeaders(backend, request) {
  const flag = backend.surface === "demo"
    ? process.env.SAMPLE_SUPABASE_AUTH_FORWARD_CLIENT_IP
    : process.env.SUPABASE_AUTH_FORWARD_CLIENT_IP;
  const clientAddress = requestClientAddress(request);
  const extra = { "Content-Type": "application/json", "User-Agent": sessionUserAgent(request) };
  if (String(flag || "").trim() === "1" && clientAddress && String(backend.serviceRoleKey).startsWith("sb_secret_")) {
    return supabaseHeaders(backend.serviceRoleKey, backend.serviceRoleKey, { ...extra, "Sb-Forwarded-For": clientAddress });
  }
  return supabaseHeaders(backend.publishableKey, backend.publishableKey, extra);
}

// Auth uses this to name signed-in devices. Preserve only coarse labels, not
// the original fingerprint, browser version, IP address, or user-supplied name.
export function sessionUserAgent(request) {
  const agent = String(request.headers?.["user-agent"] || "").slice(0, 512);
  const device = /iphone|ipad|ipod/i.test(agent) ? "iPhone"
    : /android/i.test(agent) ? "Android"
      : /windows/i.test(agent) ? "Windows"
        : /macintosh|mac os/i.test(agent) ? "Macintosh"
          : /linux/i.test(agent) ? "Linux" : "Unknown";
  const browser = /edg\//i.test(agent) ? "Edg/0"
    : /firefox\/|fxios\//i.test(agent) ? "Firefox/0"
      : /chrome\/|crios\//i.test(agent) ? "Chrome/0"
        : /safari\//i.test(agent) ? "Safari/0" : "Browser";
  return `UnionGround (${device}) ${browser}`;
}

// Status and Auth error code of a refused grant, for the operator log only:
// never the email, the password or the response body.
async function logUpstreamRefusal(upstream) {
  let code = null;
  try {
    const payload = JSON.parse(await upstream.text());
    const candidate = payload?.error_code ?? payload?.code ?? payload?.error;
    if (typeof candidate === "string" && /^[a-z0-9_.-]{1,64}$/i.test(candidate)) code = candidate;
  } catch { /* the status alone is still useful */ }
  console.warn(JSON.stringify({ event: "password-signin-upstream-refused", status: upstream.status, code }));
}

// Only a label for the admin inbox: a caller that misnames its platform
// changes which source column the row shows, nothing else.
const NATIVE_SOURCES = { ios: "native-ios", android: "native-android" };

async function recordFailure(backend, email, request, client) {
  const source = (typeof client === "string" && Object.hasOwn(NATIVE_SOURCES, client))
    ? NATIVE_SOURCES[client]
    : backend.surface === "demo" ? "web-sample" : "web-saas";
  const userAgent = String(request.headers?.["user-agent"] || "Unknown web client").slice(0, 160);
  try {
    await supabaseRpc(backend.url, backend.serviceRoleKey, backend.serviceRoleKey,
      "record_failed_login_attempt", {
        p_email: email,
        p_method: "password",
        p_source: source,
        p_user_agent: userAgent,
      });
  } catch { /* auth result must not depend on telemetry availability */ }
}
