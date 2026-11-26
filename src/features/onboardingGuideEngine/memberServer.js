// REQ-UG-ONBOARDING-GUIDE-ENGINE-PORT-STEP1-20261022.
//
// The member guide's server formulas, written out again in JavaScript from
// public.get_member_onboarding_guide (supabase/migrations/
// 20261002120000_member_onboarding_guide.sql). The guide engine never uses
// these to decide anything the server already decided: the golden fixtures
// compute a payload here from raw steps, plan and switches, and the engine's
// parity check (rule R1) compares the server's real answer with it.

/** The five member-visible guide switches: payload field and setting key. */
export const GUIDE_SWITCHES = Object.freeze([
  Object.freeze({ field: "featureDrip", key: "features.guidance_onboarding.feature_drip" }),
  Object.freeze({ field: "hudTooltips", key: "features.guidance_onboarding.hud_tooltips" }),
  Object.freeze({ field: "spotlight", key: "features.guidance_onboarding.spotlight" }),
  Object.freeze({ field: "progressiveDisclosure", key: "features.guidance_onboarding.progressive_disclosure" }),
  Object.freeze({ field: "badgeAchievements", key: "features.guidance_onboarding.badge_achievements" }),
]);

/** The only shape an insufficient_privilege during organization resolution returns. */
export const UNAVAILABLE_GUIDE_PAYLOAD = Object.freeze({
  state: "unavailable",
  applies: false,
  onboardingComplete: null,
  progressiveDisclosureActive: false,
});

/**
 * The stage boundary: greatest(2, ceil(total / 3)).
 * @param {number} total
 */
export function momentumMark(total) {
  return Math.max(2, Math.ceil(total / 3));
}

/**
 * private.member_support_is_staff(org), negated: only an organization-wide
 * grant with MFA, and a second factor when staff MFA is required, makes a
 * person staff for the guide. Chapter-only role holders stay member only.
 * @param {{ orgGrants?: unknown[], mfa?: boolean, secondFactor?: boolean, staffMfaRequired?: boolean }} who
 */
export function computeMemberOnly({ orgGrants = [], mfa = false, secondFactor = false, staffMfaRequired = true } = {}) {
  const orgWide = Array.isArray(orgGrants) && orgGrants.length > 0;
  return !(orgWide && mfa === true && (secondFactor === true || staffMfaRequired === false));
}

/**
 * Active steps in the server's order: position, then id.
 * @param {Array<{ id: string, position?: number, active?: boolean }>} steps
 */
export function activeStepsInOrder(steps) {
  return (Array.isArray(steps) ? steps : [])
    .filter((step) => step && typeof step.id === "string" && step.active !== false)
    .slice()
    .sort((a, b) => (Number(a.position) || 0) - (Number(b.position) || 0) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

/**
 * get_member_onboarding_guide's ready payload, from raw data.
 * establishedMember (BUG-UG-ESTABLISHED-MEMBER-BADGED-NEW-MEMBER-20261106,
 * 20261107192600) rests on join dates the workspace does not carry, so the
 * engine echoes the server's answer, like memberOnly without grant facts.
 * @param {{
 *   organizationId?: string | null,
 *   memberOnly: boolean,
 *   steps: Array<{ id: string, title?: string, position?: number, active?: boolean }>,
 *   plan: { status?: string, completedStepIds?: string[] } | null,
 *   switches: Partial<Record<"featureDrip" | "hudTooltips" | "spotlight" | "progressiveDisclosure" | "badgeAchievements", boolean>>,
 *   establishedMember?: boolean,
 * }} input
 */
export function buildMemberGuidePayload({ organizationId = null, memberOnly, steps, plan, switches, establishedMember = false }) {
  const on = Object.fromEntries(GUIDE_SWITCHES.map(({ field }) => [field, switches?.[field] === true]));
  const anySwitch = Object.values(on).some(Boolean);
  const active = activeStepsInOrder(steps);
  const totalSteps = active.length;
  const programConfigured = totalSteps > 0;
  const enrolled = Boolean(plan);
  const done = new Set(Array.isArray(plan?.completedStepIds) ? plan.completedStepIds : []);
  const completedSteps = active.filter((step) => done.has(step.id)).length;
  const complete = !programConfigured || plan?.status === "completed" || completedSteps >= totalSteps;
  const next = programConfigured && !complete ? active.find((step) => !done.has(step.id)) ?? null : null;
  const momentum = momentumMark(totalSteps);
  const established = establishedMember === true;
  const applies = memberOnly === true && programConfigured && anySwitch && !established;
  return {
    state: "ready",
    organizationId,
    applies,
    memberOnly: memberOnly === true,
    programConfigured,
    enrolled,
    establishedMember: established,
    totalSteps,
    completedSteps: Math.min(completedSteps, totalSteps),
    onboardingComplete: complete,
    progressiveDisclosureActive: applies && on.progressiveDisclosure && !complete,
    stage: complete ? "complete" : completedSteps < momentum ? "welcome" : "activate",
    nextStep: next ? { id: next.id, title: String(next.title ?? "") } : null,
    featureDrip: applies && on.featureDrip,
    showHud: applies && (on.hudTooltips || on.badgeAchievements),
    spotlight: !(applies && on.spotlight) ? null : complete ? "events" : "member-support",
    badge: !(applies && on.badgeAchievements) ? null
      : complete ? "ready_to_roll"
        : completedSteps >= momentum ? "momentum" : "new_member",
    switches: on,
  };
}

/** The payload fields R1 compares; organizationId and switches are echoes. */
export const PARITY_FIELDS = Object.freeze([
  "applies", "memberOnly", "programConfigured", "enrolled", "totalSteps", "completedSteps",
  "onboardingComplete", "progressiveDisclosureActive", "stage", "nextStep", "featureDrip",
  "showHud", "spotlight", "badge",
]);

/**
 * Fields where a server payload and a rebuilt payload disagree.
 * @param {Record<string, unknown>} server
 * @param {Record<string, unknown>} rebuilt
 */
export function payloadDifferences(server, rebuilt) {
  return PARITY_FIELDS.filter((field) => JSON.stringify(server?.[field] ?? null) !== JSON.stringify(rebuilt?.[field] ?? null));
}
