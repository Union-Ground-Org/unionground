import { resolveSupabaseBackend } from "./_lib/backend.js";
import {
  authenticateCaller,
  bearerToken,
  json,
  methodGuard,
  requireEnv,
  supabaseRpc,
  validateMutationOrigin,
} from "./_lib/http.js";

const CHAPTER = /^[a-z0-9][a-z0-9-]{0,63}$/;
const UNION_ORG = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const CAPABILITIES = new Set(["sms", "calendar_google", "calendar_microsoft", "cba", "notion", "enterprise"]);
const CONNECTION_STATUSES = new Set(["active", "error", "disabled"]);
const USER_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function bodyOf(value) {
  if (value && typeof value === "object") return value;
  try { return JSON.parse(value); } catch { return null; }
}

function boundedText(value, max) {
  const text = String(value || "").trim();
  return text.length <= max ? text : null;
}

// PostgREST reports a refusal from the scope oracle as a 4xx carrying the
// database's own verdict. Everything else is the oracle failing to answer at
// all: no status (a transport failure or the 8s timeout), a 5xx, or a 408/429
// the gateway produced before any policy ran. An unanswered oracle is not
// evidence that this caller lacks the scope, so it must not read as a refusal.
function oracleRefused(error) {
  const status = Number(error?.status || 0);
  return status >= 400 && status < 500 && status !== 408 && status !== 429;
}

async function organizationAdminScope(backend, token) {
  const scope = await supabaseRpc(
    backend.url,
    backend.publishableKey,
    token,
    "get_admin_org_structure",
  );
  if (scope?.scope !== "organization" || !Array.isArray(scope.chapters)) return null;
  return new Set(scope.chapters.flatMap((chapter) => (
    typeof chapter?.id === "string" ? [chapter.id] : []
  )));
}

// Whether a chapter is really a union office is not something its own
// organization can vouch for, so only a platform operator decides a binding
// (SEC-UG-TENANT-SELF-VERIFIED-UNION-OFFICE-BINDINGS-20261101).
// get_compass_platform_ai is member-callable and its canManage is
// private.compass_platform_operator(): an active registry row on an MFA
// session. verify_chapter_union_org_binding checks the registry again for the
// forwarded verifier.
async function platformOperator(backend, token) {
  const platform = await supabaseRpc(
    backend.url,
    backend.publishableKey,
    token,
    "get_compass_platform_ai",
  );
  return platform?.canManage === true;
}

export default async function handler(request, response) {
  if (!validateMutationOrigin(request)) return json(response, 403, { error: "untrusted-origin" });
  if (methodGuard(request, ["POST"], () => json(response, 405, { error: "method-not-allowed" }))) return;

  const backend = resolveSupabaseBackend(request);
  if (requireEnv([backend.url, backend.publishableKey, backend.serviceRoleKey],
    () => json(response, 503, { error: "not-configured" }))) return;
  const token = bearerToken(request);
  if (!token) return json(response, 401, { error: "unauthenticated" });

  const body = bodyOf(request.body);
  const chapterId = String(body?.chapterId || "").trim();
  if (!CHAPTER.test(chapterId)) return json(response, 400, { error: "invalid-request" });

  // The service role is a machine credential. It may only carry a named
  // reviewer's decision, so the reviewer is resolved from their own token
  // before any authorization work and forwarded to the RPC, which refuses a
  // null verifier. Without this the strongest decision in the flow would land
  // with `verified_by = null` and no audit row naming anyone.
  //
  // An Auth gateway that never answered has not rejected anybody: a transport
  // failure, a timeout or a 5xx is an outage, and answering 401 for it leaves
  // an operator unable to tell an expired session from an unavailable
  // dependency. Only a gateway that actually refused the token, or one that
  // resolved a caller with no usable user id, is 401 here.
  const caller = await authenticateCaller(backend.url, backend.publishableKey, token);
  if (caller.outcome === "unavailable") return json(response, 503, { error: "verification-unavailable" });
  const verifiedBy = typeof caller.user?.id === "string" ? caller.user.id.trim() : "";
  if (!USER_ID.test(verifiedBy)) return json(response, 401, { error: "unauthenticated" });

  let permitted;
  try {
    permitted = body?.action === "verify-binding"
      ? await platformOperator(backend, token)
      : (await organizationAdminScope(backend, token))?.has(chapterId) === true;
  } catch (error) {
    if (!oracleRefused(error)) return json(response, 503, { error: "verification-unavailable" });
    return json(response, 403, { error: "not-permitted" });
  }
  if (!permitted) return json(response, 403, { error: "not-permitted" });

  let rpc;
  let args;
  if (body?.action === "verify-binding") {
    const unionOrgId = String(body?.unionOrgId || "").trim();
    const publicNote = boundedText(body?.publicNote, 500);
    if (!UNION_ORG.test(unionOrgId) || publicNote === null || typeof body?.verified !== "boolean") {
      return json(response, 400, { error: "invalid-request" });
    }
    rpc = "verify_chapter_union_org_binding";
    args = {
      p_chapter_id: chapterId,
      p_union_org_id: unionOrgId,
      p_verified: body.verified,
      p_public_note: publicNote,
      p_verified_by: verifiedBy,
    };
  } else if (body?.action === "verify-connection") {
    const capability = String(body?.capability || "");
    const status = String(body?.status || "");
    const publicMessage = boundedText(body?.publicMessage, 500);
    if (!CAPABILITIES.has(capability) || !CONNECTION_STATUSES.has(status) || publicMessage === null) {
      return json(response, 400, { error: "invalid-request" });
    }
    rpc = "verify_chapter_connection_setup";
    args = {
      p_chapter_id: chapterId,
      p_capability: capability,
      p_status: status,
      p_public_message: publicMessage,
      p_verified_by: verifiedBy,
    };
  } else {
    return json(response, 400, { error: "invalid-request" });
  }

  try {
    const result = await supabaseRpc(
      backend.url,
      backend.serviceRoleKey,
      backend.serviceRoleKey,
      rpc,
      args,
    );
    return json(response, 200, { accepted: true, result });
  } catch (error) {
    const status = Number(error?.status || 0);
    // The database refusing the forwarded reviewer (an operator revoked since
    // the check above) is a refusal, not an outage.
    if (status === 401 || status === 403) return json(response, 403, { error: "not-permitted" });
    return json(response, status === 400 || status === 422 ? 409 : 503, {
      error: status === 400 || status === 422 ? "request-changed" : "verification-unavailable",
    });
  }
}
