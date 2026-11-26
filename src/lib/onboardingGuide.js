// REQ-UG-PROGRESSIVE-DISCLOSURE-AND-FEATURE-DRIP-20261001.
//
// The member onboarding guide (old de7df4b57c^:lib/dashboard/onboarding-guide.ts)
// on top of the organization's real onboarding checklist. The server
// (public.get_member_onboarding_guide) decides every switch, the stage, the
// next step, the spotlight and the badge; this module only normalizes that
// payload and applies it to navigation lists. Nothing here grants or hides
// access: route guards are unchanged, and the reduced navigation always
// carries a visible "Show everything" escape hatch.

// The five organization switches. Their member-visible values arrive in the
// member configuration (`switches`), so the shell only asks the server for the
// guide once an admin has turned at least one of them on.
export const ONBOARDING_GUIDE_SWITCH_KEYS = Object.freeze([
  "features.guidance_onboarding.feature_drip",
  "features.guidance_onboarding.hud_tooltips",
  "features.guidance_onboarding.spotlight",
  "features.guidance_onboarding.progressive_disclosure",
  "features.guidance_onboarding.badge_achievements",
]);

// Core member navigation kept while the guided view is active: home, the
// checklist itself (member support), the member's own cases and messages,
// rights guidance, Compass, and the account rows that must never disappear.
// The site guide ("How to use this site") is one of them: a new member is the
// person most likely to need it
// (BUG-UG-GUIDED-NAV-HIDES-SITE-GUIDE-20261018). The organization's
// Site Guide switch still removes it before this list is applied.
export const ONBOARDING_CORE_NAV_KEYS = Object.freeze([
  "today",
  "member-support",
  "cases",
  "messages",
  "rights",
  "compass",
  "notifications",
  "profile",
  "settings",
  "site-guide",
]);

const STAGES = new Set(["welcome", "activate", "complete"]);
const BADGES = new Set(["new_member", "momentum", "ready_to_roll"]);
const SPOTLIGHTS = new Set(["member-support", "events"]);

// Any surface that changes the member's onboarding progress dispatches this on
// window so the shell re-reads the guide without waiting for a navigation.
export const ONBOARDING_GUIDE_REFRESH_EVENT = "sg:onboarding-guide:refresh";

export const INACTIVE_GUIDE = Object.freeze({
  ready: false,
  applies: false,
  onboardingComplete: null,
  progressiveDisclosureActive: false,
  showHud: false,
  featureDrip: false,
  spotlight: null,
  badge: null,
  stage: null,
  nextStep: null,
  totalSteps: 0,
  completedSteps: 0,
  enrolled: false,
  establishedMember: false,
  progressiveNavigationOn: false,
});

// True when the member configuration says any guide switch is on. Absent or
// unknown values are off, matching the old getBoolean(..., false) defaults.
export function onboardingGuideSwitchesOn(configuration) {
  const switches = configuration?.switches;
  if (!switches || typeof switches !== "object") return false;
  return ONBOARDING_GUIDE_SWITCH_KEYS.some((key) => switches[key] === true);
}

function count(value) {
  const number = Number(value);
  return Number.isInteger(number) && number >= 0 ? number : 0;
}

// Fail closed: anything malformed renders as "no guide", never as a reduced
// navigation the member cannot explain.
export function normalizeOnboardingGuide(payload) {
  const ready = Boolean(payload && typeof payload === "object" && !Array.isArray(payload)
    && payload.state === "ready" && typeof payload.applies === "boolean");
  if (!ready || payload.applies !== true) {
    return {
      ...INACTIVE_GUIDE,
      ready,
      onboardingComplete: ready && typeof payload.onboardingComplete === "boolean" ? payload.onboardingComplete : null,
      establishedMember: ready && payload.establishedMember === true,
    };
  }
  const totalSteps = count(payload.totalSteps);
  const completedSteps = Math.min(count(payload.completedSteps), totalSteps);
  const nextStep = payload.nextStep && typeof payload.nextStep.id === "string" && typeof payload.nextStep.title === "string"
    ? { id: payload.nextStep.id, title: payload.nextStep.title.slice(0, 160) }
    : null;
  const onboardingComplete = payload.onboardingComplete === true;
  return {
    ready: true,
    applies: true,
    onboardingComplete,
    progressiveDisclosureActive: payload.progressiveDisclosureActive === true && !onboardingComplete,
    showHud: payload.showHud === true,
    featureDrip: payload.featureDrip === true,
    spotlight: SPOTLIGHTS.has(payload.spotlight) ? payload.spotlight : null,
    badge: BADGES.has(payload.badge) ? payload.badge : null,
    stage: STAGES.has(payload.stage) ? payload.stage : (onboardingComplete ? "complete" : "welcome"),
    nextStep,
    totalSteps,
    completedSteps,
    enrolled: payload.enrolled === true,
    establishedMember: false,
    progressiveNavigationOn: payload.switches?.progressiveDisclosure === true,
  };
}

