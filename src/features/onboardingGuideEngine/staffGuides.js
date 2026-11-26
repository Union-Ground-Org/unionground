// REQ-UG-ONBOARDING-GUIDE-ENGINE-PORT-STEP4-20261029.
//
// Guide 2, "Per feature", for the five staff keys (Batch E rule R29 with
// R36's card rules, owner amendment 1 and decision 2.2 "Yes, follow the hat").
// A person wearing a steward, grievance coordinator, chapter advisor, chapter
// administrator or leadership hat gets that role's feature guides, whether the
// role is held at organization or chapter scope. Each guide says what the role
// can do in the feature, must never do, who to ask, and one real first action
// that finishes it, even without the guide being opened.
//
// Progress is per person and lives on the server, apart from the member
// checklist (public.get_staff_onboarding_guide; a staff row never counts
// toward a member's guide). The guides ride the Feature guides switch
// (features.guidance_onboarding.feature_guides, on by default), as the
// prototype's staff features did. Pure: the server payload, the hat, the page
// and the member plan's counts all arrive as input. Shared by the web and the
// native app (apps/mobile imports this file; it imports nothing).
//
// Ported narrower than the prototype where the product has no such thing:
// no board agenda approval, statements or turnout reminders (so no locks), no
// event that a guide can wait on, and Compass is an overlay with no page.

export const STAFF_GUIDE_SWITCH = "features.guidance_onboarding.feature_guides";
export const STAFF_GUIDE_ROLES = Object.freeze(["steward", "coordinator", "advisor", "admin", "vp"]);

// A feature every staff role works in: one guide however many roles use it.
export const SHARED_STAFF_FEATURES = Object.freeze(["messages", "settings"]);

const fg = (key) => `guideEngine.fg.${key}`;
const sf = (key) => `guideEngine.sf.${key}`;

// `path` is the web page the guide belongs to (its card shows there, and the
// list opens it); `nativeHref` the phone screen. `doneOnPrimary`: the first
// action is looking, so the guide's own button is that action.
const guide = (role, feature, entry) => Object.freeze({ role, feature, stepId: `${role}.${feature}`, doneOnPrimary: false, ...entry });

const messages = (role, path, can, never) => guide(role, "messages", {
  path, nativeHref: "/messages", nameKey: "guideEngine.feature.messages", can, never, firstKey: sf("first.messages"),
});
// REQ-UG-MULTI-UNIT-SETUP-GUIDE-20261109 (#7674): the chapter lead's
// units step. It finishes from the facts the server reads for the selected
// chapter (payload.chapterUnits: at least one unit and no steward without
// one), never from a click, and shows only to a lead the server gives those
// facts to. Each of its two parts opens the web screen for it (`partPaths`):
// the administrator creates units on the organization page and gives
// stewards one in chapter access; vp, who may do neither, sees both in
// chapter access. The phone has neither screen, so `nativeHref` is null.
export const UNIT_SETUP_PARTS = Object.freeze(["create", "assign"]);
const units = (role, firstKey, partPaths, partLabels, can, never) => guide(role, "units", {
  path: partPaths.create, partPaths: Object.freeze(partPaths), partLabels: Object.freeze(partLabels), nativeHref: null, nameKey: "guideEngine.feature.units", can, never,
  firstKey, about: [sf("units.private"), sf("units.shared"), sf("units.noUnit")], fromChapter: true,
});
const settings = (role) => guide(role, "settings", {
  path: "/m/settings", nativeHref: "/account", nameKey: "guideEngine.feature.settings",
  can: [fg("default.settings")], never: [fg("member.neverSignIn")], firstKey: sf("first.settings"),
});

/**
 * Each role's guides in the engine's order: the role's core feature first
 * (casework for the steward and the coordinator, chapter health for the
 * advisor, people for the administrator, leadership for vp), then, for the
 * administrator and vp, the chapter's units, then Messages, then Settings.
 */
