import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { AdminView, invitationTargetChapterId } from "../src/views/AdminView.jsx";
import { LanguageProvider } from "../src/lib/LanguageContext.jsx";
import { fallbackData } from "./fixtures/retired-pre-bot/src/data/fallback.js";
import { AdminInvitationError } from "../src/lib/adminInvitationApi.js";
import { t } from "../src/lib/i18n.js";

// Union Ground labels the hats Committee / Campaign lead / Advisor /
// Campaign chair; the internal ids stay steward / coordinator / advisor / vp.
// The chapter-only scope note is catalogue copy the wave-2 copy pass rewords,
// so it is read from the catalogue rather than pinned.
const CHAIR_SCOPE = t("en", "admin.invitePresidentScope");

function deskWith(invitations) {
  return { ...JSON.parse(JSON.stringify(fallbackData.adminDesk)), invitations };
}

function renderAdmin(invitations, overrides = {}, lang = "en") {
  const api = {
    loadDesk: vi.fn().mockResolvedValue(deskWith(invitations)),
    grantRole: vi.fn(), revokeRole: vi.fn(), searchMembers: vi.fn(),
    createEvent: vi.fn(), updateEvent: vi.fn(), resetMfa: vi.fn(),
    inviteMember: vi.fn().mockResolvedValue({ accepted: true }),
    resendInvitation: vi.fn().mockResolvedValue({ accepted: true }),
    revokeInvitation: vi.fn().mockResolvedValue({ accepted: true }),
    ...overrides,
  };
  const onNotice = vi.fn();
  render(
    <LanguageProvider lang={lang}>
      <AdminView data={{ member: { initials: "AR" } }} api={api} onNotice={onNotice} />
    </LanguageProvider>,
  );
  return { api, onNotice };
}

