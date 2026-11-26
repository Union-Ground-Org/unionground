// REQ-UG-ONBOARDING-GUIDE-ENGINE-PORT-STEP3-20261029.
//
// Guide 1, "Getting the organization started" (Batch E rule R35, owner
// amendment 1 and decisions 2.4 and 3.5). One guide per organization, shown
// only to people who hold a role at organization scope with their sign-in
// requirements met; progress is shared across them. Each milestone is done
// when the real thing exists in the organization: the server computes every
// fact on read (public.get_organization_start_guide) and latches the
// organization live once all seven hold, so a milestone that later becomes
// untrue never reopens the guide. Pure: the server payload arrives as input.

export const ORG_START_SWITCH = "features.guidance_onboarding.org_start_guide";

// The seven milestones in the guide's order, with the product screens where
// their checks get done, best first. A screen is offered only when the hat
// being worn can open it (`reachable`), so no button leads to a refusal.
// `check` ties a screen to the check it finishes, so a milestone opens the
// screen for its first unfinished check (REQ-UNIONGROUND-OFFICER-NOTICES-
// WITH-READ-RECEIPTS-20261030: "An announcement" used to open events).
const page = (labelKey, path, check = null) => Object.freeze({ labelKey, path, check });
export const ORG_START_MILESTONES = Object.freeze([
  { id: "structure", titleKey: "guideEngine.org.structure", whyKey: "guideEngine.orgPage.why.structure", checks: ["chapters", "worksites"], opens: [page("guideEngine.orgPage.open.structure", "/m/admin/organization"), page("guideEngine.orgPage.open.structure", "/m/admin/configuration")] },
  { id: "people", titleKey: "guideEngine.org.people", whyKey: "guideEngine.orgPage.why.people", checks: ["staffGrants", "invitationsSent"], opens: [page("guideEngine.orgPage.open.invitations", "/m/admin/invitations"), page("guideEngine.orgPage.open.grants", "/m/admin/access")] },
  { id: "onboarding", titleKey: "guideEngine.org.onboarding", whyKey: "guideEngine.orgPage.why.onboardingReviewed", checks: ["activeSteps", "switchesReviewed"], opens: [page("guideEngine.orgPage.open.onboarding", "/m/support")] },
  { id: "content", titleKey: "guideEngine.org.content", whyKey: "guideEngine.orgPage.why.content", checks: ["announcements", "events", "knowledgeItems"], opens: [page("guideEngine.orgPage.open.notice", "/m/messages?filter=announcement", "announcements"), page("guideEngine.orgPage.open.content", "/m/events-desk", "events"), page("guideEngine.orgPage.open.content", "/m/admin/events", "events"), page("guideEngine.orgPage.open.knowledge", "/m/organize/library", "knowledgeItems")] },
  { id: "ballot", titleKey: "guideEngine.org.ballot", whyKey: "guideEngine.orgPage.why.ballot", checks: ["ballotDraftWithSecrecy"], opens: [page("guideEngine.orgPage.open.ballot", "/m/campaigns")] },
  { id: "support", titleKey: "guideEngine.org.support", whyKey: "guideEngine.orgPage.why.support", checks: ["supportPrograms"], opens: [page("guideEngine.orgPage.open.support", "/m/support")] },
  // Named on the guide itself (save_organization_start_contacts).
  { id: "backups", titleKey: "guideEngine.org.backups", whyKey: "guideEngine.orgPage.why.backups", checks: ["backupNamed", "spokespeople"], opens: [] },
].map((entry) => Object.freeze(entry)));

export const ORG_START_TOTAL = ORG_START_MILESTONES.length;

// The contact pickers' server limits (private.organization_start_people and
// private.organization_start_members, 20261029150000): the first 50 people
// with an organization-wide role and the first 200 active members, by name.
// A full list may be cut, and the guide says so rather than imply everyone is
// listed (BUG-UG-ORG-START-GUIDE-KNOWLEDGE-TARGET-AND-PICKER-CAP-20261102).
export const ORG_START_PEOPLE_LIMIT = 50;
export const ORG_START_MEMBERS_LIMIT = 200;

const copy = (key, params) => (params ? { key, params } : { key });
const count = (value) => (Number.isFinite(value) && value > 0 ? Math.floor(value) : 0);

