// REQ-UG-ONBOARDING-GUIDE-ENGINE-PORT-STEP3-20261029: guide 1,
// "Getting the organization started" (Batch E R35), from the server's
// org-start read: who sees it, the seven milestones and their states, the
// administrator lock, "You're live" once, the copy in both languages, and the
// card's real actions.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { guideEngineCatalogue } from "../src/lib/i18n/guideEngine.js";
import { LanguageProvider } from "../src/lib/LanguageContext.jsx";
import { plan } from "../src/features/onboardingGuideEngine/engine.js";
import { ORG_START_MEMBERS_LIMIT, ORG_START_MILESTONES, ORG_START_PEOPLE_LIMIT, ORG_START_SWITCH, ORG_START_TOTAL, newlyDoneMilestones, orgStartGuide } from "../src/features/onboardingGuideEngine/orgStart.js";
import { ORG_START_RPCS, acknowledgeOrganizationStartCelebration, markOrganizationStartSwitchesReviewed, readOrganizationStartGuide, saveOrganizationStartContacts } from "../src/features/onboardingGuideEngine/orgStartAdapter.js";
import { OrgStartGuide } from "../src/features/onboardingGuideEngine/OrgStartGuide.jsx";
import { expectHeldWriteFocus, expectOneWriteFromOneTick } from "./helpers/busyWriteFocus.js";
import { renderGuideCopy } from "../src/features/onboardingGuideEngine/memberAdapter.js";
import { workspacePageForLocation } from "../src/lib/workspacePages.js";

const MIGRATION = readFileSync(resolve(process.cwd(), "supabase/migrations/20261029150000_organization_start_guide.sql"), "utf8");
const ADMIN = "50913000-0000-4000-8000-000000000101";
const VP = "50913000-0000-4000-8000-000000000102";
const MEMBER = "50913000-0000-4000-8000-000000000103";

const check = (id, done, count = 0, adminOnly = false) => ({ id, done, count, adminOnly });
// The fictional organization of the scenario bank: milestones 1 to 3 done.
function payload(overrides = {}) {
  return {
    state: "active",
    organizationId: "50913000-0000-4000-8000-000000000001",
    organizationName: "Tamarack Valley",
    viewer: { isAdmin: true, canNameContacts: true },
    adminName: "Stacy Paquette",
    milestones: [
      { id: "structure", checks: [check("chapters", true, 2, true), check("worksites", true, 5, true)] },
      { id: "people", checks: [check("staffGrants", true, 5, true), check("invitationsSent", true, 2, true)] },
      { id: "onboarding", checks: [check("activeSteps", true, 6), check("switchesReviewed", true, 0, true)] },
      { id: "content", checks: [check("announcements", false), check("events", true, 1), check("knowledgeItems", false)] },
      { id: "ballot", checks: [check("ballotDraftWithSecrecy", false)] },
      { id: "support", checks: [check("supportPrograms", false)] },
      { id: "backups", checks: [check("backupNamed", false), check("spokespeople", false)] },
    ],
    people: [{ userId: ADMIN, name: "Stacy Paquette", roles: ["admin"] }, { userId: VP, name: "Desmond Okeke", roles: ["vp"] }],
    members: [{ userId: ADMIN, name: "Stacy Paquette" }, { userId: VP, name: "Desmond Okeke" }, { userId: MEMBER, name: "Aaliyah Brooks" }],
    contacts: { backupUserId: null, spokespersonUserIds: [] },
    ...overrides,
  };
}
const everywhere = () => true;
const en = (entry) => renderGuideCopy("en", entry);