describe("admin member invitations", () => {
  it("creates a same-chapter invitation without any password field", async () => {
    const { api, onNotice } = renderAdmin({ chapter: { id: "ma-dcf", name: "North County Transit Workers" }, items: [] });
    const card = (await screen.findByRole("heading", { name: "Invite a worker" })).closest("article");
    expect(within(card).queryByLabelText(/password/i)).not.toBeInTheDocument();
    expect(within(card).getByLabelText("Campaign")).toBeDisabled();

    fireEvent.change(within(card).getByLabelText("Full name"), { target: { value: "Rosa Delgado" } });
    fireEvent.change(within(card).getByLabelText("Email address"), { target: { value: "rosa@example.org" } });
    fireEvent.change(within(card).getByLabelText("Starting access"), { target: { value: "steward" } });
    fireEvent.change(within(card).getByLabelText("Invitation language"), { target: { value: "es" } });
    fireEvent.click(within(card).getByRole("button", { name: "Send invitation" }));

    await waitFor(() => expect(api.inviteMember).toHaveBeenCalledWith({
      fullName: "Rosa Delgado",
      email: "rosa@example.org",
      chapterId: "ma-dcf",
      initialRole: "steward",
      locale: "es",
      formerMember: false,
    }));
    expect(onNotice).toHaveBeenCalledWith("If that address is eligible, its invitation is on the way.");
    expect(within(card).getByRole("status")).toHaveTextContent("If that address is eligible");
  });

  // REQ-UG-OFFICER-ROLES-VP-TREASURER-SECRETARY-20261006: owner decision
  // October 8, 2026, President can be chosen when inviting, for this chapter only.
  it("offers Campaign chair as starting access and says it covers this chapter only", async () => {
    const { api } = renderAdmin({ chapter: { id: "ma-dcf", name: "North County Transit Workers" }, chapters: [{ id: "ma-dcf", name: "North County Transit Workers", grantsAccess: true }], items: [] });
    const card = (await screen.findByRole("heading", { name: "Invite a worker" })).closest("article");
    const access = within(card).getByLabelText("Starting access");
    expect([...access.options].map((option) => option.textContent)).toEqual([t("en", "admin.inviteMemberRole"), "Committee", "Organizer", "Campaign lead", "Advisor", "Campaign chair"]);
    expect([...access.options].map((option) => option.value)).toEqual(["", "steward", "organizer", "coordinator", "advisor", "vp"]);
    expect([...access.options].map((option) => option.value)).not.toContain("admin");
    expect(within(card).queryByText(CHAIR_SCOPE)).not.toBeInTheDocument();

    fireEvent.change(within(card).getByLabelText("Full name"), { target: { value: "Teo Vance" } });
    fireEvent.change(within(card).getByLabelText("Email address"), { target: { value: "teo@example.org" } });
    fireEvent.change(access, { target: { value: "vp" } });
    expect(within(card).getByText(CHAIR_SCOPE)).toBeInTheDocument();
    fireEvent.click(within(card).getByRole("button", { name: "Send invitation" }));
    await waitFor(() => expect(api.inviteMember).toHaveBeenCalledWith(expect.objectContaining({ initialRole: "vp", chapterId: "ma-dcf", formerMember: false })));
  });

  // Gate round 1 on #4119 (P2): create_member_invitation refuses President in
  // a chapter the admin only presides over, so the form does not offer it there.
  it("offers Campaign chair only for a chapter this admin administers", async () => {
    const { api } = renderAdmin({
      chapter: { id: "ma-dcf", name: "North County Transit Workers" },
      chapters: [{ id: "ma-dcf", name: "North County Transit Workers", grantsAccess: true }, { id: "ma-hhs", name: "HHS Chapter", grantsAccess: false }],
      items: [],
    });
    const card = (await screen.findByRole("heading", { name: "Invite a worker" })).closest("article");
    const access = within(card).getByLabelText("Starting access");
    fireEvent.change(access, { target: { value: "vp" } });
    expect(within(card).getByText(CHAIR_SCOPE)).toBeInTheDocument();

    fireEvent.change(within(card).getByLabelText("Campaign"), { target: { value: "ma-hhs" } });
    expect([...access.options].map((option) => option.value)).not.toContain("vp");
    expect(access).toHaveValue("");
    expect(within(card).queryByText(CHAIR_SCOPE)).not.toBeInTheDocument();
    fireEvent.change(within(card).getByLabelText("Full name"), { target: { value: "Teo Vance" } });
    fireEvent.change(within(card).getByLabelText("Email address"), { target: { value: "teo@example.org" } });
    fireEvent.click(within(card).getByRole("button", { name: "Send invitation" }));
    await waitFor(() => expect(api.inviteMember).toHaveBeenCalledWith(expect.objectContaining({ chapterId: "ma-hhs", initialRole: null })));

    fireEvent.change(within(card).getByLabelText("Campaign"), { target: { value: "ma-dcf" } });
    expect([...access.options].map((option) => option.value)).toContain("vp");
  });

  it("keeps failed reads distinct from an empty invitation list", async () => {
    renderAdmin(null);
    expect(await screen.findByText("Invitations could not be loaded.")).toBeInTheDocument();
    expect(screen.queryByText("No invitations yet.")).not.toBeInTheDocument();
  });

  it("resends and confirm-revokes a pending invitation", async () => {
    const invitation = {
      id: "9c6f596a-e8ae-4a8a-95c7-9f620671047e",
      normalizedEmail: "rosa@example.org",
      fullName: "Rosa Delgado",
      initialRole: null,
      locale: "es",
      status: "pending",
      deliveryVersion: 1,
      createdLabel: "Aug 12 · 2:00 PM",
      expiresLabel: "Aug 12 · 2:15 PM",
    };
    const { api } = renderAdmin({ chapter: { id: "ma-dcf", name: "North County Transit Workers" }, items: [invitation] });
    const card = (await screen.findByRole("heading", { name: "Invite a worker" })).closest("article");
    fireEvent.click(within(card).getByRole("button", { name: "Resend" }));
    await waitFor(() => expect(api.resendInvitation).toHaveBeenCalledWith(invitation.id));
    await waitFor(() => expect(within(card).getByRole("button", { name: "Revoke invitation" })).toBeEnabled());

    fireEvent.click(within(card).getByRole("button", { name: "Revoke invitation" }));
    const confirmation = await waitFor(() =>
      within(card).getByRole("group", { name: "Revoke the invitation for Rosa Delgado?" }),
    );
    fireEvent.click(within(confirmation).getByRole("button", { name: "Yes, revoke" }));
    await waitFor(() => expect(api.revokeInvitation).toHaveBeenCalledWith(invitation.id));
  });

  // BUG-UG-ADMIN-INVITATIONS-503-THEN-202-20261003: two 503s then a
  // 202 left the admin unsure whether the invitation went out. A busy answer
  // now says so, says a retry is safe, and keeps the form for one more press.
  it("says a busy failure is safe to retry and keeps the form for the retry", async () => {
    const inviteMember = vi.fn()
      .mockRejectedValueOnce(new AdminInvitationError("service-unavailable", 503))
      .mockResolvedValueOnce({ accepted: true });
    const { onNotice } = renderAdmin({ chapter: { id: "ma-dcf", name: "North County Transit Workers" }, items: [] }, { inviteMember });
    const card = (await screen.findByRole("heading", { name: "Invite a worker" })).closest("article");
    fireEvent.change(within(card).getByLabelText("Full name"), { target: { value: "Keisha Monroe" } });
    fireEvent.change(within(card).getByLabelText("Email address"), { target: { value: "keisha@example.org" } });
    fireEvent.click(within(card).getByRole("button", { name: "Send invitation" }));
    expect(await within(card).findByRole("alert")).toHaveTextContent(t("en", "admin.invitationRetry"));
    expect(within(card).getByLabelText("Email address")).toHaveValue("keisha@example.org");
    fireEvent.click(within(card).getByRole("button", { name: "Send invitation" }));
    await waitFor(() => expect(onNotice).toHaveBeenCalledWith("If that address is eligible, its invitation is on the way."));
    expect(within(card).queryByRole("alert")).toBeNull();
    expect(inviteMember).toHaveBeenCalledTimes(2);
  });

  it("does not claim an unconfirmed send failed, and does not invite a second send", async () => {
    renderAdmin({ chapter: { id: "ma-dcf", name: "North County Transit Workers" }, items: [] }, { inviteMember: vi.fn().mockRejectedValue(new AdminInvitationError("delivery-status-unavailable", 503)) });
    const card = (await screen.findByRole("heading", { name: "Invite a worker" })).closest("article");
    fireEvent.change(within(card).getByLabelText("Full name"), { target: { value: "Grant Whitfield" } });
    fireEvent.change(within(card).getByLabelText("Email address"), { target: { value: "grant@example.org" } });
    fireEvent.click(within(card).getByRole("button", { name: "Send invitation" }));
    const alert = await within(card).findByRole("alert");
    expect(alert).toHaveTextContent(t("en", "admin.invitationUnconfirmed"));
    expect(alert).not.toHaveTextContent(/did not go through|safe/);
  });

  it("says the same for a dropped connection, in Spanish too", async () => {
    renderAdmin({ chapter: { id: "ma-dcf", name: "Capítulo DCF" }, items: [] }, { inviteMember: vi.fn().mockRejectedValue(new TypeError("Load failed")) }, "es");
    const card = (await screen.findByRole("heading", { name: "Invitar a un trabajador" })).closest("article");
    fireEvent.change(within(card).getByLabelText("Nombre completo"), { target: { value: "Tomás Echeverría" } });
    fireEvent.change(within(card).getByLabelText("Correo electrónico"), { target: { value: "tomas@example.org" } });
    fireEvent.click(within(card).getByRole("button", { name: "Enviar invitación" }));
    expect(await within(card).findByRole("alert")).toHaveTextContent("Enviarla otra vez es seguro");
    expect(within(card).queryByText("Load failed")).toBeNull();
  });

  it("shows a stable inline error and bilingual labels", async () => {
    const failing = vi.fn().mockRejectedValue(new Error("provider_internal_payload"));
    renderAdmin({ chapter: { id: "ma-dcf", name: "Capítulo DCF" }, items: [] }, { inviteMember: failing }, "es");
    const card = (await screen.findByRole("heading", { name: "Invitar a un trabajador" })).closest("article");
    fireEvent.change(within(card).getByLabelText("Nombre completo"), { target: { value: "Rosa Delgado" } });
    fireEvent.change(within(card).getByLabelText("Correo electrónico"), { target: { value: "rosa@example.org" } });
    fireEvent.click(within(card).getByRole("button", { name: "Enviar invitación" }));
    expect(await within(card).findByRole("alert")).toHaveTextContent("No se pudo procesar la invitación");
    expect(within(card).queryByText("provider_internal_payload")).not.toBeInTheDocument();
  });
});