// The plain-words fact line of a check ("2 chapters", "switches reviewed").
const COUNTED = new Set(["chapters", "worksites", "staffGrants", "invitationsSent", "activeSteps", "announcements", "events", "knowledgeItems", "supportPrograms", "spokespeople"]);
const FLAG_FACT = { switchesReviewed: "switchesReviewed", ballotDraftWithSecrecy: "ballot", backupNamed: "backupNamed" };

function factLine(check) {
  if (COUNTED.has(check.id)) {
    const n = count(check.count);
    return n > 0 ? copy(`guideEngine.orgPage.fact.${check.id}.${n === 1 ? "one" : "other"}`, { n }) : null;
  }
  return check.done && FLAG_FACT[check.id] ? copy(`guideEngine.orgPage.fact.${FLAG_FACT[check.id]}`) : null;
}

function normalizeChecks(milestone, server) {
  const byId = new Map((Array.isArray(server?.checks) ? server.checks : []).map((check) => [check?.id, check]));
  return milestone.checks.map((id) => {
    const raw = byId.get(id) ?? {};
    return { id, done: raw.done === true, count: count(raw.count), adminOnly: raw.adminOnly === true };
  });
}

/**
 * R35: the org-start guide view from the server payload.
 * `null` payload (not read, or the read failed) shows nothing.
 * @param {any} payload get_organization_start_guide()
 * @param {{ reachable?: (path: string) => boolean }} [options]
 * @returns {{ view: null | object, why: { key: string, params?: object } }}
 */
