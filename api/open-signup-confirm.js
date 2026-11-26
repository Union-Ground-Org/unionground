import { accountEmailDomainBlocked, EMAIL_DOMAIN_BLOCKED } from "./_lib/accountEmailDomains.js";
import { resolveSupabaseBackend } from "./_lib/backend.js";
import { json, methodGuard, requestHostname, supabaseRpc, validateMutationOrigin } from "./_lib/http.js";
import { publishVerifiedServerTermsReceipt } from "./_lib/legalReleaseGate.js";
import { authAdminHeaders } from "./_lib/memberInvitations.js";
import { requestNetworkBucket } from "./_lib/networkAddress.js";
import {
  emailDigest, openSignupConfig, openSignupSwitchOpen, parseBody, PASSWORD_MAX, PASSWORD_MIN, readSignupToken, scopeHash,
} from "./_lib/openSignup.js";
import { isSaasHost } from "../src/lib/demoOrigin.js";
import { signupTermsReceipt } from "../src/lib/signupTermsReceipt.js";

// POST { token, password, locale }
//
// While the owner's switch is off (the default) every request gets the same
// 404 a missing route gets, before any other check.
//
// Creates the account only after the emailed link proves the mailbox. The
// admin create call carries `user_metadata: {}` so nothing a browser sends can
// reach private.handle_new_member; the accepted terms version and time go to
// app_metadata, which only the service role can write, with the state the
// person said they live in, the age attestation that state selected ("adult"
// for 18 or older, "band" for the D-03 B band) and when they gave it. The
// browser then signs in through the existing /api/auth-password-signin.
function secureJson(response, status, payload) {
  response.setHeader("Referrer-Policy", "no-referrer");
  return json(response, status, payload);
}

async function createAccount(config, email, password, link) {
  const published = await publishVerifiedServerTermsReceipt(config, () => signupTermsReceipt(link.termsVersion));
  if (!published.ran) return "unavailable";
  let upstream;
  try {
    upstream = await fetch(`${config.supabaseUrl}/auth/v1/admin/users`, {
      method: "POST",
      headers: authAdminHeaders(config.serviceKey),
      body: JSON.stringify({
        email,
        password,
        email_confirm: true,
        user_metadata: {},
        app_metadata: {
          union_ground_provisioning: "active",
          union_ground_signup: "self_serve",
          union_ground_terms_version: published.result,
          union_ground_terms_accepted_at: new Date().toISOString(),
          union_ground_residence_state: link.residenceState,
          union_ground_age_attestation: link.ageRule,
          union_ground_age_attested_at: link.ageAttestedAt,
        },
      }),
      signal: AbortSignal.timeout(8000),
    });
  } catch {
    return "unavailable";
  }
  if (upstream.ok) return "created";
  const detail = await upstream.json().catch(() => ({}));
  const code = String(detail?.error_code || detail?.code || "");
  const message = String(detail?.msg || detail?.message || detail?.error_description || "");
  if (upstream.status === 422 && (/email_exists|user_already_exists/.test(code) || /already (been )?registered/i.test(message))) {
    return "exists";
  }
  if (code === "weak_password" || /password/i.test(message)) return "password";
  return "unavailable";
}

export default async function handler(request, response) {
  if (!validateMutationOrigin(request)) return json(response, 403, { error: "not-permitted" });
  const backend = resolveSupabaseBackend(request);
  if (!await openSignupSwitchOpen(request, backend, supabaseRpc)) return secureJson(response, 404, { error: "not-found" });
  if (methodGuard(request, ["POST"], () => secureJson(response, 405, { error: "method-not-allowed" }))) return;

  if (!isSaasHost(requestHostname(request)) || backend.surface !== "saas") {
    return secureJson(response, 503, { error: "signup-unavailable" });
  }
  const config = openSignupConfig(backend);
  if (!config) return secureJson(response, 503, { error: "signup-unavailable" });

  const body = parseBody(request.body);
  const bucket = requestNetworkBucket(request);
  if (!body || !bucket) return secureJson(response, 400, { error: "invalid-request" });

  const rpc = (name, args) => supabaseRpc(config.supabaseUrl, config.serviceKey, config.serviceKey, name, args);
  try {
    const allowed = await rpc("consume_open_signup_limit", {
      p_scope_hash: scopeHash(config.keys, "network", bucket),
      p_operation: "confirm-network-hour",
    });
    if (allowed !== true) return secureJson(response, 429, { error: "rate-limited" });
  } catch {
    return secureJson(response, 503, { error: "signup-unavailable" });
  }

  const link = readSignupToken(config.keys, body.token);
  if (!link) return secureJson(response, 400, { error: "link-invalid" });
  // A link minted before the address's domain was blocked creates nothing.
  if (accountEmailDomainBlocked(link.email)) return secureJson(response, 400, { error: EMAIL_DOMAIN_BLOCKED });
  const password = typeof body.password === "string" ? body.password : "";
  if (password.length < PASSWORD_MIN || password.length > PASSWORD_MAX) {
    return secureJson(response, 400, { error: "password-rejected" });
  }

  try {
    const available = await rpc("open_signup_email_available", { p_email_hash: emailDigest(link.email) });
    // An account (or a pending invitation) for this address already exists:
    // the link has done its one job.
    if (available !== true) return secureJson(response, 400, { error: "link-invalid" });
  } catch {
    return secureJson(response, 503, { error: "signup-unavailable" });
  }

  try {
    const intake = await rpc("open_signup_intake_status", {});
    if (intake?.open !== true) return secureJson(response, 503, { error: "signup-unavailable" });
  } catch {
    return secureJson(response, 503, { error: "signup-unavailable" });
  }

  const outcome = await createAccount(config, link.email, password, link);
  if (outcome === "exists") return secureJson(response, 400, { error: "link-invalid" });
  if (outcome === "password") return secureJson(response, 400, { error: "password-rejected" });
  if (outcome !== "created") return secureJson(response, 503, { error: "signup-unavailable" });
  return secureJson(response, 200, { accepted: true, email: link.email });
}
