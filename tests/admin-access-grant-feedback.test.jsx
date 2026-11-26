// BUG-UG-PRESIDENT-GRANT-UNCONFIRMED-AND-NOT-APPLIED-20261006: a
// founder granted President and "never saw whether the grant stuck". The
// access card now keeps the outcome in place, names the member and role, says
// when the grantee will see it, and says when the staff two-step policy will
// hold the role back (loadMemberApp gives such a grantee no staff roles).
import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { AdminView } from "../src/views/AdminView.jsx";
import { LanguageProvider } from "../src/lib/LanguageContext.jsx";
import { MemberApiError } from "../src/lib/memberApiError.js";
import { fallbackData } from "./fixtures/retired-pre-bot/src/data/fallback.js";
import { mergeSelectedMembershipRoles } from "../src/lib/memberApi.js";
import { t } from "../src/lib/i18n.js";

const DEE = { userId: "member-dw", fullName: "Dee Whitcombe", initials: "DW", memberSince: 2019, roles: [] };

function desk({ requireStaffMfa = false, staff } = {}) {
  const value = JSON.parse(JSON.stringify(fallbackData.adminDesk));
  value.mfaPolicy = { requireStaffMfa, staffTotal: 2, staffEnrolled: 1, callerEnrolled: true };
  if (staff) value.mfa = { ...value.mfa, staff };
  return value;
}

function renderAccess({ lang = "en", grantRole, deskValue = desk(), afterWrite } = {}) {
  const loadDesk = vi.fn().mockResolvedValue(afterWrite ?? deskValue);
  if (afterWrite) loadDesk.mockResolvedValueOnce(deskValue);
  const api = {
    loadDesk,
    grantRole: grantRole || vi.fn().mockResolvedValue({ granted: true }),
    revokeRole: vi.fn().mockResolvedValue({ revoked: true }),
    searchMembers: vi.fn().mockResolvedValue([DEE]),
    loadFormTemplates: vi.fn().mockResolvedValue([]),
    loadFailedLoginInbox: vi.fn().mockResolvedValue({ items: [], openLast24Hours: 0, attentionThreshold: 5 }),
    loadAdministrativeEvidence: vi.fn().mockResolvedValue({ fieldNoteBlocks: [], packets: [], actions: [], history: [] }),
  };
  const onNotice = vi.fn();
  render(
    <LanguageProvider lang={lang}>
      <AdminView data={{ member: { initials: "CR", chapterName: "Copperline Library", organizationRoles: ["admin"] } }} api={api} onNotice={onNotice} />
    </LanguageProvider>,
  );
  return { api, onNotice };
}

async function grantCampaignChair({ search, role, grant }) {
  await screen.findAllByText("Alex Rivera");
  const access = within(document.getElementById("admin-access"));
  fireEvent.change(access.getByRole("searchbox", { name: search }), { target: { value: "Dee" } });
  fireEvent.submit(access.getByRole("searchbox", { name: search }).closest("form"));
  await access.findByText("Dee Whitcombe");
  fireEvent.change(access.getByRole("combobox", { name: role }), { target: { value: "vp" } });
  fireEvent.click(access.getByRole("button", { name: new RegExp(`^${grant}`) }));
  return access;
}

// The vp role id is labelled Campaign chair in Union Ground (the hat
// glossary); the internal id stays vp so role rows and RPCs keep matching.
const CHAIR = "Campaign chair";
const CHAIR_ES = "Presidencia de campaña";
// The grant notes are catalogue sentences the wave-2 copy pass is rewording
// for Union Ground, so they are built from the catalogue with the real
// name and role filled in, rather than pinning today's words.
const NAME = "Dee Whitcombe";
const VISIBLE = t("en", "admin.grantResultVisible");
const UNKNOWN = t("en", "admin.grantResultMfaUnknown", { name: NAME, role: CHAIR });
const PAUSED = t("en", "admin.grantResultMfa", { name: NAME, role: CHAIR });
const FULL = `${NAME} — With the campaign since 2019 — Worker ID ending DW`;
const DONE = `${FULL} now holds ${CHAIR}.`;
const ES_FULL = `${NAME} — En la campaña desde 2019 — ID de trabajador terminado en DW`;