describe("organization admin re-invitation of a former member", () => {
  it("sends a former-member invitation without a name or starting access and labels the row", async () => {
    const reactivation = {
      id: "0f2f9c3e-6f7a-4c1b-9e6d-2a5b8c7d9e10",
      kind: "reactivation",
      normalizedEmail: "former@example.org",
      fullName: "Luis Ortega",
      initialRole: null,
      locale: "en",
      status: "pending",
      deliveryVersion: 1,
      createdLabel: "Sep 27 · 10:00 AM",
      expiresLabel: "Sep 27 · 10:15 AM",
    };
    const { api } = renderAdmin({ chapter: { id: "ma-dcf", name: "North County Transit Workers" }, items: [reactivation] });
    const card = (await screen.findByRole("heading", { name: "Invite a worker" })).closest("article");
    expect(within(card).getByText("Former participant")).toBeInTheDocument();

    fireEvent.change(within(card).getByLabelText("Full name"), { target: { value: "Should be cleared" } });
    fireEvent.change(within(card).getByLabelText("Starting access"), { target: { value: "steward" } });
    fireEvent.click(within(card).getByLabelText("This person took part in this organization before and still has an account"));
    expect(within(card).getByLabelText("Full name")).toBeDisabled();
    expect(within(card).getByLabelText("Starting access")).toBeDisabled();
    expect(within(card).getByText(/Organization admins only/)).toBeInTheDocument();
    fireEvent.change(within(card).getByLabelText("Email address"), { target: { value: "former@example.org" } });
    fireEvent.click(within(card).getByRole("button", { name: "Send invitation" }));

    await waitFor(() => expect(api.inviteMember).toHaveBeenCalledWith({
      fullName: "",
      email: "former@example.org",
      chapterId: "ma-dcf",
      initialRole: null,
      locale: "en",
      formerMember: true,
    }));
    await waitFor(() => expect(within(card).getByLabelText("This person took part in this organization before and still has an account")).not.toBeChecked());
  });
});

