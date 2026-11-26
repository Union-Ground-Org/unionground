import { parseAlertWebhookUrl } from "./platformAlerts.js";

const last = new Map();
// No job IDs, organization IDs, authors, recipients or content enter this alert.
export async function postAnnouncementAlert(state, { env = process.env, fetchImpl = fetch, now = new Date() } = {}) {
  const kind = ["retry", "failed", "unavailable"].includes(state) ? state : "unavailable";
  const environment = env.VERCEL_ENV === "production" ? "production" : "preview";
  const key = `${environment}:${kind}`;
  let webhook;
  try { webhook = parseAlertWebhookUrl(env.UG_ALERTS_SLACK_WEBHOOK_URL); } catch { return "disabled"; }
  if (!webhook) return "disabled";
  if (now.getTime() - (last.get(key) ?? -Infinity) < 10 * 60_000) return "throttled";
  last.set(key, now.getTime());
  try {
    const result = await fetchImpl(webhook, {
      method: "POST", redirect: "manual", credentials: "omit", signal: AbortSignal.timeout(5000),
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: `Union Ground product-update delivery: ${kind}. Environment: ${environment}. ${now.toLocaleString("en-US", { timeZone: "America/New_York" })} ET. Inspect the private dispatcher; no recipient or reading information is collected.` }),
    });
    if (!result.ok) { last.delete(key); return "rejected"; }
    return "posted";
  } catch { last.delete(key); return "failed"; }
}
