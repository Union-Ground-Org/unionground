import { resolveSupabaseBackend } from "./_lib/backend.js";
import { json, methodGuard, supabaseHeaders } from "./_lib/http.js";
import { authAdminHeaders } from "./_lib/memberInvitations.js";
import { totp } from "./_lib/totp.js";
import { isSamplePersonaEmail, samplePersonaForHat } from "../src/lib/sampleBackend.js";

// Credentials-free entry for the SAMPLE origin
// (UB-UG-DEMO-STRAIGHT-IN-ENTRY-RESTORED-20261107, owner ruling
// an owner decision): sign a visitor in as one of the fictional
// Tamarack Valley persona accounts the bot seed keeps on SAMPLE, exactly as
// the pre-bot entry did before the Oct 18 retirement (#4696), which was meant
// for the pre-bot seed and not for this entry.
//
// The session is made by the production auth machinery, server-side:
//   1. the SAMPLE service role mints a single-use magic-link token for the
//      hat's persona (GoTrue admin generate_link);
//   2. the token is verified at once (GoTrue /verify), so it never leaves
//      this handler;
//   3. a staff persona then answers its own TOTP challenge. Tamarack requires
//      two-step sign-in for staff and the bots enrolled each staff account's
//      authenticator; an aal1 staff session would stop at the code screen and
//      every staff desk would refuse it. The authenticator secrets live only
//      in SAMPLE_DEMO_PERSONA_AUTHENTICATORS, a server environment variable.
// The browser receives the resulting session and adopts it with setSession.
//
// Boundaries:
//   * Demo surface only. The SaaS host resolves the production backend and
//     is refused with 404 before any key is read — a SaaS host can never
//     mint a persona session.
//   * The persona list is the server-side allowlist: one Tamarack account per
//     seeded hat (config/sample-backend.json). Arbitrary emails are not
//     reachable, and a persona outside the exact SAMPLE persona allowlist is
//     refused. The deployment pins a SAMPLE project separately.
//   * The SAMPLE service-role key mints the link against the SAMPLE project
//     alone; sampleBackendFromEnv already self-refuses every forbidden ref.
//   * The session must belong to the persona, and a staff persona's session
//     must be raised with the persona's own verified TOTP factor, or nothing
//     is returned. Never returned: the action link, the token hash, a key, an
//     authenticator secret, the persona's user row.

const AUTHENTICATORS_ENV = "SAMPLE_DEMO_PERSONA_AUTHENTICATORS";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const BASE32_SECRET = /^[A-Z2-7]{16,128}=*$/i;

function secureJson(response, status, payload) {
  response.setHeader("Referrer-Policy", "no-referrer");
  response.setHeader("Cache-Control", "no-store");
  return json(response, status, payload);
}

function safeParse(value) {
  if (typeof value === "object" && value !== null) return value;
  try { return JSON.parse(value); } catch { return null; }
}

// {"steward":{"factorId":"<uuid>","secret":"<base32>"}, ...} keyed by hat.
// Anything malformed counts as absent; the value is never echoed or logged.
function personaAuthenticator(env, hat) {
  const parsed = safeParse(String(env?.[AUTHENTICATORS_ENV] || ""));
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed) || !Object.hasOwn(parsed, hat)) return null;
  const entry = parsed[hat];
  const factorId = typeof entry?.factorId === "string" ? entry.factorId : "";
  const secret = typeof entry?.secret === "string" ? entry.secret : "";
  return UUID.test(factorId) && BASE32_SECRET.test(secret) ? { factorId, secret } : null;
}

function logIssuanceFailure(reason, status, startedAt) {
  // Fixed classifications and bounded numeric metadata only. In particular,
  // never forward an exception, upstream body, persona, request ID or token.
  try {
    console.warn(JSON.stringify({
      event: "sample_session_issuance_failed",
      reason,
      upstream_status: Number.isInteger(status) && status >= 100 && status <= 599 ? status : null,
      elapsed_ms: Math.min(60000, Math.max(0, Math.round(performance.now() - startedAt))),
    }));
  } catch {
    // A logging sink failure must not change the public fail-closed response.
  }
}

class IssuanceFailure extends Error {
  constructor(reason, status = null) {
    super(reason);
    this.reason = reason;
    this.status = status;
  }
}

function hasVerifiedTotp(user, factorId = null) {
  return Array.isArray(user?.factors) && user.factors.some((factor) => factor?.status === "verified"
    && factor?.factor_type === "totp" && (factorId === null || factor?.id === factorId));
}

