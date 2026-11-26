// REQ-UG-INTAKE-QUEUE-EMAIL-THE-OPT-IN-LIST-20261118: what the
// operator's topic update route needs besides the email itself: the mail
// configuration it may send with, the validated plan for each action, and the
// mapping of database refusals to answers.
import { UUID } from "./serviceRpc.js";
import { TOPIC_UPDATE_MAILING_ADDRESS, cleanTopicUpdate } from "./intakeTopicEmail.js";

export const TOPIC_SEND_ACTIONS = Object.freeze(["overview", "preview", "test", "send"]);

// The landing's own sender and transport (api/public-interest-stop.js), the
// site origin the unsubscribe link points at, and the rate-limit secret both
// unsubscribe routes need (api/public-interest-unsubscribe.js answers 503
// without one of at least 32 characters), so nothing is sent whose
// unsubscribe link could not work. The mailing address is the deployment's
// own published one (TOPIC_UPDATE_MAILING_ADDRESS), never ORG_POSTAL_ADDRESS,
// which belongs to chapter footers; with none published nothing is sent.
export function topicMailConfig(env = process.env) {
  const values = {
    RESEND_API_KEY: String(env.RESEND_API_KEY || "").trim(),
    NOTIFY_FROM_ADDRESS: String(env.NOTIFY_FROM_ADDRESS || "").trim(),
    PUBLIC_SITE_APP_ORIGIN: String(env.PUBLIC_SITE_APP_ORIGIN || "").trim().replace(/\/$/, ""),
    PUBLIC_INTEREST_RATE_LIMIT_SECRET: String(env.PUBLIC_INTEREST_RATE_LIMIT_SECRET || ""),
  };
  let originOk = false;
  try {
    originOk = new URL(values.PUBLIC_SITE_APP_ORIGIN).origin === values.PUBLIC_SITE_APP_ORIGIN;
  } catch { // swallow-ok: an unparseable origin is reported as missing below
    originOk = false;
  }
  const missing = Object.entries(values)
    .filter(([name, value]) => !value
      || (name === "PUBLIC_SITE_APP_ORIGIN" && !originOk)
      || (name === "PUBLIC_INTEREST_RATE_LIMIT_SECRET" && value.length < 32))
    .map(([name]) => name);
  if (!TOPIC_UPDATE_MAILING_ADDRESS) missing.push("PUBLIC_POSTAL_ADDRESS");
  return {
    ready: missing.length === 0,
    missing,
    resendKey: values.RESEND_API_KEY,
    from: values.NOTIFY_FROM_ADDRESS,
    origin: values.PUBLIC_SITE_APP_ORIGIN,
    address: TOPIC_UPDATE_MAILING_ADDRESS,
  };
}

/** The validated request, or null when the body is not a valid request. */
export function topicSendPlan(body) {
  if (!body || typeof body !== "object" || !TOPIC_SEND_ACTIONS.includes(body.action)) return null;
  if (body.action === "overview") return { action: "overview" };
  const update = cleanTopicUpdate(body);
  if (!update) return null;
  if (body.action === "preview") return { action: "preview", update };
  if (!UUID.test(String(body.key || ""))) return null;
  if (body.action === "test") return { action: "test", update, key: body.key };
  if (!UUID.test(String(body.testSendId || ""))) return null;
  return { action: "send", update, key: body.key, testSendId: body.testSendId };
}

const INVALID_SLUGS = new Map([
  ["invalid topic", "invalid-topic"],
  ["invalid subject", "invalid-subject"],
  ["invalid body", "invalid-body"],
  ["idempotency key required", "invalid-request"],
  ["idempotency key and test send required", "invalid-request"],
  ["send and outcome required", "invalid-request"],
]);

// 403 only for the database's own verdict that the caller is not an intake
// reviewer; 409 for a validation the database refused; 503 for the rest.
export function topicSendFailure(error) {
  const code = error?.code;
  const detail = String(error?.detail || "");
  if (code === "42501" && detail === "intake reviewer required") {
    return { status: 403, body: { error: "not-permitted" } };
  }
  if (code === "22023") {
    return { status: 409, body: { error: "refused", reason: INVALID_SLUGS.get(detail) || "invalid" } };
  }
  return { status: 503, body: { error: "send-unavailable" } };
}
