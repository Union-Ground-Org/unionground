// #9160: the intake operator replies to a join request with the existing
// founder invitation. Only the database supplies its recipient. The new name
// collection/use stays off until its bilingual privacy release is live.
import { runVerifiedServerLegalOperation } from "./legalReleaseGate.js";
import { digest, invitationRuntimeConfig, invitationSecret, invitationUrl, sendInvitationEmail } from "./memberInvitations.js";
import { serviceRpc } from "./serviceRpc.js";

export const INTAKE_FOUNDER_PATH = "join-request-founder-invitation";

export async function inviteIntakeFounder(request, caller, step) {
  const config = invitationRuntimeConfig(request, caller.backend);
  if (!config?.resendKey || !config.from || !config.appOrigin || config.appOrigin !== request.headers?.origin) {
    return { status: 503, body: { error: "review-unavailable" } };
  }
  const gated = await runVerifiedServerLegalOperation(caller.config, INTAKE_FOUNDER_PATH, async () => {
    const secret = invitationSecret();
    const result = await serviceRpc(caller.config, step.rpc, {
      ...step.args, p_operator_session_id: caller.sessionId, p_token_hash: digest(secret),
    });
    if (!result?.invited) return result;
    // Explicit public projection: neither the recipient nor secret is returned.
    const shown = { invited: true, repeated: result.repeated === true,
      invitationId: result.invitationId, request: result.request };
    if (!result.send) return { ...shown, delivery: "unchanged" };
    let sent = false;
    try {
      sent = await sendInvitationEmail({
        resendKey: config.resendKey, from: config.from, to: result.normalizedEmail,
        locale: result.locale, link: invitationUrl(config.appOrigin, secret), appOrigin: config.appOrigin,
        invitationId: result.invitationId, deliveryVersion: result.deliveryVersion,
        names: { source: "founder", organization: result.organizationName },
      });
    } catch { /* swallow-ok: recorded as failed below, as in the founder CLI */ }
    try {
      const receipt = await serviceRpc(caller.config, "record_organization_founder_invitation_delivery", {
        p_invitation_id: result.invitationId, p_delivery_version: result.deliveryVersion,
        p_outcome: sent ? "sent" : "failed",
      });
      // A stop or acceptance can finish first. Never claim the row's delivery
      // state is known if the version could not be recorded.
      const recorded = receipt?.invitation;
      if (!receipt?.recorded || recorded?.id !== result.invitationId
          || recorded.status !== (sent ? "pending" : "delivery_failed")
          || !Number.isFinite(Date.parse(recorded.expiresAt))
          || (sent && !Number.isFinite(Date.parse(recorded.sentAt)))) {
        return { ...shown, delivery: "unknown" };
      }
      if (shown.request) {
        shown.request = { ...shown.request, founderInvitation: {
          id: recorded.id, status: recorded.status, expiresAt: recorded.expiresAt, sentAt: recorded.sentAt ?? null,
        } };
      }
    } catch { return { ...shown, delivery: "unknown" }; }
    return { ...shown, delivery: sent ? "sent" : "failed" };
  });
  return gated.ran
    ? { status: 200, body: { result: await gated.result } }
    : { status: 409, body: { error: "refused", reason: "legal-release-pending" } };
}
