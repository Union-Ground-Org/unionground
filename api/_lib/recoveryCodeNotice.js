import { renderEmail, renderText } from "./emailTemplate.js";
import { supabaseRpc } from "./http.js";
import { withReportedFallback } from "./reportedFallback.js";

// SEC-UG-RECOVERY-CODE-USE-WRITES-NO-AUDIT-ROW-OR-NOTICE-20261112
// (#8491): the email a member gets at their account address after one of
// their recovery codes was used. It says what happened and how to get help,
// in the member's saved language, and carries no code, address, device or
// session detail: a stolen code must not be confirmed to whoever holds it,
// and the message only reaches the account's own mailbox.
// The deployment's own member app address (NOTIFY_APP_URL in .env.example).
const APP_URL = String(process.env.NOTIFY_APP_URL || "").replace(/\/$/, "");
const COPY = Object.freeze({
  en: {
    subject: "A recovery code was used on your Union Ground account",
    body: "One of your recovery codes was used on your account. Two-step sign-in was removed and every session was signed out. Sign in again and set up two-step sign-in from Settings. If this was not you, change your password and contact your local office immediately.",
  },
  es: {
    subject: "Se usó un código de recuperación en tu cuenta de Union Ground",
    body: "Se usó uno de tus códigos de recuperación en tu cuenta. Se quitó la verificación en dos pasos y se cerraron todas las sesiones. Vuelve a iniciar sesión y configura la verificación en dos pasos desde Ajustes. Si no fuiste tú, cambia tu contraseña y contacta a tu oficina local de inmediato.",
  },
});

export function recoveryCodeUsedEmail(language, address = process.env.ORG_POSTAL_ADDRESS || "") {
  const lang = language === "es" ? "es" : "en";
  const { subject, body } = COPY[lang];
  return {
    subject,
    text: renderText({ body, appUrl: APP_URL, lang, address }),
    html: renderEmail({ kind: "general", lang, subject, body, appUrl: APP_URL, address }),
  };
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const NOTICE_EMAILS = Object.freeze({ recovery_code_used: recoveryCodeUsedEmail });
const RPC_TIMEOUT_MS = 8000;
const SEND_TIMEOUT_MS = 8000;

// The Idempotency-Key names the queued row, never the attempt: every try of
// one row is the same message to the provider, which delivers it once even
// when a reply is lost or two tries overlap. The row id is random and says
// nothing about the code, the account or the address.
export function accountNoticeIdempotencyKey(id) {
  return `account-notice-${id}`;
}

// #9076 final, r3s2/r4s1: the complete provider request (sender, recipient,
// subject, text and HTML with its postal footer) is stored on the row before
// the first send, and every try sends exactly the stored request, so a retry
// under the row's key is identical even when the sender address, the footer
// or the template changed in a redeploy between tries.
async function sendNotice(row, { url, serviceKey, resendKey, from }, fetcher) {
  const render = Object.prototype.hasOwnProperty.call(NOTICE_EMAILS, row?.notice) ? NOTICE_EMAILS[row.notice] : null;
  const to = typeof row?.email === "string" ? row.email.trim() : "";
  if (!render || !to || !UUID.test(String(row?.id || "")) || !Number.isSafeInteger(row?.attempt)) return false;
  const stored = await supabaseRpc(url, serviceKey, serviceKey, "prepare_account_notice_mail",
    { p_id: row.id, p_attempt: row.attempt, p_request: { from, to: [to], ...render(row.lang) } }, { timeoutMs: RPC_TIMEOUT_MS });
  if (!stored || typeof stored !== "object" || Array.isArray(stored)) return false;
  const response = await fetcher("https://api.resend.com/emails", {
    method: "POST",
    headers: { Authorization: `Bearer ${resendKey}`, "Content-Type": "application/json", "Idempotency-Key": accountNoticeIdempotencyKey(row.id) },
    body: JSON.stringify(stored),
    signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
  });
  return Boolean(response?.ok);
}

// The longest one row can take: storing its request, its send, then
// recording the result.
export const ACCOUNT_NOTICE_ROW_WORST_CASE_MS = RPC_TIMEOUT_MS + SEND_TIMEOUT_MS + RPC_TIMEOUT_MS;
// The longest the claim, or the retention purge, can take.
export const ACCOUNT_NOTICE_RPC_TIMEOUT_MS = RPC_TIMEOUT_MS;

// SEC-UG-ACCOUNT-RECOVERY-NOTICE-AND-RESET-LOCK-GAPS-20261117 (#9036):
// finalize_mfa_recovery_code queues the email in private.account_notice_mail
// in the same transaction that consumes the code, with the account's address
// and language as they were then, so every try of a row is the identical
// message under one key. This claims due rows (one account's when userId is
// given, otherwise every account's), sends each, and marks it sent or puts it
// back with a back-off. It never throws. The answer counts what happened:
// `unavailable` when nothing could be claimed or no mail provider is
// configured, `failed` for rows the provider did not accept, `deferred` for
// claimed rows left for their lease to end because the deadline (epoch ms)
// had no room for one more worst-case row. A row whose result could not be
// recorded is due again after its lease, under the same key.
export async function deliverAccountNotices(
  { url, serviceKey, resendKey, from, userId = null, limit = 20, deadline = Number.POSITIVE_INFINITY, clock = Date.now },
  fetcher = fetch,
  { report } = {},
) {
  const outcome = { claimed: 0, sent: 0, failed: 0, deferred: 0, unavailable: false };
  const options = report ? { report } : undefined;
  if (!resendKey || !from) return { ...outcome, unavailable: true };
  // No room for the claim and one worst-case row: claim nothing this time.
  if (clock() + RPC_TIMEOUT_MS + ACCOUNT_NOTICE_ROW_WORST_CASE_MS > deadline) return outcome;
  const rows = await withReportedFallback(
    () => supabaseRpc(url, serviceKey, serviceKey, "claim_account_notice_mail",
      { p_user_id: userId, p_limit: limit }, { timeoutMs: RPC_TIMEOUT_MS }),
    null, options);
  if (!Array.isArray(rows)) return { ...outcome, unavailable: true };
  for (const row of rows) {
    outcome.claimed += 1;
    if (clock() + ACCOUNT_NOTICE_ROW_WORST_CASE_MS > deadline) {
      outcome.deferred += 1;
      continue;
    }
    const sent = await withReportedFallback(() => sendNotice(row, { url, serviceKey, resendKey, from }, fetcher), false, options);
    if (sent) outcome.sent += 1;
    else outcome.failed += 1;
    if (!UUID.test(String(row?.id || "")) || !Number.isSafeInteger(row?.attempt)) continue;
    await withReportedFallback(
      () => supabaseRpc(url, serviceKey, serviceKey, "complete_account_notice_mail",
        { p_id: row.id, p_attempt: row.attempt, p_sent: sent }, { timeoutMs: RPC_TIMEOUT_MS }),
      null, options);
  }
  return outcome;
}

// Retention runs whether or not a mail provider is configured: the sweep's
// claim with no account and a zero limit deletes rows queued more than seven
// days ago and claims nothing. Answers whether the call went through.
export async function purgeAccountNotices({ url, serviceKey }, { report } = {}) {
  const rows = await withReportedFallback(
    () => supabaseRpc(url, serviceKey, serviceKey, "claim_account_notice_mail",
      { p_user_id: null, p_limit: 0 }, { timeoutMs: RPC_TIMEOUT_MS }),
    null, report ? { report } : undefined);
  return Array.isArray(rows);
}
