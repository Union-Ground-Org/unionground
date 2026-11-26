import { json, methodGuard, validateMutationOrigin } from "./_lib/http.js";
import { inviteIntakeFounder } from "./_lib/intakeFounderInvitation.js";
import { intakeOperatorRequest } from "./_lib/intakeOperator.js";
import { INVITE_REQUEST_PASS_PATH, intakeReviewFailure, intakeReviewPlan } from "./_lib/intakeReview.js";
import { runVerifiedServerLegalOperation } from "./_lib/legalReleaseGate.js";
import { hasQueryString, serviceRpc } from "./_lib/serviceRpc.js";

// POST /api/intake-review — the platform operator's queue of people who asked
// Union Ground for updates, an invite or to join
// (REQ-UG-INTAKE-QUEUE-STORE-INVITE-REQUESTS-AND-OPERATOR-READ-20261118).
// Actions: summary, list, export, status, note, and for an invite request
// organizations, pass and passes (REQ-UNIONGROUND-INTAKE-QUEUE-SEND-
// INVITATION-FROM-ROW-20261118: pass the request to an organization's
// administrators as an invitation suggestion). The bearer token is validated
// by GoTrue, the session must be aal2 on an account with a verified factor (or
// a server-issued UV key), and only then does the route call one service-only
// RPC with the operator's id and session id (api/_lib/intakeOperator.js). The
// database checks the live session, the recovery and reset boundaries and the
// intake_review capability (42501 'intake reviewer required' answers 403
// not-permitted), reads only rows with no organization, and audits every list,
// export, status, note and pass.
// #9160 adds the legally gated founder action for join rows.

function reply(response, status, payload) {
  response.setHeader("Referrer-Policy", "no-referrer");
  return json(response, status, payload);
}

export default async function handler(request, response) {
  if (!validateMutationOrigin(request)) return json(response, 403, { error: "untrusted-origin" });
  if (methodGuard(request, ["POST"], () => reply(response, 405, { error: "method-not-allowed" }))) return;
  if (hasQueryString(request)) return reply(response, 400, { error: "invalid-request" });

  const caller = await intakeOperatorRequest(request, "review-unavailable");
  if (caller.refusal) return reply(response, caller.refusal.status, caller.refusal.body);

  const step = intakeReviewPlan(caller.body, caller.operatorId);
  if (!step) return reply(response, 400, { error: "invalid-request" });

  try {
    if (caller.body.action === "founder") {
      const outcome = await inviteIntakeFounder(request, caller, step);
      return reply(response, outcome.status, outcome.body);
    }
    const execute = () => serviceRpc(caller.config, step.rpc, { ...step.args, p_operator_session_id: caller.sessionId });
    let result;
    if (step.rpc === "pass_intake_invite_request") {
      const gate = await runVerifiedServerLegalOperation(caller.config, INVITE_REQUEST_PASS_PATH, execute);
      if (!gate.ran) return reply(response, 200, { result: { passed: false, refusal: "privacy-not-released" } });
      result = await gate.result;
    } else result = await execute();
    return reply(response, 200, { result });
  } catch (error) {
    const failure = intakeReviewFailure(error);
    return reply(response, failure.status, failure.body);
  }
}
