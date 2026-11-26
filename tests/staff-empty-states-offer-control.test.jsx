// @vitest-environment jsdom
// BUG-UG-STAFF-CAN-ADD-EMPTY-STATES-WITHOUT-CONTROL-20261006: admins
// and presidents in the Member hat read "staff can add" on empty library,
// space, coordination and action pages with no control in sight. Union
// Ground left contract clauses out, so the clause page and its writer must
// not be offered under any hat.
import "@testing-library/jest-dom/vitest";
import { existsSync, readFileSync } from "node:fs";
import { createElement } from "react";
import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { explicitHatAllowsView, heldAuthoringHats } from "../src/App.jsx";
import { StaffAuthoringContext, StaffAuthoringHint } from "../src/components/StaffAuthoringHint.jsx";
import { OrganizationCoordinationDesk } from "../src/features/coordination/ui/OrganizationCoordinationDesk.jsx";
import { appViewForPath } from "../src/lib/appRoutes.js";
import { LanguageProvider } from "../src/lib/LanguageContext.jsx";
import { buildCoordinationActor } from "../src/lib/mi1CoordinationWiring.js";
import { STAFF_TOOL_ROLES } from "../src/lib/staffPlanes.js";
import { ProductHubView } from "../src/views/ProductHubView.jsx";
import { CollectiveActionsView } from "../src/views/CollectiveActionsView.jsx";

function withHats(hats, wearHat, child, lang = "en") {
  return createElement(LanguageProvider, { lang },
    createElement(StaffAuthoringContext.Provider, { value: { hats, wearHat } }, child));
}

describe("empty authoring pages offer the control or name who adds", () => {
  it("offers no Contract clauses page or clause writer under any hat", () => {
    for (const hat of STAFF_TOOL_ROLES) {
      expect({ hat, opens: explicitHatAllowsView(hat, "clauses", false, [hat]) }).toEqual({ hat, opens: false });
    }
    expect(appViewForPath("/m/clauses")).toBeNull();
    expect(existsSync("src/features/clauses")).toBe(false);
    expect(existsSync("src/lib/mi1ClauseWiring.js")).toBe(false);
    const app = readFileSync("src/App.jsx", "utf8");
    expect(app).not.toContain("clauseRolesForSelectedHat");
    expect(app).not.toContain("ClauseQuickReference");
  });

  it("offers an admin and president both held hats on each authoring page, and nothing elsewhere", () => {
    for (const view of ["hub", "coordination", "actions"]) {
      expect({ view, hats: heldAuthoringHats(["vp", "admin"], view) }).toEqual({ view, hats: ["admin", "vp"] });
    }
    expect(heldAuthoringHats(["vp", "admin"], "clauses")).toEqual([]);
    expect(heldAuthoringHats([], "hub")).toEqual([]);
    expect(heldAuthoringHats(["admin"], "today")).toEqual([]);
  });

  it("offers a chapter-only hat only where chapter roles can write", () => {
    // Coordination requires an organization grant. Collective actions offer
    // candidates from chapter grants, then the server scopes the actual editor.
    expect(heldAuthoringHats(["steward", "admin"], "coordination", ["admin"])).toEqual(["admin"]);
    expect(heldAuthoringHats(["steward"], "coordination", [])).toEqual([]);
    expect(heldAuthoringHats(["steward", "admin"], "actions", ["admin"])).toEqual(["steward", "admin"]);
    expect(heldAuthoringHats(["steward", "admin"], "clauses", ["admin"])).toEqual([]);
    expect(heldAuthoringHats(["steward"], "hub", [])).toEqual(["steward"]);
    expect(heldAuthoringHats(["vp"], "actions", [])).toEqual(["vp"]);
  });

  it("wears the chosen held hat from an empty authoring page", () => {
    const wearHat = vi.fn();
    render(withHats(["admin", "vp"], wearHat, createElement(StaffAuthoringHint, { item: "actions" })));
    expect(screen.getByRole("note")).toHaveTextContent("You can add collective actions in one of your staff roles. You are acting as Worker");
    fireEvent.click(screen.getByRole("button", { name: "Act as Campaign chair here" }));
    expect(wearHat).toHaveBeenCalledWith("vp");
    expect(screen.getByRole("button", { name: "Act as Admin here" })).toBeVisible();
  });

  it("names who adds when the viewer holds no staff hat, in English and Spanish", () => {
    const { rerender } = render(withHats([], null, createElement(StaffAuthoringHint, { item: "library" })));
    expect(screen.getByRole("note")).toHaveTextContent("Committee members, campaign leads, advisors, admins and campaign chairs of this campaign add library documents here.");
    expect(screen.queryByRole("button")).toBeNull();
    rerender(withHats([], null, createElement(StaffAuthoringHint, { item: "spaces" }), "es"));
    expect(screen.getByRole("note")).toHaveTextContent("Los miembros del comité, el liderazgo de campaña, los asesores, los administradores y la presidencia de campaña de esta campaña añaden espacios de conversación aquí.");
  });

  it("offers the hat on an empty coordination tab for a member-hat admin", () => {
    const actor = buildCoordinationActor({
      userId: "user-1", organizationId: "org-1", membershipStatus: "active",
      selectedHat: "member", organizationRoles: ["admin"],
      mfaSatisfied: true, sessionScope: "resolved",
    });
    const model = { state: "ready", organizationId: "org-1", staff: false, records: [], leaderboards: [], messages: [], resources: [], exportRuns: [], outreach: [] };
    const wearHat = vi.fn();
    render(withHats(["admin"], wearHat, createElement(OrganizationCoordinationDesk, { actor, model, status: "ready" })));
    expect(screen.getByText("Use this area to plan work together. The first record can be created here.")).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Act as Admin here" }));
    expect(wearHat).toHaveBeenCalledWith("admin");
  });
});