describe("R35 org-start guide rules", () => {
  it("defines the switch the server now ships and seven milestones in the guide's order", () => {
    expect(ORG_START_SWITCH).toBe("features.guidance_onboarding.org_start_guide");
    expect(ORG_START_MILESTONES.map((milestone) => milestone.id)).toEqual(["structure", "people", "onboarding", "content", "ballot", "support", "backups"]);
    expect(ORG_START_TOTAL).toBe(7);
  });

  it("shows nothing and says why when the read is missing, hidden, off or done", () => {
    expect(orgStartGuide(null)).toEqual({ view: null, why: { key: "guideEngine.why.r35.notRead" } });
    expect(orgStartGuide({ state: "hidden" })).toEqual({ view: null, why: { key: "guideEngine.why.r35.orgWideOnly" } });
    expect(orgStartGuide({ state: "off" })).toEqual({ view: null, why: { key: "guideEngine.why.r35.off" } });
    expect(orgStartGuide({ state: "done" })).toEqual({ view: null, why: { key: "guideEngine.why.r35.live" } });
    expect(en(orgStartGuide({ state: "hidden" }).why)).toBe("Only organization-wide roles see this guide.");
  });

  it("counts shared progress and names the next milestone (org-half: 3 of 7, next Post your first content)", () => {
    const { view, why } = orgStartGuide(payload(), { reachable: everywhere });
    expect(view.ring).toMatchObject({ done: 3, total: 7 });
    expect(en(view.ring.text)).toBe("3 of 7 milestones");
    expect(en(view.title)).toBe("Finish setting up Tamarack Valley");
    expect(en(view.eyebrow)).toBe("Organization setup");
    expect(en(view.next.line)).toBe("Next: Post your first content");
    expect(view.milestones.map((milestone) => milestone.state)).toEqual(["done", "done", "done", "next", "notYet", "notYet", "notYet"]);
    expect(en(why)).toBe("3 of 7 milestones done; next: Post your first content.");
    expect(en(view.milestones[0].fact)).toBe("2 campaigns · 5 worksites");
    expect(en(view.milestones[3].fact)).toBe("1 meeting");
    expect(en(view.milestones[4].fact)).toBe("Nothing yet");
  });

  it("starts a brand-new organization at 0 of 7 with Set up your structure next", () => {
    const empty = payload({ milestones: payload().milestones.map((milestone) => ({ ...milestone, checks: milestone.checks.map((entry) => ({ ...entry, done: false, count: 0 })) })) });
    const { view } = orgStartGuide(empty, { reachable: everywhere });
    expect(view.ring.done).toBe(0);
    expect(en(view.next.title)).toBe("Set up your structure");
    expect(en(view.title)).toBe("Get Tamarack Valley ready for workers");
  });

  // UB-UG-ORG-START-BANNER-ON-ESTABLISHED-ORGANIZATION-20261106: an
  // established organization with only administrator work left (SAMPLE's
  // Tamarack at 6 of 7, worksites open) offers a steward nothing to do.
  it("lets only people who can move an open milestone act on it, without changing the count", () => {
    const sixOfSeven = (viewer) => payload({ viewer, milestones: payload().milestones.map((milestone) => ({ ...milestone, checks: milestone.checks.map((entry) => ({ ...entry, done: entry.id !== "worksites" })) })) });
    const steward = orgStartGuide(sixOfSeven({ isAdmin: false, canNameContacts: false }), { reachable: everywhere }).view;
    expect(steward.ring).toMatchObject({ done: 6, total: 7 });
    expect(steward.milestones[0].state).toBe("needsAdmin");
    expect(steward.canAct).toBe(false);
    expect(en(steward.title)).toBe("Finish setting up Tamarack Valley");
    const admin = orgStartGuide(sixOfSeven({ isAdmin: true, canNameContacts: true }), { reachable: everywhere }).view;
    expect(admin.ring).toMatchObject({ done: 6, total: 7 });
    expect(admin.canAct).toBe(true);
    // An open milestone whose screen the worn hat cannot open is not an action either.
    expect(orgStartGuide(payload({ viewer: { isAdmin: false, canNameContacts: false } }), { reachable: () => false }).view.canAct).toBe(false);
    // Backups have no screen: naming contacts is the action, for whoever may.
    const onlyBackups = (viewer) => payload({ viewer, milestones: payload().milestones.map((milestone) => (milestone.id === "backups" ? milestone : { ...milestone, checks: milestone.checks.map((entry) => ({ ...entry, done: true })) })) });
    expect(orgStartGuide(onlyBackups({ isAdmin: false, canNameContacts: true }), { reachable: () => false }).view.canAct).toBe(true);
    expect(orgStartGuide(onlyBackups({ isAdmin: false, canNameContacts: false }), { reachable: () => false }).view.canAct).toBe(false);
    // The switch review is an administrator's action with no screen of its own.
    const onlySwitches = (viewer) => payload({ viewer, milestones: payload().milestones.map((milestone) => ({ ...milestone, checks: milestone.checks.map((entry) => ({ ...entry, done: entry.id !== "switchesReviewed" })) })) });
    expect(orgStartGuide(onlySwitches({ isAdmin: true, canNameContacts: true }), { reachable: () => false }).view.canAct).toBe(true);
    expect(orgStartGuide(onlySwitches({ isAdmin: false, canNameContacts: false }), { reachable: () => false }).view.canAct).toBe(false);
  });

  it("locks administrator-only work for other org-wide roles and names who to ask", () => {
    const steward = payload({ viewer: { isAdmin: false, canNameContacts: false }, milestones: payload().milestones.map((milestone) => (milestone.id === "onboarding" ? { ...milestone, checks: [check("activeSteps", true, 6), check("switchesReviewed", false, 0, true)] } : milestone)) });
    const { view } = orgStartGuide(steward, { reachable: everywhere });
    const onboarding = view.milestones.find((milestone) => milestone.id === "onboarding");
    expect(onboarding.state).toBe("needsAdmin");
    expect(en(onboarding.lock)).toBe("Only an administrator can do this. Ask Stacy Paquette.");
    expect(onboarding.checks.find((entry) => entry.id === "switchesReviewed")).toMatchObject({ locked: true });
    // The locked milestone never becomes "next"; the first one this person can do does.
    expect(view.milestones.find((milestone) => milestone.state === "next").id).toBe("content");
    expect(view.canReviewSwitches).toBe(false);
  });

  it("offers a screen only when the hat being worn can open it", () => {
    const none = orgStartGuide(payload(), { reachable: () => false }).view;
    expect(none.milestones.every((milestone) => milestone.open === null)).toBe(true);
    const admin = orgStartGuide(payload(), { reachable: (path) => path === "/m/admin/events" || path === "/m/campaigns" }).view;
    expect(admin.milestones.find((milestone) => milestone.id === "content").open).toEqual({ label: { key: "guideEngine.orgPage.open.content" }, path: "/m/admin/events" });
    // The notice composer is offered when the worn role reaches the inbox.
    const inbox = orgStartGuide(payload(), { reachable: (path) => path === "/m/messages?filter=announcement" || path === "/m/admin/events" }).view;
    expect(inbox.milestones.find((milestone) => milestone.id === "content").open).toEqual({ label: { key: "guideEngine.orgPage.open.notice" }, path: "/m/messages?filter=announcement" });
    // A role that reaches the inbox but cannot post notices (App refuses the
    // composer address for it) is sent to events, never to a dead end.
    const coordinator = orgStartGuide(payload(), { reachable: (path) => path === "/m/messages" || path === "/m/events-desk" }).view;
    expect(coordinator.milestones.find((milestone) => milestone.id === "content").open).toEqual({ label: { key: "guideEngine.orgPage.open.content" }, path: "/m/events-desk" });
    expect(admin.milestones.find((milestone) => milestone.id === "ballot").open.path).toBe("/m/campaigns");
    // A done milestone needs no button.
    expect(admin.milestones[0].open).toBeNull();
  });

  // BUG-UG-ORG-START-GUIDE-KNOWLEDGE-TARGET-AND-PICKER-CAP-20261102.
  it("opens the knowledge editor when knowledge items are the content milestone's only open check", () => {
    const onlyKnowledge = payload({ milestones: payload().milestones.map((milestone) => (milestone.id === "content"
      ? { ...milestone, checks: [check("announcements", true, 1), check("events", true, 1), check("knowledgeItems", false)] } : milestone)) });
    const view = orgStartGuide(onlyKnowledge, { reachable: everywhere }).view;
    expect(view.milestones.find((milestone) => milestone.id === "content").open).toEqual({ label: { key: "guideEngine.orgPage.open.knowledge" }, path: "/m/organize/library" });
    // Announcements still come first while they are open.
    expect(orgStartGuide(payload(), { reachable: everywhere }).view.milestones.find((milestone) => milestone.id === "content").open.path).toBe("/m/messages?filter=announcement");
  });

  it("lets the hats that hold the guide reach the knowledge editor tab through Organize", () => {
    const page = workspacePageForLocation("/m/organize/library");
    expect(page).toMatchObject({ group: "hub", tab: "library" });
    // This edition's admin and vp rails (public form) carry no Organize entry;
    // the guide reads reachability below, so an unreachable step shows no link.
    const app = readFileSync(resolve(process.cwd(), "src/App.jsx"), "utf8");
    expect(app).toContain("reachable: (path) => Boolean(orgStartEntry(path))");
    expect(app).toContain("const item = orgStartEntry(target.path);");
  });

  it("says when a contact picker list may be cut at the server's limit", () => {
    const full = (n) => Array.from({ length: n }, (_, index) => ({ userId: `50913000-0000-4000-8000-${String(index).padStart(12, "0")}`, name: `Person ${String(index).padStart(3, "0")}`, roles: ["admin"] }));
    const small = orgStartGuide(payload(), { reachable: everywhere }).view;
    expect(small.peoplePartial).toBeNull();
    expect(small.membersPartial).toBeNull();
    const big = orgStartGuide(payload({ people: full(ORG_START_PEOPLE_LIMIT), members: full(ORG_START_MEMBERS_LIMIT) }), { reachable: everywhere }).view;
    expect(big.peoplePartial).toEqual({ key: "guideEngine.orgPage.contacts.partial", params: { n: 50 } });
    expect(big.membersPartial).toEqual({ key: "guideEngine.orgPage.contacts.partial", params: { n: 200 } });
    expect(en(big.membersPartial)).toBe("Only the first 200, by name, are listed here. Someone further down the list can't be chosen here yet.");
    // The limits are the migration's own.
    expect(MIGRATION).toMatch(new RegExp(`limit ${ORG_START_PEOPLE_LIMIT}\\n`));
    expect(MIGRATION).toMatch(new RegExp(`limit ${ORG_START_MEMBERS_LIMIT}\\n`));
  });


  it("reports a milestone finished between two reads once", () => {
    const before = orgStartGuide(payload(), { reachable: everywhere }).view;
    const after = orgStartGuide(payload({ milestones: payload().milestones.map((milestone) => (milestone.id === "ballot" ? { ...milestone, checks: [check("ballotDraftWithSecrecy", true, 1)] } : milestone)) }), { reachable: everywhere }).view;
    expect(newlyDoneMilestones(before, after).map((milestone) => milestone.id)).toEqual(["ballot"]);
    expect(newlyDoneMilestones(after, after)).toEqual([]);
  });

  it("is plan()'s R35 when a staff hat supplies the read", () => {
    const view = plan({ now: Date.UTC(2026, 9, 29), hat: "member", switches: {}, guide: null, guideFailed: false, orgStart: { payload: payload(), reachable: everywhere } });
    expect(view.orgStart.ring.done).toBe(3);
    expect(view.decisions.find((entry) => entry.rule === "R35").why.key).toBe("guideEngine.why.r35.progress");
  });
});

