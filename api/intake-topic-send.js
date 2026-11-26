import { json, methodGuard, validateMutationOrigin } from "./_lib/http.js";
import { intakeOperatorRequest } from "./_lib/intakeOperator.js";
import { UNSUBSCRIBE_ROUTE, sendTopicUpdateEmail, topicUpdateEmail } from "./_lib/intakeTopicEmail.js";
import { topicMailConfig, topicSendFailure, topicSendPlan } from "./_lib/intakeTopicSend.js";
import { hasQueryString, serviceRpc } from "./_lib/serviceRpc.js";

// POST /api/intake-topic-send — the platform operator writes one update for a
// landing topic and sends it to everyone who opted in
// (REQ-UG-INTAKE-QUEUE-EMAIL-THE-OPT-IN-LIST-20261118). Actions:
//   overview  recipients per topic, today's sends, the newest sends and
//             whether mail is configured
//   preview   the rendered email in both frame languages and the count
//   test      one copy to the operator's own signed-in address
//   send      queue the list send (needs a delivered test of the same content
//             within 24 hours; one per topic per Eastern day)
// The same operator front door as api/intake-review.js; the database decides
// who is an intake_review operator and keeps every send and its counts.
// Nothing here mails the list: api/intake-topic-send-dispatch.js drains the
// queue in small batches.

function reply(response, status, payload) {
  response.setHeader("Referrer-Policy", "no-referrer");
  response.setHeader("Cache-Control", "no-store");
  return json(response, status, payload);
}

function sampleLink(origin) {
  return new URL(UNSUBSCRIBE_ROUTE, origin).toString();
}

async function overview(caller) {
  return serviceRpc(caller.config, "intake_topic_send_overview", {
    p_operator_user_id: caller.operatorId,
    p_operator_session_id: caller.sessionId,
  });
}

export default async function handler(request, response) {
  if (!validateMutationOrigin(request)) return json(response, 403, { error: "untrusted-origin" });
  if (methodGuard(request, ["POST"], () => reply(response, 405, { error: "method-not-allowed" }))) return;
  if (hasQueryString(request)) return reply(response, 400, { error: "invalid-request" });

  const caller = await intakeOperatorRequest(request, "send-unavailable");
  if (caller.refusal) return reply(response, caller.refusal.status, caller.refusal.body);
  const plan = topicSendPlan(caller.body);
  if (!plan) return reply(response, 400, { error: "invalid-request" });
  const mail = topicMailConfig();
  const operator = { p_operator_user_id: caller.operatorId, p_operator_session_id: caller.sessionId };

  try {
    if (plan.action === "overview") {
      const result = await overview(caller);
      return reply(response, 200, { result: { ...result, mail: { ready: mail.ready, missing: mail.missing } } });
    }

    if (plan.action === "preview") {
      const result = await overview(caller);
      const topic = (result?.topics || []).find((entry) => entry?.topic === plan.update.topic) || null;
      const origin = mail.origin || String(process.env.PUBLIC_SITE_APP_ORIGIN || "").replace(/\/$/, "");
      const frame = (locale) => topicUpdateEmail({
        ...plan.update, locale, link: sampleLink(origin), address: mail.address,
      });
      return reply(response, 200, {
        result: {
          topic: plan.update.topic,
          recipients: topic?.recipients ?? 0,
          sentToday: topic?.sentToday === true,
          email: { en: frame("en"), es: frame("es") },
          mail: { ready: mail.ready, missing: mail.missing },
        },
      });
    }

    if (!mail.ready) return reply(response, 503, { error: "mail-unavailable", missing: mail.missing });

    if (plan.action === "test") {
      const begun = await serviceRpc(caller.config, "begin_intake_topic_test_send", {
        ...operator,
        p_topic: plan.update.topic,
        p_subject: plan.update.subject,
        p_body: plan.update.body,
        p_idempotency_key: plan.key,
      });
      if (begun?.refusal === "repeat") {
        return reply(response, 200, { result: { send: begun.send, delivered: begun.send?.sent === 1, repeat: true } });
      }
      if (begun?.started !== true) return reply(response, 409, { error: "refused", reason: begun?.refusal || "invalid" });
      const message = topicUpdateEmail({
        topic: plan.update.topic,
        subject: begun.subject,
        body: begun.body,
        locale: "en",
        link: sampleLink(mail.origin),
        address: mail.address,
        test: true,
      });
      const outcome = await sendTopicUpdateEmail({
        resendKey: mail.resendKey,
        from: mail.from,
        to: begun.to,
        message,
        idempotencyKey: `ug-topic-test-${begun.send.id}`,
      });
      const finished = await serviceRpc(caller.config, "finish_intake_topic_test_send", {
        ...operator,
        p_send_id: begun.send.id,
        p_delivered: outcome === "sent",
      });
      return reply(response, 200, { result: { send: finished?.send || begun.send, delivered: outcome === "sent" } });
    }

    const queued = await serviceRpc(caller.config, "queue_intake_topic_send", {
      ...operator,
      p_topic: plan.update.topic,
      p_subject: plan.update.subject,
      p_body: plan.update.body,
      p_test_send_id: plan.testSendId,
      p_idempotency_key: plan.key,
    });
    if (queued?.refusal === "repeat") return reply(response, 200, { result: { send: queued.send, repeat: true } });
    if (queued?.queued !== true) return reply(response, 409, { error: "refused", reason: queued?.refusal || "invalid" });
    return reply(response, 200, { result: { send: queued.send } });
  } catch (error) {
    const failure = topicSendFailure(error);
    return reply(response, failure.status, failure.body);
  }
}
