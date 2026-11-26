// REQ-UG-ONBOARDING-GUIDE-ENGINE-PORT-STEP1-20261022.
//
// The onboarding guide engine, ported from the Batch E prototype (step 1 of
// 4). plan(input) turns what the product reads today into one view: the Home
// card, guided navigation, spotlight, badge, Home nudge, the member's steps,
// the one action the product allows next, and a "why" for each of the rules
// R1 to R38. Only "The product today" mode exists here. Two of the
// prototype's proposed layers, per-feature guides (R36) and coach marks
// (R26), arrived with port step 2 behind their own default-off switches
// (memberLayers.js); the rest (event-driven step completion, undo, locks,
// org-start and staff guides) come with later port steps and answer "not in
// the product today" until then.
//
// plan() is pure: the clock arrives as input.now, nothing reads storage, the
// DOM or the network, and every user-facing line is a { key, params } entry
// from src/lib/i18n/guideEngine.js (or the product's own onboardingGuide.* and
// homeNudge.* keys). It reuses the product's normalizer, card copy, guided
// navigation and nudge choice, so it cannot drift from what ships.
import {
  INACTIVE_GUIDE,
  ONBOARDING_CORE_NAV_KEYS,
  hiddenGuidedNavCount,
  normalizeOnboardingGuide,
  onboardingGuideCard,
  onboardingGuideSwitchesOn,
  withNewMemberGuidedNav,
} from "../../lib/onboardingGuide.js";
import { chooseHomeNudge, normalizeHomeNudges } from "../memberHome/nudges.js";
import { buildMemberGuidePayload, computeMemberOnly, momentumMark, payloadDifferences } from "./memberServer.js";
import { coachMarkDecision, memberFeatureGuides, proposedSwitchOn } from "./memberLayers.js";
import { orgStartGuide } from "./orgStart.js";
import { staffFeatureGuides } from "./staffGuides.js";

export const GUIDE_ENGINE_MODE = "exists_today";

/** Rule ids, names and where each decision's data comes from. */
export const GUIDE_ENGINE_RULES = Object.freeze([
  ["R1", "Member payload parity", "exists_today"],
  ["R2", "Applies", "exists_today"],
  ["R3", "Stage", "exists_today"],
  ["R4", "Card or entry row", "exists_today"],
  ["R5", "Feature drip", "exists_today"],
  ["R6", "Spotlight", "exists_today"],
  ["R7", "Guided navigation", "exists_today"],
  ["R8", "Badges", "exists_today"],
  ["R9", "Home reminder", "exists_today"],
  ["R10", "Event-driven completion", "proposed"],
  ["R11", "Order", "proposed"],
  ["R12", "Opening a screen finishes nothing", "proposed"],
  ["R13", "Undo", "proposed"],
  ["R14", "Skip", "proposed"],
  ["R15", "Locks", "proposed"],
  ["R16", "Show everything", "on_this_device"],
  ["R17", "Multi-role merge", "proposed"],
  ["R18", "Role switch", "proposed"],
  ["R19", "Inserted step", "proposed"],
  ["R20", "Turned-off step", "proposed"],
  ["R21", "Reorder or switch flip", "proposed"],
  ["R22", "Day 2 and day 7", "proposed"],
  ["R23", "Stalled ladder", "exists_today"],
  ["R24", "Snooze limit", "on_this_device"],
  ["R25", "Celebration", "on_this_device"],
  ["R26", "Coach marks", "proposed"],
  ["R27", "Guide bar", "proposed"],
  ["R28", "Persistence", "on_this_device"],
  ["R29", "Staff guide switch", "proposed"],
  ["R30", "Small groups", "proposed"],
  ["R31", "Announcements", "proposed"],
  ["R32", "200% text, reduced motion", "on_this_device"],
  ["R33", "Who counts as staff", "exists_today"],
  ["R34", "Mode", "proposed"],
  ["R35", "Getting the organization started", "proposed"],
  ["R36", "Per-feature guides", "proposed"],
  ["R37", "Member guide holds member steps only", "exists_today"],
  ["R38", "Guide state", "exists_today"],
].map(([id, name, source]) => Object.freeze({ id, name, source })));

