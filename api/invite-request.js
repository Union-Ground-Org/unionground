import { resolveSupabaseBackend } from "./_lib/backend.js";
import { json, methodGuard, requireEnv, supabaseRpc } from "./_lib/http.js";
import { runVerifiedServerLegalOperation } from "./_lib/legalReleaseGate.js";
import {
  INVITE_REQUEST_STORE_PATH, inviteRequestFields, scheduleInviteRequestEmail, sendInviteRequestEmail,
} from "./_lib/inviteRequest.js";
import { publicInterestEmailScope, publicInterestScope } from "./_lib/publicInterest.js";
import { publicContact } from "../src/lib/publicContact.js";
import { requestNetworkBucket } from "./_lib/networkAddress.js";

function safeParse(value) {
  if (typeof value === "object" && value !== null && !Array.isArray(value)) return value;
  try {
    const parsed = JSON.parse(value);
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

class LimiterUnavailable extends Error {}

// One charge against the database limiter (20261125120200): 10 requests per
// network per hour, 3 per requester address per day. A missing function or an
// unreachable database fails closed, so the form never mails unthrottled.
async function consume(config, scope, key) {
  let allowed;
  try {
    allowed = await supabaseRpc(config.supabaseUrl, config.serviceKey, config.serviceKey,
      "consume_invite_request_attempt", { p_scope: scope, p_key: key });
  } catch {
    throw new LimiterUnavailable();
  }
  if (typeof allowed !== "boolean") throw new LimiterUnavailable();
  return allowed;
}

function reply(response, status, payload) {
  response.setHeader("Referrer-Policy", "no-referrer");
  return json(response, status, payload);
}

function exactOrigin(value) {
  try {
    return new URL(value).origin === value;
  } catch { // swallow-ok: an unparseable origin is no origin, and the caller refuses it
    return false;
  }
}

// The store runs only on the INVITE_REQUEST_STORE_PATH legal path, with the
// server key and the landing form's rate secret; otherwise the route keeps its
// email-only behaviour.

function storeConfig(backend) {
  const config = {
    supabaseUrl: backend?.url || "",
    serviceKey: backend?.serviceRoleKey || "",
    rateKey: String(process.env.PUBLIC_INTEREST_RATE_LIMIT_SECRET || ""),
  };
  if (!config.supabaseUrl || !config.serviceKey || config.rateKey.length < 32 || !exactOrigin(config.supabaseUrl)) return null;
  return config;
}

// POST /api/invite-request — a person without an invitation asks the Union
// Ground team for one. The request is stored for the platform operator's
// intake queue by the service-only public.submit_invite_request (the landing
// form's limits and suppression check; a confirmed stop deletes it), then
// emailed to the support mailbox with the requester as Reply-To. Nothing is
// sent to the requester's address. The browser gets the same accepted answer
// whether or not a row was stored. Until the privacy release that discloses
// the store is live, or when the database cannot take the request, the email
// alone carries it, as before November 18, 2026.
// Union Ground publishes no support mailbox yet (src/lib/publicContact.js), so
// the route answers request-unavailable until one exists. Every request that
// would send is charged against a per-network and a per-address limit first.
export default async function handler(request, response) {
  if (methodGuard(request, ["POST"], () => reply(response, 405, { error: "method-not-allowed" }))) return;

  // Production-only, like the public-interest form: the SAMPLE demo origin
  // never stores or sends real requests.
  const backend = resolveSupabaseBackend(request);
  if (backend.surface === "demo") return reply(response, 404, { error: "not-available" });
  const support = publicContact("support");
  if (!support) return reply(response, 503, { error: "request-unavailable" });
  const config = {
    appOrigin: String(process.env.PUBLIC_SITE_APP_ORIGIN || "").replace(/\/$/, ""),
    resendKey: process.env.RESEND_API_KEY,
    from: process.env.NOTIFY_FROM_ADDRESS,
    supabaseUrl: backend.url,
    serviceKey: backend.serviceRoleKey,
  };
  if (requireEnv(Object.values(config), () => reply(response, 503, { error: "request-unavailable" }))) return;
  if (!exactOrigin(config.appOrigin)) return reply(response, 503, { error: "request-unavailable" });
  if (String(request.url || "").includes("?")) return reply(response, 400, { error: "invalid-request" });
  if (String(request.headers?.origin || "") !== config.appOrigin) return reply(response, 403, { error: "not-permitted" });

  const body = safeParse(request.body);
  // Honeypot: a filled hidden field gets the ordinary answer and sends nothing.
  if (body && String(body.website || "").trim()) return reply(response, 202, { accepted: true });
  const fields = body && inviteRequestFields(body);
  if (!fields) return reply(response, 400, { error: "invalid-request" });
  const mail = { resendKey: config.resendKey, from: config.from, to: support.email, request: fields };

  const store = storeConfig(backend);
  const scopeHash = store && publicInterestScope(request, store.rateKey);
  if (store && scopeHash) {
    let result = null;
    try {
      const gate = await runVerifiedServerLegalOperation(store, INVITE_REQUEST_STORE_PATH, () => supabaseRpc(store.supabaseUrl, store.serviceKey, store.serviceKey, "submit_invite_request", {
        p_email: fields.email,
        p_name: fields.name,
        p_organization_name: fields.organization,
        p_note: fields.note,
        p_locale: fields.locale,
        p_website: "",
        p_scope_hash: scopeHash,
        p_email_scope_hash: publicInterestEmailScope(fields.email, "request_invite", store.rateKey),
      }));
      if (gate.ran) result = await gate.result;
    } catch { /* swallow-ok: the email below carries the request */ }
    if (result?.accepted === true) {
      // notify is false once the address has had three support emails today;
      // the correction itself is already stored and shows in the queue.
      if (result.stored === true && result.notify === true) scheduleInviteRequestEmail(mail);
      return reply(response, 202, { accepted: true });
    }
  }

  try {
    // The network bucket first: a network already over its budget does not
    // also charge the address it names.
    if (!await consume(config, "network", requestNetworkBucket(request) || "unknown")) {
      return reply(response, 429, { error: "try-later" });
    }
    if (!await consume(config, "email", fields.email)) return reply(response, 429, { error: "try-later" });
  } catch {
    return reply(response, 503, { error: "request-unavailable" });
  }

  let sent = false;
  try {
    sent = await sendInviteRequestEmail(mail);
  } catch { /* answered below */ }
  if (!sent) return reply(response, 502, { error: "delivery-unavailable" });
  return reply(response, 202, { accepted: true });
}