export const STAFF_FEATURE_GUIDES = Object.freeze({
  steward: Object.freeze([
    guide("steward", "casework", {
      path: "/m/steward/requests", nativeHref: "/work", nameKey: "guideEngine.feature.casework",
      can: [fg("steward.canTake"), fg("steward.canSecond"), fg("steward.canMeet")],
      never: [fg("steward.neverPromise"), fg("steward.neverShare"), fg("steward.neverNotes")],
      firstKey: sf("first.steward.casework"),
    }),
    messages("steward", "/m/steward/messages", [fg("default.messages"), fg("steward.canTake")], [fg("steward.neverShare"), fg("steward.neverSpeak")]),
    settings("steward"),
  ]),
  coordinator: Object.freeze([
    guide("coordinator", "casework", {
      path: "/m/coordinator/cases", nativeHref: "/work", nameKey: "guideEngine.feature.casework",
      can: [fg("coordinator.canAssign"), fg("coordinator.canDeadlines"), fg("coordinator.canBoard")],
      never: [fg("coordinator.neverOther"), fg("coordinator.neverReassign"), fg("coordinator.neverExport")],
      firstKey: sf("first.coordinator.casework"),
    }),
    messages("coordinator", "/m/messages", [fg("default.messages")], [fg("coordinator.neverPost")]),
    settings("coordinator"),
  ]),
  advisor: Object.freeze([
    guide("advisor", "chapter-health", {
      path: "/m/advisor", nativeHref: "/work", nameKey: "guideEngine.feature.chapterHealth",
      can: [sf("can.advisor.numbers"), fg("advisor.canGrants")],
      never: [fg("advisor.neverSmall"), fg("advisor.neverVote"), fg("advisor.neverRecords")],
      firstKey: sf("first.advisor.chapterHealth"), doneOnPrimary: true,
    }),
    messages("advisor", "/m/messages", [fg("advisor.canConsult"), fg("default.messages")], [fg("advisor.neverContact"), fg("advisor.neverPromise")]),
    settings("advisor"),
  ]),
  admin: Object.freeze([
    guide("admin", "people", {
      path: "/m/admin/access", nativeHref: "/work", nameKey: "guideEngine.feature.people",
      can: [fg("admin.canRoles"), fg("admin.canInvite"), fg("admin.canResets")],
      never: [fg("admin.neverRole"), fg("admin.neverReset"), fg("admin.neverData")],
      firstKey: sf("first.admin.people"),
    }),
    units("admin", sf("first.units"), { create: "/m/admin/organization", assign: "/m/organize/record" }, { create: sf("units.create"), assign: sf("units.assign") }, [fg("admin.canUnits"), fg("admin.canUnitStewards")], [fg("admin.neverUnitLeft")]),
    messages("admin", "/m/messages", [fg("default.messages")], [fg("admin.neverCases")]),
    settings("admin"),
  ]),
  vp: Object.freeze([
    guide("vp", "leadership", {
      path: "/m/vp/attention", nativeHref: "/work", nameKey: "guideEngine.feature.leadership",
      can: [sf("can.vp.attention"), fg("vp.canTurnout")],
      never: [fg("vp.neverVote"), fg("vp.neverRecords"), fg("vp.neverSpeak")],
      firstKey: sf("first.vp.leadership"),
    }),
    units("vp", sf("first.units.vp"), { create: "/m/organize/record", assign: "/m/organize/record" }, { create: sf("units.check"), assign: sf("units.checkStewards") }, [fg("vp.canUnits")], [fg("vp.neverUnits")]),
    messages("vp", "/m/messages", [fg("default.messages")], [fg("vp.neverTell")]),
    settings("vp"),
  ]),
});

// The step ids the server accepts (public.complete_staff_onboarding_step),
// plus one "role-switch" row per role: the first switch into that hat.
export const STAFF_GUIDE_STEP_IDS = Object.freeze(Object.values(STAFF_FEATURE_GUIDES).flat().map((entry) => entry.stepId));
export const roleSwitchStepId = (role) => `${role}.role-switch`;