// BUG-UG-INVITE-CHAPTER-LOCKED-TO-CURRENT-CHAPTER-20261003
describe("admin member invitations: choosing the invitee's chapter", () => {
  const local = { id: "hb-local", name: "Harrow Bay Local" };
  const hhs = { id: "hb-hhs", name: "HHS Chapter" };

  it("offers the chapters the database allows and sends the chosen one, without changing the selected chapter", async () => {
    const { api } = renderAdmin({
      chapter: local,
      chapters: [local, hhs],
      items: [{
        id: "11111111-1111-4111-8111-111111111111", fullName: "Nadia Okafor", normalizedEmail: "nadia@example.org",
        chapterId: hhs.id, chapterName: hhs.name, status: "pending", initialRole: null, locale: "en",
        expiresAt: "2026-10-04T12:00:00Z", createdAt: "2026-10-04T11:45:00Z",
      }],
    });
    const card = (await screen.findByRole("heading", { name: "Invite a worker" })).closest("article");
    const picker = within(card).getByLabelText("Campaign");
    expect(picker.tagName).toBe("SELECT");
    expect(picker).not.toBeDisabled();
    expect(picker).toHaveValue(local.id);
    expect(within(picker).getAllByRole("option").map((option) => option.textContent)).toEqual([local.name, hhs.name]);
    expect(within(card).getAllByText(hhs.name).length).toBeGreaterThan(1);

    fireEvent.change(picker, { target: { value: hhs.id } });
    fireEvent.change(within(card).getByLabelText("Full name"), { target: { value: "Tomás Reyes" } });
    fireEvent.change(within(card).getByLabelText("Email address"), { target: { value: "tomas@example.org" } });
    fireEvent.click(within(card).getByRole("button", { name: "Send invitation" }));

    await waitFor(() => expect(api.inviteMember).toHaveBeenCalledWith(expect.objectContaining({
      email: "tomas@example.org",
      chapterId: hhs.id,
    })));
  });

  it("keeps the chapter locked when the admin may invite into one chapter only", async () => {
    renderAdmin({ chapter: local, chapters: [local], items: [] });
    const card = (await screen.findByRole("heading", { name: "Invite a worker" })).closest("article");
    const field = within(card).getByLabelText("Campaign");
    expect(field.tagName).toBe("INPUT");
    expect(field).toBeDisabled();
    expect(field).toHaveValue(local.name);
  });

  it("falls back to the selected chapter for a pick the database did not list", () => {
    const invitations = { chapter: local, chapters: [local, hhs] };
    expect(invitationTargetChapterId(invitations, hhs.id)).toBe(hhs.id);
    expect(invitationTargetChapterId(invitations, "other-org-chapter")).toBe(local.id);
    expect(invitationTargetChapterId(invitations, "")).toBe(local.id);
    expect(invitationTargetChapterId({ chapter: local }, hhs.id)).toBe(local.id);
  });
});