// The guide card's copy keys, chosen exactly like the old HUD: feature drip
// changes the title to "one clear next step" / "keep the momentum going".
export function onboardingHudCopy(guide) {
  if (!guide?.applies) return null;
  if (guide.stage === "complete") {
    return {
      titleKey: "onboardingGuide.completeTitle",
      // Old copy: the "full navigation is now available" line only when the
      // organization uses the guided navigation at all.
      bodyKey: guide.progressiveNavigationOn ? "onboardingGuide.completeBodyNavigation" : "onboardingGuide.completeBody",
      ctaKey: "onboardingGuide.seeEvents",
      target: { view: "events", path: "/m/events" },
    };
  }
  const early = guide.stage === "welcome";
  return {
    titleKey: early
      ? (guide.featureDrip ? "onboardingGuide.welcomeTitleDrip" : "onboardingGuide.welcomeTitle")
      : (guide.featureDrip ? "onboardingGuide.activateTitleDrip" : "onboardingGuide.activateTitle"),
    bodyKey: early ? "onboardingGuide.welcomeBody" : "onboardingGuide.activateBody",
    ctaKey: guide.enrolled ? "onboardingGuide.openOnboarding" : "onboardingGuide.startOnboarding",
    target: { view: "memberSupport", path: "/m/support/onboarding" },
  };
}

export const ONBOARDING_BADGE_LABEL_KEYS = Object.freeze({
  new_member: "onboardingGuide.badgeNewMember",
  momentum: "onboardingGuide.badgeMomentum",
  ready_to_roll: "onboardingGuide.badgeReadyToRoll",
});

// The whole card as the guide engine hands it to OnboardingHud: copy keys,
// stage, badge, next step and counts. Null when the card does not show.
export function onboardingGuideCard(guide) {
  const copy = guide?.showHud ? onboardingHudCopy(guide) : null;
  if (!copy) return null;
  const complete = guide.stage === "complete";
  return {
    ...copy,
    eyebrowKey: "onboardingGuide.eyebrow",
    stage: guide.stage,
    badge: guide.badge,
    badgeKey: guide.badge ? ONBOARDING_BADGE_LABEL_KEYS[guide.badge] : null,
    nextStepTitle: complete ? null : guide.nextStep?.title ?? null,
    params: { completed: guide.completedSteps, total: guide.totalSteps },
    dismissable: complete,
  };
}

// UX-UG-WEB-NAVIGATION-TOO-MANY-DESTINATIONS-20261018: every member's
// first days get the guided core navigation, whether or not the organization
// wrote onboarding steps. The account's creation time stands in for the join
// date (an invited member's account is created when they accept). Staff, and
// a member who finished the organization's own checklist, keep the full list;
// "Show everything" stays available throughout.
// BUG-UG-GUIDED-MENU-NOTE-POINTS-AT-ONBOARDING-STEPS-THAT-DO-NOT-EXIST-20261103:
// with no onboarding steps assigned the view ends only when the 14 days do, so
// the result carries newMemberWindowOnly and the note says that instead. With
// steps assigned it carries newMemberWindowOnly false: the view ends at the
// steps or the 14 days, whichever comes first, and the note says both. The
// organization's own guided view carries neither and keeps its steps note.
// BUG-UG-ESTABLISHED-MEMBER-BADGED-NEW-MEMBER-20261106: a member the
// server calls established (joined before the organization's onboarding
// program, never chose the guide) is not new, however recent the account, and
// keeps the full list.
export const NEW_MEMBER_GUIDED_NAV_DAYS = 14;
const DAY_MS = 86_400_000;

