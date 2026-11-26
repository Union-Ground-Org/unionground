import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AdminView } from "../src/views/AdminView.jsx";
import { WorkspacePages } from "../src/components/WorkspacePages.jsx";
import { LanguageProvider } from "../src/lib/LanguageContext.jsx";
import { fallbackData } from "./fixtures/retired-pre-bot/src/data/fallback.js";
import { t } from "../src/lib/i18n.js";
import { expectOneWriteFromOneTick, expectReadyRetryAfterThrowAtOnce } from "./helpers/busyWriteFocus.js";

function makeApi(overrides = {}) {
  return {
    loadDesk: vi.fn().mockResolvedValue(JSON.parse(JSON.stringify(fallbackData.adminDesk))),
    grantRole: vi.fn().mockResolvedValue({ granted: true }),
    revokeRole: vi.fn().mockResolvedValue({ revoked: true }),
    searchMembers: vi.fn().mockResolvedValue([]),
    createEvent: vi.fn().mockResolvedValue({ created: true }),
    updateEvent: vi.fn().mockResolvedValue({ updated: true }),
    closeGovernance: vi.fn().mockResolvedValue({ updated: true }),
    loadFormTemplates: vi.fn().mockResolvedValue([]),
    upsertFormTemplate: vi.fn().mockResolvedValue({ key: "demo", version: 1, active: true }),
    deactivateFormTemplate: vi.fn().mockResolvedValue({ key: "demo", active: false }),
    reactivateFormTemplate: vi.fn().mockResolvedValue({ key: "demo", active: true }),
    updateOrganizationSetting: vi.fn().mockResolvedValue({ updated: true }),
    updateOrganizationLabel: vi.fn().mockResolvedValue({ updated: true }),
    loadFailedLoginInbox: vi.fn().mockResolvedValue({ items: [], openLast24Hours: 0, attentionThreshold: 5 }),
    dispositionFailedLoginAttempt: vi.fn().mockResolvedValue({ updated: true }),
    loadAdministrativeEvidence: vi.fn().mockResolvedValue({
      fieldNoteBlocks: [], packets: [], actions: [], history: [],
    }),
    addFieldNoteEvidence: vi.fn().mockResolvedValue({ created: true }),
    draftFieldNotePacket: vi.fn().mockResolvedValue({ created: true }),
    executeAdministrativeObjectAction: vi.fn().mockResolvedValue({ created: true }),
    ...overrides,
  };
}

function renderAdmin(lang = "en", overrides = {}) {
  const api = overrides.api || makeApi();
  const onNotice = overrides.onNotice || vi.fn();
  const data = overrides.data || {
    member: { initials: "AR", chapterName: "Harborview Care United", organizationRoles: ["admin"] },
  };
  render(
    <LanguageProvider lang={lang}>
      <AdminView data={data} api={api} onNotice={onNotice} demo={overrides.demo} sampleLive={overrides.sampleLive} />
    </LanguageProvider>,
  );
  return { api, onNotice };
}

