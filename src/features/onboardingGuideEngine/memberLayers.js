// REQ-UG-ONBOARDING-GUIDE-ENGINE-PORT-STEP2-20261023.
//
// The proposed member layers of the onboarding guide engine (Batch E rules
// R36 per-feature guides and R26 coach marks), each behind its own switch.
// Port step 3 (REQ-UG-ONBOARDING-GUIDE-ENGINE-PORT-STEP3-20261029)
// gave both switches a server definition, default on and organization
// editable (supabase/migrations/20261029150000_organization_start_guide.sql),
// so the member configuration carries them. Pure: the stored marks, the
// screen, the clock and what else is on screen all arrive as input.
//
// Ported from the prototype's src/engine/featureGuides.ts and its coach-mark
// rule, narrowed to what the product can know today: an organization's
// onboarding steps carry no screen, so no member guide is tied to a step and
// every one is Optional; Compass opens as an overlay, not a screen, so it has
// no guide card; the "Ask" line names the member's own steward or is left out.

export const PROPOSED_MEMBER_SWITCHES = Object.freeze({
  featureGuides: "features.guidance_onboarding.feature_guides",
  coachMarks: "features.guidance_onboarding.coach_marks",
});

const fg = (key) => `guideEngine.fg.${key}`;

/**
 * The member's features in the engine's order (ROLE_CORE.member without
 * Compass), with the product view and path they open, the product's own name
 * for them, and the real action that finishes each guide. `doneOnPrimary`
 * marks the two guides whose first action is looking ("See what's next",
 * "See what's on the ballot"): pressing the guide's own button is that action.
 */
export const MEMBER_FEATURES = Object.freeze([
  { feature: "home", view: "today", path: "/m", nameKey: "nav.home", can: [fg("default.home"), fg("member.canHelp")], never: [fg("member.neverPost")], firstKey: fg("memberFirst.home"), doneOnPrimary: true },
  { feature: "member-support", view: "memberSupport", path: "/m/support", nameKey: "nav.memberSupport", can: [fg("member.canHelp"), fg("default.memberSupport")], never: [fg("member.neverPost")], firstKey: fg("default.memberSupport"), stewardFirstKey: fg("memberFirst.memberSupport.name"), doneOnPrimary: false },
  { feature: "rights", view: "rights", path: "/m/rights", nameKey: "nav.knowRights", can: [fg("member.canRights"), fg("default.rights")], never: [fg("member.neverPost")], firstKey: fg("memberFirst.rights"), doneOnPrimary: false },
  { feature: "events", view: "events", path: "/m/events", nameKey: "morehub.events", can: [fg("default.events"), fg("member.canVote")], never: [fg("member.neverPost")], firstKey: fg("memberFirst.events"), doneOnPrimary: false },
  { feature: "messages", view: "messages", path: "/m/messages", nameKey: "nav.messages", can: [fg("default.messages"), fg("member.canHelp")], never: [fg("member.neverPost")], firstKey: fg("memberFirst.messages"), doneOnPrimary: false },
  { feature: "pulse", view: "voice", path: "/m/voice", nameKey: "morehub.beHeard", can: [fg("member.canVote"), fg("default.pulse")], never: [fg("member.neverPost")], firstKey: fg("first.pulse"), doneOnPrimary: false },
  { feature: "ballots", view: "voting", path: "/m/voting", nameKey: "nav.voting", can: [fg("member.canVote"), fg("default.ballots")], never: [fg("member.neverVote")], firstKey: fg("memberFirst.ballots"), doneOnPrimary: true },
  { feature: "settings", view: "settings", path: "/m/settings", nameKey: "nav.settings", can: [fg("default.settings"), fg("member.canSettings")], never: [fg("member.neverSignIn")], firstKey: fg("memberFirst.settings.2"), doneOnPrimary: false },
].map((entry) => Object.freeze(entry)));

/** The feature a product view belongs to, or null. */
export function featureOfView(view) {
  return MEMBER_FEATURES.find((entry) => entry.view === view)?.feature ?? null;
}

export function proposedSwitchOn(switches, name) {
  return Boolean(switches && typeof switches === "object" && switches[PROPOSED_MEMBER_SWITCHES[name]] === true);
}

const copy = (key, params) => (params ? { key, params } : { key });
const at = (marks, feature) => (Number.isFinite(marks?.[feature]) ? marks[feature] : null);