// A member with no staff role the shell knows of. Unknown roles, or roles the
// staff two-step policy is holding back, are not "member only".
export function memberOnlyAccount(data) {
  return Boolean(data) && data.rolesUnknown !== true && data.staffMfa?.blocked !== true
    && (Array.isArray(data.roles) ? data.roles : []).every((role) => role === "member");
}

export function withNewMemberGuidedNav(guide, { accountCreatedAt = null, memberOnly = false, now = Date.now() } = {}) {
  const base = guide ?? INACTIVE_GUIDE;
  if (base.progressiveDisclosureActive || !memberOnly || base.establishedMember === true
    || (base.applies && base.onboardingComplete === true)) return base;
  const created = Date.parse(accountCreatedAt ?? "");
  const age = now - created;
  if (!Number.isFinite(created) || age < 0 || age >= NEW_MEMBER_GUIDED_NAV_DAYS * DAY_MS) return base;
  const stepsAssigned = base.applies === true && base.totalSteps > 0;
  return { ...base, progressiveDisclosureActive: true, newMemberWindowOnly: !stepsAssigned };
}

// Applies the guided view to one list of navigation items. `showAll` is the
// member's own escape hatch; when it is on (or the guide is inactive) the list
// is returned untouched.
export function guidedNavItems(items, guide, showAll = false) {
  if (!Array.isArray(items)) return [];
  if (!guide?.progressiveDisclosureActive || showAll) return items;
  return items.filter((item) => item && ONBOARDING_CORE_NAV_KEYS.includes(item.key));
}

// How many items the guided view is holding back across the given lists, so
// the escape hatch can say what it will reveal.
export function hiddenGuidedNavCount(lists, guide) {
  if (!guide?.progressiveDisclosureActive) return 0;
  return lists.flat().filter((item) => item && !ONBOARDING_CORE_NAV_KEYS.includes(item.key)).length;
}

export function isSpotlit(item, guide) {
  return Boolean(guide?.spotlight && item?.key === guide.spotlight);
}

// BUG-UG-SPOTLIT-MEMBER-SUPPORT-OPENS-RIGHTS-20261018: the spotlit
// "Next step" row lands on the step itself. Member support opens on its
// Emergency rights tab by default, so its spotlit row links to the checklist.
const SPOTLIGHT_PATHS = Object.freeze({ "member-support": "/m/support/onboarding" });

export function spotlightNavItem(item) {
  const path = item ? SPOTLIGHT_PATHS[item.key] : null;
  return path ? { ...item, path } : item;
}

// Per-device memory of the member's "Show everything" choice. It is a view
// preference only (no server identity log), keyed by the member id.
export function guideShowAllStorageKey(memberId) {
  return memberId ? `sg:member:${memberId}:onboarding-guide:show-all` : null;
}

function browserStorage() {
  // Some browsers deny the storage getter itself, before any method can run.
  try { return globalThis.localStorage; } catch { return null; }
}

export function readGuideShowAll(memberId, storage = browserStorage()) {
  const key = guideShowAllStorageKey(memberId);
  if (!key || !storage) return false;
  try { return storage.getItem(key) === "true"; } catch { return false; }
}

export function writeGuideShowAll(memberId, value, storage = browserStorage()) {
  const key = guideShowAllStorageKey(memberId);
  if (!key || !storage) return;
  try {
    if (value) storage.setItem(key, "true");
    else storage.removeItem(key);
  } catch {
    // Private mode or a full quota: the choice simply lasts this session.
  }
}

// For an account that starts on the full navigation (see the hook), "no choice
// yet" and "chose the guided view" differ, so both answers are stored.
export function readGuideShowAllChoice(memberId, storage = browserStorage()) {
  const key = guideShowAllStorageKey(memberId);
  if (!key || !storage) return null;
  try {
    const value = storage.getItem(key);
    if (value === "true") return true;
    return value === "false" ? false : null;
  } catch { return null; }
}

export function writeGuideShowAllChoice(memberId, value, storage = browserStorage()) {
  const key = guideShowAllStorageKey(memberId);
  if (!key || !storage) return;
  try { storage.setItem(key, value ? "true" : "false"); } catch { /* the choice lasts this session */ }
}

