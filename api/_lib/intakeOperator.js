import { resolveSupabaseBackend } from "./backend.js";
import { authenticateCaller, bearerToken } from "./http.js";
import { UUID, parseBody, tokenClaims } from "./serviceRpc.js";

// The platform operator's front door, shared by api/intake-review.js and
// api/intake-topic-send.js (REQ-UG-INTAKE-QUEUE-STORE-INVITE-REQUESTS-AND-OPERATOR-READ-20261118,
// REQ-UG-INTAKE-QUEUE-EMAIL-THE-OPT-IN-LIST-20261118). The bearer
// token is validated by GoTrue, the session must be aal2 on an account with a
// verified factor (or a server-issued UV key), and only then does the caller
// get the operator's id and session id for one service-only RPC. The database
// still decides whether this is an intake_review operator on a live session.

function exactOrigin(value) {
  try {
    const url = new URL(value);
    return url.origin === value ? value : null;
  } catch { // swallow-ok: an unparseable origin is no origin, and the caller refuses it
    return null;
  }
}

/**
 * Either { refusal: { status, body } } or { config, backend, body, operatorId, sessionId }.
 * Production only: the SAMPLE demo has no Union Ground leads to work.
 */
export async function intakeOperatorRequest(request, unavailable) {
  const backend = resolveSupabaseBackend(request);
  if (backend.surface === "demo") return { refusal: { status: 404, body: { error: "not-available" } } };
  const config = {
    supabaseUrl: backend?.url || "",
    publishableKey: backend?.publishableKey || "",
    serviceKey: backend?.serviceRoleKey || "",
  };
  if (!Object.values(config).every(Boolean) || !exactOrigin(config.supabaseUrl)) {
    return { refusal: { status: 503, body: { error: unavailable } } };
  }

  const token = bearerToken(request);
  if (!token) return { refusal: { status: 401, body: { error: "unauthenticated" } } };
  const body = parseBody(request.body);
  if (!body) return { refusal: { status: 400, body: { error: "invalid-request" } } };

  const caller = await authenticateCaller(config.supabaseUrl, config.publishableKey, token);
  if (caller.outcome === "unavailable") return { refusal: { status: 503, body: { error: unavailable } } };
  const operatorId = typeof caller.user?.id === "string" ? caller.user.id.trim() : "";
  if (!UUID.test(operatorId)) return { refusal: { status: 401, body: { error: "unauthenticated" } } };

  // GoTrue accepted this token, so its payload is the session's own.
  const claims = tokenClaims(token);
  const sessionId = typeof claims?.session_id === "string" && UUID.test(claims.session_id) ? claims.session_id : null;
  const factors = Array.isArray(caller.user.factors) ? caller.user.factors : [];
  if (!sessionId || claims?.aal !== "aal2" || (!factors.some((factor) => factor?.status === "verified") && claims?.ug_key_uv !== true)) {
    return { refusal: { status: 403, body: { error: "mfa-required" } } };
  }
  return { config, backend, body, operatorId, sessionId };
}