const ROLE_LABEL_KEYS = Object.freeze({ steward: "guideEngine.role.steward", coordinator: "guideEngine.role.coordinator", advisor: "guideEngine.role.advisor", admin: "guideEngine.role.admin", vp: "guideEngine.role.vpOrg" });
// Guide chips and switch notices name the grant's scope. The demo hat and
// desk use demo.hatVp separately and keep the President name.
export const staffRoleLabelKey = (role, scope = "organization") => (role === "vp" && scope === "chapter" ? "guideEngine.role.vpChapter" : ROLE_LABEL_KEYS[role] ?? null);

const copy = (key, params) => (params ? { key, params } : { key });
const time = (value) => {
  if (typeof value !== "string" || !value) return null;
  const at = Date.parse(value);
  return Number.isFinite(at) ? at : null;
};

// The staff desk writes that are a guide's real first action, per hat: the
// method on that hat's desk API and the feature it finishes. A steward takes
// a request by acknowledging it (closing one is not taking it).
export const STAFF_GUIDE_ACTIONS = Object.freeze({
  steward: Object.freeze({ triage: "casework", reply: "messages", sendResource: "messages" }),
  coordinator: Object.freeze({ assignCase: "casework" }),
  advisor: Object.freeze({}),
  admin: Object.freeze({ grantRole: "people", rejectLeadershipClaim: "people", inviteMember: "people", resendInvitation: "people" }),
  vp: Object.freeze({ markReviewed: "leadership" }),
});

const takesRequest = (_requestId, action) => action === "acknowledge";

/**
 * `write`, also finishing `hat`'s `feature` guide once it has resolved, and
 * only while `hooks.scope()` (the signed-in person and organization) is what
 * it was when the write started. A write that throws finishes nothing; its
 * own result passes through.
 * @param {string} hat
 * @param {string} feature
 * @param {((...args: any[]) => any) | undefined} write
 * @param {{ scope: () => string, finish: (hat: string, feature: string) => void }} hooks
 * @param {((...args: any[]) => boolean) | null} [when]
 */
export function finishesStaffGuide(hat, feature, write, hooks, when = null) {
  if (typeof write !== "function") return write;
  return async (...args) => {
    const started = hooks.scope();
    const result = await write(...args);
    if ((!when || when(...args)) && hooks.scope() === started) hooks.finish(hat, feature);
    return result;
  };
}

/** `api` with `hat`'s first-action methods (STAFF_GUIDE_ACTIONS) finishing their guides. */
export function withStaffGuideActions(api, hat, hooks) {
  if (!api) return api;
  const after = (feature, write, when = null) => finishesStaffGuide(hat, feature, write, hooks, when);
  if (hat === "steward") return { ...api, triage: after("casework", api.triage, takesRequest), reply: after("messages", api.reply), sendResource: after("messages", api.sendResource) };
  if (hat === "coordinator") return { ...api, assignCase: after("casework", api.assignCase) };
  if (hat === "admin") {
    return { ...api, grantRole: after("people", api.grantRole), rejectLeadershipClaim: after("people", api.rejectLeadershipClaim), inviteMember: after("people", api.inviteMember), resendInvitation: after("people", api.resendInvitation) };
  }
  if (hat === "vp") return { ...api, markReviewed: after("leadership", api.markReviewed) };
  return api;
}

/** The staff guide that finishes when `feature` gets its real action under `hat`, or null. */
export function staffGuideFor(hat, feature) {
  return (STAFF_FEATURE_GUIDES[hat] ?? []).find((entry) => entry.feature === feature) ?? null;
}