describe("org-start copy", () => {
  it("has every line the guide renders in English and Spanish", () => {
    const keys = new Set();
    const collect = (entry) => {
      if (!entry || typeof entry !== "object") return;
      if (typeof entry.key === "string" && entry.key.startsWith("guideEngine.")) keys.add(entry.key);
      Object.values(entry).forEach((value) => (Array.isArray(value) ? value.forEach(collect) : collect(value)));
    };
    collect(orgStartGuide(payload(), { reachable: everywhere }));
    collect(orgStartGuide(payload({ viewer: { isAdmin: false }, adminName: null }), { reachable: everywhere }));
    for (const state of ["hidden", "off", "done", "live"]) collect(orgStartGuide({ state, organizationName: "Tamarack Valley" }));
    const source = ["OrgStartGuide.jsx", "OrgStartGuideCard.jsx"]
      .map((name) => readFileSync(resolve(process.cwd(), "src/features/onboardingGuideEngine", name), "utf8")).join("\n");
    for (const match of source.matchAll(/"(guideEngine\.[\w.]+)"/g)) keys.add(match[1]);
    for (const n of ["one", "other"]) for (const id of ["chapters", "worksites", "staffGrants", "invitationsSent", "activeSteps", "announcements", "events", "knowledgeItems", "supportPrograms", "spokespeople"]) keys.add(`guideEngine.orgPage.fact.${id}.${n}`);
    for (const key of keys) {
      expect(guideEngineCatalogue.en[key], key).toEqual(expect.any(String));
      expect(guideEngineCatalogue.es[key], key).toEqual(expect.any(String));
    }
    expect(renderGuideCopy("es", { key: "guideEngine.org.ring", params: { done: 3, total: 7 } })).toBe("3 de 7 etapas");
  });
});