const EN = { search: "Search workers by name (min 2 characters)", role: "Organization-wide role to grant", grant: `Grant organization-wide ${CHAIR} to ${NAME}` };
const ES = { search: "Busca trabajadores por nombre (mín. 2 caracteres)", role: "Rol de toda la organización a otorgar", grant: `Otorgar ${CHAIR_ES} para toda la organización a ${NAME}` };

describe("access card grant result", () => {
  it("keeps a named success on the card and says when the grantee will see it", async () => {
    const { api, onNotice } = renderAccess();
    const access = await grantCampaignChair(EN);
    const result = await access.findByRole("status");
    expect(api.grantRole).toHaveBeenCalledWith("member-dw", "vp");
    expect(result).toHaveTextContent(DONE);
    expect(result).toHaveTextContent(VISIBLE);
    expect(result).not.toHaveTextContent("two-step");
    // The desk reloads after the write; the result survives the reload.
    await vi.waitFor(() => expect(api.loadDesk).toHaveBeenCalledTimes(2));
    expect(access.getByRole("status")).toHaveTextContent(DONE);
    expect(onNotice).toHaveBeenCalledWith("Role granted");
  });

  // Gate round 2 on #4096: the next-load promise must not sit beside the
  // pause, because loadMemberApp gives that grantee no staff roles.
  it("says the role stays paused, and promises nothing, when staff two-step is required and the grantee has no authenticator", async () => {
    renderAccess({ deskValue: desk({ requireStaffMfa: true, staff: [{ userId: "member-dw", fullName: "Dee Whitcombe", initials: "DW", roles: ["vp"], totpVerified: false }] }) });
    const access = await grantCampaignChair(EN);
    const result = await access.findByRole("status");
    expect(result).toHaveTextContent(PAUSED);
    expect(result).not.toHaveTextContent(VISIBLE);
    expect(result).not.toHaveTextContent("they do not need to sign in again");
    expect(result).not.toHaveTextContent("next time they open");
  });

  it("drops the two-step warning when the grantee already has an authenticator", async () => {
    renderAccess({ deskValue: desk({ requireStaffMfa: true, staff: [{ userId: "member-dw", fullName: "Dee Whitcombe", initials: "DW", roles: ["vp"], totpVerified: true }] }) });
    const access = await grantCampaignChair(EN);
    const result = await access.findByRole("status");
    expect(result).toHaveTextContent(DONE);
    expect(result).toHaveTextContent(VISIBLE);
    expect(result).not.toHaveTextContent("two-step");
  });

  // Gate round 1 on #4096: the MFA roster lists role holders only, so a first
  // grant is absent from the pre-grant desk. Absence is not "no authenticator".
  it("calls a first-time grantee unknown before the reload, then promises visibility once it lists them enrolled", async () => {
    const { api } = renderAccess({
      deskValue: desk({ requireStaffMfa: true }),
      afterWrite: desk({ requireStaffMfa: true, staff: [{ userId: "member-dw", fullName: "Dee Whitcombe", initials: "DW", roles: ["vp"], totpVerified: true }] }),
    });
    // Hold the post-grant reload open: the note first paints on the
    // pre-grant desk, whose roster does not list Dee at all.
    let finishReload;
    api.loadDesk.mockReturnValueOnce(new Promise((resolve) => { finishReload = resolve; }));
    const access = await grantCampaignChair(EN);
    expect(await access.findByRole("status")).toHaveTextContent(DONE);
    await vi.waitFor(() => expect(api.loadDesk).toHaveBeenCalledTimes(2));
    // Absent from the pre-grant roster: unknown, so neither paused nor promised.
    expect(access.getByRole("status")).toHaveTextContent(UNKNOWN);
    expect(access.getByRole("status")).not.toHaveTextContent(PAUSED);
    expect(access.getByRole("status")).not.toHaveTextContent(VISIBLE);
    finishReload(desk({ requireStaffMfa: true, staff: [{ userId: "member-dw", fullName: "Dee Whitcombe", initials: "DW", roles: ["vp"], totpVerified: true }] }));
    await screen.findAllByText("Dee Whitcombe");
    await vi.waitFor(() => expect(access.getByRole("status")).toHaveTextContent(VISIBLE));
    expect(access.getByRole("status")).not.toHaveTextContent("two-step");
  });

  it("names the pause once the post-grant reload lists a first-time grantee without an authenticator", async () => {
    const access = await (async () => {
      renderAccess({
        deskValue: desk({ requireStaffMfa: true }),
        afterWrite: desk({ requireStaffMfa: true, staff: [{ userId: "member-dw", fullName: "Dee Whitcombe", initials: "DW", roles: ["vp"], totpVerified: false }] }),
      });
      return grantCampaignChair(EN);
    })();
    await vi.waitFor(() => expect(access.getByRole("status")).toHaveTextContent(PAUSED));
    expect(access.getByRole("status")).not.toHaveTextContent(VISIBLE);
  });

  it("treats an unread MFA roster as unknown, not unenrolled", async () => {
    const unread = desk({ requireStaffMfa: true });
    unread.mfa = null;
    renderAccess({ deskValue: unread });
    const access = await grantCampaignChair(EN);
    const result = await access.findByRole("status");
    expect(result).toHaveTextContent(DONE);
    expect(result).toHaveTextContent(UNKNOWN);
    expect(result).not.toHaveTextContent(PAUSED);
    expect(result).not.toHaveTextContent(VISIBLE);
  });

  it("names a refusal from catalogue copy, never the server's English, in Spanish", async () => {
    const grantRole = vi.fn().mockRejectedValue(new MemberApiError("Grant role", { code: "42501", message: "organization admin required" }));
    renderAccess({ lang: "es", grantRole });
    const access = await grantCampaignChair(ES);
    const alert = await access.findByRole("alert");
    expect(alert).toHaveTextContent(`No se otorgó ${CHAIR_ES} a ${ES_FULL}. Tu rol no permite este cambio, así que no se cambió nada.`);
    expect(alert).not.toHaveTextContent("organization admin required");
  });

  it("drops the note when the same role is removed again", async () => {
    const after = desk();
    after.roster = [...after.roster, { userId: "member-dw", fullName: "Dee Whitcombe", initials: "DW", memberSince: 2019, roles: ["vp"] }];
    const { api } = renderAccess({ afterWrite: after });
    const access = await grantCampaignChair(EN);
    expect(await access.findByRole("status")).toHaveTextContent(DONE);
    fireEvent.click(await access.findByRole("button", { name: `Remove organization-wide ${CHAIR} from ${NAME}` }));
    await vi.waitFor(() => expect(api.revokeRole).toHaveBeenCalledWith("member-dw", "vp"));
    await vi.waitFor(() => expect(access.queryByText(new RegExp(`now holds ${CHAIR}`))).not.toBeInTheDocument());
    // Gate round 2 on #4104: the search row drops the removed role too, so
    // its Grant button (disabled while the role is held) is offered again.
    await vi.waitFor(() => expect(access.getByRole("button", { name: new RegExp(`^${EN.grant}`) })).not.toBeDisabled());
  });

  // REQ-UG-FOUNDER-SOLE-ADMIN-HANDOFF-TO-OFFICERS-20261006: the
  // president removing the founder's Admin role needs the same in-place
  // confirmation as a grant.
  it("confirms a removal in place, naming the member and role", async () => {
    const { api } = renderAccess();
    await screen.findAllByText("Alex Rivera");
    const access = within(document.getElementById("admin-access"));
    fireEvent.click(access.getByRole("button", { name: "Remove organization-wide Admin from Alex Rivera" }));
    await vi.waitFor(() => expect(api.revokeRole).toHaveBeenCalledWith("staff-ar", "admin"));
    expect(await access.findByRole("status")).toHaveTextContent("Alex Rivera — With the campaign since 2018 — Worker ID ending AR no longer holds Admin.");
  });

  // Gate round 3 on #4104: a founder removing their own Admin role loses the
  // admin reads, so the reload fails; the confirmation must not be hidden
  // behind the failure card.
  it("confirms a founder's own Admin removal even though the desk can no longer load", async () => {
    const loadDesk = vi.fn().mockResolvedValueOnce(desk())
      .mockRejectedValue(new MemberApiError("Staff roster", { code: "42501", message: "organization admin required" }));
    const api = { loadDesk, revokeRole: vi.fn().mockResolvedValue({ revoked: true }), searchMembers: vi.fn().mockResolvedValue([]), loadFormTemplates: vi.fn().mockResolvedValue([]), loadFailedLoginInbox: vi.fn().mockResolvedValue({ items: [], openLast24Hours: 0, attentionThreshold: 5 }), loadAdministrativeEvidence: vi.fn().mockResolvedValue({ fieldNoteBlocks: [], packets: [], actions: [], history: [] }) };
    render(
      <LanguageProvider lang="en">
        <AdminView data={{ member: { id: "staff-ar", initials: "AR", chapterName: "Copperline Library", organizationRoles: ["admin"] } }} api={api} onNotice={vi.fn()} />
      </LanguageProvider>,
    );
    await screen.findAllByText("Alex Rivera");
    const access = within(document.getElementById("admin-access"));
    fireEvent.click(access.getByRole("button", { name: "Remove organization-wide Admin from Alex Rivera" }));
    await vi.waitFor(() => expect(loadDesk).toHaveBeenCalledTimes(2));
    expect(await screen.findByRole("status")).toHaveTextContent("Alex Rivera — With the campaign since 2018 — Worker ID ending AR no longer holds Admin.");
    expect(screen.queryByRole("button", { name: "Try again" })).not.toBeInTheDocument();
  });

  it("names the last-admin refusal from catalogue copy", async () => {
    const { api } = renderAccess();
    api.revokeRole.mockRejectedValue(new MemberApiError("Revoke role", { code: "22023", message: "cannot remove the last organization admin" }));
    await screen.findAllByText("Alex Rivera");
    const access = within(document.getElementById("admin-access"));
    fireEvent.click(access.getByRole("button", { name: "Remove organization-wide Admin from Alex Rivera" }));
    const alert = await access.findByRole("alert");
    expect(alert).toHaveTextContent(`Admin was not removed from Alex Rivera — With the campaign since 2018 — Worker ID ending AR. ${t("en", "admin.revokeLastAdmin")}`);
    expect(alert).not.toHaveTextContent("cannot remove the last");
  });

  it("names a refused grant and its reason in place", async () => {
    const grantRole = vi.fn().mockRejectedValue(new MemberApiError("Grant role", { code: "57014", message: "canceling statement due to statement timeout" }));
    renderAccess({ grantRole });
    const access = await grantCampaignChair(EN);
    const alert = await access.findByRole("alert");
    expect(alert).toHaveTextContent(`${CHAIR} was not granted to ${FULL}. ${t("en", "error.serviceBusy")}`);
    expect(alert).not.toHaveTextContent("canceling statement");
    expect(access.queryByRole("status")).not.toBeInTheDocument();
  });

  it("says nothing changed when the member already held the role", async () => {
    renderAccess({ grantRole: vi.fn().mockResolvedValue({ granted: false }) });
    const access = await grantCampaignChair(EN);
    expect(await access.findByRole("status")).toHaveTextContent(`${FULL} already holds ${CHAIR}. Nothing changed.`);
  });

  it("reports the result in Spanish", async () => {
    renderAccess({ lang: "es" });
    const access = await grantCampaignChair(ES);
    expect(await access.findByRole("status")).toHaveTextContent(`${ES_FULL} ahora tiene el rol ${CHAIR_ES}.`);
  });

  // The grantee half: every load re-reads get_my_chapter_memberships, whose
  // roles include organization_role_grants, so the next load carries the new
  // hat with no new sign-in or token refresh.
  it("gives the grantee the granted hat from the next load's membership projection", () => {
    const memberships = [{ chapterId: "c1", organizationId: "org-1", selected: true, roles: ["vp"], organizationRoles: ["vp"], chapterRoles: [] }];
    expect(mergeSelectedMembershipRoles([], memberships)).toEqual(["vp"]);
  });
});