// BUG-UG-STAFF-AUTHORING-HINT-OMITS-ORG-WIDE-REQUIREMENT-20261102: a
// chapter Coordinator on Contract clauses and a chapter Advisor on Collective
// actions read that coordinators and advisors add items there, but those
// writers need an organization-wide grant and neither page showed a control.
describe("organization-grant authoring pages say the role must be organization-wide", () => {
  const ORG_WIDE_EN = "Stewards, coordinators, advisors, admins and presidents with an organization-wide role add";
  const ORG_WIDE_ES = "Los delegados, coordinadores, asesores, administradores y presidentes con un rol en toda la organización añaden";

  // #9166 replaced the organization-wide note on collective actions: a hat
  // granted for the selected chapter writes that chapter's actions, so the
  // empty page offers the chapter advisor its hat, and wearing it shows the
  // form the server allows (get_collective_actions manageScope "chapter").
  it("offers a chapter advisor its hat on empty collective actions, and the chapter form once worn", async () => {
    const hats = heldAuthoringHats(["advisor"], "actions", []);
    expect(hats).toEqual(["advisor"]);
    const wearHat = vi.fn();
    const memberClient = {
      rpc: vi.fn(async (name) => {
        if (name === "get_collective_actions") return { data: { organizationId: "org-1", generatedAt: "2026-11-02T12:00:00Z", manageScope: null, manageChapterId: null, actions: [] }, error: null };
        if (name === "get_my_chapter_memberships") return { data: [{ selected: true, organizationId: "org-1", chapterId: "chapter-a", organizationRoles: [], chapterRoles: ["advisor"] }], error: null };
        return { data: null, error: null };
      }),
    };
    const actor = { userId: "user-1", organizationId: "org-1", chapterId: "chapter-a", selectedHat: "member", organizationRoles: [], chapterRoles: ["advisor"], membershipStatus: "active", organizationStatus: "active", mfaSatisfied: true };
    const { unmount } = render(withHats(hats, wearHat, createElement(CollectiveActionsView, { actor, client: memberClient, lang: "en" })));
    expect(await screen.findByText("No active actions yet.")).toBeVisible();
    expect(screen.queryByRole("heading", { name: "Create action" })).toBeNull();
    expect(screen.getByRole("note")).not.toHaveTextContent("organization-wide");
    fireEvent.click(screen.getByRole("button", { name: "Act as Advisor here" }));
    expect(wearHat).toHaveBeenCalledWith("advisor");
    unmount();

    const advisorClient = {
      rpc: vi.fn(async (name) => {
        if (name === "get_collective_actions") return { data: { organizationId: "org-1", generatedAt: "2026-11-02T12:00:00Z", manageScope: "chapter", manageChapterId: "chapter-a", actions: [] }, error: null };
        if (name === "get_my_chapter_memberships") return { data: [{ selected: true, organizationId: "org-1", chapterId: "chapter-a", organizationRoles: [], chapterRoles: ["advisor"] }], error: null };
        if (name === "save_digital_action") return { data: { id: "action-1", organizationId: "org-1", status: "draft" }, error: null };
        return { data: null, error: null };
      }),
    };
    render(withHats([], null, createElement(CollectiveActionsView, { actor: { ...actor, selectedHat: "advisor" }, client: advisorClient, lang: "en" })));
    expect(await screen.findByRole("heading", { name: "Create action" })).toBeVisible();
    expect(screen.getByText("Actions you create here are for your chapter.")).toBeVisible();
    fireEvent.change(screen.getByLabelText("Title"), { target: { value: "Safer break room" } });
    fireEvent.change(screen.getByLabelText("Summary"), { target: { value: "Ask the chapter to sign on." } });
    fireEvent.submit(screen.getByRole("heading", { name: "Create action" }).closest("form"));
    await vi.waitFor(() => expect(advisorClient.rpc).toHaveBeenCalledWith("save_digital_action", expect.objectContaining({ p_selected_hat: "advisor", p_chapter_id: "chapter-a" })));
  });

  // #9166 round 1 (r1s3): the shell offers every held hat on Collective
  // actions, but a steward limited to one unit manages none; the page offers
  // only the hats the server names in authoringHats.


  it("keeps offering an organization-granted hat in place of the note", () => {
    const wearHat = vi.fn();
    const hats = heldAuthoringHats(["coordinator", "advisor"], "coordination", ["coordinator", "advisor"]);
    expect(hats).toEqual(["coordinator", "advisor"]);
    render(withHats(hats, wearHat, createElement(StaffAuthoringHint, { item: "coordination" })));
    expect(screen.getByRole("note")).not.toHaveTextContent("organization-wide");
    fireEvent.click(screen.getByRole("button", { name: "Act as Campaign lead here" }));
    expect(wearHat).toHaveBeenCalledWith("coordinator");
  });
});