const DAY_MS = 86_400_000;
const SHOWN_CAP_DAYS = 7;
const ONBOARDING_NUDGE_SWITCH = "features.home.onboarding_nudge";

const NUDGE_COPY = Object.freeze({
  onboarding: { titleKey: "homeNudge.onboardingTitle", bodyKey: "homeNudge.onboardingBody", actionKey: "homeNudge.onboardingAction", notNowKey: "homeNudge.notNowOnboarding" },
  starter: { titleKey: "homeNudge.starterTitle", bodyKey: "homeNudge.starterBody", actionKey: "homeNudge.starterAction", notNowKey: "homeNudge.notNowStarter" },
  passkey: { titleKey: "homeNudge.passkeyTitle", bodyKey: "homeNudge.passkeyBody", actionKey: "homeNudge.passkeyAction", notNowKey: "homeNudge.notNowPasskey" },
});

const copy = (key, params) => (params ? { key: `guideEngine.${key}`, params } : { key: `guideEngine.${key}` });
const yesNo = (value) => copy(value ? "common.yes" : "common.no");
// A device clock outside the Date range (a tampered or corrupt history entry)
// still compares as the product's chooser does; it just has no date to show.
const iso = (ms) => {
  const date = new Date(ms);
  return Number.isFinite(date.getTime()) ? date.toISOString() : null;
};

function guideStateOf(payload, failed) {
  if (failed) return "error";
  if (payload?.state === "ready") return "ready";
  if (payload?.state === "unavailable") return "unavailable";
  return "error";
}

