import { readFileSync } from "node:fs";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { loadAdminDesk } from "../src/lib/memberApi.js";
import { AdminView } from "../src/views/AdminView.jsx";
import { AdminLaunchChecklist, AdminLaunchChecklistSlot, launchChecklistSteps } from "../src/features/orgSetup/AdminLaunchChecklist.jsx";
import { LanguageProvider } from "../src/lib/LanguageContext.jsx";
import { fallbackData } from "./fixtures/retired-pre-bot/src/data/fallback.js";

const workspace = vi.hoisted(() => ({ current: null }));
vi.mock("../src/components/WorkspacePages.jsx", async (original) => ({
  ...await original(),
  useWorkspace: () => workspace.current,
}));
beforeEach(() => { workspace.current = null; });

// REQ-UG-ADMIN-LAUNCH-CHECKLIST-20261018: a new admin gets an ordered
// "Getting started" list with live completion state and a link per step, and
// it goes away once every step is done.
function newOrganizationDesk(overrides = {}) {
  const value = JSON.parse(JSON.stringify(fallbackData.adminDesk));
  value.organization = { ...(value.organization ?? {}), chapters: [{ id: "chapter-1", name: "Copperline Library" }] };
  value.roster = [value.roster[0]];
  value.events = [];
  value.onboardingStepCount = 0;
  value.invitations = { ...(value.invitations ?? {}), items: [] };
  value.mfaPolicy = { requireStaffMfa: true, staffTotal: 1, staffEnrolled: 0, callerEnrolled: false };
  return Object.assign(value, overrides);
}

function renderAdmin(desk) {
  const api = {
    loadDesk: vi.fn().mockResolvedValue(desk),
    loadFormTemplates: vi.fn().mockResolvedValue([]),
    loadFailedLoginInbox: vi.fn().mockResolvedValue({ items: [], openLast24Hours: 0, attentionThreshold: 5 }),
    loadAdministrativeEvidence: vi.fn().mockResolvedValue({ fieldNoteBlocks: [], packets: [], actions: [], history: [] }),
  };
  render(
    <LanguageProvider lang="en">
      <AdminView data={{ member: { initials: "CR", chapterName: "Copperline Library", organizationId: "org-1", organizationRoles: ["admin"] } }} api={api} onNotice={vi.fn()} />
    </LanguageProvider>,
  );
}