export function orgStartGuide(payload, { reachable = () => false } = {}) {
  const state = payload && typeof payload === "object" ? payload.state : null;
  if (state === "off") return { view: null, why: copy("guideEngine.why.r35.off") };
  if (state === "hidden") return { view: null, why: copy("guideEngine.why.r35.orgWideOnly") };
  if (state === "done") return { view: null, why: copy("guideEngine.why.r35.live") };
  if (state !== "active" && state !== "live") return { view: null, why: copy("guideEngine.why.r35.notRead") };
  const orgName = typeof payload.organizationName === "string" && payload.organizationName.trim() ? payload.organizationName.trim() : "";
  if (state === "live") {
    return {
      view: { kind: "celebrate", orgName, title: copy("guideEngine.org.liveTitle", { org: orgName }), body: copy("guideEngine.org.liveBody") },
      why: copy("guideEngine.why.r35.celebrate"),
    };
  }
  const isAdmin = payload.viewer?.isAdmin === true;
  const adminName = typeof payload.adminName === "string" && payload.adminName.trim() ? payload.adminName.trim() : null;
  const serverMilestones = new Map((Array.isArray(payload.milestones) ? payload.milestones : []).map((entry) => [entry?.id, entry]));
  let nextFound = false;
  const milestones = ORG_START_MILESTONES.map((milestone, index) => {
    const checks = normalizeChecks(milestone, serverMilestones.get(milestone.id));
    const done = checks.every((check) => check.done);
    const open = checks.filter((check) => !check.done);
    const lockedForMe = !done && !isAdmin && open.every((check) => check.adminOnly);
    let state = "done";
    if (!done) {
      if (lockedForMe) state = "needsAdmin";
      else if (!nextFound) { state = "next"; nextFound = true; }
      else state = "notYet";
    }
    const facts = checks.map(factLine).filter(Boolean);
    return {
      id: milestone.id,
      number: index + 1,
      title: copy(milestone.titleKey),
      why: copy(milestone.whyKey),
      state,
      done,
      fact: facts.length === 0 ? copy("guideEngine.orgPage.nothingYet") : facts.length === 1 ? facts[0] : copy("guideEngine.orgPage.factSep", { a: facts[0], b: facts[1] }),
      checks: checks.map((check) => ({
        ...check,
        label: copy(`guideEngine.org.sub.${check.id}`),
        who: copy(check.adminOnly ? "guideEngine.orgPage.who.admin" : "guideEngine.orgPage.who.any"),
        locked: !check.done && check.adminOnly && !isAdmin,
      })),
      lock: lockedForMe ? (adminName ? copy("guideEngine.org.lock.adminOnly", { name: adminName }) : copy("guideEngine.org.lock.adminOnlyNoName")) : null,
      open: done ? null : (() => {
        const openChecks = new Set(open.map((check) => check.id));
        // The full address goes to `reachable`: the notice composer is an
        // address on the inbox that only the posting roles can use.
        const reachableOpens = milestone.opens.filter((entry) => reachable(entry.path));
        const target = reachableOpens.find((entry) => entry.check && openChecks.has(entry.check)) ?? reachableOpens[0] ?? null;
        return target ? { label: copy(target.labelKey), path: target.path } : null;
      })(),
    };
  });
  // UB-UG-ORG-START-BANNER-ON-ESTABLISHED-ORGANIZATION-20261106: a
  // milestone this person can move is one with a screen the worn hat opens,
  // the switch review for an administrator, or the contacts form for someone
  // who may name them. With none, the card offers no "Continue setup".
  const canAct = milestones.some((milestone) => !milestone.done && milestone.state !== "needsAdmin" && (
    milestone.open !== null
    || (milestone.id === "backups" && payload.viewer?.canNameContacts === true)
    || (isAdmin && milestone.checks.some((check) => check.id === "switchesReviewed" && !check.done))
  ));
  const done = milestones.filter((milestone) => milestone.done).length;
  const next = milestones.find((milestone) => milestone.state === "next") ?? milestones.find((milestone) => !milestone.done) ?? null;
  const people = (Array.isArray(payload.people) ? payload.people : [])
    .filter((person) => person && typeof person.name === "string" && person.name.trim())
    .map((person) => ({ userId: person.userId ?? null, name: person.name.trim(), roles: Array.isArray(person.roles) ? person.roles.filter((role) => typeof role === "string") : [] }));
  // Spokespeople may be any active member; the server sends this list only to
  // people who may name them.
  const members = (Array.isArray(payload.members) ? payload.members : [])
    .filter((member) => member && typeof member.userId === "string" && typeof member.name === "string" && member.name.trim())
    .map((member) => ({ userId: member.userId, name: member.name.trim() }));
  const partial = (rows, limit) => (Array.isArray(rows) && rows.length >= limit ? copy("guideEngine.orgPage.contacts.partial", { n: limit }) : null);
  return {
    view: {
      kind: "guide",
      orgName,
      // An organization with any milestone done is already running: the
      // card asks to finish its setup rather than to get it ready.
      title: copy(done > 0 ? "guideEngine.org.cardTitleUnderway" : "guideEngine.org.cardTitle", { org: orgName }),
      eyebrow: copy("guideEngine.org.title"),
      ring: { done, total: ORG_START_TOTAL, percent: Math.round((done / ORG_START_TOTAL) * 100), text: copy("guideEngine.org.ring", { done, total: ORG_START_TOTAL }) },
      next: next ? { id: next.id, title: next.title, line: copy("guideEngine.org.next", { title: next.title }) } : null,
      milestones,
      people,
      members,
      peoplePartial: partial(payload.people, ORG_START_PEOPLE_LIMIT),
      membersPartial: partial(payload.members, ORG_START_MEMBERS_LIMIT),
      isAdmin,
      canAct,
      canReviewSwitches: isAdmin,
      canNameContacts: payload.viewer?.canNameContacts === true,
      contacts: {
        backupUserId: typeof payload.contacts?.backupUserId === "string" ? payload.contacts.backupUserId : null,
        spokespersonUserIds: Array.isArray(payload.contacts?.spokespersonUserIds) ? payload.contacts.spokespersonUserIds.filter((id) => typeof id === "string") : [],
      },
    },
    why: next ? copy("guideEngine.why.r35.progress", { done, total: ORG_START_TOTAL, next: next.title }) : copy("guideEngine.why.r35.celebrate"),
  };
}

/** The milestones that became done between two views, for one polite line each. */
export function newlyDoneMilestones(before, after) {
  if (before?.kind !== "guide" || after?.kind !== "guide") return [];
  const was = new Set(before.milestones.filter((milestone) => milestone.done).map((milestone) => milestone.id));
  return after.milestones.filter((milestone) => milestone.done && !was.has(milestone.id));
}