describe("org-start server doors", () => {
  it("names every RPC literally and passes the writers' arguments", async () => {
    const calls = [];
    const client = { rpc: vi.fn(async (name, args) => { calls.push([name, args]); return { data: { state: "active" }, error: null }; }) };
    await readOrganizationStartGuide(client);
    await markOrganizationStartSwitchesReviewed(client);
    await saveOrganizationStartContacts(client, { backupUserId: VP, spokespersonUserIds: [ADMIN] });
    await acknowledgeOrganizationStartCelebration(client);
    expect(calls).toEqual([
      ["get_organization_start_guide", undefined],
      ["mark_organization_start_switches_reviewed", undefined],
      ["save_organization_start_contacts", { p_backup_user_id: VP, p_spokesperson_user_ids: [ADMIN] }],
      ["acknowledge_organization_start_celebration", undefined],
    ]);
    expect(Object.values(ORG_START_RPCS).sort()).toEqual(calls.map(([name]) => name).sort());
    await expect(readOrganizationStartGuide({ rpc: async () => ({ data: null, error: { code: "42501", message: "no" } }) })).rejects.toMatchObject({ code: "42501" });
  });

  it("defines the three guidance switches default on and organization editable, and the read for org-wide roles only", () => {
    for (const key of ["feature_guides", "coach_marks", "org_start_guide"]) {
      expect(MIGRATION).toMatch(new RegExp(`'features\\.guidance_onboarding\\.${key}', 'boolean', '(?:[^']|'')+',\\s*'(?:[^']|'')+',\\s*'true', null, null, null, 13[0-2]0, 'guidance_onboarding', true, true\\)`));
    }
    expect(MIGRATION).toMatch(/has_organization_role\(org, array\['steward','coordinator','advisor','admin','vp'\]\)/);
    expect(MIGRATION).toMatch(/return pg_catalog\.jsonb_build_object\('state', 'hidden'\)/);
    expect(MIGRATION).toMatch(/revoke all on table private\.organization_start_guide_state from public, anon, authenticated, service_role/);
    for (const name of Object.values(ORG_START_RPCS)) {
      expect(MIGRATION).toMatch(new RegExp(`create function public\\.${name}\\([^)]*\\)\\nreturns jsonb\\nlanguage plpgsql\\nvolatile\\nsecurity definer\\nset search_path = ''`));
      expect(MIGRATION).toMatch(new RegExp(`grant execute on function public\\.${name}\\([^)]*\\) to authenticated;`));
    }
  });
});

