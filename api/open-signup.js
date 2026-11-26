import { accountEmailDomainBlocked, EMAIL_DOMAIN_BLOCKED } from "./_lib/accountEmailDomains.js";
import { recordAccountMailFailure } from "./_lib/accountMailAlerts.js";
import { resolveSupabaseBackend } from "./_lib/backend.js";
import { json, methodGuard, requestHostname, supabaseRpc, validateMutationOrigin } from "./_lib/http.js";
import { publishVerifiedServerTermsReceipt } from "./_lib/legalReleaseGate.js";
import { requestNetworkBucket } from "./_lib/networkAddress.js";
import {
  emailDigest, mintSignupToken, normalizeEmail, openSignupConfig, openSignupSwitchOpen, parseBody,
  resendIdempotencyKey, scopeHash, sendConfirmationEmail, signupLink, turnstileVerdict,
} from "./_lib/openSignup.js";
import { isSaasHost } from "../src/lib/demoOrigin.js";
import { isResidenceRegion } from "../src/lib/residenceRegions.js";
import { displayedTermsVersion } from "../src/lib/signupTermsReceipt.js";

// POST { email, locale, turnstileToken, acceptedTerms, residenceState, ageAttested, website }
// GET answers { open } for the browser, only while the owner's switch is on.
//
// While the switch is off (the default) every request gets the same 404 a
// missing route gets, before any other check.
//
// Past the request-shape checks every outcome is the same 200 {accepted:true}:
// a bot, a limit, an existing account or pending invitation and a failed send
// are indistinguishable from success, so this route is never an account
// oracle. Only the success path sends one email. A failed send and an
// unavailable Turnstile check are recorded privately (accountMailAlerts.js)
// without changing that answer or its timing.
function secureJson(response, status, payload) {
  response.setHeader("Referrer-Policy", "no-referrer");
  return json(response, status, payload);
}

class Unavailable extends Error {}

async function serviceRpc(config, name, body) {
  try {
    return await supabaseRpc(config.supabaseUrl, config.serviceKey, config.serviceKey, name, body);
  } catch {
    // A missing function (the signup database half not applied yet) or an
    // unreachable backend: fail closed with the unavailable answer. The
    // failure never depends on the submitted address.
    throw new Unavailable();
  }
}

async function consume(config, scope, operation) {
  return (await serviceRpc(config, "consume_open_signup_limit", {
    p_scope_hash: scope,
    p_operation: operation,
  })) === true;
}

// Every answer after Turnstile passes (limited, existing account or pending
// invitation, sent, unavailable) is held to at least this long from the start
// of the request, so the fast "nothing to send" branches are not
// distinguishable by time from the send branch. A send slower than the floor
// remains a residual. Tests replace `sleep`/`now` so they never wait.
export const signupTiming = {
  floorMs: 1500,
  now: () => Date.now(),
  sleep: (ms) => new Promise((resolve) => { setTimeout(resolve, ms); }),
};

// Runs the post-Turnstile work and returns the answer to send.
async function afterTurnstile(config, body, email, bucket) {
  const accepted = [200, { accepted: true }];
  if (!bucket) return accepted;
  const published = await publishVerifiedServerTermsReceipt(config, () => displayedTermsVersion());
  if (!published.ran) return [503, { error: "signup-unavailable" }];
  try {
    const intake = await serviceRpc(config, "open_signup_intake_status", {});
    if (intake?.open !== true) return accepted;
    const network = scopeHash(config.keys, "network", bucket);
    if (!await consume(config, network, "network-hour")) return accepted;
    if (!await consume(config, network, "network-day")) return accepted;
    if (!await consume(config, scopeHash(config.keys, "email", email), "email-day")) return accepted;
    const available = await serviceRpc(config, "open_signup_email_available", { p_email_hash: emailDigest(email) });
    if (available !== true) return accepted;
  } catch (error) {
    if (error instanceof Unavailable) return [503, { error: "signup-unavailable" }];
    throw error;
  }

  const locale = body.locale === "es" ? "es" : "en";
  const token = mintSignupToken(config.keys, {
    email, locale, termsVersion: published.result, residenceState: body.residenceState,
  });
  const sent = await sendConfirmationEmail({
    resendKey: config.resendKey,
    from: config.notifyFrom,
    to: email,
    locale,
    link: signupLink(config.appOrigin, token),
    idempotencyKey: resendIdempotencyKey(config.keys, email),
  });
  if (!sent) recordAccountMailFailure("signup_confirmation_send_failed");
  return accepted;
}

export default async function handler(request, response) {
  if (!validateMutationOrigin(request)) return json(response, 403, { error: "not-permitted" });
  const backend = resolveSupabaseBackend(request);
  if (!await openSignupSwitchOpen(request, backend, supabaseRpc)) return secureJson(response, 404, { error: "not-found" });
  if (request.method === "GET") {
    response.setHeader("Cache-Control", "no-store");
    // This also keeps confirmed founders in first-run setup. Capacity only
    // denies new confirmations; their reserved place is consumed by the RPC.
    return secureJson(response, 200, { open: Boolean(openSignupConfig(backend)) });
  }
  if (methodGuard(request, ["POST"], () => secureJson(response, 405, { error: "method-not-allowed" }))) return;
  const startedAt = signupTiming.now();

  // Previews, the demo host and SAMPLE never reach an Auth project from here.
  if (!isSaasHost(requestHostname(request)) || backend.surface !== "saas") {
    return secureJson(response, 503, { error: "signup-unavailable" });
  }
  const config = openSignupConfig(backend);
  if (!config) return secureJson(response, 503, { error: "signup-unavailable" });

  const body = parseBody(request.body);
  // An account is created only behind the
  // terms, a listed state and the age attestation that state selects.
  if (!body || body.acceptedTerms !== true || !isResidenceRegion(body.residenceState)
      || body.ageAttested !== true) {
    return secureJson(response, 400, { error: "invalid-request" });
  }
  const accepted = () => secureJson(response, 200, { accepted: true });

  if (String(body.website ?? "").trim()) return accepted();
  const email = normalizeEmail(body.email);
  if (!email) return accepted();
  // A government or employer address is refused openly: the answer depends
  // only on the address's domain, never on whether an account exists.
  if (accountEmailDomainBlocked(email)) return secureJson(response, 400, { error: EMAIL_DOMAIN_BLOCKED });
  // Turnstile first: a bot without a valid token cannot spend a real
  // person's network or email budget.
  const remoteIp = String(request.headers?.["x-vercel-forwarded-for"] || "").split(",")[0].trim();
  const verdict = await turnstileVerdict(config.turnstileSecret, body.turnstileToken, remoteIp);
  if (verdict !== "pass") {
    if (verdict === "unavailable") recordAccountMailFailure("signup_turnstile_unavailable");
    return accepted();
  }

  const [status, payload] = await afterTurnstile(config, body, email, requestNetworkBucket(request));
  const remaining = signupTiming.floorMs - (signupTiming.now() - startedAt);
  if (remaining > 0) await signupTiming.sleep(remaining);
  return secureJson(response, status, payload);
}
