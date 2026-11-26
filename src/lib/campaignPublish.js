// A device clock may be fast. Near the deadline, keep Publish available and
// let the server decide; only withdraw it after this shared allowance.
export const CAMPAIGN_PUBLISH_CLOCK_ALLOWANCE_MS = 5 * 60000;

/** @param {unknown} closesAt */
function campaignCloseTime(closesAt) {
  return typeof closesAt === "string" ? Date.parse(closesAt) : NaN;
}

/** @param {unknown} closesAt */
export function campaignCloseDatePassed(closesAt) {
  return campaignCloseTime(closesAt) <= Date.now();
}

/** @param {unknown} closesAt */
export function campaignPublishWithdrawn(closesAt) {
  return Date.now() - campaignCloseTime(closesAt) > CAMPAIGN_PUBLISH_CLOCK_ALLOWANCE_MS;
}

// publish_vote_campaign uses this refusal for an expired close date OR missing
// quorum/options. Only name the close date when it has actually passed. Web's
// MemberApiError adds a fixed label; native keeps the raw PostgREST message.
/** @param {unknown} error @param {unknown} closesAt */
export function isCampaignCloseDateRefusal(error, closesAt) {
  if (!error || typeof error !== "object" || !campaignCloseDatePassed(closesAt)) return false;
  const code = Reflect.get(error, "code");
  const message = Reflect.get(error, "message");
  return code === "22023" && (message === "campaign is not ready to publish"
    || message === "Publish campaign: campaign is not ready to publish");
}