describe("admin launch checklist", () => {
  it("shows the ordered steps for a new organization, each with a link and an incomplete state, above the admin directory", async () => {
    renderAdmin(newOrganizationDesk());
    const list = await screen.findByRole("region", { name: "Getting started" });
    const items = within(list).getAllByRole("listitem");
    expect(items.map((item) => within(item).getByRole("link").textContent)).toEqual([
      "Turn on two-step sign-in",
      "Set up your campaign's structure",
      "Invite your coworkers",
      "Assign committee members",
      "Write the welcome checklist for new workers",
    ]);
    expect(within(list).getAllByRole("link").map((link) => link.getAttribute("href"))).toEqual([
      "/m/settings/security", "/m/admin/setup-review", "/m/admin/invitations", "/m/admin/access", "/m/support/onboarding",
    ]);
    for (const item of items) expect(item).toHaveTextContent("Not done yet");
    // One progress counter on the admin home: the organization guide's ring.
    expect(list).not.toHaveTextContent(/first steps done/);
    // The checklist comes before the tools-first directory.
    const directory = document.querySelector(".workspace-directory");
    if (directory) expect(list.compareDocumentPosition(directory) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("marks finished steps done from live state", async () => {
    const desk = newOrganizationDesk();
    desk.mfaPolicy.callerEnrolled = true;
    desk.onboardingStepCount = 3;
    desk.roster[0].roles = ["admin", "steward"];
    desk.invitations.items = [{ id: "invite-1", normalizedEmail: "rosa@example.org", fullName: "Rosa Delgado", chapterId: "chapter-1", initialRole: null, locale: "en", status: "pending", deliveryVersion: 1, createdLabel: "Aug 12", expiresLabel: "Aug 13" }];
    renderAdmin(desk);
    const list = await screen.findByRole("region", { name: "Getting started" });
    const [twoStep, structure, invite, steward, welcome] = within(list).getAllByRole("listitem");
    expect(twoStep).toHaveTextContent("Done");
    expect(structure).toHaveTextContent("Not done yet");
    expect(invite).toHaveTextContent("Done");
    expect(steward).toHaveTextContent("Done");
    expect(welcome).toHaveTextContent("Done");
  });

  it("goes away once every step is done and never counts an unreadable step as done", () => {
    const done = {
      organization: { chapters: [{ id: "a" }, { id: "b" }] },
      roster: [{ roles: ["admin", "steward"] }, {}],
      invitations: { items: [] },
      onboardingStepCount: 2,
      mfaPolicy: { callerEnrolled: true },
    };
    expect(launchChecklistSteps({ desk: done }).map((step) => step.done)).toEqual([true, true, true, true, true]);
    const { container, rerender } = render(<LanguageProvider lang="en"><AdminLaunchChecklist desk={done} /></LanguageProvider>);
    expect(container).toBeEmptyDOMElement();
    const unreadable = { ...done, onboardingStepCount: null };
    expect(launchChecklistSteps({ desk: unreadable }).map((step) => step.done)).toEqual([true, true, true, true, null]);
    rerender(<LanguageProvider lang="en"><AdminLaunchChecklist desk={unreadable} /></LanguageProvider>);
    expect(screen.getByRole("region", { name: "Getting started" })).toHaveTextContent("Could not check");
  });

  it("keeps the invitation step unknown when one source is unreadable and the other shows nothing, and done when either proves it", () => {
    const base = { organization: { chapters: [{ id: "a" }] }, mfaPolicy: { callerEnrolled: false }, onboardingStepCount: 0 };
    const invite = (desk) => launchChecklistSteps({ desk }).find((step) => step.key === "invite").done;
    expect(invite({ ...base, roster: [{}], invitations: null })).toBeNull();
    expect(invite({ ...base, roster: null, invitations: { items: [] } })).toBeNull();
    expect(invite({ ...base, roster: [{}], invitations: { items: [] } })).toBe(false);
    expect(invite({ ...base, roster: [{}, {}], invitations: null })).toBe(true);
    expect(invite({ ...base, roster: null, invitations: { items: [{ id: "i" }] } })).toBe(true);
  });

  it("does not count the founder's own accepted invitation as inviting members", () => {
    const base = { organization: { chapters: [{ id: "a" }] }, mfaPolicy: { callerEnrolled: true }, onboardingStepCount: 0 };
    const invite = (desk) => launchChecklistSteps({ desk }).find((step) => step.key === "invite").done;
    const founderOwn = { items: [{ id: "own", kind: "founder", normalizedEmail: "founder@example.org", status: "accepted" }] };
    // Members who accepted without a staff role are not on the staff roster; their invitations still count.
    const memberJoined = { id: "joined", kind: "provision", normalizedEmail: "rosa@example.org", status: "accepted" };
    expect(invite({ ...base, roster: [{ roles: ["admin"] }], invitations: { items: [...founderOwn.items, memberJoined] } })).toBe(true);
    expect(invite({ ...base, roster: [{ roles: ["admin"] }], invitations: founderOwn })).toBe(false);
    expect(invite({ ...base, roster: null, invitations: founderOwn })).toBeNull();
    expect(invite({ ...base, roster: [{ roles: ["admin"] }], invitations: { items: [...founderOwn.items, { id: "next", status: "pending" }] } })).toBe(true);
    expect(invite({ ...base, roster: [{ roles: ["admin"] }, { roles: [] }], invitations: founderOwn })).toBe(true);
  });

  it("leaves the organization-structure step to organization administrators", () => {
    const desk = { organization: { chapters: [{ id: "a" }] }, roster: [{}], invitations: { items: [] }, mfaPolicy: { callerEnrolled: false }, onboardingStepCount: 0 };
    expect(launchChecklistSteps({ desk, organizationAdmin: true }).map((step) => step.key)).toContain("structure");
    expect(launchChecklistSteps({ desk, organizationAdmin: false }).map((step) => step.key)).toEqual(["twoStep", "invite", "steward", "welcome"]);
  });

  // UX-UG-ADMIN-CHECKLIST-LINK-AND-STATUS-POLISH-20261020: brand links
  // and one desk chip per state.
  it("styles the step links like the desk and shows each state as a chip", () => {
    const desk = {
      mfaPolicy: { callerEnrolled: true }, organization: { chapters: [{ id: "c1" }] },
      roster: [{ id: "a", roles: ["admin"] }, { id: "b", roles: ["member"] }], invitations: { items: [] }, onboardingStepCount: undefined,
    };
    render(<LanguageProvider lang="en"><AdminLaunchChecklist desk={desk} organizationAdmin /></LanguageProvider>);
    const items = screen.getAllByRole("listitem");
    expect(items.map((item) => item.querySelector(".xus-chip")?.className)).toEqual([
      "xus-chip xus-chip--on", "xus-chip xus-chip--off", "xus-chip xus-chip--on", "xus-chip xus-chip--off", "xus-chip xus-chip--warn",
    ]);
    expect(items[0].querySelector(".xus-chip")).toHaveTextContent("Done");
    expect(items[0].querySelector(".xus-chip__ic")).toHaveAttribute("aria-hidden", "true");
    expect(items[4].querySelector(".xus-chip")).toHaveTextContent("Could not check");
    for (const item of items) expect(item).toHaveClass("xus-launch-step");
    const sheet = readFileSync("src/styles.css", "utf8");
    expect(sheet).toMatch(/\.xus-list a\s*\{[^}]*color:\s*var\(--primary\)/);
    expect(sheet).toMatch(/\.xus-list a:focus-visible\s*\{[^}]*outline/);
    expect(sheet).toMatch(/\.xus-chip--warn\s*\{[^}]*--amber-ink/);
  });

  it("opens a step in the workspace when one is mounted and leaves a plain link otherwise", () => {
    const desk = { organization: { chapters: [{ id: "a" }] }, roster: [{}], invitations: { items: [] }, onboardingStepCount: 0, mfaPolicy: { callerEnrolled: false } };
    const view = render(<LanguageProvider lang="en"><AdminLaunchChecklist desk={desk} /></LanguageProvider>);
    expect(fireEvent.click(screen.getByRole("link", { name: "Invite your coworkers" }))).toBe(true);
    view.unmount();
    const open = vi.fn();
    workspace.current = { open };
    render(<LanguageProvider lang="en"><AdminLaunchChecklist desk={desk} /></LanguageProvider>);
    expect(fireEvent.click(screen.getByRole("link", { name: "Turn on two-step sign-in" }))).toBe(false);
    expect(open).toHaveBeenCalledWith("/m/settings/security", "settings");
    fireEvent.click(screen.getByRole("link", { name: "Write the welcome checklist for new workers" }));
    expect(open).toHaveBeenLastCalledWith("/m/support/onboarding", "memberSupport");
  });

  it("takes its place in the overview only once the desk has loaded without an error", () => {
    const desk = { organization: { chapters: [{ id: "a" }] }, roster: [{}], invitations: { items: [] }, onboardingStepCount: 0, mfaPolicy: { callerEnrolled: false } };
    const slot = (props) => render(<LanguageProvider lang="en"><AdminLaunchChecklistSlot {...props} /></LanguageProvider>);
    expect(slot({}).container).toBeEmptyDOMElement();
    expect(slot({ desk, error: "offline" }).container).toBeEmptyDOMElement();
    cleanup();
    slot({ desk });
    expect(screen.getByRole("region", { name: "Getting started" })).toBeInTheDocument();
  });
});

// BUG-UG-CHAPTER-ADMIN-CHECKLIST-TWO-STEP-COULD-NOT-CHECK-20261103:
// get_staff_mfa_policy refuses (42501) an admin who holds admin only through a
// chapter role, so the two-step step read null and said "Could not check" even
// with two-step on. The real desk loader now also reads the caller's own,
// role-free get_staff_mfa_standing, and the step uses it first.
describe("the two-step step for chapter-scoped and organization-wide admins", () => {
  const seed = fallbackData.adminDesk;
  const refused = { message: "admin role required", code: "42501" };
  function deskClient({ policy, standing }) {
    const answers = {
      get_staff_roster: () => ({ data: [seed.roster[0]], error: null }),
      get_admin_events: () => ({ data: [], error: null }),
      get_member_invitations: () => ({ data: { chapter: null, items: [] }, error: null }),
      get_admin_org_structure: () => ({ data: { scope: "chapter", chapterId: "chapter-1", chapters: [{ id: "chapter-1", name: "Copperline Library" }] }, error: null }),
      get_staff_mfa_policy: () => policy,
      get_staff_mfa_standing: () => standing,
    };
    return { rpc: (name) => Promise.resolve(answers[name]?.() ?? { data: null, error: null }) };
  }
  async function twoStepChip(client, organizationRoles) {
    const api = {
      loadDesk: vi.fn(() => loadAdminDesk(client, "en")),
      loadFormTemplates: vi.fn().mockResolvedValue([]),
      loadFailedLoginInbox: vi.fn().mockResolvedValue({ items: [], openLast24Hours: 0, attentionThreshold: 5 }),
      loadAdministrativeEvidence: vi.fn().mockResolvedValue({ fieldNoteBlocks: [], packets: [], actions: [], history: [] }),
    };
    render(
      <LanguageProvider lang="en">
        <AdminView data={{ member: { initials: "CR", chapterName: "Copperline Library", organizationId: "org-1", organizationRoles } }} api={api} onNotice={vi.fn()} />
      </LanguageProvider>,
    );
    const list = await screen.findByRole("region", { name: "Getting started" });
    const twoStep = within(list).getAllByRole("listitem")[0];
    expect(within(twoStep).getByRole("link")).toHaveTextContent("Turn on two-step sign-in");
    return twoStep.querySelector(".xus-chip");
  }
  const standing = (enrolled) => ({ data: { requireStaffMfa: false, holdsStaffRole: true, enrolled, assured: enrolled, blocked: false }, error: null });

  it("shows a chapter-scoped admin with two-step on as done although the organization policy read is refused", async () => {
    const client = deskClient({ policy: { data: null, error: refused }, standing: standing(true) });
    expect((await loadAdminDesk(client, "en"))).toMatchObject({ mfaPolicy: null, callerTwoStepEnrolled: true });
    expect(await twoStepChip(client, [])).toHaveTextContent("Done");
  });

  it("shows a chapter-scoped admin with two-step off as not done yet, not as could not check", async () => {
    const chip = await twoStepChip(deskClient({ policy: { data: null, error: refused }, standing: standing(false) }), []);
    expect(chip).toHaveTextContent("Not done yet");
    expect(chip).not.toHaveTextContent("Could not check");
  });

  it("shows an organization-wide admin's two-step from either read, and could not check only when both reads fail", async () => {
    const policy = { data: { requireStaffMfa: true, staffTotal: 1, staffEnrolled: 1, callerEnrolled: true }, error: null };
    expect(await twoStepChip(deskClient({ policy, standing: standing(true) }), ["admin"])).toHaveTextContent("Done");
    cleanup();
    // A failed standing read falls back to the policy read.
    expect(await twoStepChip(deskClient({ policy, standing: { data: null, error: { message: "read failed", code: "57014" } } }), ["admin"])).toHaveTextContent("Done");
    cleanup();
    expect(await twoStepChip(deskClient({ policy: { data: null, error: refused }, standing: { data: null, error: { message: "read failed", code: "57014" } } }), ["admin"]))
      .toHaveTextContent("Could not check");
  });
});