export default async function handler(request, response, env = process.env) {
  if (methodGuard(request, ["POST"], () => secureJson(response, 405, { error: "method-not-allowed" }))) return;

  const backend = resolveSupabaseBackend(request, env);
  if (backend.surface !== "demo") return secureJson(response, 404, { error: "not-available" });
  if (!backend.url || !backend.serviceRoleKey || !backend.publishableKey) {
    return secureJson(response, 503, { error: "sample-backend-unconfigured" });
  }

  const body = safeParse(request.body) || {};
  const persona = samplePersonaForHat(typeof body.hat === "string" ? body.hat : "");
  if (!persona || !isSamplePersonaEmail(persona.email)) return secureJson(response, 400, { error: "unknown-hat" });

  const startedAt = performance.now();
  let signal;
  let lastStatus = null;
  // One GoTrue step: its HTTP failure is classified as `failure`, and its
  // body is read only after a 2xx answer.
  async function step(path, headers, payload, failure) {
    let readingBody = false;
    try {
      const answer = await fetch(`${backend.url}/auth/v1${path}`, payload === undefined
        ? { method: "GET", headers, signal }
        : {
          method: "POST",
          headers: { ...headers, "Content-Type": "application/json" },
          body: JSON.stringify(payload),
          signal,
        });
      lastStatus = answer.status;
      if (!answer.ok) throw new IssuanceFailure(failure, answer.status);
      readingBody = true;
      return await answer.json();
    } catch (error) {
      if (error instanceof IssuanceFailure) throw error;
      throw new IssuanceFailure(signal?.aborted ? "timeout"
        : readingBody && error instanceof SyntaxError ? "invalid_json" : "transport_error", lastStatus);
    }
  }

  let session;
  try {
    // One deadline for the whole sign-in, as the single mint had before.
    signal = AbortSignal.timeout(8000);
    // authAdminHeaders routes through supabaseHeaders: a modern sb_secret_
    // key rides in `apikey` alone with the pinned server User-Agent — never
    // as a bearer the gateway would refuse (REQ-UG-SUPABASE-SECRET-KEY-
    // 20260803 is the incident this shape exists to prevent).
    //
    // The persona must already exist. GoTrue turns a magic link for a missing
    // address into a signup and creates the account before answering, so an
    // absent persona (a seed not applied) is refused before any link is asked
    // for (gate r1s3/r2s3 on #7375).
    const listed = await step(`/admin/users?page=1&per_page=50&filter=${encodeURIComponent(persona.email)}`,
      authAdminHeaders(backend.serviceRoleKey), undefined, "upstream_http");
    const seeded = Array.isArray(listed?.users) && listed.users.some((user) =>
      String(user?.email || "").toLowerCase() === persona.email && !user?.deleted_at);
    if (!seeded) throw new IssuanceFailure("persona_missing", lastStatus);
    const link = await step("/admin/generate_link", authAdminHeaders(backend.serviceRoleKey),
      { type: "magiclink", email: persona.email }, "upstream_http");
    // GoTrue's wire response carries hashed_token at the top level; auth-js
    // proxies move it under properties. Accept either shape. A link GoTrue
    // issued as anything but a magic link (a signup for an account the seed
    // never made) is refused rather than used.
    const linkType = link?.verification_type ?? link?.properties?.verification_type;
    if (linkType !== undefined && linkType !== "magiclink") throw new IssuanceFailure("unexpected_link_type", lastStatus);
    const tokenHash = String(link?.hashed_token || link?.properties?.hashed_token || "");
    if (!tokenHash) throw new IssuanceFailure("missing_token", lastStatus);

    session = await step("/verify", supabaseHeaders(backend.publishableKey), { type: "email", token_hash: tokenHash }, "verify_http");
    if (typeof session?.access_token !== "string" || typeof session?.refresh_token !== "string"
      || String(session?.user?.email || "").toLowerCase() !== persona.email) {
      throw new IssuanceFailure("identity_mismatch", lastStatus);
    }

    const staff = persona.roles.length > 0 || hasVerifiedTotp(session.user);
    if (staff) {
      const authenticator = personaAuthenticator(env, persona.hat);
      if (!authenticator || !hasVerifiedTotp(session.user, authenticator.factorId)) {
        throw new IssuanceFailure("missing_authenticator", lastStatus);
      }
      const asUser = supabaseHeaders(backend.publishableKey, session.access_token);
      const challenge = await step(`/factors/${authenticator.factorId}/challenge`, asUser, {}, "mfa_http");
      if (typeof challenge?.id !== "string" || !challenge.id) throw new IssuanceFailure("mfa_http", lastStatus);
      session = await step(`/factors/${authenticator.factorId}/verify`, asUser,
        { challenge_id: challenge.id, code: totp(authenticator.secret) }, "mfa_http");
      if (typeof session?.access_token !== "string" || typeof session?.refresh_token !== "string") {
        throw new IssuanceFailure("mfa_http", lastStatus);
      }
    }
  } catch (error) {
    logIssuanceFailure(error instanceof IssuanceFailure ? error.reason : "transport_error",
      error instanceof IssuanceFailure ? error.status : null, startedAt);
    // The persona account is missing (seed not applied), its authenticator is
    // not configured, or GoTrue refused. Fail closed with a retryable answer;
    // never fall back to fixtures or to a lower assurance level here.
    return secureJson(response, 503, { error: "persona-unavailable" });
  }
  return secureJson(response, 200, { accessToken: session.access_token, refreshToken: session.refresh_token });
}