// The member's steps in the server's order with the product's three states.
// Members read active steps only (get_member_support_workspace).
function memberSteps(workspace, nextStepId) {
  const program = Array.isArray(workspace?.onboardingProgram) ? workspace.onboardingProgram : [];
  const done = new Set(workspace?.onboardingPlan?.completedStepIds ?? []);
  return program
    .filter((step) => step && typeof step.id === "string" && step.active !== false)
    .slice()
    .sort((a, b) => (Number(a.position) || 0) - (Number(b.position) || 0) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
    .map((step, index) => {
      const state = done.has(step.id) ? "done" : step.id === nextStepId ? "next" : "todo";
      return {
        id: step.id,
        title: String(step.title ?? ""),
        position: index + 1,
        state,
        // No per-step date reaches a member, so a done row says only "Done".
        reason: state === "done" ? copy("row.done") : null,
      };
    });
}

// Done steps that sit after an open one: only a staff override makes those.
function outOfOrderPositions(steps) {
  const firstOpen = steps.findIndex((step) => step.state !== "done");
  if (firstOpen < 0) return [];
  return steps.slice(firstOpen).filter((step) => step.state === "done").map((step) => step.position);
}

// One reminder's two clocks on this device: Not now, then the 7-day cap.
function snoozeFor(entry = {}, now, snoozeDays) {
  const dismissedAt = Number.isFinite(entry.dismissedAt) ? entry.dismissedAt : null;
  if (dismissedAt !== null && now - dismissedAt < snoozeDays * DAY_MS) {
    return { until: dismissedAt + snoozeDays * DAY_MS, why: copy("why.r24.snoozed", { day: iso(dismissedAt), days: snoozeDays, until: iso(dismissedAt + snoozeDays * DAY_MS) }) };
  }
  const shownAt = Number.isFinite(entry.shownAt) ? entry.shownAt : null;
  if (!entry.shownThisSession && shownAt !== null && now - shownAt < SHOWN_CAP_DAYS * DAY_MS) {
    return { until: shownAt + SHOWN_CAP_DAYS * DAY_MS, why: copy("why.r24.cooldownOn", { day: iso(shownAt), until: iso(shownAt + SHOWN_CAP_DAYS * DAY_MS) }) };
  }
  return { until: null, why: copy("why.r24.none") };
}

/**
 * @typedef {{
 *   mode?: "exists_today",
 *   now: number,
 *   hat?: string,
 *   device?: "phone" | "desktop",
 *   switches?: Record<string, unknown> | null,
 *   guide?: unknown,
 *   guideFailed?: boolean,
 *   workspace?: { onboardingProgram?: unknown[], onboardingPlan?: { status?: string, completedStepIds?: string[] } | null } | null,
 *   nudges?: unknown,
 *   nudgesState?: "ready" | "unauthorized" | "error",
 *   who?: { orgGrants?: unknown[], mfa?: boolean, secondFactor?: boolean, staffMfaRequired?: boolean, memberOnlyAccount?: boolean, accountCreatedAt?: string | null },
 *   prefs?: { showAll?: boolean, completeDismissed?: boolean, textScale?: number, reducedMotion?: boolean },
 *   navLists?: Array<Array<{ key: string }>>,
 *   nudgeContext?: { history?: Record<string, { dismissedAt?: number | null, shownAt?: number | null, shownThisSession?: boolean }>, welcomeTourActive?: boolean, passkeySupported?: boolean, hasPasskey?: boolean | null, signedInAt?: number | null },
 *   lastAction?: string | null,
 *   screen?: { view?: string | null } | null,
 *   stewardName?: string | null,
 *   layers?: { featureMarks?: Record<string, Record<string, number>>, coach?: { anchorReached?: boolean, secondsOnScreen?: number, featureGuideOpen?: boolean, blocked?: boolean, shownThisSession?: string | null, seen?: Record<string, number> } },
 * }} GuideEngineInput
 */

/**
 * @param {GuideEngineInput} input
 */
export function plan(input) {
  const mode = input?.mode ?? GUIDE_ENGINE_MODE;
  if (mode !== GUIDE_ENGINE_MODE) throw new Error(`guide engine mode ${mode} is not ported yet`);
  if (!Number.isFinite(input?.now)) throw new Error("guide engine needs input.now");
  const now = input.now;
  const hat = input.hat ?? "member";
  const memberHat = hat === "member";
  const prefs = input.prefs ?? {};
  const payload = input.guide && typeof input.guide === "object" ? /** @type {Record<string, any>} */ (input.guide) : null;
  const guideState = guideStateOf(payload, input.guideFailed === true);
  const ready = guideState === "ready";
  // The web shell reads the guide only when a guide switch is on (pre-gate).
  const gated = !onboardingGuideSwitchesOn({ switches: input.switches ?? null });
  const legacy = gated || !ready ? { ...INACTIVE_GUIDE } : normalizeOnboardingGuide(payload);
  const serverSwitches = ready && payload.switches && typeof payload.switches === "object" ? payload.switches : {};
  const who = input.who ?? {};
  const hasGrantFacts = Array.isArray(who.orgGrants);
  // The product keeps a member's first-14-days guided navigation even when
  // the guide call fails (App.jsx), so a failed state says so when it applies.
  const navGuide = memberHat ? withNewMemberGuidedNav(legacy, {
    accountCreatedAt: who.accountCreatedAt ?? null,
    memberOnly: who.memberOnlyAccount === true,
    now,
  }) : INACTIVE_GUIDE;
  const failedWhy = guideState === "unavailable" ? copy("why.r38.unavailable") : copy("why.r38.error");
  const stateWhy = !ready && navGuide.progressiveDisclosureActive === true ? copy("why.r38.newMemberNav", { state: failedWhy }) : failedWhy;
  const decisions = [];
  const decide = (rule, why) => {
    const entry = GUIDE_ENGINE_RULES.find((item) => item.id === rule);
    decisions.push({ rule, source: entry.source, why });
  };

  // R1: the server's answer, and the same answer rebuilt from the workspace.
  // memberOnly is rebuilt from the grant facts when they are known; without
  // them the server's answer would only be echoed, so that field stays unchecked.
  let parity = { checked: false, differences: [], unchecked: [] };
  if (ready && input.workspace) {
    const rebuilt = buildMemberGuidePayload({
      organizationId: payload.organizationId ?? null,
      memberOnly: hasGrantFacts ? computeMemberOnly(who) : payload.memberOnly === true,
      steps: /** @type {any[]} */ (input.workspace.onboardingProgram ?? []),
      plan: input.workspace.onboardingPlan ?? null,
      switches: serverSwitches,
      establishedMember: payload.establishedMember === true,
    });
    parity = {
      checked: true,
      differences: payloadDifferences(payload, rebuilt).filter((field) => hasGrantFacts || field !== "memberOnly"),
      unchecked: hasGrantFacts ? [] : ["memberOnly"],
    };
  }
  const total = ready ? Number(payload.totalSteps) || 0 : 0;
  const done = ready ? Math.min(Number(payload.completedSteps) || 0, total) : 0;
  const stage = ready && typeof payload.stage === "string" ? payload.stage : null;
  decide("R1", ready
    ? copy("why.r1.built", { completed: done, total, stage: copy(`stage.${stage ?? "welcome"}`) })
    : copy("why.r1.unavailable"));

  // R2: applies = member only, an active step, a switch on and not an
  // established member (joined before the steps, never chose the guide).
  const memberOnly = ready ? payload.memberOnly === true : null;
  const anyServerSwitch = Object.values(serverSwitches).some((value) => value === true);
  decide("R2", !ready ? stateWhy
    : !memberOnly ? copy("why.r2.notMemberOnly")
      : payload.programConfigured !== true ? copy("why.r2.noSteps")
        : !anyServerSwitch || gated ? copy("why.r2.allOff")
          : payload.establishedMember === true ? copy("why.r2.established")
            : copy("why.r2.member"));

  // R3: stage against the Momentum mark.
  const mark = momentumMark(total);
  decide("R3", !ready ? stateWhy
    : stage === "complete" ? copy("why.r3.complete", { done, total })
    : stage === "activate" ? copy("why.r3.activate", { done, m: mark })
      : copy("why.r3.welcome", { done, m: mark, total }));

  // R4: the web card. The member hat only; no entry row on the web.
  const complete = legacy.applies && legacy.stage === "complete";
  const builtCard = memberHat ? onboardingGuideCard(legacy) : null;
  const putAway = complete && prefs.completeDismissed === true;
  const card = builtCard && !putAway ? builtCard : null;
  decide("R4", !memberHat ? copy("why.r2.noStaffToday")
    : !legacy.applies ? copy("why.r4.off")
      : !legacy.showHud ? copy("why.r4.webNoEntry")
        : putAway ? copy("why.r4.putAway")
          : complete ? copy("why.r4.completeWeb")
            : serverSwitches.hudTooltips === true ? copy("why.r4.card") : copy("why.r4.cardViaBadges"));

  // R5: feature drip changes only the card's two titles.
  decide("R5", !legacy.applies ? copy("why.r5.notInUse") : legacy.featureDrip ? copy("why.r5.on") : copy("why.r5.off"));

  // R6: spotlight, member hat only.
  const spotlight = memberHat ? legacy.spotlight : null;
  decide("R6", !memberHat ? copy("why.r2.noStaffToday")
    : !legacy.applies ? copy("why.r6.none")
      : serverSwitches.spotlight !== true ? copy("why.r6.off")
        : spotlight === "events" ? copy("why.r6.events") : copy("why.r6.support"));

  // R7 and R16: the guided core navigation and its Show everything escape.
  const showAll = prefs.showAll === true;
  const lists = Array.isArray(input.navLists) ? input.navLists : [];
  const hiddenCount = hiddenGuidedNavCount(lists, navGuide);
  const nav = {
    guided: navGuide.progressiveDisclosureActive === true && !showAll,
    offered: navGuide.progressiveDisclosureActive === true,
    coreKeys: ONBOARDING_CORE_NAV_KEYS,
    hiddenCount,
    spotlight,
    // The guide the navigation surfaces read (guidedNavItems, isSpotlit,
    // GuidedNavToggle): the member's guide plus the first-14-days view.
    guide: navGuide,
  };
  const navWhy = !memberHat ? copy("why.r7.staffHat")
    : !nav.offered ? (complete ? copy("why.r7.complete") : copy("why.r7.off"))
      : showAll ? copy("why.r7.showEverything")
        : copy("why.r7.guided", { core: ONBOARDING_CORE_NAV_KEYS.length, count: hiddenCount });
  decide("R7", navWhy);

  // R8: badges, member hat only.
  const badge = memberHat ? legacy.badge : null;
  decide("R8", !memberHat ? copy("why.r2.noStaffToday")
    : badge === "ready_to_roll" ? copy("why.r8.ready")
      : badge === "momentum" ? copy("why.r8.momentum")
        : badge === "new_member" ? copy("why.r8.new") : copy("why.r8.none"));

  // R9 and R24: the one Home nudge, with its two clocks.
  const nudgesRead = input.nudges && typeof input.nudges === "object" && input.nudgesState !== "unauthorized" && input.nudgesState !== "error";
  const server = nudgesRead ? normalizeHomeNudges(input.nudges, payload) : null;
  const context = input.nudgeContext ?? {};
  const chosen = chooseHomeNudge({
    server,
    welcomeTourActive: context.welcomeTourActive === true,
    passkeySupported: context.passkeySupported === true,
    hasPasskey: context.hasPasskey ?? null,
    signedInAt: context.signedInAt ?? null,
    history: context.history ?? {},
    now,
  });
  // Each reminder keeps its own clocks; R24 names the first one a clock is
  // hiding, in the product's order, and R9 explains the onboarding reminder.
  const history = context.history ?? {};
  const passkeyEligible = Boolean(server?.passkey) && context.passkeySupported === true && context.hasPasskey === false;
  const onboardingClock = server?.onboarding ? snoozeFor(history.onboarding, now, server.snoozeDays) : null;
  const passkeyClock = passkeyEligible ? snoozeFor(history.passkey, now, server.snoozeDays) : null;
  const snooze = [onboardingClock, passkeyClock].find((clock) => clock && clock.until !== null) ?? { until: null, why: copy("why.r24.none") };
  const nudge = chosen ? {
    kind: chosen.kind,
    ...NUDGE_COPY[chosen.kind],
    params: chosen.kind === "onboarding" ? { step: chosen.completed + 1, total: chosen.total } : {},
  } : null;
  const enrolled = ready ? payload.enrolled === true : Boolean(input.workspace?.onboardingPlan);
  const onboardingWhy = !server ? (input.nudgesState === "unauthorized" ? copy("why.r9.noChapter") : copy("why.r38.error"))
    : server.guidedFirstRun || context.welcomeTourActive === true ? copy("why.r9.guidedFirstRun")
      : nudge?.kind === "onboarding" ? copy("why.r9.shows")
        : onboardingClock ? onboardingClock.why
          : input.switches?.[ONBOARDING_NUDGE_SWITCH] === false ? copy("why.r9.switchOff")
            : !enrolled ? copy("why.r9.noPlan") : copy("why.r9.finished");
  decide("R9", nudge && nudge.kind !== "onboarding" ? copy(`why.r9.${nudge.kind}Shows`, { onboarding: onboardingWhy }) : onboardingWhy);

  // Steps and the one action the product allows: Start, or Complete on the
  // first open active step (the server refuses any other order).
  const nextStepId = ready && payload.nextStep && typeof payload.nextStep.id === "string" ? payload.nextStep.id : null;
  const steps = memberSteps(input.workspace, nextStepId);
  const next = steps.find((step) => step.state === "next")
    ?? (nextStepId ? { id: nextStepId, title: String(payload.nextStep.title ?? "").slice(0, 160), position: null, state: "next", reason: null } : null);
  let action = null;
  if (memberHat && ready && payload.programConfigured === true && payload.onboardingComplete !== true) {
    if (!enrolled) action = { kind: "start_plan", label: copy("action.startPlan") };
    else if (next) action = { kind: "complete_step", stepId: next.id, label: copy("action.complete", { title: next.title }) };
  }

  // R10 to R15: the product has none of the proposed completion paths. A
  // staff skip is stored in completedStepIds like a completion
  // (staff_update_member_onboarding_plan), so a member's data cannot show one.
  decide("R10", input.lastAction ? copy("why.r10.today", { action: input.lastAction }) : copy("why.r10.none"));
  const outOfOrder = outOfOrderPositions(steps);
  const staffOrder = outOfOrder.length ? copy("why.r11.staffOutOfOrder", { steps: outOfOrder.join(", ") }) : null;
  decide("R11", staffOrder ?? copy("why.r11.inOrder"));
  decide("R12", copy("why.r12.never"));
  decide("R13", copy("why.r13.today"));
  decide("R14", staffOrder ?? copy("why.r14.unknownFromMember"));
  decide("R15", copy("why.r15.today"));
  decide("R16", navWhy);
  decide("R17", copy("why.r17.single", { rows: total, roles: copy("role.member") }));
  decide("R18", copy("why.r18.today"));
  decide("R19", copy("why.r19.today"));
  decide("R20", copy("why.r20.today"));
  decide("R21", copy("why.r21.noSnapshot"));
  decide("R22", copy("why.r22.today"));
  decide("R23", copy("why.r23.today"));
  decide("R24", snooze.why);
  decide("R25", copy("why.r25.today"));
  // R26 and R36: the two proposed member layers, each behind its own switch.
  const featureGuidesOn = proposedSwitchOn(input.switches, "featureGuides");
  const coachMarksOn = proposedSwitchOn(input.switches, "coachMarks");
  const layers = input.layers ?? {};
  const featureGuides = memberFeatureGuides({
    on: featureGuidesOn,
    memberHat,
    memberOnly: ready ? payload.memberOnly === true : who.memberOnlyAccount === true,
    view: input.screen?.view ?? null,
    stewardName: input.stewardName ?? null,
    marks: layers.featureMarks ?? {},
  });
  const coachMark = coachMarkDecision({
    on: coachMarksOn,
    applies: memberHat && legacy.applies && action?.kind === "complete_step",
    anchor: action?.kind === "complete_step" ? `next-step:${action.stepId}` : null,
    control: next?.title ?? "",
    ...(layers.coach ?? {}),
    featureGuideOpen: Boolean(featureGuides.view?.showing) || layers.coach?.featureGuideOpen === true,
  });
  decide("R26", coachMarksOn ? coachMark.why : copy("why.r26.today"));
  decide("R27", copy("why.r27.today"));
  decide("R28", copy("why.r28.today"));
  // R29: guide 2 for the staff hat worn, from the server's staff guide read
  // (port step 4). Without that input the product-today line stands.
  const staffGuides = input.staff ? staffFeatureGuides(input.staff) : { view: null, why: copy("why.r29.product") };
  decide("R29", staffGuides.why);
  decide("R30", copy("why.r30.none"));
  decide("R31", copy("why.r31.none"));
  const large = Number(prefs.textScale) >= 2;
  const reduced = prefs.reducedMotion === true;
  decide("R32", copy(`why.r32.${large ? "large" : "normal"}${reduced ? "Reduced" : "Full"}`));

  // R33: who counts as staff. The server's memberOnly decides; the
  // computation is shown when the grant facts are known.
  decide("R33", hasGrantFacts ? copy("why.memberOnlyCalc", {
    org: yesNo(who.orgGrants.length > 0),
    mfa: yesNo(who.mfa === true),
    factor: yesNo(who.secondFactor === true),
    notRequired: yesNo(who.staffMfaRequired === false),
    result: yesNo(memberOnly ?? computeMemberOnly(who)),
  }) : copy("why.r33.keepsMember"));
  decide("R34", featureGuidesOn || coachMarksOn ? copy("why.r34.proposed") : copy("why.r34.today"));
  // R35: guide 1, "Getting the organization started", from the server's
  // org-start read (port step 3). Without a read it shows nothing.
  const orgStart = input.orgStart ? orgStartGuide(input.orgStart.payload ?? null, { reachable: input.orgStart.reachable }) : { view: null, why: { key: "guideEngine.why.r35.notRead" } };
  decide("R35", orgStart.why);
  decide("R36", featureGuides.why);
  decide("R37", copy("why.r37.rule"));
  decide("R38", ready ? copy("why.r38.ready") : stateWhy);

  return {
    mode,
    guideState,
    applies: legacy.applies,
    memberOnly,
    legacy,
    parity,
    stage: legacy.applies ? legacy.stage : null,
    ring: ready && total > 0 ? {
      done,
      total,
      percent: Math.round((done / total) * 100),
      text: copy("ring.steps", { done, total }),
    } : null,
    card,
    entry: null,
    nav,
    badge,
    nudge,
    hiddenUntil: snooze.until === null ? null : iso(snooze.until),
    steps,
    next,
    action,
    featureGuides: featureGuides.view,
    orgStart: orgStart.view,
    staffGuides: staffGuides.view,
    coachMark: coachMark.show ? { anchor: coachMark.anchor, titleKey: "onboardingGuide.spotlight", bodyKey: "onboardingGuide.nextStep", params: { title: next?.title ?? "" } } : null,
    motion: reduced ? "reduced" : "full",
    decisions,
  };
}