/** The roles the server says this person holds in the organization, in the engine's order, once each. */
export function heldStaffRoles(payload) {
  const roles = Array.isArray(payload?.roles) ? payload.roles : [];
  const scopes = new Map();
  for (const entry of roles) {
    const role = typeof entry === "string" ? entry : entry?.role;
    if (!STAFF_GUIDE_ROLES.includes(role)) continue;
    const scope = entry?.scope === "chapter" ? "chapter" : "organization";
    // An organization-wide grant wins over the same role at chapter scope.
    if (!scopes.has(role) || scope === "organization") scopes.set(role, scope);
  }
  return STAFF_GUIDE_ROLES.filter((role) => scopes.has(role)).map((role) => ({ role, scope: scopes.get(role) }));
}

function progressById(payload) {
  const out = new Map();
  for (const row of Array.isArray(payload?.steps) ? payload.steps : []) {
    if (typeof row?.stepId !== "string") continue;
    out.set(row.stepId, { seen: time(row.seenAt), got: time(row.gotAt), reopen: time(row.reopenedAt), completed: time(row.completedAt) });
  }
  return out;
}

const NONE = Object.freeze({ seen: null, got: null, reopen: null, completed: null });

const count = (value) => (Number.isInteger(value) && value >= 0 ? value : null);

/**
 * The selected chapter's unit setup from the server, or null when it sent
 * none, sent it malformed, or (when the caller names the chapter it shows)
 * sent another chapter's facts.
 */
export function chapterUnitSetup(payload, chapterId = undefined) {
  const fact = payload?.chapterUnits;
  if (!fact || typeof fact !== "object") return null;
  if (chapterId !== undefined && fact.chapterId !== chapterId) return null;
  const units = count(fact.units);
  const stewards = count(fact.stewards);
  const without = count(fact.stewardsWithoutUnit);
  if (units === null || stewards === null || without === null || without > stewards) return null;
  return { units, stewards, stewardsWithoutUnit: without, done: units > 0 && without === 0 };
}

function unitParts(entry, setup) {
  return UNIT_SETUP_PARTS.map((id) => ({
    id,
    label: copy(entry.partLabels[id]),
    path: entry.partPaths[id],
    done: id === "create" ? setup.units > 0 : setup.stewardsWithoutUnit === 0,
    status: id === "create"
      ? copy("guideEngine.sf.units.createStatus", { n: setup.units })
      : copy("guideEngine.sf.units.assignStatus", { done: setup.stewards - setup.stewardsWithoutUnit, total: setup.stewards }),
  }));
}

/**
 * R29 for a staff hat. `payload` is get_staff_onboarding_guide(); `hat` the
 * staff hat being worn (anything else shows nothing); `path` the page on
 * screen; `memberPlan` the person's member checklist counts when they hold
 * one ({ completed, total, stalled }), shown as its own group.
 * @param {{ payload: any, hat: string | null, path?: string | null, memberPlan?: { completed: number, total: number, stalled?: boolean } | null, chapterId?: string | null }} input
 */