// REQ-UG-FIRST-CLICK-AND-DEAD-CONTROLS-20261030: an admin acting as
// Member saw New space and New thread once, made three spaces, and on the next
// visit found neither control and spaces that opened nothing. The hat switch
// only appeared on the empty page, so it vanished once spaces existed.
describe("organize spaces keep the way back to the add controls", () => {
  const space = (id, name, threads = []) => ({ id, name, description: "", visibility: "chapter", threads });
  const product = { spaces: [space("s1", "Main Library"), space("s2", "Eastgate Branch", [{ id: "t1", title: "Shift swaps", kind: "issue", status: "open", posts: [] }])], documents: [], records: [], intake: [], handshakes: [], governance: [], partnerOrgs: [] };
  const data = { member: { id: "user-1", initials: "CR", fullName: "Callum Reyes" }, roles: [], conversations: [], broadcasts: [], product };

  it("offers the held staff hat above existing spaces for a member-hat admin", () => {
    const wearHat = vi.fn();
    render(withHats(["admin"], wearHat, createElement(ProductHubView, { data, onCreateSpace: vi.fn(), onCreateThread: vi.fn() })));
    expect(screen.queryByRole("button", { name: "New space" })).toBeNull();
    expect(screen.getByRole("note")).toHaveTextContent("You can add conversation spaces in one of your staff roles.");
    fireEvent.click(screen.getByRole("button", { name: "Act as Admin here" }));
    expect(wearHat).toHaveBeenCalledWith("admin");
  });

  it("adds no note for a member with no staff hat once spaces exist, in English and Spanish", () => {
    const { rerender } = render(withHats([], null, createElement(ProductHubView, { data })));
    expect(screen.queryByRole("note")).toBeNull();
    expect(screen.getByText("No threads in this space yet.")).toBeVisible();
    rerender(withHats([], null, createElement(ProductHubView, { data }), "es"));
    expect(screen.getByText("Todavía no hay hilos en este espacio.")).toBeVisible();
  });

  it("says when a space has no threads to open, and lists the threads of one that has", () => {
    render(withHats([], null, createElement(ProductHubView, { data: { ...data, roles: ["steward"] }, onCreateSpace: vi.fn(), onCreateThread: vi.fn() })));
    expect(screen.getByRole("button", { name: "New space" })).toBeVisible();
    expect(screen.getAllByRole("button", { name: "New thread" })).toHaveLength(2);
    expect(screen.getAllByText("No threads in this space yet.")).toHaveLength(1);
    expect(screen.getByRole("button", { name: /Shift swaps/ })).toBeVisible();
  });
});