// BUG-UG-INVITE-STARTING-ACCESS-NO-OFFICER-TITLES-20261003
describe("admin member invitations: how officers are represented", () => {
  const chapter = { id: "hb-hhs", name: "HHS Chapter" };
  const titled = (displayTitle) => ({ items: [{ userId: "u-1", fullName: "Nadia Okafor", initials: "NO", memberSince: null, chapterId: chapter.id, chapterName: chapter.name, roles: [], displayTitle }], nextCursor: null });

  it.each([
    ["en", "Titles such as Vice Chair, Treasurer or Secretary are display only and grant no access; Starting access is assigned separately. After the person joins, set their title in the worker directory."],
    ["es", "Los cargos como Vicepresidencia, Tesorería o Secretaría solo se muestran y no dan acceso; el acceso inicial se asigna por separado. Cuando la persona se una, asigna su cargo en el directorio de trabajadores."],
  ])("explains in the form that titles are display-only and set later in the directory (%s)", async (lang, note) => {
    const invitations = { chapter, items: [] };
    const { api } = renderAdmin(invitations, { loadDesk: vi.fn().mockResolvedValue({ ...deskWith(invitations), memberDirectory: titled(null) }) }, lang);
    const heading = lang === "es" ? "Invitar a un trabajador" : "Invite a worker";
    const card = (await screen.findByRole("heading", { name: heading })).closest("article");
    expect(within(card).getByText(note)).toBeInTheDocument();
    if (lang !== "en") return;
    // The explanation changes nothing about what the form sends.
    fireEvent.change(within(card).getByLabelText("Full name"), { target: { value: "Rosa Delgado" } });
    fireEvent.change(within(card).getByLabelText("Email address"), { target: { value: "rosa@example.org" } });
    fireEvent.change(within(card).getByLabelText("Starting access"), { target: { value: "steward" } });
    fireEvent.click(within(card).getByRole("button", { name: "Send invitation" }));
    await waitFor(() => expect(api.inviteMember).toHaveBeenCalledWith({
      fullName: "Rosa Delgado", email: "rosa@example.org", chapterId: chapter.id, initialRole: "steward", locale: "en", formerMember: false,
    }));
  });

  it("refreshes the desk after a title save so the audit trail shows it", async () => {
    const invitations = { chapter, items: [] };
    const directory = { items: [{ ...titled(null).items[0], displayTitleEditable: true }], nextCursor: null };
    const { api } = renderAdmin(invitations, {
      loadDesk: vi.fn().mockResolvedValue({ ...deskWith(invitations), memberDirectory: directory }),
      setMemberDisplayTitle: vi.fn().mockResolvedValue({ updated: true, displayTitle: "Trustee" }),
    });
    fireEvent.click(await screen.findByRole("button", { name: "Set a title for Nadia Okafor" }));
    fireEvent.change(screen.getByLabelText(/^Title/), { target: { value: "Trustee" } });
    fireEvent.click(screen.getByRole("button", { name: "Save title" }));
    await waitFor(() => expect(api.setMemberDisplayTitle).toHaveBeenCalledWith("u-1", chapter.id, "Trustee"));
    await waitFor(() => expect(api.loadDesk).toHaveBeenCalledTimes(2));
  });

  it("says nothing about titles while the directory cannot carry them", async () => {
    const invitations = { chapter, items: [] };
    const { container } = { container: document.body };
    renderAdmin(invitations, { loadDesk: vi.fn().mockResolvedValue({ ...deskWith(invitations), memberDirectory: { items: [{ userId: "u-1", fullName: "Nadia Okafor", initials: "NO", chapterId: chapter.id, chapterName: chapter.name, roles: [] }], nextCursor: null } }) });
    await screen.findByRole("heading", { name: "Invite a worker" });
    expect(container.textContent).not.toContain("Titles such as");
    expect(screen.getByLabelText("Starting access")).toBeInTheDocument();
  });
});

