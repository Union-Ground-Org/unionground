// REQ-UG-ONBOARDING-GUIDE-ENGINE-PORT-STEP4-20261029: guide 2 for the
// five staff keys (Batch E R29 with R36's card rules), from the server's staff
// guide read: it follows the hat worn at organization or chapter scope, counts
// a shared feature once for a person with several roles, finishes on the real
// first action even when never opened, keeps the member checklist apart, and
// speaks both languages.
import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { act, render, renderHook, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { guideEngineCatalogue } from "../src/lib/i18n/guideEngine.js";
import { LanguageProvider } from "../src/lib/LanguageContext.jsx";
import { plan } from "../src/features/onboardingGuideEngine/engine.js";
import { renderGuideCopy } from "../src/features/onboardingGuideEngine/memberAdapter.js";
import {
  SHARED_STAFF_FEATURES,
  STAFF_FEATURE_GUIDES,
  STAFF_GUIDE_ACTIONS,
  STAFF_GUIDE_ROLES,
  STAFF_GUIDE_STEP_IDS,
  STAFF_GUIDE_SWITCH,
  UNIT_SETUP_PARTS,
  chapterUnitSetup,
  heldStaffRoles,
  roleSwitchStepId,
  staffFeatureGuides,
  withStaffGuideActions,
} from "../src/features/onboardingGuideEngine/staffGuides.js";
import { STAFF_GUIDE_RPCS, completeStaffOnboardingStep, markStaffOnboardingStep, readStaffOnboardingGuide, useStaffOnboardingGuide } from "../src/features/onboardingGuideEngine/staffGuideAdapter.js";
import { StaffFeatureGuide, StaffGuideList } from "../src/features/onboardingGuideEngine/StaffGuides.jsx";
import { STAFF_ROLE_NAVIGATION } from "../src/lib/staffNavigation.js";
import { TAB_PAGE_GROUPS } from "../src/lib/workspacePages.js";
import { CHAPTER_SETUP_CHANGED_EVENT, CHAPTER_SETUP_UNDO_KINDS, announceChapterSetupAfter, announceChapterSetupChanged } from "../src/lib/onboardingGuide.js";
import { announceLearningUndone, useLearningUndone } from "../src/features/learningPeriod/undoneSignal.js";

const MIGRATION = readFileSync(resolve(process.cwd(), "supabase/migrations/20261030010000_staff_onboarding_guides.sql"), "utf8");
// The step allowlist as last defined (REQ-UG-MULTI-UNIT-SETUP-GUIDE-20261109 added the units steps).
const ALLOWLIST_MIGRATION = readdirSync(resolve(process.cwd(), "supabase/migrations")).filter((name) => name.endsWith(".sql")).sort()
  .map((name) => readFileSync(resolve(process.cwd(), "supabase/migrations", name), "utf8"))
  .filter((text) => /function private\.staff_onboarding_step_known\(/.test(text)).at(-1);
const ORG = "50914000-0000-4000-8000-000000000001";
const at = (minutes) => new Date(Date.UTC(2026, 9, 29, 16, minutes)).toISOString();

const payload = (roles, steps = []) => ({ state: "active", organizationId: ORG, roles, steps });
const steward = [{ role: "steward", scope: "organization" }];
const en = (entry) => renderGuideCopy("en", entry);

describe("staff feature guides: who gets them", () => {
  it("shows nothing until read, when off, for a worker, and for a hat the server does not confirm", () => {
    expect(staffFeatureGuides({ payload: null, hat: "steward" })).toMatchObject({ view: null, why: { key: "guideEngine.why.r29.notRead" } });
    expect(staffFeatureGuides({ payload: { state: "off", organizationId: ORG }, hat: "steward" }).why.key).toBe("guideEngine.why.r29.off");
    expect(staffFeatureGuides({ payload: { state: "hidden" }, hat: "steward" }).why.key).toBe("guideEngine.why.r29.notStaff");
    expect(staffFeatureGuides({ payload: payload(steward), hat: "member" }).why.key).toBe("guideEngine.why.r29.memberHat");
    expect(staffFeatureGuides({ payload: payload(steward), hat: "coordinator" })).toMatchObject({ view: null, why: { key: "guideEngine.why.r29.notHeld" } });
  });

  it("follows the hat at campaign scope too (decision 2.2): a campaign committee worker gets the committee worker guides", () => {
    const { view } = staffFeatureGuides({ payload: payload([{ role: "steward", scope: "chapter" }]), hat: "steward" });
    expect(view.items.map((item) => item.feature)).toEqual(["casework", "messages", "settings"]);
  });

  it("starts a new committee worker with Issue work next and the ring at 0 of 3 (s-new)", () => {
    const { view, why } = staffFeatureGuides({ payload: payload(steward), hat: "steward", path: "/m/steward" });
    expect(view.next.feature).toBe("casework");
    expect(en(view.ring)).toBe("0 of 3 feature guides done");
    expect(view.showing).toBeNull();
    expect(view.note).toBeNull();
    expect(en(why)).toBe("Feature guides for the role you're working as (Committee member): 3, 0 done.");
  });

  it("orders each role's core feature first, then the campaign's units for the administrator and vp, then Messages, then Settings", () => {
    const first = Object.fromEntries(STAFF_GUIDE_ROLES.map((role) => [role, STAFF_FEATURE_GUIDES[role][0].feature]));
    expect(first).toEqual({ steward: "casework", coordinator: "casework", advisor: "chapter-health", admin: "people", vp: "leadership" });
    for (const role of STAFF_GUIDE_ROLES) {
      expect(STAFF_FEATURE_GUIDES[role].slice(1).map((entry) => entry.feature)).toEqual(["admin", "vp"].includes(role) ? ["units", "messages", "settings"] : ["messages", "settings"]);
    }
  });

  it("opens every guide, and each part of the units step, on a page the role's own navigation reaches", () => {
    for (const role of STAFF_GUIDE_ROLES) {
      const paths = new Set([...STAFF_ROLE_NAVIGATION[role].map((item) => item.path), `/m/${role}`, "/m/settings", "/m/messages"]);
      // A tab or section page under a navigation line, as guide 1's pages are reached,
      // or a sibling tab of a tabbed page the navigation opens (the hub's tab bar
      // shows Record beside Organize).
      const tabbed = (path) => Object.values(TAB_PAGE_GROUPS).some((group) => group.tabs.some((tab) => `${group.base}/${tab}` === path)
        && group.tabs.some((tab) => paths.has(`${group.base}/${tab}`)) && !(group.staffOnlyTabs ?? []).includes(path.slice(group.base.length + 1)));
      const reached = (path) => paths.has(path) || [...paths].some((base) => path.startsWith(`${base}/`)) || tabbed(path);
      for (const entry of STAFF_FEATURE_GUIDES[role]) {
        expect(reached(entry.path), `${entry.stepId} ${entry.path}`).toBe(true);
        for (const id of entry.partPaths ? UNIT_SETUP_PARTS : []) expect(reached(entry.partPaths[id]), `${entry.stepId} ${id}`).toBe(true);
      }
    }
  });
});

describe("staff feature guides: progress", () => {
  it("finishes a guide done before it was opened and says so (f-done-without-opening)", () => {
    const { view } = staffFeatureGuides({ payload: payload(steward, [{ stepId: "steward.casework", completedAt: at(5) }]), hat: "steward", path: "/m/steward/requests" });
    expect(en(view.ring)).toBe("1 of 3 feature guides done");
    expect(view.next.feature).toBe("messages");
    expect(view.showing).toMatchObject({ feature: "casework", done: true, doneBeforeOpened: true });
    expect(view.showingAs).toBe("first");
  });

  it("shows a card the first time its page is reached, keeps it until Got it, and brings it back when reopened", () => {
    const where = { hat: "steward", path: "/m/steward/messages" };
    expect(staffFeatureGuides({ payload: payload(steward), ...where }).view.showingAs).toBe("first");
    const seen = [{ stepId: "steward.messages", seenAt: at(1) }];
    expect(staffFeatureGuides({ payload: payload(steward, seen), ...where }).view.showingAs).toBe("first");
    const got = [{ stepId: "steward.messages", seenAt: at(1), gotAt: at(2) }];
    expect(staffFeatureGuides({ payload: payload(steward, got), ...where }).view.showing).toBeNull();
    const reopened = [{ stepId: "steward.messages", seenAt: at(1), gotAt: at(2), reopenedAt: at(3) }];
    expect(staffFeatureGuides({ payload: payload(steward, reopened), ...where }).view.showingAs).toBe("reopened");
    // Seen first and done later is not "done before you opened this guide".
    const doneAfter = [{ stepId: "steward.messages", seenAt: at(1), completedAt: at(4) }];
    expect(staffFeatureGuides({ payload: payload(steward, doneAfter), ...where }).view.showing.doneBeforeOpened).toBe(false);
  });

  it("merges a person's roles: a shared feature counts once for both, a role-only one keeps its chip (combo)", () => {
    const roles = [{ role: "steward", scope: "organization" }, { role: "advisor", scope: "chapter" }];
    const asAdvisor = staffFeatureGuides({ payload: payload(roles, [{ stepId: "steward.messages", completedAt: at(3) }]), hat: "advisor", path: "/m/messages" }).view;
    expect(asAdvisor.done.map((item) => item.feature)).toEqual(["messages"]);
    const messages = asAdvisor.showing;
    expect(messages.countsForAll).toBe(true);
    expect(messages.lines.map((line) => line.role)).toEqual(["steward", "advisor"]);
    expect(asAdvisor.items[0]).toMatchObject({ feature: "chapter-health", countsForAll: false, roleChip: { key: "guideEngine.role.advisor" } });
    expect(en(asAdvisor.ring)).toBe("1 of 3 feature guides done");
    // The first switch into a hat says so; later switches carry the note.
    expect(asAdvisor.firstSwitch).toBe(true);
    expect(en(asAdvisor.note)).toBe("You're now working as Campaign Advisor");
    const later = staffFeatureGuides({ payload: payload(roles, [{ stepId: roleSwitchStepId("advisor"), seenAt: at(1) }]), hat: "advisor" }).view;
    expect(later.firstSwitch).toBe(false);
    expect(en(later.note)).toBe("Working as Campaign Advisor · 3 guides left");
  });

  it("never mixes in the worker checklist: it is its own group with the worker's own counts (s-staff-member-plan)", () => {
    const { view } = staffFeatureGuides({ payload: payload(steward), hat: "steward", memberPlan: { completed: 1, total: 6 } });
    expect(view.total).toBe(3);
    expect(en(view.memberSteps.label)).toBe("Worker steps (1 of 6)");
    expect(staffFeatureGuides({ payload: payload(steward), hat: "steward", memberPlan: { completed: 0, total: 0 } }).view.memberSteps).toBeNull();
  });

  it("reads the role list defensively: unknown roles drop and an organization grant wins over campaign scope", () => {
    expect(heldStaffRoles({ roles: [{ role: "vp", scope: "chapter" }, { role: "vp", scope: "organization" }, { role: "member" }, "steward"] }))
      .toEqual([{ role: "steward", scope: "organization" }, { role: "vp", scope: "organization" }]);
  });

  it("carries the staff view on plan() and puts its reason on R29", () => {
    const view = plan({ now: Date.now(), hat: "member", staff: { payload: payload(steward), hat: "steward", path: "/m/steward" } });
    expect(view.staffGuides.next.feature).toBe("casework");
    expect(view.decisions.find((row) => row.rule === "R29").why.key).toBe("guideEngine.why.r29.list");
    expect(plan({ now: Date.now(), hat: "member" }).staffGuides).toBeNull();
  });
});

describe("staff feature guides: the real first action", () => {
  const hooks = () => {
    let scope = "user-a:org";
    const finish = vi.fn();
    return { finish, setScope: (value) => { scope = value; }, hooks: { scope: () => scope, finish } };
  };

  it("finishes Issue work only when a committee worker takes (acknowledges) a request, after the write lands", async () => {
    const { finish, hooks: h } = hooks();
    const api = { triage: vi.fn(async () => ({ ok: true })), loadDesk: vi.fn() };
    const wrapped = withStaffGuideActions(api, "steward", h);
    expect(wrapped.loadDesk).toBe(api.loadDesk);
    await wrapped.triage("request-1", "close");
    expect(finish).not.toHaveBeenCalled();
    await expect(wrapped.triage("request-1", "acknowledge")).resolves.toEqual({ ok: true });
    expect(finish).toHaveBeenCalledWith("steward", "casework");
  });

  it("finishes nothing when the write fails or the person changed while it ran", async () => {
    const { finish, setScope, hooks: h } = hooks();
    const failing = withStaffGuideActions({ assignCase: vi.fn(async () => { throw new Error("refused"); }) }, "coordinator", h);
    await expect(failing.assignCase("case-1", "steward-1")).rejects.toThrow("refused");
    const slow = withStaffGuideActions({ markReviewed: vi.fn(async () => { setScope("user-b:org"); return true; }) }, "vp", h);
    await slow.markReviewed("case-2");
    expect(finish).not.toHaveBeenCalled();
  });

  it("maps every first action to a guide of its own role and wraps exactly those methods", async () => {
    for (const [role, methods] of Object.entries(STAFF_GUIDE_ACTIONS)) {
      const api = Object.fromEntries(Object.keys(methods).map((name) => [name, vi.fn(async () => "ok")]));
      const finish = vi.fn();
      const wrapped = withStaffGuideActions({ ...api, loadDesk: vi.fn() }, role, { scope: () => "same", finish });
      for (const [name, feature] of Object.entries(methods)) {
        expect(STAFF_FEATURE_GUIDES[role].some((entry) => entry.feature === feature), `${role} ${feature}`).toBe(true);
        expect(wrapped[name]).not.toBe(api[name]);
        await wrapped[name]("id", "acknowledge");
        expect(finish).toHaveBeenLastCalledWith(role, feature);
      }
    }
  });
});

describe("staff feature guides: server contract", () => {
  it("names each RPC literally and passes the step and key", async () => {
    const rpc = vi.fn(async () => ({ data: { state: "hidden" }, error: null }));
    await readStaffOnboardingGuide({ rpc });
    await completeStaffOnboardingStep({ rpc }, "steward.casework", "key-1");
    await markStaffOnboardingStep({ rpc }, "steward.casework", "got");
    expect(rpc.mock.calls).toEqual([
      [STAFF_GUIDE_RPCS.read],
      [STAFF_GUIDE_RPCS.complete, { p_step_id: "steward.casework", p_idempotency_key: "key-1" }],
      [STAFF_GUIDE_RPCS.mark, { p_step_id: "steward.casework", p_mark: "got" }],
    ]);
    await expect(readStaffOnboardingGuide({ rpc: async () => ({ data: null, error: { message: "nope", code: "42501" } }) })).rejects.toThrow();
  });

  it("accepts on the server exactly the steps the client defines, and rides the Feature guides switch", () => {
    for (const stepId of [...STAFF_GUIDE_STEP_IDS, ...STAFF_GUIDE_ROLES.map(roleSwitchStepId)]) expect(ALLOWLIST_MIGRATION).toContain(`'${stepId}'`);
    expect(MIGRATION).toContain(`'${STAFF_GUIDE_SWITCH}'`);
    expect(MIGRATION).not.toMatch(/insert into public\.platform_setting_definitions/);
    // Kept apart from the member checklist.
    expect(MIGRATION).not.toMatch(/(insert into|update) public\.(member_onboarding_plans|organization_onboarding_steps)/);
  });

  it("drops an answer that arrives for an earlier person", async () => {
    const reads = [];
    const client = { rpc: vi.fn(() => new Promise((resolve) => { reads.push(resolve); })) };
    const { result, rerender } = renderHook((props) => useStaffOnboardingGuide(props), { initialProps: { client, enabled: true, scope: "a:org" } });
    rerender({ client, enabled: true, scope: "b:org" });
    await waitFor(() => expect(reads).toHaveLength(2));
    await act(async () => { reads[0]({ data: payload(steward), error: null }); });
    expect(result.current.payload).toBeNull();
    const fresh = payload([{ role: "admin", scope: "organization" }]);
    await act(async () => { reads[1]({ data: fresh, error: null }); });
    expect(result.current.payload).toEqual(fresh);
  });

  it("makes a fresh idempotency key per write, with or without crypto.randomUUID, and reads an empty answer as nothing", async () => {
    const rpc = vi.fn(async () => undefined);
    await expect(completeStaffOnboardingStep({ rpc }, "steward.casework")).resolves.toBeNull();
    vi.stubGlobal("crypto", undefined);
    try {
      await completeStaffOnboardingStep({ rpc }, "steward.casework");
    } finally {
      vi.unstubAllGlobals();
    }
    const [first, second] = rpc.mock.calls.map(([, args]) => args.p_idempotency_key);
    expect(first).toMatch(/^[0-9a-f-]{36}$/);
    expect(second).toMatch(/^\d+-[0-9a-z]*$/);
    await expect(markStaffOnboardingStep({ rpc: async () => ({ data: undefined, error: null }) }, "steward.casework", "seen")).resolves.toBeNull();
  });

  it("stays off and never calls the server when the switch is off or there is no client", async () => {
    const rpc = vi.fn(async () => ({ data: payload(steward), error: null }));
    const client = { rpc };
    const off = renderHook(() => useStaffOnboardingGuide({ client, enabled: false, scope: "a:org" }));
    await act(async () => { window.dispatchEvent(new Event("focus")); });
    await expect(off.result.current.complete("steward.casework")).resolves.toBeNull();
    await expect(off.result.current.mark("steward.casework", "got")).resolves.toBeNull();
    expect(off.result.current.payload).toBeNull();
    const clientless = renderHook(() => useStaffOnboardingGuide({ client: null, enabled: true, scope: "a:org" }));
    await act(async () => { await clientless.result.current.reload(); });
    await expect(clientless.result.current.complete("steward.casework")).resolves.toBeNull();
    expect(clientless.result.current.payload).toBeNull();
    expect(rpc).not.toHaveBeenCalled();
    off.unmount();
    clientless.unmount();
  });

  it("re-reads on focus and on a new refresh key, shows nothing after a failed read, and stops listening on unmount", async () => {
    const first = payload(steward);
    const rpc = vi.fn(async () => ({ data: first, error: null }));
    const { result, rerender, unmount } = renderHook((props) => useStaffOnboardingGuide(props), { initialProps: { client: { rpc }, enabled: true, scope: "a:org", refreshKey: 1 } });
    await waitFor(() => expect(result.current.payload).toEqual(first));
    rpc.mockResolvedValueOnce({ data: null, error: { message: "nope", code: "42501" } });
    await act(async () => { window.dispatchEvent(new Event("focus")); });
    await waitFor(() => expect(result.current.payload).toBeNull());
    expect(rpc).toHaveBeenCalledTimes(2);
    rerender({ client: { rpc }, enabled: true, scope: "a:org", refreshKey: 2 });
    await waitFor(() => expect(result.current.payload).toEqual(first));
    expect(rpc).toHaveBeenCalledTimes(3);
    unmount();
    window.dispatchEvent(new Event("focus"));
    expect(rpc).toHaveBeenCalledTimes(3);
  });

  it("keeps a write's answer for the same person, drops it for a new one, and shows nothing new when a write fails", async () => {
    const seen = payload(steward, [{ id: "steward.casework", seenAt: at(1) }]);
    const done = payload(steward, [{ id: "steward.casework", completedAt: at(2) }]);
    const rpc = vi.fn(async (name) => ({ data: name === STAFF_GUIDE_RPCS.read ? payload(steward) : name === STAFF_GUIDE_RPCS.mark ? seen : done, error: null }));
    const client = { rpc };
    const { result, rerender } = renderHook((props) => useStaffOnboardingGuide(props), { initialProps: { client, enabled: true, scope: "a:org" } });
    await waitFor(() => expect(result.current.payload).toEqual(payload(steward)));
    await act(async () => { await expect(result.current.mark("steward.casework", "seen")).resolves.toEqual(seen); });
    expect(result.current.payload).toEqual(seen);
    expect(rpc).toHaveBeenLastCalledWith(STAFF_GUIDE_RPCS.mark, { p_step_id: "steward.casework", p_mark: "seen" });
    await act(async () => { await expect(result.current.complete("steward.casework")).resolves.toEqual(done); });
    expect(result.current.payload).toEqual(done);
    rpc.mockResolvedValueOnce({ data: null, error: { message: "refused", code: "42501" } });
    await act(async () => { await expect(result.current.complete("steward.casework")).resolves.toBeNull(); });
    expect(result.current.payload).toEqual(done);
    let land;
    rpc.mockImplementationOnce(() => new Promise((resolve) => { land = resolve; }));
    let pending;
    act(() => { pending = result.current.complete("steward.casework"); });
    rerender({ client, enabled: true, scope: "b:org" });
    await waitFor(() => expect(result.current.payload).toEqual(payload(steward)));
    await act(async () => { land({ data: done, error: null }); await pending; });
    expect(result.current.payload).toEqual(payload(steward));
  });
});

// REQ-UG-MULTI-UNIT-SETUP-GUIDE-20261109 (#7674): the chapter lead's
// units step finishes from the selected chapter's facts, never from a click.
describe("staff feature guides: the campaign's units", () => {
  const admin = [{ role: "admin", scope: "chapter" }];
  const lead = [{ role: "vp", scope: "chapter" }];
  const withUnits = (roles, units, steps = []) => ({ ...payload(roles, steps), chapterUnits: units });
  const unitsItem = (view) => [...view.items, ...view.done].find((item) => item.feature === "units") ?? null;

  it("shows the step only to a lead the server sent the campaign's facts to, and drops malformed facts", () => {
    expect(staffFeatureGuides({ payload: payload(admin), hat: "admin" }).view.items.map((item) => item.feature)).toEqual(["people", "messages", "settings"]);
    const view = staffFeatureGuides({ payload: withUnits(admin, { chapterId: "c", units: 0, stewards: 2, stewardsWithoutUnit: 2 }), hat: "admin" }).view;
    expect(view.items.map((item) => item.feature)).toEqual(["people", "units", "messages", "settings"]);
    expect(en(view.ring)).toBe("0 of 4 feature guides done");
    for (const bad of [null, "3", { units: -1, stewards: 0, stewardsWithoutUnit: 0 }, { units: 1, stewards: 1, stewardsWithoutUnit: 2 }, { units: 1.5, stewards: 0, stewardsWithoutUnit: 0 }]) {
      expect(chapterUnitSetup({ chapterUnits: bad }), JSON.stringify(bad)).toBeNull();
      expect(unitsItem(staffFeatureGuides({ payload: withUnits(admin, bad), hat: "admin" }).view)).toBeNull();
    }
    // A steward never gets it, even if a payload carried the facts.
    expect(unitsItem(staffFeatureGuides({ payload: withUnits(steward, { units: 1, stewards: 0, stewardsWithoutUnit: 0 }), hat: "steward" }).view)).toBeNull();
  });

  it("stays open until the campaign has a unit and every committee worker has one, and each part says where it stands", () => {
    const parts = (units) => unitsItem(staffFeatureGuides({ payload: withUnits(admin, units), hat: "admin" }).view);
    const none = parts({ units: 0, stewards: 3, stewardsWithoutUnit: 3 });
    expect(none.done).toBe(false);
    expect(none.parts.map((part) => [part.id, part.done, part.path, en(part.status)])).toEqual([
      ["create", false, "/m/admin/organization", "Units so far: 0"],
      ["assign", false, "/m/organize/record", "0 of 3 committee members are in one of your units"],
    ]);
    const some = parts({ units: 2, stewards: 3, stewardsWithoutUnit: 1 });
    expect([some.done, some.parts.map((part) => part.done)]).toEqual([false, [true, false]]);
    expect(en(some.parts[1].status)).toBe("2 of 3 committee members are in one of your units");
    // Units but no stewards yet: every steward (none) has one.
    expect(parts({ units: 1, stewards: 0, stewardsWithoutUnit: 0 }).done).toBe(true);
    // No units: not done even with no stewards.
    expect(parts({ units: 0, stewards: 0, stewardsWithoutUnit: 0 }).done).toBe(false);
  });

  it("finishes from the facts alone: a recorded completion does not finish it and losing a unit reopens it", () => {
    const completed = [{ stepId: "admin.units", completedAt: at(1), seenAt: at(0) }];
    expect(unitsItem(staffFeatureGuides({ payload: withUnits(admin, { units: 0, stewards: 1, stewardsWithoutUnit: 1 }, completed), hat: "admin" }).view).done).toBe(false);
    const done = staffFeatureGuides({ payload: withUnits(admin, { units: 2, stewards: 1, stewardsWithoutUnit: 0 }, [{ stepId: "admin.units", seenAt: at(0) }]), hat: "admin" }).view;
    expect(unitsItem(done)).toMatchObject({ done: true, doneBeforeOpened: false });
    expect(done.done.map((item) => item.feature)).toEqual(["units"]);
    expect(unitsItem(staffFeatureGuides({ payload: withUnits(admin, { units: 2, stewards: 1, stewardsWithoutUnit: 0 }), hat: "admin" }).view).doneBeforeOpened).toBe(true);
  });

  it("gives vp, who can do neither part, both parts in campaign access with what to check", () => {
    const item = unitsItem(staffFeatureGuides({ payload: withUnits(lead, { units: 1, stewards: 2, stewardsWithoutUnit: 1 }), hat: "vp", path: "/m/organize/record" }).view);
    expect(item.path).toBe("/m/organize/record");
    expect(en(item.firstLabel)).toBe("See how your campaign's units are set up");
    expect(item.parts.map((part) => [en(part.label), part.path])).toEqual([["Your campaign's units", "/m/organize/record"], ["Committee members in your units", "/m/organize/record"]]);
    expect(en(item.lines[0].neverDo[0])).toBe("Create units or make someone a committee member. Your Campaign Administrator does that.");
  });
});

describe("staff feature guides: copy", () => {
  const keysOf = (role) => STAFF_FEATURE_GUIDES[role].flatMap((entry) => [entry.nameKey, entry.firstKey, ...entry.can, ...entry.never, ...(entry.about ?? []),
    ...Object.values(entry.partLabels ?? {}), `guideEngine.sf.ask.${role}`]);
  const unitKeys = ["guideEngine.sf.units.about", "guideEngine.sf.units.createStatus", "guideEngine.sf.units.assignStatus", "guideEngine.sf.units.webOnly"];
  const shellKeys = ["guideEngine.ring.features", "guideEngine.sf.yourGuides", "guideEngine.sf.countsBoth", "guideEngine.sf.memberSteps", "guideEngine.sf.memberStepsNote", "guideEngine.sf.stalled", "guideEngine.sf.cardAllDone", "guideEngine.sf.nextWord", "guideEngine.interstitial", "guideEngine.interstitial.againGuides", "guideEngine.feature.chapterHealth", ...["notRead", "off", "notStaff", "memberHat", "notHeld", "list"].map((key) => `guideEngine.why.r29.${key}`)];

  it("has every line in English and Spanish", () => {
    for (const key of [...STAFF_GUIDE_ROLES.flatMap(keysOf), ...shellKeys, ...unitKeys]) {
      expect(guideEngineCatalogue.en[key], key).toEqual(expect.any(String));
      expect(guideEngineCatalogue.es[key], key).toEqual(expect.any(String));
    }
  });

  it("names no sample person in an Ask line: it names the role to ask", () => {
    for (const role of STAFF_GUIDE_ROLES) expect(guideEngineCatalogue.en[`guideEngine.sf.ask.${role}`]).toMatch(/^your /);
    expect(SHARED_STAFF_FEATURES).toEqual(["messages", "settings"]);
  });
});

describe("staff feature guides on screen", () => {
  const renderEn = (node) => render(<LanguageProvider lang="en">{node}</LanguageProvider>);



  // B-52 (#9525, site audit of Nov 22, 2026): on the Advisor's Chapter health
  // page the guide card printed "About Chapter health" and then an h2
  // "Chapter health" under the page's h1 "Chapter health".
  it.each([
    ["en", "Campaign health", "About Campaign health"],
    ["es", "Salud de la campaña", "Sobre Salud de la campaña"],
  ])("names the guide, not only its feature, so the page title is printed once (%s)", (lang, page, guide) => {
    const view = staffFeatureGuides({ payload: payload([{ role: "advisor", scope: "organization" }]), hat: "advisor", path: "/m/advisor" }).view;
    const { container } = render(<LanguageProvider lang={lang}>
      <h1>{page}</h1>
      <StaffFeatureGuide guides={view} />
    </LanguageProvider>);
    expect(screen.getAllByRole("heading", { name: page })).toHaveLength(1);
    expect(screen.getByRole("heading", { level: 2, name: guide })).toBeTruthy();
    expect(screen.getByRole("region", { name: guide })).toBeTruthy();
    // The words are printed once in the card: no eyebrow says them again.
    expect(container.querySelector(".member-guide-card").textContent.split(guide)).toHaveLength(2);
  });


  it("keeps a finished guide's dismiss quiet", () => {
    const view = staffFeatureGuides({ payload: payload(steward), hat: "steward", path: "/m/steward/requests" }).view;
    renderEn(<StaffFeatureGuide guides={{ ...view, showing: { ...view.showing, done: true } }} />);
    expect(screen.getByRole("button", { name: "Got it" })).toHaveClass("member-guide-card__quiet");
  });


  it.each([
    ["en", "Committee member", "Campaign lead", "Campaign chair", "Reply to a message"],
    ["es", "Miembro del comité", "Líder de la campaña", "Presidencia de campaña", "Responde un mensaje"],
  ])("names campaign access in shared guides and keeps the Campaign chair hat name (%s)", (lang, stewardLabel, chapterLeadLabel, presidentLabel, action) => {
    const roles = [{ role: "steward", scope: "organization" }, { role: "vp", scope: "chapter" }];
    const view = staffFeatureGuides({ payload: payload(roles), hat: "vp", path: "/m/messages" }).view;
    render(<LanguageProvider lang={lang}><StaffFeatureGuide guides={view} /></LanguageProvider>);
    expect(screen.getAllByText(lang === "es" ? "Cuenta para los dos roles" : "Counts for both roles").length).toBeGreaterThan(0);
    expect(screen.getAllByText(stewardLabel).length).toBeGreaterThan(0);
    expect(screen.getAllByText(chapterLeadLabel).length).toBeGreaterThan(0);
    expect(renderGuideCopy(lang, view.showing.lines.find((line) => line.role === "vp").roleLabel)).toBe(chapterLeadLabel);
    expect(renderGuideCopy(lang, view.showing.roleChip)).toBe(chapterLeadLabel);
    expect(renderGuideCopy(lang, view.roleLabel)).toBe(chapterLeadLabel);
    expect(renderGuideCopy(lang, view.note)).toContain(chapterLeadLabel);
    expect(renderGuideCopy(lang, { key: "demo.hatVp" })).toBe(presidentLabel);
    expect(screen.queryByText(presidentLabel)).toBeNull();
    expect(screen.getByRole("button", { name: action })).toBeTruthy();
  });
});

// REQ-UG-MULTI-UNIT-SETUP-GUIDE-20261109, gate round 1 (stage 196):
// the units step's facts belong to the selected chapter, and setup writes
// make the guide read them again.
describe("units step stays with its campaign and follows setup writes", () => {
  const facts = (chapterId) => ({ chapterId, units: 0, stewards: 1, stewardsWithoutUnit: 1 });
  const leadPayload = (chapterId) => ({ ...payload([{ role: "admin", scope: "chapter" }]), chapterUnits: facts(chapterId) });
  const unitsShown = (result) => JSON.stringify(result.view ?? {}).includes("admin.units");

  it("shows the units step only with the selected campaign's facts", () => {
    expect(unitsShown(staffFeatureGuides({ payload: leadPayload("a"), hat: "admin", path: "/m/admin/organization", chapterId: "a" }))).toBe(true);
    expect(unitsShown(staffFeatureGuides({ payload: leadPayload("a"), hat: "admin", path: "/m/admin/organization", chapterId: "b" }))).toBe(false);
    expect(unitsShown(staffFeatureGuides({ payload: leadPayload("a"), hat: "admin", path: "/m/admin/organization", chapterId: null }))).toBe(false);
    // A caller that names no chapter (the phone) keeps the server's answer.
    expect(unitsShown(staffFeatureGuides({ payload: leadPayload("a"), hat: "admin", path: "/m/admin/organization" }))).toBe(true);
  });

  it("drops the first campaign's answer when the scope moves to another campaign, even when it lands late", async () => {
    let landA;
    const rpc = vi.fn()
      .mockImplementationOnce(() => new Promise((resolve) => { landA = resolve; }))
      .mockResolvedValueOnce({ data: leadPayload("b"), error: null });
    const { result, rerender } = renderHook((props) => useStaffOnboardingGuide(props), { initialProps: { client: { rpc }, enabled: true, scope: "u:org:a" } });
    rerender({ client: { rpc }, enabled: true, scope: "u:org:b" });
    await waitFor(() => expect(result.current.payload).toEqual(leadPayload("b")));
    await act(async () => { landA({ data: leadPayload("a"), error: null }); });
    expect(result.current.payload).toEqual(leadPayload("b"));
  });

  it("keys the web guide by campaign, names the campaign to the guide, and reads it again on a campaign setup change", () => {
    const app = readFileSync(resolve(process.cwd(), "src/App.jsx"), "utf8");
    expect(app).toContain('const staffGuideScope = `${session?.user?.id ?? ""}:${data?.member?.organizationId ?? ""}:${data?.member?.chapterId ?? ""}`;');
    expect(app).toMatch(/staff: \{[\s\S]{0,600}chapterId: data\?\.member\?\.chapterId \?\? null,/);
    expect(app).toMatch(/window\.addEventListener\(CHAPTER_SETUP_CHANGED_EVENT, onChange\)/);
    expect(app).toMatch(/const onChange = \(\) => \{ void staffGuideStateRef\.current\.reload\(\); \};/);
  });

  it("announces a campaign setup change as a window meeting", () => {
    const heard = vi.fn();
    window.addEventListener(CHAPTER_SETUP_CHANGED_EVENT, heard);
    announceChapterSetupChanged();
    window.removeEventListener(CHAPTER_SETUP_CHANGED_EVENT, heard);
    expect(heard).toHaveBeenCalledTimes(1);
  });

  // Final review r4s1: a steward removed or granted through the admin role
  // and membership paths changes the units step's facts as well.
  it("announces a campaign setup change after a role or membership write succeeds, never after one that fails", async () => {
    const heard = vi.fn();
    window.addEventListener(CHAPTER_SETUP_CHANGED_EVENT, heard);
    try {
      const write = vi.fn().mockResolvedValueOnce({ updated: true }).mockRejectedValueOnce(Object.assign(new Error("you can no longer change this role"), { code: "42501" }));
      const announced = announceChapterSetupAfter(write);
      await expect(announced("user-1", "chapter-a", "steward", false)).resolves.toEqual({ updated: true });
      expect(write).toHaveBeenCalledWith("user-1", "chapter-a", "steward", false);
      expect(heard).toHaveBeenCalledTimes(1);
      await expect(announced("user-1", "chapter-a", "steward", false)).rejects.toThrow("you can no longer change this role");
      expect(heard).toHaveBeenCalledTimes(1);
    } finally {
      window.removeEventListener(CHAPTER_SETUP_CHANGED_EVENT, heard);
    }
  });

  // A learning-period undo of a role, scope or membership
  // change can restore a steward's earlier unit or remove a steward, so the
  // web guide reads its facts again after one.
  it("reads the guide again after an undo of a role, scope or membership change, and not after other undos", () => {
    expect(CHAPTER_SETUP_UNDO_KINDS).toEqual([
      "chapter_membership_grant", "chapter_membership_revoke", "chapter_membership_revoke_final",
      "chapter_role_grant", "chapter_role_revoke", "chapter_role_scope",
      "organization_role_grant", "organization_role_revoke",
    ]);
    const reload = vi.fn();
    const hook = renderHook(() => useLearningUndone(CHAPTER_SETUP_UNDO_KINDS, reload));
    announceLearningUndone(["unit_settings", "own_report_preferences"]);
    expect(reload).not.toHaveBeenCalled();
    announceLearningUndone(["chapter_role_scope"]);
    expect(reload).toHaveBeenCalledTimes(1);
    hook.unmount();
    const app = readFileSync(resolve(process.cwd(), "src/App.jsx"), "utf8");
    expect(app).toContain("useLearningUndone(CHAPTER_SETUP_UNDO_KINDS, () => { void staffGuideStateRef.current.reload(); });");
  });

  it("announces after every admin role and membership write, including setChapterRole", () => {
    const app = readFileSync(resolve(process.cwd(), "src/App.jsx"), "utf8");
    for (const method of ["grantRole", "revokeRole", "grantChapterMembership", "revokeChapterMembership", "setChapterRole"]) {
      expect(app, method).toMatch(new RegExp(`\\n    ${method}: announceChapterSetupAfter\\(\\(`));
    }
  });
});