// The completed-stage card can be put away; the in-progress card cannot (it
// is the guide). Same per-device, view-only storage as the escape hatch.
export function guideCompleteDismissKey(memberId) {
  return memberId ? `sg:member:${memberId}:onboarding-guide:complete-dismissed` : null;
}

// BUG-UG-HOME-GUIDE-DISMISSAL-SESSION-AND-FAILED-READ-NUDGE-TEST-20261027:
// the device write can fail (quota, a denied storage) and the card that took
// the click is unmounted by the next navigation, so the choice is also held
// here, per member and per storage, above every place the card renders. The
// same reader serves the guide engine's plan and the card, so a remount on
// another route reads the put-away choice for the rest of the session.
const sessionDismissed = new WeakMap();
const sessionDismissedWithoutStorage = new Set();
function sessionMemory(storage) {
  if (!storage) return sessionDismissedWithoutStorage;
  let keys = sessionDismissed.get(storage);
  if (!keys) { keys = new Set(); sessionDismissed.set(storage, keys); }
  return keys;
}

export function readGuideCompleteDismissed(memberId, storage = browserStorage()) {
  const key = guideCompleteDismissKey(memberId);
  if (!key) return false;
  if (sessionMemory(storage).has(key)) return true;
  if (!storage) return false;
  try { return storage.getItem(key) === "true"; } catch { return false; }
}

export function writeGuideCompleteDismissed(memberId, storage = browserStorage()) {
  const key = guideCompleteDismissKey(memberId);
  if (!key) return;
  sessionMemory(storage).add(key);
  if (!storage) return;
  try { storage.setItem(key, "true"); } catch { /* the session memory above holds the choice */ }
}

// Tests only: a fresh session for the memory a storage instance cannot clear.
export function forgetGuideCompleteDismissedThisSession(storage = browserStorage()) {
  sessionMemory(storage).clear();
}

// REQ-UG-ONBOARDING-GUIDE-ENGINE-PORT-STEP2-20261023: the proposed
// member layers' marks on this device (view state only, written only while
// their default-off switch is on): per-feature guides seen, Got it, reopened
// and acted on, and the coach marks already shown. The one-per-session coach
// mark marker lives in sessionStorage.
export function guideLayerStorageKeys(memberId) {
  return memberId ? {
    featureGuides: `sg:member:${memberId}:onboarding-guide:feature-guides`,
    coachMarks: `sg:member:${memberId}:onboarding-guide:coach-marks`,
    coachSession: `sg:member:${memberId}:onboarding-guide:coach-mark-shown`,
  } : null;
}

const FEATURE_MARK_KINDS = ["seen", "got", "reopen", "acted"];

function readJson(storage, key) {
  try {
    const value = JSON.parse(storage.getItem(key) || "{}");
    return value && typeof value === "object" && !Array.isArray(value) ? value : {};
  } catch { return {}; }
}

function marksOnly(value) {
  // Only feature -> finite time pairs survive a read, so a tampered value
  // can never put text or objects into the guide.
  return Object.fromEntries(Object.entries(value && typeof value === "object" ? value : {})
    .filter(([name, at]) => /^[a-z-]{1,40}$/.test(name) && Number.isFinite(at)));
}

export function readFeatureGuideMarks(memberId, storage = browserStorage()) {
  const keys = guideLayerStorageKeys(memberId);
  const value = keys && storage ? readJson(storage, keys.featureGuides) : {};
  return Object.fromEntries(FEATURE_MARK_KINDS.map((kind) => [kind, marksOnly(value[kind])]));
}

export function writeFeatureGuideMark(memberId, kind, feature, at = Date.now(), storage = browserStorage()) {
  const keys = guideLayerStorageKeys(memberId);
  if (!keys || !storage || !FEATURE_MARK_KINDS.includes(kind)) return readFeatureGuideMarks(memberId, storage);
  const next = readFeatureGuideMarks(memberId, storage);
  // First shown and first done keep their first time; Got it and reopen move.
  if ((kind === "seen" || kind === "acted") && Number.isFinite(next[kind][feature])) return next;
  next[kind] = { ...next[kind], [feature]: at };
  try { storage.setItem(keys.featureGuides, JSON.stringify(next)); } catch { /* the mark lasts this page */ }
  return next;
}

