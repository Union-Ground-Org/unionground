import { resolveSupabaseBackend } from "./_lib/backend.js";
import { json, methodGuard, requireEnv, supabaseRpc } from "./_lib/http.js";
import { acceptanceScope, digest, INVITATION_TOKEN, invitationRuntimeConfig } from "./_lib/memberInvitations.js";

// REQ-UG-INVITE-TERMS-AGE-STATE-FORM-CLARITY-20261030: the invitation
// page names the organization, chapter, role, inviter and sign-in address
// before the person accepts. The emailed token is the only authority, as on
// /api/accept-invitation: the same origin binding, a network rate limit spent
// before the caller learns anything (in a bucket separate from acceptance, so
// reading never uses up an acceptance), and one answer for every token that
// is not a pending invitation. Nothing is claimed or changed.

const ROLES = new Set(["steward", "coordinator", "advisor", "admin", "vp"]);

function secureJson(response, status, payload) {
  response.setHeader("Referrer-Policy", "no-referrer");
  response.setHeader("Cache-Control", "no-store");
  return json(response, status, payload);
}

function safeParse(value) {
  if (typeof value === "object" && value !== null) return value;
  try { return JSON.parse(value); } catch { return null; }
}

// Display text only: bounded, no control characters, and (except for the
// address itself) never something that reads as an email address.
function displayText(value, { allowAt = false, max = 160 } = {}) {
  if (typeof value !== "string") return null;
  const text = value.trim();
  if (!text || text.length > max) return null;
  if ([...text].some((character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127)) return null;
  if (!allowAt && text.includes("@")) return null;
  return text;
}

export function invitationPreviewBody(preview) {
  const email = displayText(preview?.email, { allowAt: true, max: 254 });
  const organization = displayText(preview?.organizationName, { allowAt: true });
  if (preview?.available !== true || !email || !organization) return null;
  return {
    organization,
    chapter: displayText(preview.chapterName, { allowAt: true }),
    role: ROLES.has(preview.role) ? preview.role : "member",
    email,
    inviter: displayText(preview.inviterName),
  };
}

export default async function handler(request, response) {
  if (methodGuard(request, ["POST"], () => secureJson(response, 405, { error: "method-not-allowed" }))) return;

  const backend = resolveSupabaseBackend(request);
  const config = invitationRuntimeConfig(request, backend);
  if (!config) return secureJson(response, 404, { error: "not-available" });
  if (requireEnv([config.supabaseUrl, config.serviceKey, config.appOrigin, config.rateKey],
    () => secureJson(response, 503, { error: "not-configured" }))) return;
  if (config.rateKey.length < 32) return secureJson(response, 503, { error: "not-configured" });
  if (String(request.url || "").includes("?")) return secureJson(response, 400, { error: "invalid-request" });
  if (String(request.headers?.origin || "") !== config.appOrigin) return secureJson(response, 403, { error: "not-permitted" });
  try {
    if (new URL(config.appOrigin).origin !== config.appOrigin
        || new URL(config.supabaseUrl).origin !== config.supabaseUrl) throw new Error("bad-origin");
  } catch {
    return secureJson(response, 503, { error: "not-configured" });
  }

  const acceptScope = acceptanceScope(request, config.rateKey);
  if (!acceptScope) return secureJson(response, 400, { error: "invalid-request" });
  const scopeHash = digest(`member-invitation-preview-v1:${acceptScope}`);
  const parsedBody = typeof request.body === "string" && request.body.length > 4096 ? null : safeParse(request.body);
  const token = typeof parsedBody?.token === "string" ? parsedBody.token : "";
  const tokenHash = INVITATION_TOKEN.test(token) ? digest(token) : null;
  const rpc = (name, body) => supabaseRpc(config.supabaseUrl, config.serviceKey, config.serviceKey, name, body);

  let limit;
  try {
    limit = await rpc("consume_member_invitation_accept_limit_for_token", { p_scope_hash: scopeHash, p_token_hash: tokenHash });
  } catch {
    return secureJson(response, 503, { error: "preview-unavailable" });
  }
  if (!limit?.allowed) return secureJson(response, 429, { error: "try-later" });
  if (!tokenHash) return secureJson(response, 410, { error: "invitation-unavailable" });

  let preview;
  try {
    preview = await rpc("preview_member_invitation", { p_token_hash: tokenHash });
  } catch {
    return secureJson(response, 503, { error: "preview-unavailable" });
  }
  const body = invitationPreviewBody(preview);
  if (!body) return secureJson(response, 410, { error: "invitation-unavailable" });
  return secureJson(response, 200, body);
}
