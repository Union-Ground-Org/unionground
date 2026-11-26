// REQ-UG-HOME-NUDGES-20261001.
//
// One Home nudge slot that shows at most ONE nudge, restoring the old passkey
// registration nudge (de7df4b57c^:components/passkey-register-nudge.tsx) and
// the onboarding nudge (components/home/member-onboarding-nudge.tsx):
//   * never while the welcome tour / guided first run is still open
//     (commit d26c1051c7: the two onboarding flows must not compete). The
//     server folds in 's onboarding guide (guidedFirstRun); the client
//     adds the SAMPLE welcome banner;
//   * onboarding first (it is the member's own checklist), then the
//     Union Ground starting list, then passkey;
//   * the starting-list card (REQ-UG-FIRST-RUN-GUIDE-WITHOUT-ORG-CHECKLIST-20261018)
//     only for a member, never staff, whose organization has no active
//     onboarding step of its own (get_member_onboarding_guide: memberOnly and
//     not programConfigured). It links to the four built-in steps on Member
//     support > Onboarding and stays until the member opens it or chooses Not
//     now, on this device; it has no weekly cap and no snooze expiry;
//   * the passkey nudge only when the organization allows passkey enrollment,
//     the device supports passkeys, the member has none, and ten minutes have
//     passed since sign-in (passkey-register-nudge.tsx PASSKEY_LOGIN_DELAY_MS);
//   * "Not now" snoozes a nudge on this device for the organization's
//     limits.home.nudge_snooze_days (old REMINDER_DISMISS_COOLDOWN_MS, 28 days);
//   * once shown, a nudge is not shown again in a LATER session for seven days
//     (old REMINDER_WEEKLY_CAP_MS), though it stays put for the session it
//     appeared in.
// Pure functions; native imports them through a typed seam.

export const NUDGES_RPC = "get_member_home_nudges";
export const GUIDE_RPC = "get_member_onboarding_guide";
export const PASSKEY_NUDGE_DELAY_MS = 10 * 60 * 1000;
const DAY_MS = 86_400_000;
const SHOWN_CAP_DAYS = 7;
const DEFAULT_SNOOZE_DAYS = 28;

/**
 * True only when the caller's guide answer says, in so many words, that the
 * caller is a member (not staff) of an organization with no active onboarding
 * step. Anything else, including an error or an "unavailable" answer, is false.
 * @param {unknown} guidePayload
 * @returns {boolean}
 */
export function starterListApplies(guidePayload) {
  const value = guidePayload && typeof guidePayload === "object" ? /** @type {Record<string, any>} */ (guidePayload) : {};
  return value.state === "ready" && value.memberOnly === true && value.programConfigured === false;
}

/**
 * @param {unknown} payload
 * @param {unknown} [guidePayload] get_member_onboarding_guide's answer, if read
 * @returns {{ passkey: boolean, onboarding: { completed: number, total: number } | null, starterList: boolean, guidedFirstRun: boolean, snoozeDays: number }}
 */
export function normalizeHomeNudges(payload, guidePayload = null) {
  const value = payload && typeof payload === "object" ? /** @type {Record<string, any>} */ (payload) : {};
  // BUG-UG-ESTABLISHED-MEMBER-BADGED-NEW-MEMBER-20261106: the guide's
  // established member is never prompted to finish onboarding (the server
  // already offers none; this holds against an older server answer).
  const established = Boolean(guidePayload && typeof guidePayload === "object"
    && /** @type {Record<string, any>} */ (guidePayload).establishedMember === true);
  const onboarding = !established && value.onboarding && Number.isInteger(value.onboarding.total) && Number.isInteger(value.onboarding.completed)
    && value.onboarding.total > 0 && value.onboarding.completed >= 0 && value.onboarding.completed < value.onboarding.total
    ? { completed: value.onboarding.completed, total: value.onboarding.total }
    : null;
  return {
    passkey: value.passkey === true,
    onboarding,
    starterList: onboarding === null && starterListApplies(guidePayload),
    guidedFirstRun: value.guidedFirstRun === true,
    snoozeDays: Number.isInteger(value.snoozeDays) && value.snoozeDays > 0 ? value.snoozeDays : DEFAULT_SNOOZE_DAYS,
  };
}

function within(timestamp, now, days) {
  return Number.isFinite(timestamp) && now - timestamp < days * DAY_MS;
}

/**
 * @param {{ dismissedAt?: number | null, shownAt?: number | null, shownThisSession?: boolean, now: number, snoozeDays: number }} input
 * @returns {boolean}
 */
export function nudgeAllowedByHistory({ dismissedAt = null, shownAt = null, shownThisSession = false, now, snoozeDays }) {
  if (within(dismissedAt, now, snoozeDays)) return false;
  if (shownThisSession) return true;
  return !within(shownAt, now, SHOWN_CAP_DAYS);
}

/**
 * @param {{
 *   server: { passkey: boolean, onboarding: { completed: number, total: number } | null, starterList?: boolean, guidedFirstRun?: boolean, snoozeDays: number },
 *   welcomeTourActive?: boolean,
 *   passkeySupported?: boolean,
 *   hasPasskey?: boolean | null,
 *   signedInAt?: number | null,
 *   history?: Record<string, { dismissedAt?: number | null, shownAt?: number | null, shownThisSession?: boolean }>,
 *   now?: number,
 * }} input
 * @returns {null | { kind: "onboarding", completed: number, total: number } | { kind: "starter" } | { kind: "passkey" }}
 */
export function chooseHomeNudge({ server, welcomeTourActive = false, passkeySupported = false, hasPasskey = null, signedInAt = null, history = {}, now = Date.now() }) {
  if (!server || welcomeTourActive || server.guidedFirstRun) return null;
  const allowed = (kind) => nudgeAllowedByHistory({ ...(history[kind] ?? {}), now, snoozeDays: server.snoozeDays });
  if (server.onboarding && allowed("onboarding")) {
    return { kind: "onboarding", completed: server.onboarding.completed, total: server.onboarding.total };
  }
  if (server.starterList && !Number.isFinite(history.starter?.dismissedAt)) {
    return { kind: "starter" };
  }
  const settled = !Number.isFinite(signedInAt) || now >= /** @type {number} */ (signedInAt) + PASSKEY_NUDGE_DELAY_MS;
  // hasPasskey null means "not known yet": never nudge on a guess.
  if (server.passkey && passkeySupported && hasPasskey === false && settled && allowed("passkey")) {
    return { kind: "passkey" };
  }
  return null;
}