// A coach mark is anchored to the next step's control, and only there.
const isCoachMarkAnchor = (anchor) => typeof anchor === "string" && /^next-step:[\w-]{1,80}$/.test(anchor);

export function readCoachMarksSeen(memberId, storage = browserStorage()) {
  const keys = guideLayerStorageKeys(memberId);
  if (!keys || !storage) return {};
  const value = readJson(storage, keys.coachMarks).seen;
  return Object.fromEntries(Object.entries(value && typeof value === "object" ? value : {})
    .filter(([anchor, at]) => isCoachMarkAnchor(anchor) && Number.isFinite(at)));
}

export function writeCoachMarkSeen(memberId, anchor, at = Date.now(), storage = browserStorage()) {
  const keys = guideLayerStorageKeys(memberId);
  if (!keys || !storage) return;
  try { storage.setItem(keys.coachMarks, JSON.stringify({ seen: { ...readCoachMarksSeen(memberId, storage), [anchor]: at } })); } catch { /* session-only */ }
}

function sessionStore() {
  try { return globalThis.sessionStorage; } catch { return null; }
}

export function readCoachMarkSession(memberId, storage = sessionStore()) {
  const keys = guideLayerStorageKeys(memberId);
  if (!keys || !storage) return null;
  try {
    const anchor = storage.getItem(keys.coachSession);
    return isCoachMarkAnchor(anchor) ? anchor : null;
  } catch { return null; }
}

export function writeCoachMarkSession(memberId, anchor, storage = sessionStore()) {
  const keys = guideLayerStorageKeys(memberId);
  if (!keys || !storage || !isCoachMarkAnchor(anchor)) return;
  try { storage.setItem(keys.coachSession, anchor); } catch { /* best effort */ }
}

// A real member action a feature guide counts (port step 2): the shell's
// handlers announce it here after the write succeeds.
export const ONBOARDING_GUIDE_ACTION_EVENT = "sg:onboarding-guide:action";

export function announceGuideAction(feature, target = globalThis) {
  if (typeof target?.dispatchEvent !== "function" || typeof CustomEvent !== "function") return;
  target.dispatchEvent(new CustomEvent(ONBOARDING_GUIDE_ACTION_EVENT, { detail: { feature } }));
}

// A chapter's unit setup changed (a unit saved or removed, a steward placed
// or a role changed): the staff guide's units step reads its facts again
// (REQ-UG-MULTI-UNIT-SETUP-GUIDE-20261109). Sent after the write lands.
export const CHAPTER_SETUP_CHANGED_EVENT = "sg:chapter-setup:changed";

// The learning-period undo kinds that can change a chapter's stewards or where
// they sit: a role or membership grant or revocation, or a role's unit scope.
// Undoing one can restore a steward's earlier unit or remove a steward, so the
// staff guide's units step reads its facts again.
export const CHAPTER_SETUP_UNDO_KINDS = Object.freeze([
  "chapter_membership_grant", "chapter_membership_revoke", "chapter_membership_revoke_final",
  "chapter_role_grant", "chapter_role_revoke", "chapter_role_scope",
  "organization_role_grant", "organization_role_revoke",
]);

export function announceChapterSetupChanged(target = globalThis) {
  if (typeof target?.dispatchEvent !== "function" || typeof CustomEvent !== "function") return;
  target.dispatchEvent(new CustomEvent(CHAPTER_SETUP_CHANGED_EVENT));
}

/**
 * A write that can change a chapter's stewards (a role or membership grant or
 * revocation), announcing the change once it has succeeded. A write that
 * throws (failed or refused) announces nothing.
 */
export function announceChapterSetupAfter(write, target = globalThis) {
  return async (...args) => {
    const result = await write(...args);
    announceChapterSetupChanged(target);
    return result;
  };
}

// The server's answer as it arrived; the guide engine (port step 2) plans
// from this, and the normalized guide below is the same answer read the old way.
export async function readMemberOnboardingGuide(client) {
  if (!client?.rpc) return null;
  const { data, error } = await client.rpc("get_member_onboarding_guide");
  if (error) throw error;
  return data ?? null;
}

export async function loadMemberOnboardingGuide(client) {
  return normalizeOnboardingGuide(await readMemberOnboardingGuide(client));
}
