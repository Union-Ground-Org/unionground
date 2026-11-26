import { randomUUID } from "node:crypto";
import { resolveSupabaseBackend } from "./_lib/backend.js";
import { cronAuthorization, cronRefusalBody } from "./_lib/cronAuth.js";
import { json, methodGuard, validateMutationOrigin } from "./_lib/http.js";
import {
  sendTopicUpdateEmail, topicUpdateEmail, topicUpdateHeaders, unsubscribeLink, unsubscribeToken,
} from "./_lib/intakeTopicEmail.js";
import { topicMailConfig } from "./_lib/intakeTopicSend.js";
import { serviceRpc } from "./_lib/serviceRpc.js";

// GET /api/intake-topic-send-dispatch — the Vercel cron that drains queued
// topic update deliveries (REQ-UG-INTAKE-QUEUE-EMAIL-THE-OPT-IN-LIST-20261118).
// Rate bounded: one batch of at most BATCH_SIZE per tick (vercel.json runs it
// every two minutes), one email at a time with SEND_SPACING_MS between them,
// so the list goes out at most 750 an hour. Each delivery gets its own
// single-use stop token before it is taken: the database keeps only the
// digest, as a stop confirmation, and the raw token is only in that email's
// unsubscribe link and List-Unsubscribe header. Every outcome is written back
// (sent; failed when the provider refused it; retry when it declined for now;
// unknown when there was no definite answer, so it is never resent and its
// link keeps working), and the send's counts on the operator's page follow
// from them. The deliveries this invocation runs out of time for were never
// tried: they go back in ONE release call for the whole untried tail, which
// gives each its attempt back, and that call's time is reserved before the
// runtime limit, so a slow provider can never leave untried leases to expire
// as failures.

const BATCH_SIZE = 25;
const SEND_SPACING_MS = 600;
// vercel.json gives this function 60 seconds. One service RPC takes at most
// 8 seconds (serviceRpc's timeout), so the release keeps 9 of them, and one
// more is left for the answer. A delivery starts only while its email (10 s),
// its outcome RPC (8 s) and the spacing still fit inside the rest.
const RUNTIME_LIMIT_MS = 60000;
const RELEASE_RESERVE_MS = 8000 + 1000;
const INVOCATION_BUDGET_MS = RUNTIME_LIMIT_MS - RELEASE_RESERVE_MS - 1000;
const DELIVERY_BUDGET_MS = 10000 + 8000 + SEND_SPACING_MS;

const pause = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });

export default async function handler(request, response) {
  if (methodGuard(request, ["GET"], () => json(response, 405, { error: "method-not-allowed" }))) return;
  // The shared rule first: a missing, short or placeholder CRON_SECRET answers
  // 503 for the operator before anything else is read.
  const cron = cronAuthorization(request);
  if (!cron.ok) return json(response, cron.status, cronRefusalBody(cron));
  if (!validateMutationOrigin(request)) return json(response, 403, { error: "untrusted-origin" });
  const backend = resolveSupabaseBackend(request);
  const config = { supabaseUrl: backend?.url || "", serviceKey: backend?.serviceRoleKey || "" };
  if (!config.supabaseUrl || !config.serviceKey) return json(response, 503, { error: "dispatch-unavailable" });
  // Fail before taking anything: a delivery is never leased while mail is
  // not fully configured, so nothing looks attempted, failed or sent.
  const mail = topicMailConfig();
  if (!mail.ready) return json(response, 503, { error: "mail-unavailable", missing: mail.missing });

  const deadline = Date.now() + INVOCATION_BUDGET_MS;
  const lease = randomUUID();
  const tokens = Array.from({ length: BATCH_SIZE }, () => unsubscribeToken());
  let claimed;
  try {
    claimed = await serviceRpc(config, "claim_intake_topic_send_batch", {
      p_lease_token: lease,
      p_token_hashes: tokens.map((entry) => entry.digest),
    });
  } catch {
    return json(response, 503, { error: "dispatch-unavailable" });
  }

  const deliveries = Array.isArray(claimed?.deliveries) ? claimed.deliveries : [];
  const counts = {
    claimed: deliveries.length, sent: 0, failed: 0, retry: 0, unknown: 0, deferred: 0,
    skipped: Number(claimed?.skipped) || 0, unrecorded: 0, unreleased: 0,
  };
  let untried = [];
  for (const [index, delivery] of deliveries.entries()) {
    // Out of time: nothing goes out for this one or the rest; they are
    // released together below. A delivery whose outcome is never written runs
    // out its five-minute lease and is counted failed by the next claim, never
    // sent a second time.
    if (Date.now() + DELIVERY_BUDGET_MS > deadline) {
      untried = deliveries.slice(index);
      break;
    }
    if (index > 0) await pause(SEND_SPACING_MS);
    // In time but without a token of this batch, it cannot carry an
    // unsubscribe link, so it is failed, never requeued for ever.
    const token = tokens[Number(delivery.token) - 1]?.token;
    let outcome = "failed";
    if (token) {
      const link = unsubscribeLink(mail.origin, token);
      outcome = await sendTopicUpdateEmail({
        resendKey: mail.resendKey,
        from: mail.from,
        to: delivery.email,
        message: topicUpdateEmail({
          topic: delivery.topic,
          subject: delivery.subject,
          body: delivery.body,
          locale: delivery.locale,
          link,
          address: mail.address,
        }),
        headers: topicUpdateHeaders(link),
        idempotencyKey: `ug-topic-${delivery.sendId}-${delivery.id}-${delivery.attempt}`,
      });
    }
    counts[outcome] += 1;
    try {
      await serviceRpc(config, "finish_intake_topic_send_delivery", {
        p_lease_token: lease,
        p_delivery_id: delivery.id,
        p_outcome: outcome,
      });
    } catch {
      counts.unrecorded += 1;
    }
  }
  if (untried.length) {
    try {
      const released = await serviceRpc(config, "release_intake_topic_send_deliveries", {
        p_lease_token: lease,
        p_delivery_ids: untried.map((delivery) => delivery.id),
      });
      counts.deferred = Number(released?.released) || 0;
      counts.unreleased = untried.length - counts.deferred;
    } catch { // swallow-ok: counted as unreleased; those leases expire and the next claim settles them
      counts.unreleased = untried.length;
    }
  }
  return json(response, 200, { ok: true, ...counts });
}