// #9166 round 1 (r1s1, r2s2): an organization manager sees another chapter's
// action, but the join refuses it; the page says so instead of offering Join,
// and a participant still sees Withdraw.
describe("collective actions offer Join only where the server allows it", () => {
  const ACTIONS = [
    { id: "a-other", kind: "petition", status: "published", title: "Other chapter petition", summary: "Chapter A only.", chapterId: "chapter-a", targetCount: 50, participantCount: 3, viewerParticipation: null, viewerCanEdit: true, viewerCanJoin: false },
    { id: "a-joined", kind: "petition", status: "published", title: "Joined before", summary: "Signed earlier.", chapterId: "chapter-a", targetCount: 50, participantCount: 4, viewerParticipation: "signature", viewerCanEdit: true, viewerCanJoin: false },
    { id: "org-wide", kind: "petition", status: "published", title: "Whole organization petition", summary: "Everyone.", chapterId: null, targetCount: 50, participantCount: 9, viewerParticipation: null, viewerCanEdit: true, viewerCanJoin: true },
  ];
  const client = {
    rpc: vi.fn(async (name) => {
      if (name === "get_collective_actions") return { data: { organizationId: "org-1", generatedAt: "2026-11-18T12:00:00Z", manageScope: "organization", manageChapterId: null, authoringHats: ["vp"], actions: ACTIONS }, error: null };
      if (name === "get_my_chapter_memberships") return { data: [{ selected: true, organizationId: "org-1", chapterId: "chapter-b", organizationRoles: ["vp"], chapterRoles: [] }], error: null };
      return { data: null, error: null };
    }),
  };
  const actor = { userId: "user-1", organizationId: "org-1", chapterId: "chapter-b", selectedHat: "vp", organizationRoles: ["vp"], chapterRoles: [], membershipStatus: "active", organizationStatus: "active", mfaSatisfied: true };
  const card = async (title) => (await screen.findByRole("heading", { name: title })).closest("article");

  it("on the classic page", async () => {
    render(withHats([], null, createElement(CollectiveActionsView, { actor, client, lang: "en" })));
    const other = await card("Other chapter petition");
    expect(within(other).queryByRole("button", { name: "Join action" })).toBeNull();
    expect(within(other).getByText("Only members of this action's chapter can join it.")).toBeVisible();
    expect(within(await card("Joined before")).getByRole("button", { name: "Withdraw" })).toBeEnabled();
    expect(within(await card("Whole organization petition")).getByRole("button", { name: "Join action" })).toBeEnabled();
  });

  it("on the alternate Campaign page", async () => {
    render(withHats([], null, createElement(CollectiveActionsView, { actor, client, lang: "en", alt: true })));
    const other = await card("Other chapter petition");
    expect(within(other).queryByRole("checkbox")).toBeNull();
    expect(within(other).getByText("Only members of this action's chapter can join it.")).toBeVisible();
    expect(within(await card("Joined before")).getByRole("checkbox")).toHaveAttribute("aria-checked", "true");
    expect(within(await card("Whole organization petition")).getByRole("checkbox")).toHaveAttribute("aria-checked", "false");
  });

  it("in Spanish", async () => {
    render(withHats([], null, createElement(CollectiveActionsView, { actor, client, lang: "es" }), "es"));
    expect(within(await card("Other chapter petition")).getByText("Solo los miembros del capítulo de esta acción pueden unirse.")).toBeVisible();
  });
});