describe("admin view", () => {
  it.each(["en", "es"])("names the scope when the review list is empty (%s)", async (lang) => {
    const seed = { ...fallbackData.adminDesk, leadershipReviews: [] };
    renderAdmin(lang, { api: makeApi({ loadDesk: vi.fn().mockResolvedValue(seed) }) });
    expect(await screen.findByText(t(lang, "admin.leadershipReviewsEmpty"))).toBeInTheDocument();
  });

  it("keeps the Events desk on the same current SAMPLE event list as members", () => {
    const memberUpcoming = fallbackData.events.filter((event) => !event.isPast);
    expect(fallbackData.adminDesk.events.map((event) => event.id)).toEqual(memberUpcoming.map((event) => event.id));
    expect(fallbackData.adminDesk.events.every((event) => new Date(event.startsAt).getTime() > Date.now())).toBe(true);
  });

  it("renders the roster, events with their check-in codes, and the audit trail", async () => {
    renderAdmin();
    // Roster and the MFA status card both list staff, so names appear twice.
    expect((await screen.findAllByText("Alex Rivera")).length).toBeGreaterThan(0);
    expect(screen.getByText("SG-MEET7")).toBeInTheDocument();
    expect(screen.getByText(/42 going/)).toBeInTheDocument();
    expect(screen.getAllByText(/0 checked in/)).toHaveLength(3);
    // Audit sentences use the same translated role labels as the chips.
    // The fixture's grant entry names whoever it names; the role must read as
    // Union Ground's hat label, never the raw slug or the sibling's title.
    const grantEntry = fallbackData.adminDesk.audit.find((item) => item.action === "grant_role" && item.detail?.role === "coordinator");
    expect(screen.getByText(`${grantEntry.actorName} granted Campaign lead to ${grantEntry.targetName}`)).toBeInTheDocument();
    expect(screen.getByText("Alex Rivera created meeting “Caseload-relief rally”")).toBeInTheDocument();
    // The Campaign chair's review panel, in the organizing hat vocabulary.
    const reviewsTitle = t("en", "admin.leadershipReviewsTitle");
    expect(screen.getByText(reviewsTitle)).toBeInTheDocument();
    expect(reviewsTitle).not.toMatch(/President/);
    const review = fallbackData.adminDesk.leadershipReviews[0];
    const reviewLine = `${review.caseReference} · ${review.caseTitle} — ${t("en", "admin.leadershipReviewBy", { name: review.reviewerName })}`;
    expect(screen.getByText((_, element) => element?.textContent?.includes(reviewLine) && !Array.from(element.children).some((child) => child.textContent.includes(reviewLine)))).toBeInTheDocument();
  });

  it.each([
    ["en", ["Alex Rivera cancelled meeting “Member meeting”", "Alex Rivera restored meeting “Member meeting”", "Alex Rivera deleted meeting “Member meeting”"]],
    ["es", ["Alex Rivera canceló la reunión “Member meeting”", "Alex Rivera restauró la reunión “Member meeting”", "Alex Rivera eliminó la reunión “Member meeting”"]],
  ])("renders EVT-06 event lifecycle audit verbs in %s without raw action slugs", async (lang, expected) => {
    const seed = JSON.parse(JSON.stringify(fallbackData.adminDesk));
    seed.audit = ["cancel_event", "restore_event", "delete_event"].map((action, index) => ({
      id: `audit-event-${index}`,
      action,
      actorName: "Alex Rivera",
      detail: { title: "Member meeting" },
      createdLabel: "Aug 12",
    }));
    renderAdmin(lang, { api: makeApi({ loadDesk: vi.fn().mockResolvedValue(seed) }) });
    for (const sentence of expected) expect(await screen.findByText(sentence)).toBeInTheDocument();
    for (const slug of ["cancel_event", "restore_event", "delete_event"]) expect(screen.queryByText(slug)).not.toBeInTheDocument();
  });

  // Union Ground has no reward economy, so the reward verbs have no audit
  // sentence any more; a legacy reward row still never prints its raw slug.
  it("renders the remaining security, Compass, and chapter audit vocabulary and hides legacy reward slugs", async () => {
    const seed = JSON.parse(JSON.stringify(fallbackData.adminDesk));
    const actions = [
      ["reset_mfa", { factorsRemoved: 2 }],
      ["recover_signin_address", {}],
      ["recover_signin_address_failed", {}],
      ["claim_reward", { item: "Chapter mug" }],
      ["grant_reward", { item: "Chapter mug" }],
      ["revoke_reward", { item: "Chapter mug" }],
      ["fulfill_reward", { item: "Chapter mug", to: "Jordan Bell" }],
      ["set_staff_mfa_policy", { requireStaffMfa: true }],
      ["set_compass_ai_enabled", { enabled: true }],
      ["set_compass_ai_role_limit", { role: "steward", hourlyLimit: 12 }],
      ["attest_compass_ai_provider", { status: "revoked" }],
      ["create_chapter", { chapterId: "chapter-new" }],
      ["update_chapter", { chapterId: "chapter-new" }],
    ];
    seed.audit = actions.map(([action, detail], index) => ({
      id: `audit-extra-${index}`,
      action,
      actorName: "Alex Rivera",
      targetName: "Jordan Bell",
      detail,
      createdLabel: "Aug 13",
    }));
    renderAdmin("en", { api: makeApi({ loadDesk: vi.fn().mockResolvedValue(seed) }) });
    const auditHeading = await screen.findByRole("heading", { name: "Recent admin activity" });
    const auditCard = auditHeading.closest("article");
    for (const [action] of actions) expect(screen.queryByText(action)).not.toBeInTheDocument();
    expect(auditCard.querySelectorAll(".xus-arow")).toHaveLength(6);
    fireEvent.click(within(auditCard).getByRole("button", { name: "Show more (7 remaining)" }));
    expect(auditCard.querySelectorAll(".xus-arow")).toHaveLength(12);
    fireEvent.click(within(auditCard).getByRole("button", { name: "Show more (1 remaining)" }));
    expect(auditCard.querySelectorAll(".xus-arow")).toHaveLength(actions.length);
  });

  it("lets an admin set status only with a written data-rights response", async () => {
    const { api, onNotice } = renderAdmin();
    expect(await screen.findByText("Darnell Brooks · Export")).toBeInTheDocument();
    const save = screen.getByRole("button", { name: "Save response" });
    expect(save).toBeDisabled();
    fireEvent.change(screen.getByRole("textbox", { name: "Written response" }), { target: { value: "Your export is ready in the secure portal." } });
    fireEvent.click(save);
    await vi.waitFor(() => expect(api.closeGovernance).toHaveBeenCalledWith("governance-demo-1", "fulfilled", "Your export is ready in the secure portal."));
    expect(onNotice).toHaveBeenCalledWith("Data-rights request updated");
  });

  it("shows a prior written response and resaves with an admin-chosen status", async () => {
    const seed = JSON.parse(JSON.stringify(fallbackData.adminDesk));
    seed.governance[0].response = "We sent the export on Monday.";
    seed.governance[0].status = "fulfilled";
    const api = makeApi({ loadDesk: vi.fn().mockResolvedValue(seed) });
    renderAdmin("en", { api });
    expect(await screen.findByText("We sent the export on Monday.")).toBeInTheDocument();
    // Draft starts blank even though a response already exists — resaving
    // requires writing a fresh one, not silently repeating the old text.
    const governance = within(document.getElementById("admin-governance"));
    expect(governance.getByLabelText("Written response")).toHaveValue("");
    fireEvent.change(governance.getByLabelText("Status"), { target: { value: "denied" } });
    fireEvent.change(governance.getByLabelText("Written response"), { target: { value: "Denied: retention window expired." } });
    fireEvent.click(governance.getByRole("button", { name: "Save response" }));
    await vi.waitFor(() => expect(api.closeGovernance).toHaveBeenCalledWith("governance-demo-1", "denied", "Denied: retention window expired."));
  });

  it("renders data-rights requests as unavailable — not empty — when their reader fails", async () => {
    const seed = JSON.parse(JSON.stringify(fallbackData.adminDesk));
    seed.governance = null;
    const api = makeApi({ loadDesk: vi.fn().mockResolvedValue(seed) });
    renderAdmin("en", { api });
    await screen.findAllByText("Alex Rivera");
    expect(screen.getByText("Data-rights requests could not be loaded.")).toBeInTheDocument();
    expect(screen.queryByText("No data-rights requests.")).not.toBeInTheDocument();
  });

  it("shows the empty state when there are no data-rights requests", async () => {
    const seed = JSON.parse(JSON.stringify(fallbackData.adminDesk));
    seed.governance = [];
    const api = makeApi({ loadDesk: vi.fn().mockResolvedValue(seed) });
    renderAdmin("en", { api });
    await screen.findAllByText("Alex Rivera");
    expect(screen.getByText("No data-rights requests.")).toBeInTheDocument();
  });

  // BUG-UG-PAGES-FAIL-HARD-ON-MISSING-OR-SLOW-FUNCTION-20261003: an
  // admin write that timed out used to toast the driver's sentence.
  it("says the service is busy, not the database text, when a role grant times out", async () => {
    const { MemberApiError } = await import("../src/lib/memberApiError.js");
    const api = makeApi({
      searchMembers: vi.fn().mockResolvedValue([{ userId: "member-jb", fullName: "Jordan Bell", initials: "JB", memberSince: 2023, roles: [] }]),
      grantRole: vi.fn().mockRejectedValue(new MemberApiError("Grant role", { code: "57014", message: "canceling statement due to statement timeout" })),
    });
    const { onNotice } = renderAdmin("en", { api });
    await screen.findAllByText("Alex Rivera");
    const access = within(document.getElementById("admin-access"));
    fireEvent.change(access.getByRole("searchbox", { name: "Search workers by name (min 2 characters)" }), { target: { value: "Jor" } });
    fireEvent.click(access.getByRole("button", { name: "Search" }));
    fireEvent.click(await access.findByRole("button", { name: "Grant organization-wide Committee to Jordan Bell — With the campaign since 2023 — Worker ID ending JB" }));
    // The busy sentence is catalogue copy the wave-2 copy pass rewords for
    // Union Ground, so it is read from the catalogue.
    await vi.waitFor(() => expect(onNotice).toHaveBeenCalledWith(t("en", "error.serviceBusy")));
    expect(onNotice.mock.calls.flat().join(" ")).not.toContain("canceling statement");
  });

  it("searches members and grants the selected role", async () => {
    const api = makeApi({
      searchMembers: vi.fn().mockResolvedValue([{ userId: "member-jb", fullName: "Jordan Bell", initials: "JB", memberSince: 2023, roles: [] }]),
    });
    const { onNotice } = renderAdmin("en", { api });
    await screen.findAllByText("Alex Rivera");
    const access = within(document.getElementById("admin-access"));
    fireEvent.change(access.getByRole("searchbox", { name: "Search workers by name (min 2 characters)" }), { target: { value: "Jor" } });
    fireEvent.click(access.getByRole("button", { name: "Search" }));
    expect(await access.findByText("Jordan Bell")).toBeInTheDocument();
    expect(api.searchMembers).toHaveBeenCalledWith("Jor");
    // Human-readable tenure disambiguates same-named members pre-grant.
    expect(access.getByText("With the campaign since 2023")).toBeInTheDocument();
    fireEvent.click(access.getByRole("button", { name: "Grant organization-wide Committee to Jordan Bell — With the campaign since 2023 — Worker ID ending JB" }));
    // Default role select is steward; the desk reloads after the write.
    await vi.waitFor(() => expect(api.grantRole).toHaveBeenCalledWith("member-jb", "steward"));
    await vi.waitFor(() => expect(onNotice).toHaveBeenCalledWith("Role granted"));
    expect(api.loadDesk).toHaveBeenCalledTimes(2);
  });

  it("toasts an honest no-change notice when the grant was a conflict no-op", async () => {
    const api = makeApi({
      searchMembers: vi.fn().mockResolvedValue([{ userId: "member-jb", fullName: "Jordan Bell", initials: "JB", memberSince: 2023, roles: [] }]),
      grantRole: vi.fn().mockResolvedValue({ granted: false }),
    });
    const { onNotice } = renderAdmin("en", { api });
    await screen.findAllByText("Alex Rivera");
    const access = within(document.getElementById("admin-access"));
    fireEvent.change(access.getByRole("searchbox", { name: "Search workers by name (min 2 characters)" }), { target: { value: "Jor" } });
    fireEvent.click(access.getByRole("button", { name: "Search" }));
    await access.findByText("Jordan Bell");
    fireEvent.click(access.getByRole("button", { name: "Grant organization-wide Committee to Jordan Bell — With the campaign since 2023 — Worker ID ending JB" }));
    await vi.waitFor(() => expect(onNotice).toHaveBeenCalledWith("No change — they already hold that role."));
    expect(onNotice).not.toHaveBeenCalledWith("Role granted");
  });

  it("blocks the search submit while a write is in flight", async () => {
    let resolveGrant;
    const api = makeApi({
      searchMembers: vi.fn().mockResolvedValue([{ userId: "member-jb", fullName: "Jordan Bell", initials: "JB", memberSince: 2023, roles: [] }]),
      grantRole: vi.fn(() => new Promise((resolve) => { resolveGrant = resolve; })),
    });
    renderAdmin("en", { api });
    await screen.findAllByText("Alex Rivera");
    const access = within(document.getElementById("admin-access"));
    fireEvent.change(access.getByRole("searchbox", { name: "Search workers by name (min 2 characters)" }), { target: { value: "Jor" } });
    fireEvent.click(access.getByRole("button", { name: "Search" }));
    await access.findByText("Jordan Bell");
    fireEvent.click(access.getByRole("button", { name: "Grant organization-wide Committee to Jordan Bell — With the campaign since 2023 — Worker ID ending JB" }));
    // Mid-flight: a new search could otherwise race the results patch.
    const search = access.getByRole("button", { name: "Search" });
    expect(search).toBeEnabled();
    expect(search).toHaveAttribute("aria-disabled", "true");
    fireEvent.submit(search.closest("form"));
    expect(api.searchMembers).toHaveBeenCalledTimes(1);
    resolveGrant({ granted: true });
    await vi.waitFor(() => expect(search).not.toHaveAttribute("aria-disabled"));
  });

  it("targets the intended duplicate-name member for role grants and MFA reset", async () => {
    const first = { userId: "10000000-0000-4000-8000-000000000001", fullName: "Maria Fonseca", initials: "MF", memberSince: 2024, chapterName: "Harborview Care United", roles: [] };
    const second = { ...first, userId: "20000000-0000-4000-8000-000000000002", chapterName: "Harborview Care Springfield" };
    const api = makeApi({ searchMembers: vi.fn().mockResolvedValue([first, second]), resetMfa: vi.fn().mockResolvedValue({ removed: 1 }) });
    renderAdmin("en", { api });
    await screen.findAllByText("Alex Rivera");
    fireEvent.change(screen.getByRole("searchbox", { name: "Search workers by name (min 2 characters)" }), { target: { value: "Maria" } });
    fireEvent.click(screen.getByRole("button", { name: "Search" }));

    expect(await screen.findByText("Worker ID ending 000001")).toBeInTheDocument();
    expect(screen.getByText("Worker ID ending 000002")).toBeInTheDocument();
    expect(screen.getByText("With the campaign since 2024 · Harborview Care United")).toBeInTheDocument();
    expect(screen.getByText("With the campaign since 2024 · Harborview Care Springfield")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Grant organization-wide Committee to Maria Fonseca — With the campaign since 2024 · Harborview Care Springfield — Worker ID ending 000002" }));
    await vi.waitFor(() => expect(api.grantRole).toHaveBeenCalledWith(second.userId, "steward"));

    const reset = screen.getByRole("button", { name: "Reset two-step sign-in for Maria Fonseca — With the campaign since 2024 · Harborview Care Springfield — Worker ID ending 000002" });
    await vi.waitFor(() => expect(reset).not.toHaveAttribute("aria-disabled"));
    fireEvent.click(reset);
    const confirmation = screen.getByRole("dialog", { name: "Reset this worker's MFA" });
    fireEvent.click(within(confirmation).getByRole("button", { name: "Remove two-step sign-in for Maria Fonseca — With the campaign since 2024 · Harborview Care Springfield — Worker ID ending 000002" }));
    await vi.waitFor(() => expect(api.resetMfa).toHaveBeenCalledWith(second.userId));
  });

  // UX-UG-NAME-EXACT-MEMBER-ACCESS-PAGE-S-ROLE-GRANT-20261013: the
  // durable note outlives the search rows it came from, so it names the member
  // the way the grant button did.
  it("revokes a role from a roster chip", async () => {
    const api = makeApi();
    const { onNotice } = renderAdmin("en", { api });
    await screen.findAllByText("Alex Rivera");
    fireEvent.click(screen.getByRole("button", { name: "Remove organization-wide Admin from Alex Rivera" }));
    await vi.waitFor(() => expect(api.revokeRole).toHaveBeenCalledWith("staff-ar", "admin"));
    await vi.waitFor(() => expect(onNotice).toHaveBeenCalledWith("Role removed"));
  });

  // E1 card layer — see the matching guard in vp-view.test.jsx. Anchored on the
  // revoke control because it exists only inside the roster, so a sibling plane
  // card cannot satisfy the assertion if the roster loses its class.
  it("keeps the .plane-card surface on the roster and the plane sections", async () => {
    renderAdmin();
    const revoke = await screen.findByRole("button", { name: "Remove organization-wide Admin from Alex Rivera" });
    expect(revoke.closest(".plane-card")).not.toBeNull();
    // Promote, MFA, events and audit are plane surfaces too.
    expect(document.querySelectorAll(".plane-card").length).toBeGreaterThan(1);
  });

  // Wave 2e pixel-parity layer. The .plane-card pin above says the surface
  // still exists; this says the prototype's card anatomy is the thing wearing
  // it. Both are needed: the four cards could keep .plane-card and lose every
  // measurement the restyle transcribed, and nothing above would notice.
  it("wears the prototype's plane anatomy — header strip, KPI tiles, and backed cards", async () => {
    renderAdmin();
    await screen.findAllByText("Alex Rivera");
    // The .ph strip replaced ScreenHeader: title in the h1, the old eyebrow
    // demoted to the subline rather than deleted.
    expect(screen.getByRole("heading", { level: 1, name: "Campaign admin" })).toBeInTheDocument();
    // An organization-wide Admin (organizationRoles admin) reads the organization subline.
    expect(screen.getByText("Organization admin tools")).toBeInTheDocument();
    // Four real KPI tiles — no dues tiles, which this schema cannot compute.
    expect(document.querySelectorAll(".pkpi-grid .pkpi").length).toBe(4);
    // Directory, organization, lifecycle, operational retention, invitations,
    // sign-in recovery, promote, MFA, Compass governance, organization
    // settings, navigation labels, failed sign-ins, evidence operations,
    // events, data rights, audit, leadership reviews, chapter binding and
    // connections, handshake documents, multi-chapter membership. The form
    // editor is its own section, and so is the organization setup review.
    // The automation page now shows its link card to /m/automations (inventory A5).
    // Union Ground has no reward economy editor or rewards queue, and no
    // union-catalog verification request, vouch, verifier, or research-draft
    // pages: those six cards are gone. The Getting started checklist adds one
    // while any step (here the unread welcome-checklist step) is not done.
    // The Labels page also carries the workload-categories card, and the
    // roster import is its own card while invitations are available.
    expect(document.querySelectorAll(".plane-card.xus-card").length).toBe(26);
    expect(document.getElementById("admin-roster-import")).not.toBeNull();
    expect(document.getElementById("admin-workload-categories")).not.toBeNull();
    // Every card carries the prototype's tinted head strip with a title in it.
    expect(document.querySelectorAll(".xus-card > .xus-cardhead .xus-cardttl").length).toBe(24);
    expect(document.getElementById("admin-rewards")).toBeNull();
    expect(document.getElementById("admin-reward-economy")).toBeNull();
    // Paint lives in classes, not inline: an inline background cannot be
    // contrast-audited, which is why the restyle moved them out at all. The
    // roster's own rows are excluded — StaffRoster is a shared component.
    const inlinePainted = [...document.querySelectorAll(".xus-card [style]")]
      .filter((node) => /background|(^|;)\s*color\s*:/.test(node.getAttribute("style")));
    expect(inlinePainted).toEqual([]);
  });

  it("loads and writes the administrative evidence workspace through the backed API", async () => {
    const api = makeApi({
      loadAdministrativeEvidence: vi.fn().mockResolvedValue({
        fieldNoteBlocks: [{ id: "block-1", issueKey: "staffing", sourceTitle: "Listening session", sourceType: "interview", provenance: "Recorded with consent", annotation: "", packetState: "draft", body: "Overnight vacancies remain open." }],
        packets: [],
        actions: [{ targetKind: "field_note_block", actionKey: "include", label: "Include evidence in packet" }],
        history: [], page: 0, pageSize: 25, hasNext: { notes: true, actions: false },
      }),
    });
    renderAdmin("en", { api });
    expect(await screen.findByRole("heading", { name: "Evidence operations" })).toBeInTheDocument();
    expect((await screen.findAllByText("staffing · Listening session")).length).toBeGreaterThan(0);
    fireEvent.click(screen.getByRole("button", { name: "Next" }));
    await waitFor(() => expect(api.loadAdministrativeEvidence).toHaveBeenCalledWith(1));
    const noteForm = screen.getByRole("button", { name: "Add Field Notes evidence" }).closest("form");
    fireEvent.change(within(noteForm).getByLabelText("Source title"), { target: { value: "Claims handbook" } });
    fireEvent.change(within(noteForm).getByLabelText("Source provenance"), { target: { value: "Member-provided copy" } });
    fireEvent.change(within(noteForm).getByLabelText("Issue key"), { target: { value: "staffing" } });
    fireEvent.change(within(noteForm).getByLabelText("Evidence text"), { target: { value: "Two vacancies observed." } });
    fireEvent.submit(noteForm);
    await waitFor(() => expect(api.addFieldNoteEvidence).toHaveBeenCalledWith(expect.objectContaining({ sourceTitle: "Claims handbook" })));
  });

  it("explains instead of offering invitation and password-reissue controls on the SAMPLE origin", async () => {
    const person = { userId: "u-1", fullName: "Jordan Lee", initials: "JL", chapterName: "Harborview Care United" };
    const api = makeApi({
      inviteMember: vi.fn(),
      reissuePassword: vi.fn(),
      searchRecoveryMembers: vi.fn().mockResolvedValue([person]),
    });
    renderAdmin("en", { api, demo: false, sampleLive: true });
    await screen.findAllByText("Alex Rivera");
    expect(screen.getByRole("heading", { name: "Invite a worker" })).toBeInTheDocument();
    expect(screen.getByText(/The demo does not send invitations/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Send invitation" })).toBeNull();
    expect(screen.queryByRole("button", { name: /^Resend/ })).toBeNull();

    const recoverySearch = screen.getByRole("heading", { name: "Sign-in help: new password or address" }).closest("article").querySelector(".xus-recovery-search");
    fireEvent.change(within(recoverySearch).getByLabelText("Search campaign workers by name"), { target: { value: "Jordan" } });
    fireEvent.click(within(recoverySearch).getByRole("button", { name: "Search workers" }));
    fireEvent.click(await screen.findByRole("button", { name: /^Choose Jordan Lee/ }));
    expect(screen.getByText(/The demo does not reissue passwords/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /password/i })).toBeNull();
    expect(api.inviteMember).not.toHaveBeenCalled();
    expect(api.reissuePassword).not.toHaveBeenCalled();
  });

  it("omits the prototype's still-unbacked dues and bulk-member controls", async () => {
    renderAdmin();
    await screen.findAllByText("Alex Rivera");
    // The prototype's Users & dues screen ships a dues column, dues KPIs, a
    // CSV import and per-row Manage menus. Provisioning is now backed by the
    // invitation state machine, but the other controls remain unsupported.
    expect(screen.getByRole("heading", { name: "Invite a worker" })).toBeInTheDocument();
    for (const dead of [/dues/i, /bulk import/i]) {
      expect(screen.queryByText(dead)).toBeNull();
    }
    // Anchored: a per-row "Manage" menu, not a setting such as "Save Management behavior categories".
    expect(screen.queryByRole("button", { name: /^manage\b/i })).toBeNull();
  });

  it("creates an event through the form", async () => {
    const api = makeApi();
    renderAdmin("en", { api });
    await screen.findAllByText("Alex Rivera");
    const events = within(document.getElementById("admin-events"));
    fireEvent.click(events.getByRole("button", { name: "New meeting" }));
    fireEvent.change(events.getByLabelText("Web name"), { target: { value: "evt-2026-town-hall" } });
    fireEvent.change(events.getByLabelText("Title"), { target: { value: "Member town hall" } });
    fireEvent.change(events.getByLabelText("Starts"), { target: { value: "2026-08-20T18:00" } });
    fireEvent.change(events.getByLabelText("Location"), { target: { value: "Chapter Hall" } });
    fireEvent.change(events.getByLabelText("Summary"), { target: { value: "Open Q&A with the bargaining team." } });
    fireEvent.change(events.getByLabelText("Check-in code (SG-…)"), { target: { value: "SG-TOWN26" } });
    expect(events.getByText("Publishes to Harborview Care United")).toBeInTheDocument();
    fireEvent.click(events.getByLabelText("Share with every campaign in this agency"));
    fireEvent.click(events.getByLabelText("Share across all agencies in this organization"));
    fireEvent.click(events.getByRole("button", { name: "Yes, share across all agencies" }));
    fireEvent.click(events.getByRole("button", { name: "Save" }));
    await vi.waitFor(() => expect(api.createEvent).toHaveBeenCalled());
    const payload = api.createEvent.mock.calls[0][0];
    expect(payload.id).toBe("evt-2026-town-hall");
    expect(payload.checkInCode).toBe("SG-TOWN26");
    expect(payload.startsAt).toBe(new Date("2026-08-20T18:00").toISOString());
    expect(payload.isPublic).toBe(true);
    expect(payload.isPublicAcrossAgencies).toBe(true);
  });

  it("names each event's server scope instead of presenting one org-wide calendar", async () => {
    // Union Ground's demo has no public events: every SAMPLE meeting is its
    // own campaign's. A stored row that is still flagged organization-wide
    // must still say so, so the seed adds one.
    expect(fallbackData.adminDesk.events.every((event) => !event.isPublic && !event.isPublicAcrossAgencies)).toBe(true);
    const seed = JSON.parse(JSON.stringify(fallbackData.adminDesk));
    seed.events[2] = { ...seed.events[2], isPublic: true, isPublicAcrossAgencies: true };
    renderAdmin("en", { api: makeApi({ loadDesk: vi.fn().mockResolvedValue(seed) }) });
    await screen.findAllByText("Alex Rivera");
    const events = within(document.getElementById("admin-events"));
    expect(events.getAllByText("Harborview Care United campaign")).toHaveLength(2);
    expect(events.getByText("All agencies")).toBeInTheDocument();
  });

  it("toasts an honest notice when an edit changed nothing server-side", async () => {
    const api = makeApi({ updateEvent: vi.fn().mockResolvedValue({ updated: false }) });
    const { onNotice } = renderAdmin("en", { api });
    await screen.findAllByText("Alex Rivera");
    const events = within(document.getElementById("admin-events"));
    fireEvent.click(events.getAllByRole("button", { name: "Edit" })[0]);
    fireEvent.click(events.getByRole("button", { name: "Save" }));
    await vi.waitFor(() => expect(onNotice).toHaveBeenCalledWith("No changes to save."));
    expect(onNotice).not.toHaveBeenCalledWith("Meeting updated");
  });

  it("renders the audit trail as unavailable — not empty — when its reader fails", async () => {
    const seed = JSON.parse(JSON.stringify(fallbackData.adminDesk));
    seed.audit = null;
    const api = makeApi({ loadDesk: vi.fn().mockResolvedValue(seed) });
    renderAdmin("en", { api });
    await screen.findAllByText("Alex Rivera");
    expect(screen.getByText("The audit trail couldn't be loaded.")).toBeInTheDocument();
    expect(screen.queryByText("No admin actions logged yet.")).not.toBeInTheDocument();
  });

  it("prefills the edit form with the event's own start time and preserves it", async () => {
    const api = makeApi();
    renderAdmin("en", { api });
    await screen.findAllByText("Alex Rivera");
    const event = fallbackData.adminDesk.events[0];
    const events = within(document.getElementById("admin-events"));
    fireEvent.click(events.getAllByRole("button", { name: "Edit" })[0]);

    // The form must open with the event's own start time, so the admin can see
    // and adjust it instead of facing a blank field.
    const startsInput = events.getByLabelText("Starts");
    expect(startsInput.value).not.toBe("");
    expect(new Date(startsInput.value).toISOString()).toBe(new Date(event.startsAt).toISOString());

    fireEvent.change(events.getByLabelText("Location"), { target: { value: "Union Hall, Floor 2" } });
    fireEvent.click(events.getByRole("button", { name: "Save" }));
    await vi.waitFor(() => expect(api.updateEvent).toHaveBeenCalled());
    const [eventId, fields] = api.updateEvent.mock.calls[0];
    expect(eventId).toBe("evt-2026-chapter-meeting");
    expect(fields.location).toBe("Union Hall, Floor 2");
    // The start time was shown but not edited, so it is sent as null and the
    // server keeps the stored value rather than a re-serialized copy of it.
    expect(fields.startsAt).toBeNull();
  });

  it("renders fully in Spanish", async () => {
    renderAdmin("es");
    expect(await screen.findByText("Administración de la campaña")).toBeInTheDocument();
    expect(screen.getByText("Roles y acceso de la organización")).toBeInTheDocument();
    // The events title renders in the section header and the card header.
    expect(screen.getAllByText("Reuniones y códigos de registro").length).toBeGreaterThan(0);
    // Role labels localize inside audit sentences too — no EN/ES mixing.
    const grantEntry = fallbackData.adminDesk.audit.find((item) => item.action === "grant_role" && item.detail?.role === "coordinator");
    expect(screen.getByText(`${grantEntry.actorName} otorgó Liderazgo de campaña a ${grantEntry.targetName}`)).toBeInTheDocument();
  });

  it("keeps organization role mutation controls away from chapter-only admins", async () => {
    const api = makeApi({
      searchMembers: vi.fn().mockResolvedValue([{ userId: "member-jb", fullName: "Jordan Bell", initials: "JB", roles: [] }]),
    });
    renderAdmin("en", {
      api,
      data: { member: { initials: "AR", chapterName: "Harborview Care United", organizationRoles: [], chapterRoles: ["admin"] } },
    });
    await screen.findAllByText("Alex Rivera");
    const access = within(document.getElementById("admin-access"));
    expect(access.getByText(/Only an organization administrator can grant or remove/)).toBeInTheDocument();
    expect(access.queryByLabelText("Organization-wide role to grant")).not.toBeInTheDocument();
    expect(access.queryByRole("button", { name: /Remove organization-wide/ })).not.toBeInTheDocument();
    fireEvent.change(access.getByRole("searchbox", { name: "Search workers by name (min 2 characters)" }), { target: { value: "Jor" } });
    fireEvent.click(access.getByRole("button", { name: "Search" }));
    expect(await access.findByText("Jordan Bell")).toBeInTheDocument();
    expect(access.queryByRole("button", { name: /Grant organization-wide/ })).not.toBeInTheDocument();
    expect(access.getByRole("button", { name: /Reset two-step sign-in for Jordan Bell/ })).toBeInTheDocument();
  });

  it("does not show the organization-only retention card or its shortcut to a chapter-only admin", async () => {
    renderAdmin("en", {
      data: { member: { initials: "AR", chapterName: "Harborview Care United", organizationRoles: [], chapterRoles: ["admin"] } },
    });
    await screen.findAllByText("Alex Rivera");
    expect(document.getElementById("admin-retention-engine")).toBeNull();
    expect(document.querySelector('a[href="#admin-retention-engine"]')).toBeNull();
  });

  it("keeps the retention card and its shortcut for an organization admin", async () => {
    renderAdmin("en");
    await screen.findAllByText("Alex Rivera");
    expect(document.getElementById("admin-retention-engine")).not.toBeNull();
    expect(document.querySelector('a[href="#admin-retention-engine"]')).not.toBeNull();
  });

  it("never offers the signed-in admin a reset of their own second factor", async () => {
    // Presentation pin for the acceptance line "never for the caller's own
    // account": the endpoint and both DB authorities refuse a self-target on
    // their own; this keeps the control from being offered in the first place.
    renderAdmin("en", {
      data: { member: { id: "staff-ar", initials: "AR", chapterName: "Harborview Care United", organizationRoles: ["admin"] } },
    });
    await screen.findAllByText("Alex Rivera");
    expect(screen.getByText("You can't reset your own two-step sign-in — another admin has to do it.")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Reset two-step sign-in for Alex Rivera/ })).not.toBeInTheDocument();
    // A colleague's row still carries the control.
    expect(screen.getByRole("button", { name: /Reset two-step sign-in for Priya Chandran/ })).toBeInTheDocument();
  });

  it("mounts the registry editor in the admin plane and identifies demo-only writes", async () => {
    const api = makeApi();
    renderAdmin("en", { api, demo: true });
    expect(await screen.findByRole("heading", { name: "Form templates" })).toBeInTheDocument();
    await waitFor(() => expect(api.loadFormTemplates).toHaveBeenCalledTimes(1));
    expect(screen.getByText("Preview only — template changes reset when you leave the demo.")).toBeInTheDocument();
    expect(document.getElementById("admin-form-templates")).toHaveAttribute("tabindex", "-1");
  });

  it("shows an inline error card with retry instead of blanking on load failure", async () => {
    const api = makeApi({
      loadDesk: vi.fn().mockRejectedValueOnce(new Error("Staff roster: denied")).mockResolvedValue(JSON.parse(JSON.stringify(fallbackData.adminDesk))),
    });
    renderAdmin("en", { api });
    expect(await screen.findByText("Load failed")).toBeInTheDocument();
    expect(screen.queryByText("Staff roster: denied")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect((await screen.findAllByText("Alex Rivera")).length).toBeGreaterThan(0);
  });
});

describe("admin overview directory first paint", () => {
  const data = { member: { initials: "AR", chapterName: "Harborview Care United", organizationRoles: ["admin"] } };

  function renderAdminWorkspace({ api }) {
    window.history.replaceState({}, "", "/m/admin");
    return render(
      <LanguageProvider lang="en">
        <WorkspacePages view="admin" hat="admin" location={window.location.href} navigate={vi.fn()}>
          <AdminView data={data} api={api} onNotice={vi.fn()} demo />
        </WorkspacePages>
      </LanguageProvider>,
    );
  }

  function campaignsLink() {
    return document.querySelector('a[href="/m/campaigns"], a[href^="/m/campaigns?"]');
  }

  it("lists /m/campaigns while loadDesk never resolves and keeps KPIs off the first paint", () => {
    const view = renderAdminWorkspace({ api: makeApi({ loadDesk: () => new Promise(() => {}) }) });
    expect(campaignsLink()).toBeTruthy();
    expect(view.container.querySelector(".pkpi-grid")).toBeNull();
    expect([...view.container.querySelectorAll(".workspace-page-menu select option")].map((option) => option.value))
      .not.toContain("/m/campaigns");
  });

  it("keeps the directory after the load-failed empty state without exposing desk KPIs", async () => {
    const view = renderAdminWorkspace({
      api: makeApi({ loadDesk: vi.fn().mockRejectedValue(new Error("Staff roster: denied")) }),
    });
    const error = await screen.findByText("Load failed");
    const directory = view.container.querySelector(".workspace-directory");
    const heading = view.container.querySelector("h1");
    expect(directory).toBeTruthy();
    expect(campaignsLink()).toBeTruthy();
    expect(view.container.querySelector(".pkpi-grid")).toBeNull();
    expect(heading.compareDocumentPosition(error) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(error.compareDocumentPosition(directory) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });
});

// Union Ground has no points economy: the admin rewards card (claims
// queue, fulfillment advance, shipping evidence, reasoned grant and revoke)
// and the reward-economy editor are gone, even when a desk still carries a
// legacy reward queue and the member snapshot still lists reward items.
describe("admin view without a reward economy", () => {
  const legacyQueue = [
    { id: "legacy-grant-1", memberName: "Darnell Brooks", itemKey: "union-swag", labelEn: "Picket-Tested thermos", labelEs: "Termo", fulfillment: "ship", status: "claimed", source: "member_claim", reason: null, note: null, createdLabel: "Jul 27" },
    { id: "legacy-grant-2", memberName: "Maria Fonseca", itemKey: "minutes-name", labelEn: "Name in the Minutes", labelEs: "Tu nombre en el acta", fulfillment: "event", status: "claimed", source: "member_claim", reason: null, note: null, createdLabel: "Jul 27" },
  ];
  const legacyItems = [{ key: "union-swag", labelEn: "Picket-Tested thermos", labelEs: "Termo", points: 400, fulfillment: "ship" }];

  for (const lang of ["en", "es"]) {
    it(`renders no reward queue, grant, revoke, shipping, or economy controls in ${lang}`, async () => {
      const desk = JSON.parse(JSON.stringify(fallbackData.adminDesk));
      desk.rewardQueue = legacyQueue;
      const grantReward = vi.fn();
      const revokeReward = vi.fn();
      const advanceFulfillment = vi.fn();
      renderAdmin(lang, {
        api: makeApi({ loadDesk: vi.fn().mockResolvedValue(desk), grantReward, revokeReward, advanceFulfillment }),
        data: { member: { initials: "AR", chapterName: "Harborview Care United", organizationRoles: ["admin"] }, rewardItems: legacyItems },
      });
      await screen.findAllByText("Alex Rivera");
      expect(document.getElementById("admin-rewards")).toBeNull();
      expect(document.getElementById("admin-reward-economy")).toBeNull();
      expect(document.querySelector('a[href="#admin-rewards"], a[href="#admin-reward-economy"]')).toBeNull();
      for (const label of ["Picket-Tested thermos", "Name in the Minutes", "Termo", "Tu nombre en el acta"]) {
        expect(screen.queryByText(label)).toBeNull();
      }
      for (const key of ["admin.rewardsTitle", "admin.grantReward", "admin.rewardsUnavailable"]) {
        const copy = t(lang, key);
        if (copy && copy !== key) expect(screen.queryByText(copy)).toBeNull();
      }
      expect(screen.queryByRole("button", { name: /^(Mark shipped|Mark delivered|Confirm shipped|Grant reward|Revoke)$/ })).toBeNull();
      expect(screen.queryByLabelText("Carrier")).toBeNull();
      expect(screen.queryByLabelText("Tracking number")).toBeNull();
      expect(screen.queryByLabelText("Rewards")).toBeNull();
      expect(screen.queryByLabelText("Contributions")).toBeNull();
      expect(grantReward).not.toHaveBeenCalled();
      expect(revokeReward).not.toHaveBeenCalled();
      expect(advanceFulfillment).not.toHaveBeenCalled();
    });
  }
});

describe("admin MFA reset and legal hold management", () => {
  it("refuses self-reset in the UI and requires confirmation for another staff member", async () => {
    const seed = JSON.parse(JSON.stringify(fallbackData.adminDesk));
    const self = seed.mfa.staff[0];
    const other = seed.mfa.staff[1];
    const api = makeApi({ loadDesk: vi.fn().mockResolvedValue(seed), resetMfa: vi.fn().mockResolvedValue({ removed: 1, audited: true, notified: true }) });
    renderAdmin("en", { api, data: { member: { id: self.userId, organizationRoles: ["admin"] } } });
    const card = await screen.findByText("Two-step sign-in status");
    const section = card.closest("article");
    expect(within(section).getByText(/You can't reset your own/)).toBeInTheDocument();
    const otherRow = within(section).getByText(other.fullName).closest(".xus-row");
    fireEvent.click(within(otherRow).getByRole("button"));
    expect(api.resetMfa).not.toHaveBeenCalled();
    const dialog = screen.getByRole("dialog", { name: "Reset this worker's MFA" });
    fireEvent.click(within(dialog).getByRole("button", { name: /Remove two-step sign-in for/ }));
    await waitFor(() => expect(api.resetMfa).toHaveBeenCalledWith(other.userId));
  });
  it("opens hold controls from the admin conversation search without changing staff hats", async () => {
    const api = makeApi({
      listLegalHolds: vi.fn().mockResolvedValue([]),
      loadHoldConversations: vi.fn().mockResolvedValue({ rows: [{ id: "conv-42", memberName: "Renata Cole", title: "Scheduling" }], nextCursor: null }),
      loadLegalHold: vi.fn().mockResolvedValue({ held: false, canManage: true }),
      placeLegalHold: vi.fn().mockResolvedValue({ held: true }),
    });
    renderAdmin("en", { api });
    fireEvent.click(await screen.findByRole("button", { name: "Search conversations" }));
    fireEvent.click(await screen.findByRole("button", { name: "Manage legal hold" }));
    const dialog = screen.getByRole("dialog", { name: "Renata Cole" });
    fireEvent.click(await within(dialog).findByRole("button", { name: "Place legal hold" }));
    fireEvent.click(within(dialog).getByRole("button", { name: "Place hold" }));
    await waitFor(() => expect(api.placeLegalHold).toHaveBeenCalledWith("conv-42", "litigation"));
  });
});

describe("admin preservation-order card", () => {
  const HOLD_ROW = {
    conversationId: "conv-7",
    conversationTitle: "Shift changes",
    memberName: "Renata Cole",
    memberInitials: "RC",
    reasonCode: "litigation",
    placedAt: "2026-03-04T12:00:00.000Z",
  };

  function holdApi(overrides = {}) {
    return makeApi({
      listLegalHolds: vi.fn().mockResolvedValue([HOLD_ROW]),
      releaseLegalHold: vi.fn().mockResolvedValue({ released: true }),
      ...overrides,
    });
  }

  function holdCard() {
    return document.querySelector("#admin-legal-holds");
  }

  it("lists an active preservation order with its reason and the date it was placed", async () => {
    renderAdmin("en", { api: holdApi() });
    const card = await waitFor(() => {
      const found = holdCard();
      expect(within(found).getByText("Renata Cole")).toBeInTheDocument();
      return found;
    });
    expect(within(card).getByText("RC")).toBeInTheDocument();
    expect(within(card).getByText("Shift changes")).toBeInTheDocument();
    // The reason is translated, not the raw `litigation` slug, and the date is
    // rendered in the reader's locale.
    expect(within(card).getByText(/^Litigation · since /)).toBeInTheDocument();
    expect(within(card).queryByText("No conversation is under legal hold.")).toBeNull();
  });

  it("releases a hold only after the confirmation is accepted, and reloads the list", async () => {
    const api = holdApi();
    const { onNotice } = renderAdmin("en", { api });
    const release = await screen.findByRole("button", { name: "Release the legal hold on Renata Cole" });

    // Cancelling the confirmation leaves the hold in place: releasing a
    // preservation order is the one action here that lets messages expire.
    fireEvent.click(release);
    const cancelled = screen.getByRole("group", { name: "Release the legal hold on Renata Cole" });
    fireEvent.click(within(cancelled).getByRole("button", { name: "Cancel" }));
    expect(screen.queryByRole("group", { name: "Release the legal hold on Renata Cole" })).toBeNull();
    expect(api.releaseLegalHold).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Release the legal hold on Renata Cole" }));
    fireEvent.click(screen.getByRole("button", { name: "Confirm releasing the legal hold on Renata Cole" }));
    await waitFor(() => expect(api.releaseLegalHold).toHaveBeenCalledWith("conv-7"));
    await waitFor(() => expect(onNotice).toHaveBeenCalledWith("Legal hold released."));
    // The card re-reads rather than dropping the row locally, so what an admin
    // sees afterwards is the server's answer.
    await waitFor(() => expect(api.listLegalHolds).toHaveBeenCalledTimes(2));
  });

  it("reports a release that changed nothing as news rather than success", async () => {
    const api = holdApi({ releaseLegalHold: vi.fn().mockResolvedValue({ released: false }) });
    const { onNotice } = renderAdmin("en", { api });
    fireEvent.click(await screen.findByRole("button", { name: "Release the legal hold on Renata Cole" }));
    fireEvent.click(screen.getByRole("button", { name: "Confirm releasing the legal hold on Renata Cole" }));
    await waitFor(() => expect(onNotice).toHaveBeenCalledWith(
      "No change — that conversation was no longer under a legal hold.",
    ));
  });

  it("names a hold whose member cannot be resolved instead of rendering a blank row", async () => {
    const api = holdApi({
      listLegalHolds: vi.fn().mockResolvedValue([{ ...HOLD_ROW, memberName: "", placedAt: null }]),
    });
    renderAdmin("en", { api });
    const label = await screen.findByRole("button", { name: "Release the legal hold on Preserved conversation" });
    expect(label).toBeInTheDocument();
    expect(within(holdCard()).getByText("Preserved conversation")).toBeInTheDocument();
  });

  it("says the preservation orders could not be loaded and retries on demand", async () => {
    const listLegalHolds = vi.fn()
      .mockRejectedValueOnce(new Error("rpc down"))
      .mockResolvedValue([HOLD_ROW]);
    renderAdmin("en", { api: holdApi({ listLegalHolds }) });
    const card = await waitFor(() => {
      const found = holdCard();
      expect(within(found).getByText("Preservation orders could not be loaded.")).toBeInTheDocument();
      return found;
    });
    fireEvent.click(within(card).getByRole("button", { name: "Try again" }));
    await waitFor(() => expect(within(holdCard()).getByText("Renata Cole")).toBeInTheDocument());
    expect(within(holdCard()).queryByText("Preservation orders could not be loaded.")).toBeNull();
  });

  it("says so plainly when no conversation is held", async () => {
    renderAdmin("en", { api: holdApi({ listLegalHolds: vi.fn().mockResolvedValue([]) }) });
    await waitFor(() => expect(
      within(holdCard()).getByText("No conversation is under legal hold."),
    ).toBeInTheDocument());
  });

  it("searches conversations, pages through the matches, and closes the hold dialog again", async () => {
    const loadHoldConversations = vi.fn()
      .mockResolvedValueOnce({ rows: [{ id: "conv-1", memberName: "Renata Cole", title: "Scheduling" }], nextCursor: 25 })
      .mockResolvedValueOnce({ rows: [{ id: "conv-2", memberName: "Ana Diaz", title: "Overtime" }], nextCursor: null });
    const api = holdApi({
      listLegalHolds: vi.fn().mockResolvedValue([]),
      loadHoldConversations,
      loadLegalHold: vi.fn().mockResolvedValue({ held: false, canManage: true }),
    });
    renderAdmin("en", { api });
    fireEvent.change(await screen.findByLabelText("Find a conversation"), { target: { value: " cole " } });
    fireEvent.click(screen.getByRole("button", { name: "Search conversations" }));
    await screen.findByText("Scheduling");
    expect(loadHoldConversations).toHaveBeenCalledWith({ search: "cole", cursor: null });

    fireEvent.click(screen.getByRole("button", { name: "Next conversations" }));
    await screen.findByText("Overtime");
    expect(loadHoldConversations).toHaveBeenLastCalledWith({ search: "cole", cursor: 25 });

    fireEvent.click(screen.getByRole("button", { name: "Manage legal hold" }));
    const dialog = await screen.findByRole("dialog", { name: "Ana Diaz" });
    fireEvent.click(within(dialog).getByRole("button", { name: "Close" }));
    fireEvent.transitionEnd(document.querySelector(".dialog-backdrop"));
    await waitFor(() => expect(document.querySelector(".dialog-backdrop")).toBeNull());
  });

  it("reports a failed conversation search on the card instead of an empty result", async () => {
    const api = holdApi({
      listLegalHolds: vi.fn().mockResolvedValue([]),
      loadHoldConversations: vi.fn().mockRejectedValue(new Error("rpc down")),
    });
    renderAdmin("en", { api });
    fireEvent.click(await screen.findByRole("button", { name: "Search conversations" }));
    await waitFor(() => expect(within(holdCard()).getByRole("alert")).toHaveTextContent(
      "Preservation orders could not be loaded.",
    ));
  });

});

describe("admin MFA reset confirmation dialog", () => {
  it("abandons an MFA reset when the confirmation dialog is dismissed", async () => {
    const seed = JSON.parse(JSON.stringify(fallbackData.adminDesk));
    const other = seed.mfa.staff[1];
    const api = makeApi({ loadDesk: vi.fn().mockResolvedValue(seed), resetMfa: vi.fn() });
    renderAdmin("en", { api, data: { member: { id: seed.mfa.staff[0].userId, organizationRoles: ["admin"] } } });
    const section = (await screen.findByText("Two-step sign-in status")).closest("article");
    const row = within(section).getByText(other.fullName).closest(".xus-row");

    fireEvent.click(within(row).getByRole("button"));
    fireEvent.click(within(screen.getByRole("dialog", { name: "Reset this worker's MFA" })).getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Reset this worker's MFA" })).toBeNull());

    // The dialog's own close control is the same abandonment, and neither one
    // touches the endpoint.
    fireEvent.click(within(row).getByRole("button"));
    const reopened = await screen.findByRole("dialog", { name: "Reset this worker's MFA" });
    fireEvent.click(within(reopened).getByRole("button", { name: "Close" }));
    // The close guard runs off a microtask, so the exit only starts once it has
    // allowed the close; the surface leaves the DOM after its transition ends.
    await waitFor(() => expect(document.querySelector(".dialog-backdrop")).toHaveAttribute("data-state", "closing"));
    fireEvent.transitionEnd(document.querySelector(".dialog-backdrop"));
    await waitFor(() => expect(document.querySelector(".dialog-backdrop")).toBeNull());
    expect(api.resetMfa).not.toHaveBeenCalled();
  });
});

// REQ-UG-UNION-CATALOG-SETUP-REVIEW-PREFILL-20260925: the setup review is
// its own admin page, and the overview carries the setup banner while the
// organization has at most one chapter.
describe("admin organization setup", () => {
  const data = { member: { initials: "AR", chapterName: "Harborview Care United", organizationRoles: ["admin"], organizationId: "a1b2c3d4-0000-4000-8000-000000000001" } };

  function renderAt(path, desk) {
    window.history.replaceState({}, "", path);
    const api = makeApi({ loadDesk: vi.fn().mockResolvedValue(desk) });
    render(
      <LanguageProvider lang="en">
        <WorkspacePages view="admin" hat="admin" location={window.location.href} navigate={vi.fn()}>
          <AdminView data={data} api={api} onNotice={vi.fn()} demo />
        </WorkspacePages>
      </LanguageProvider>,
    );
    return api;
  }

  afterEach(() => {
    window.history.replaceState({}, "", "/");
    window.localStorage.clear();
  });

  it("mounts the setup review page at /m/admin/setup-review, sending nothing in the demo", async () => {
    renderAt("/m/admin/setup-review", JSON.parse(JSON.stringify(fallbackData.adminDesk)));
    expect(await screen.findByRole("heading", { name: "Set up your organization", level: 2 })).toBeInTheDocument();
    expect(screen.getAllByText("Setting up from public records isn't available in the demo.").length).toBeGreaterThan(0);
    expect(screen.queryByText("Where does your organization belong?")).toBeNull();
  });

  it("shows the setup banner on the overview only while the organization has one chapter", async () => {
    const desk = JSON.parse(JSON.stringify(fallbackData.adminDesk));
    desk.organization.chapters = desk.organization.chapters.slice(0, 1);
    renderAt("/m/admin", desk);
    expect(await screen.findByRole("link", { name: "Start setup" })).toHaveAttribute("href", "/m/admin/setup-review");
  });

  it("hides the banner for a populated organization", async () => {
    renderAt("/m/admin", JSON.parse(JSON.stringify(fallbackData.adminDesk)));
    await screen.findAllByText(/Seats|seats/);
    expect(screen.queryByRole("link", { name: "Start setup" })).toBeNull();
  });
});

// Union Ground has no public union catalog, so the organization
// verification request, the vouch list, the platform verifier's queue and the
// operator research draft are not admin pages: their paths render none of
// that surface and never reach a claim API, in the demo or live.
describe("admin view without union catalog verification pages", () => {
  const data = { member: { initials: "AR", chapterName: "Harborview Care United", organizationRoles: ["admin"], organizationId: "a1b2c3d4-0000-4000-8000-000000000001" } };

  afterEach(() => {
    window.history.replaceState({}, "", "/");
  });

  for (const path of ["/m/admin/catalog-verification", "/m/admin/catalog-vouch", "/m/admin/catalog-verifier"]) {
    for (const demo of [true, false]) {
      it(`renders no verification surface at ${path} (${demo ? "demo" : "live"})`, async () => {
        window.history.replaceState({}, "", path);
        const claimApi = {
          listVouchableOrganizationClaims: vi.fn().mockResolvedValue([]),
          requestClaimReview: vi.fn().mockResolvedValue({ items: [] }),
          submitOrganizationClaim: vi.fn(),
          vouchOrganizationClaim: vi.fn(),
        };
        const api = makeApi({ loadDesk: vi.fn().mockResolvedValue(JSON.parse(JSON.stringify(fallbackData.adminDesk))), ...claimApi });
        render(
          <LanguageProvider lang="en">
            <WorkspacePages view="admin" hat="admin" location={window.location.href} navigate={vi.fn()}>
              <AdminView data={data} api={api} onNotice={vi.fn()} demo={demo} />
            </WorkspacePages>
          </LanguageProvider>,
        );
        await vi.waitFor(() => expect(api.loadDesk).toHaveBeenCalled());
        await screen.findAllByText(/Alex Rivera|Load failed|Seats|seats/);
        for (const name of ["Verify your organization", "Vouch for chapters"]) {
          expect(screen.queryByRole("heading", { name })).toBeNull();
        }
        for (const text of [
          "Verification requests aren't sent from the demo.",
          "Nothing is waiting for your vouch.",
          "This page is for the platform verifier.",
          "Reviewing organization claims isn't available in the demo.",
        ]) {
          expect(screen.queryByText(text)).toBeNull();
        }
        for (const fn of Object.values(claimApi)) expect(fn).not.toHaveBeenCalled();
        expect(document.querySelector('a[href^="/m/admin/catalog-"]')).toBeNull();
      });
    }
  }
});

describe("admin view MFA reset while it runs", () => {
  const maria = { userId: "10000000-0000-4000-8000-000000000001", fullName: "Maria Fonseca", initials: "MF", memberSince: 2024, chapterName: "Harborview Care United", roles: [] };
  const NAME = "Maria Fonseca — With the campaign since 2024 · Harborview Care United — Worker ID ending 000001";
  async function openConfirmation(api) {
    renderAdmin("en", { api });
    await screen.findAllByText("Alex Rivera");
    fireEvent.change(screen.getByRole("searchbox", { name: "Search workers by name (min 2 characters)" }), { target: { value: "Maria" } });
    fireEvent.click(screen.getByRole("button", { name: "Search" }));
    fireEvent.click(await screen.findByRole("button", { name: `Reset two-step sign-in for ${NAME}` }));
    const confirmation = screen.getByRole("dialog", { name: "Reset this worker's MFA" });
    return { confirmation, remove: within(confirmation).getByRole("button", { name: `Remove two-step sign-in for ${NAME}` }) };
  }

  it("resets once when Remove two-step sign-in is activated twice in one tick", async () => {
    const api = makeApi({ searchMembers: vi.fn().mockResolvedValue([maria]), resetMfa: vi.fn().mockResolvedValue({ removed: 1, notified: true }) });
    const { remove } = await openConfirmation(api);
    await expectOneWriteFromOneTick(api.resetMfa, [() => fireEvent.click(remove), () => fireEvent.click(remove)]);
  });

  it("resets again from an immediate press after a reset that throws at once", async () => {
    const api = makeApi({ searchMembers: vi.fn().mockResolvedValue([maria]), resetMfa: vi.fn().mockResolvedValue({ removed: 1, notified: true }) });
    const { remove } = await openConfirmation(api);
    await expectReadyRetryAfterThrowAtOnce(api.resetMfa, remove);
  });
});