function renderCard(view, handlers = {}) {
  const props = { onOpen: vi.fn(), onReviewSwitches: vi.fn(async () => null), onSaveContacts: vi.fn(async () => null), onCelebrated: vi.fn(async () => null), ...handlers };
  const result = render(<LanguageProvider lang="en"><OrgStartGuide guide={{ view }} {...props} /></LanguageProvider>);
  return { ...result, props };
}

describe("org-start card", () => {

  it("opens meetings once the announcement is done and meetings are not", () => {
    const pending = payload({ milestones: payload().milestones.map((milestone) => (milestone.id === "content" ? { ...milestone, checks: [check("announcements", true, 1), check("events", false), check("knowledgeItems", false)] } : milestone)) });
    const content = orgStartGuide(pending, { reachable: everywhere }).view.milestones.find((milestone) => milestone.id === "content");
    expect(content.open).toEqual({ label: { key: "guideEngine.orgPage.open.content" }, path: "/m/events-desk" });
  });

  // Record 8435: the contacts Save keeps focus while it saves, and a second
  // activation in the same tick sends no second save.
  it("keeps the contacts Save focused while it saves, and saves once in one tick", async () => {
    const onSaveContacts = vi.fn(async () => null);
    renderCard(orgStartGuide(payload(), { reachable: everywhere }).view, { onSaveContacts });
    fireEvent.click(screen.getByRole("button", { name: "Continue setup" }));
    fireEvent.click(screen.getByRole("button", { name: /Name backups and spokespeople/ }));
    await expectHeldWriteFocus(onSaveContacts, screen.getByRole("button", { name: "Save" }));
    expect(onSaveContacts).toHaveBeenCalledTimes(1);
    const save = screen.getByRole("button", { name: "Save" });
    await act(async () => {});
    expect(save).not.toHaveAttribute("aria-disabled");
    await expectOneWriteFromOneTick(onSaveContacts, [() => fireEvent.click(save), () => fireEvent.click(save)]);
  });

  it("records the switch review for an administrator and names the backup and spokespeople", async () => {
    const pending = payload({ milestones: payload().milestones.map((milestone) => (milestone.id === "onboarding" ? { ...milestone, checks: [check("activeSteps", true, 6), check("switchesReviewed", false, 0, true)] } : milestone)) });
    const { props } = renderCard(orgStartGuide(pending, { reachable: everywhere }).view);
    fireEvent.click(screen.getByRole("button", { name: "Continue setup" }));
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "These switches look right" })); });
    expect(props.onReviewSwitches).toHaveBeenCalledTimes(1);
    expect(screen.getByText("Switches reviewed")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /Name backups and spokespeople/ }));
    fireEvent.change(screen.getByLabelText("Backup"), { target: { value: VP } });
    // The backup holds an organization-wide role; any active member may be a spokesperson.
    expect([...screen.getByLabelText("Backup").querySelectorAll("option")].map((option) => option.textContent)).toEqual(["No backup yet", "Stacy Paquette", "Desmond Okeke"]);
    fireEvent.click(screen.getByRole("checkbox", { name: "Aaliyah Brooks" }));
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Save" })); });
    expect(props.onSaveContacts).toHaveBeenCalledWith({ backupUserId: VP, spokespersonUserIds: [MEMBER] });
    expect(screen.getByText("Backup and spokespeople saved.")).toBeTruthy();
  });


  it("shows a committee worker of an established organization its progress with no Continue setup", () => {
    const established = payload({ viewer: { isAdmin: false, canNameContacts: false }, milestones: payload().milestones.map((milestone) => ({ ...milestone, checks: milestone.checks.map((entry) => ({ ...entry, done: entry.id !== "worksites" })) })) });
    renderCard(orgStartGuide(established, { reachable: everywhere }).view);
    expect(screen.getByRole("heading", { name: "Finish setting up Tamarack Valley" })).toBeTruthy();
    expect(screen.getByText("6 of 7 milestones")).toBeTruthy();
    expect(screen.getByText("Nothing here needs you; an administrator finishes the rest.")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Continue setup" })).toBeNull();
    expect(screen.queryByText(/^Next:/)).toBeNull();
    expect(screen.queryByText("Everyone with an organization-wide role sees this list and its progress.")).toBeNull();
  });

  it("closes the celebration with Done", async () => {
    const { props } = renderCard(orgStartGuide({ state: "live", organizationName: "Tamarack Valley" }).view);
    expect(screen.getByRole("heading", { name: "Tamarack Valley is live" })).toBeTruthy();
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Done" })); });
    expect(props.onCelebrated).toHaveBeenCalledTimes(1);
  });

  // #9895 (W9-7 of #9463): a Done the server does not take used to be
  // swallowed, with no working state and no word; the card just stayed.
  it("keeps Done busy while it saves and says under it when the server does not take it", async () => {
    let refuse;
    const onCelebrated = vi.fn(() => new Promise((_, reject) => { refuse = reject; }));
    const { container } = renderCard(orgStartGuide({ state: "live", organizationName: "Tamarack Valley" }).view, { onCelebrated });
    const done = screen.getByRole("button", { name: "Done" });
    // The region is in the accessibility tree before any failure: its own
    // class keeps it out of the shared .org-start__status:empty display none,
    // and its :empty rule only takes it out of the layout.
    const status = container.querySelector(".org-start__done-status");
    expect(screen.getAllByRole("status")).toContain(status);
    expect(status).not.toHaveClass("org-start__status");
    expect(status).toHaveTextContent("");
    const css = readFileSync(resolve(process.cwd(), "src/features/onboardingGuideEngine/OrgStartGuide.css"), "utf8");
    expect(css).toMatch(/\.org-start__done-status:empty\s*\{\s*position:\s*absolute;\s*margin:\s*0;\s*\}/u);
    expect(css).not.toMatch(/\.org-start__done-status[^{]*\{[^}]*(display:\s*none|visibility:\s*hidden)/u);
    await act(async () => { fireEvent.click(done); fireEvent.click(done); });
    expect(onCelebrated).toHaveBeenCalledTimes(1);
    expect(done).toHaveAttribute("aria-busy", "true");
    await act(async () => { refuse(new Error("refused")); });
    expect(done).not.toHaveAttribute("aria-busy");
    expect(status).toHaveTextContent("That didn't save. Try again.");
  });

  it("renders nothing without a view", () => {
    const { container } = renderCard(null);
    expect(container.innerHTML).toBe("");
  });
});
