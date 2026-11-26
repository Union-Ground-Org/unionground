import { resolveSupabaseBackend } from "./_lib/backend.js";
import { cronAuthorization, cronRefusalBody } from "./_lib/cronAuth.js";
import { json, methodGuard, supabaseRpc } from "./_lib/http.js";
import { portalOrigin } from "../src/lib/demoOrigin.js";

// Production-only schedule tick. The service seam creates run records and
// advances schedules (REQ-UG-SCHEDULED-EXPORTS-PARITY-20261001: hourly,
// like the old agency-exports route), then settles every queued email or SFTP
// run instead of leaving it queued forever:
//   - email: when the operator has configured RESEND_API_KEY and
//     NOTIFY_FROM_ADDRESS, the schedule owner receives a sign-in link to the
//     download. The email never carries the exported data. Without that
//     configuration the run records the honest 'not_configured' state.
//   - SFTP: this deployment has no SFTP transport, so the run records
//     'not_configured' (sftp_transport_unavailable).
// Either way the export stays downloadable in the coordination desk until it
// expires. SAMPLE-host requests cannot select SAMPLE credentials here.
// The signed-in app on the Union Ground portal; with no portal yet the
// email omits the link and says to sign in.
const APP_URL = portalOrigin("saas") ? `${portalOrigin("saas")}/m` : "";
// Vercel allows 60 seconds including the scheduler and response. Admit only
// deliveries whose claim, send, and settlement all fit before this deadline.
const INVOCATION_BUDGET_MS = 55_000;
const DELIVERY_RPC_TIMEOUT_MS = 8_000;
const EMAIL_SEND_TIMEOUT_MS = 10_000;
const DELIVERY_BATCH = 25;
const DELIVERY_RESERVE_MS = 2 * DELIVERY_RPC_TIMEOUT_MS + EMAIL_SEND_TIMEOUT_MS;

function remainingTimeout(deadlineAt, cap) {
  const remaining = deadlineAt - Date.now();
  if (remaining <= 0) throw new Error("invocation_budget");
  return Math.min(cap, remaining);
}

const DATASET_LABELS = Object.freeze({
  en: Object.freeze({
    coordination_records: "coordination records",
    members_directory: "members directory",
    events: "events",
    resources: "resources",
    knowledge_articles: "knowledge articles",
    broadcast_log: "broadcast log",
  }),
  es: Object.freeze({
    coordination_records: "registros de coordinación",
    members_directory: "directorio de miembros",
    events: "eventos",
    resources: "recursos",
    knowledge_articles: "artículos de conocimiento",
    broadcast_log: "registro de difusiones",
  }),
});

export function exportReadyEmail({ dataset, organizationName, expiresAt, lang }) {
  const locale = lang === "es" ? "es" : "en";
  const label = DATASET_LABELS[locale][dataset] || DATASET_LABELS[locale].coordination_records;
  const expires = new Date(expiresAt);
  const until = Number.isNaN(expires.valueOf())
    ? ""
    : new Intl.DateTimeFormat(locale === "es" ? "es-US" : "en-US", {
      year: "numeric", month: "short", day: "numeric", hour: "numeric", minute: "2-digit",
      timeZone: "America/New_York", timeZoneName: "short",
    }).format(expires);
  const organization = String(organizationName || "").replace(/[\r\n]+/g, " ").slice(0, 120);
  if (locale === "es") {
    return {
      subject: `Tu exportación programada de ${label} está lista`,
      text: [
        `La exportación programada de ${label} de ${organization} está lista.`,
        until ? `Inicia sesión para descargarla antes del ${until}.` : "Inicia sesión para descargarla.",
        ...(APP_URL ? [`${APP_URL}/coordination`] : []),
        "",
        "Este correo no contiene los datos exportados.",
      ].join("\n"),
    };
  }
  return {
    subject: `Your scheduled ${label} export is ready`,
    text: [
      `The scheduled ${label} export for ${organization} is ready.`,
      until ? `Sign in to download it before ${until}.` : "Sign in to download it.",
      ...(APP_URL ? [`${APP_URL}/coordination`] : []),
      "",
      "This email does not contain the exported data.",
    ].join("\n"),
  };
}