/**
 * R36 for the member hat. `marks` is the device's record of this person's
 * guides: seen (first shown), got (Got it), reopen (opened again from "Your
 * guides") and acted (the real first action), each a time per feature.
 * @param {{ on: boolean, memberHat: boolean, memberOnly: boolean, view?: string | null, stewardName?: string | null, marks?: { seen?: Record<string, number>, got?: Record<string, number>, reopen?: Record<string, number>, acted?: Record<string, number> } }} input
 */
export function memberFeatureGuides({ on, memberHat, memberOnly, view = null, stewardName = null, marks = {} }) {
  if (!on) return { view: null, why: copy("guideEngine.why.r36.today") };
  if (!memberHat) return { view: null, why: copy("guideEngine.why.r2.noStaffToday") };
  if (!memberOnly) return { view: null, why: copy("guideEngine.why.r2.notMemberOnly") };
  const name = typeof stewardName === "string" && stewardName.trim() ? stewardName.trim() : null;
  const items = MEMBER_FEATURES.map((entry, index) => {
    const acted = at(marks.acted, entry.feature);
    const seen = at(marks.seen, entry.feature);
    const done = acted !== null;
    return {
      feature: entry.feature,
      view: entry.view,
      path: entry.path,
      title: copy(entry.nameKey),
      canDo: entry.can.map((key) => copy(key)),
      neverDo: entry.never.map((key) => copy(key)),
      askWho: name ? copy(fg("member.askName"), { name }) : null,
      firstLabel: name && entry.stewardFirstKey ? copy(entry.stewardFirstKey, { name }) : copy(entry.firstKey),
      doneOnPrimary: entry.doneOnPrimary,
      optional: true,
      done,
      // Done before the guide was ever shown, or done first and seen later.
      doneBeforeOpened: done && (seen === null || acted < seen),
      why: done ? copy("guideEngine.why.r36.done") : index === 0 ? copy("guideEngine.why.r36.core") : copy("guideEngine.why.r36.rest"),
    };
  });
  const here = view ? items.find((item) => item.view === view) ?? null : null;
  let showing = null;
  let showingAs = null;
  if (here) {
    const seen = at(marks.seen, here.feature) ?? -1;
    const got = at(marks.got, here.feature) ?? -1;
    const reopen = at(marks.reopen, here.feature) ?? -1;
    // The card stays until Got it; reopening from "Your guides" brings it back.
    if (seen < 0 || (got < seen && reopen < 0)) { showing = here; showingAs = "first"; }
    else if (reopen > got) { showing = here; showingAs = "reopened"; }
  }
  const done = items.filter((item) => item.done);
  return {
    view: { items: items.filter((item) => !item.done), done, showing, showingAs },
    why: here && showing
      ? copy("guideEngine.why.r36.showing", { feature: copy(MEMBER_FEATURES.find((entry) => entry.feature === here.feature).nameKey) })
      : copy("guideEngine.why.r36.list", { count: items.length, done: done.length }),
  };
}

export const COACH_MARK_WAIT_SECONDS = 10;

/**
 * R26: at most one coach mark per session, only for the control the current
 * next step needs, never in the first ten seconds on a screen, never while a
 * feature guide card or a dialog is on screen, once per control.
 * `control` names the anchored control in the why line.
 * @param {{ on: boolean, applies: boolean, anchor?: string | null, control?: string, anchorReached?: boolean, secondsOnScreen?: number, featureGuideOpen?: boolean, blocked?: boolean, shownThisSession?: string | null, seen?: Record<string, number> }} input
 */
export function coachMarkDecision({ on, applies, anchor = null, control = "", anchorReached = false, secondsOnScreen = 0, featureGuideOpen = false, blocked = false, shownThisSession = null, seen = {} }) {
  const no = (why) => ({ show: false, anchor: null, why: copy(`guideEngine.why.r26.${why}`) });
  if (!on) return no("switchOff");
  if (!applies || !anchor) return no("noGuide");
  if (Number.isFinite(seen?.[anchor])) return no("seen");
  // A feature guide card or a dialog always wins, even over this session's
  // mark; the mark comes back when they close.
  if (featureGuideOpen) return no("held");
  if (blocked) return no("blocked");
  // The mark already on screen this session stays until Got it.
  if (shownThisSession === anchor) return { show: true, anchor, why: copy("guideEngine.why.r26.first", { control }) };
  if (shownThisSession) return no("oneSession");
  if (!anchorReached) return no("notReached");
  if (!(secondsOnScreen >= COACH_MARK_WAIT_SECONDS)) return no("wait");
  return { show: true, anchor, why: copy("guideEngine.why.r26.first", { control }) };
}