export function staffFeatureGuides({ payload, hat, path = null, memberPlan = null, chapterId = undefined }) {
  const no = (key, params) => ({ view: null, why: copy(`guideEngine.why.r29.${key}`, params) });
  if (!payload) return no("notRead");
  if (payload.state === "off") return no("off");
  if (payload.state !== "active") return no("notStaff");
  if (!STAFF_GUIDE_ROLES.includes(hat)) return no("memberHat");
  const held = heldStaffRoles(payload);
  const worn = held.find((entry) => entry.role === hat);
  // The hat follows the server's roles: a hat the server does not confirm gets nothing.
  if (!worn) return no("notHeld", { role: copy(staffRoleLabelKey(hat)) });
  const progress = progressById(payload);
  const mark = (stepId) => progress.get(stepId) ?? NONE;
  const several = held.length > 1;
  const setup = chapterUnitSetup(payload, chapterId);
  // The units step shows only to a chapter lead the server sent its facts to.
  const guides = STAFF_FEATURE_GUIDES[hat].filter((entry) => !entry.fromChapter || setup);
  const items = guides.map((entry, index) => {
    const shared = SHARED_STAFF_FEATURES.includes(entry.feature);
    // A shared feature is one guide for every role that uses it: done once,
    // it is done for each (multi-role merge).
    const roles = shared ? held.map((h) => h.role) : [hat];
    const completions = roles.map((role) => mark(`${role}.${entry.feature}`).completed).filter((at) => at !== null);
    const completed = completions.length ? Math.min(...completions) : null;
    const own = mark(entry.stepId);
    // A step that finishes from the chapter is done while its facts hold.
    const done = entry.fromChapter ? setup.done : completed !== null;
    const lines = roles.map((role) => {
      const source = staffGuideFor(role, entry.feature);
      return {
        role,
        roleLabel: copy(staffRoleLabelKey(role, held.find((h) => h.role === role)?.scope)),
        canDo: source.can.map((key) => copy(key)),
        neverDo: source.never.map((key) => copy(key)),
      };
    });
    return {
      stepId: entry.stepId,
      role: hat,
      feature: entry.feature,
      path: entry.path,
      nativeHref: entry.nativeHref,
      title: copy(entry.nameKey),
      // Role chips only when the person holds more than one staff role.
      roleChip: several ? copy(staffRoleLabelKey(hat, worn.scope)) : null,
      countsForAll: several && shared,
      lines,
      about: (entry.about ?? []).map((key) => copy(key)),
      parts: entry.fromChapter ? unitParts(entry, setup) : null,
      askWho: copy(sf(`ask.${hat}`)),
      firstLabel: copy(entry.firstKey),
      doneOnPrimary: entry.doneOnPrimary,
      done,
      // Done before the guide was ever shown, or done first and seen later.
      doneBeforeOpened: done && (own.seen === null || (!entry.fromChapter && completed < own.seen)),
      why: done ? copy("guideEngine.why.r36.done") : index === 0 ? copy("guideEngine.why.r36.core") : copy("guideEngine.why.r36.rest"),
    };
  });
  const open = items.filter((item) => !item.done);
  const done = items.filter((item) => item.done);
  const here = path ? items.find((item) => item.path === path) ?? null : null;
  let showing = null;
  let showingAs = null;
  if (here) {
    const own = mark(here.stepId);
    const seen = own.seen ?? -1;
    const got = own.got ?? -1;
    const reopen = own.reopen ?? -1;
    // The card stays until Got it; reopening from the list brings it back.
    if (seen < 0 || (got < seen && reopen < 0)) { showing = here; showingAs = "first"; }
    else if (reopen > got) { showing = here; showingAs = "reopened"; }
  }
  const roleLabel = copy(staffRoleLabelKey(hat, worn.scope));
  // The first switch into a hat says so once; later switches carry a short note.
  const switchedBefore = mark(roleSwitchStepId(hat)).seen !== null;
  const note = several
    ? (switchedBefore
      ? copy("guideEngine.interstitial.againGuides", { role: roleLabel, n: open.length })
      : copy("guideEngine.interstitial", { role: roleLabel }))
    : null;
  const plan = memberPlan && Number.isFinite(memberPlan.total) && memberPlan.total > 0
    ? { done: Math.max(0, Math.min(memberPlan.total, Math.floor(memberPlan.completed ?? 0))), total: Math.floor(memberPlan.total), stalled: memberPlan.stalled === true }
    : null;
  return {
    view: {
      role: hat,
      roleLabel,
      items: open,
      done,
      next: open[0] ?? null,
      ring: copy("guideEngine.ring.features", { done: done.length, total: items.length }),
      doneCount: done.length,
      total: items.length,
      showing,
      showingAs,
      note,
      firstSwitch: several && !switchedBefore,
      memberSteps: plan ? { ...plan, label: copy("guideEngine.sf.memberSteps", { done: plan.done, total: plan.total }) } : null,
    },
    why: showing
      ? copy("guideEngine.why.r36.showing", { feature: here.title })
      : copy("guideEngine.why.r29.list", { role: roleLabel, count: items.length, done: done.length }),
  };
}