async function sendExportReadyEmail({ resendKey, from, delivery, deadlineAt }) {
  const message = exportReadyEmail({
    dataset: delivery.dataset,
    organizationName: delivery.organizationName,
    expiresAt: delivery.expiresAt,
    lang: delivery.recipient?.lang,
  });
  try {
    const response = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${resendKey}`,
        "Content-Type": "application/json",
        // One run is announced at most once even if a lease is re-claimed.
        "Idempotency-Key": `organization-export-${delivery.runId}`,
      },
      body: JSON.stringify({ from, to: [delivery.recipient.email], subject: message.subject, text: message.text }),
      signal: AbortSignal.timeout(remainingTimeout(deadlineAt, EMAIL_SEND_TIMEOUT_MS)),
    });
    return response.ok;
  } catch {
    return false;
  }
}

export function deliveryOutcome(delivery, emailConfigured) {
  if (delivery.deliveryMode === "sftp_unset") return { status: "not_configured", note: "sftp_transport_unavailable" };
  if (!emailConfigured) return { status: "not_configured", note: "email_transport_unset" };
  if (!delivery.recipient?.email) return { status: "failed", note: "no_recipient" };
  return null;
}

export async function deliverQueuedExports(backend, env = process.env, deadlineAt = Date.now() + INVOCATION_BUDGET_MS) {
  const rpc = (name, body) => supabaseRpc(
    backend.url, backend.serviceRoleKey, backend.serviceRoleKey, name, body,
    { timeoutMs: remainingTimeout(deadlineAt, DELIVERY_RPC_TIMEOUT_MS) },
  );
  const resendKey = env.RESEND_API_KEY;
  const from = env.NOTIFY_FROM_ADDRESS;
  const emailConfigured = Boolean(resendKey && from);
  const summary = { delivered: 0, notConfigured: 0, failed: 0 };
  for (let index = 0; index < DELIVERY_BATCH; index += 1) {
    if (deadlineAt - Date.now() <= DELIVERY_RESERVE_MS) break;
    // A bulk claim would lease rows this invocation cannot reach. Leave those
    // queued instead of stranding them until the lease expires on a later tick.
    const claimed = await rpc("claim_organization_export_deliveries", { p_limit: 1 });
    const delivery = Array.isArray(claimed) ? claimed[0] : null;
    if (!delivery) break;
    let outcome = deliveryOutcome(delivery, emailConfigured);
    if (!outcome) {
      outcome = await sendExportReadyEmail({ resendKey, from, delivery, deadlineAt })
        ? { status: "delivered", note: null }
        : { status: "failed", note: "email_send_failed" };
    }
    await rpc("complete_organization_export_delivery", {
      p_run_id: delivery.runId, p_status: outcome.status, p_note: outcome.note,
    });
    if (outcome.status === "delivered") summary.delivered += 1;
    else if (outcome.status === "not_configured") summary.notConfigured += 1;
    else summary.failed += 1;
  }
  return summary;
}

export default async function handler(request, response) {
  if (methodGuard(request, ["GET"], () => json(response, 405, { ok: false, error: "method_not_allowed" }))) return;
  const deadlineAt = Date.now() + INVOCATION_BUDGET_MS;
  const cron = cronAuthorization(request);
  if (!cron.ok) return json(response, cron.status, cronRefusalBody(cron, { ok: false }));
  const backend = resolveSupabaseBackend(request);
  if (!backend.url || !backend.serviceRoleKey) {
    return json(response, 503, { ok: false, error: "not_configured" });
  }
  let processed;
  try {
    const result = await supabaseRpc(
      backend.url,
      backend.serviceRoleKey,
      backend.serviceRoleKey,
      "run_due_organization_coordination_exports",
      { p_now: new Date().toISOString(), p_limit: 50 },
      { timeoutMs: 20_000 },
    );
    processed = Number(result?.processed || 0);
  } catch {
    return json(response, 503, { ok: false, error: "schedule_runner_unavailable" });
  }
  try {
    const deliveries = await deliverQueuedExports(backend, process.env, deadlineAt);
    return json(response, 200, { ok: true, processed, deliveries });
  } catch {
    // The schedules already ran; only the email/SFTP settlement is retried on
    // the next tick (a claimed run's lease expires after 15 minutes).
    return json(response, 200, { ok: true, processed, deliveries: null, error: "delivery_worker_unavailable" });
  }
}
