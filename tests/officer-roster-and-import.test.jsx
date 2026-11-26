import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { DirectoryCard, filterDirectoryRows } from "../src/components/AdminCommandCenter.jsx";
import { RosterInvitations } from "../src/components/RosterInvitations.jsx";
import { matchRosterInvitations, parseRosterInvitations } from "../src/features/memberOperations/rosterInvitations.js";
import { t } from "../src/lib/i18n.js";
import { LanguageProvider } from "../src/lib/LanguageContext.jsx";
import { buildSiteGuide } from "../src/lib/siteGuide.js";
import { STAFF_ROLE_NAVIGATION } from "../src/lib/staffNavigation.js";

// REQ-UG-OFFICER-MEMBER-ROSTER-AND-EXPORT-20261030 (swarm finding 12):
// officers found no roster, no import and no export. The roster (Member
// directory) and the roster-invitation import already existed on the admin
// desk; these pin that officers can now find them, filter the roster, have
// duplicates matched in the import preview, and export the list they see

const wrap = (ui, lang = "en") => render(<LanguageProvider lang={lang}>{ui}</LanguageProvider>);

const PEOPLE = [
  { userId: "u1", fullName: "Ada Stone", initials: "AS", chapterId: "north", chapterName: "North", roles: ["steward"] },
  { userId: "u2", fullName: "Bo Reyes", initials: "BR", chapterId: "south", chapterName: "South", roles: [] },
  { userId: "u3", fullName: "Cy Moss", initials: "CM", chapterId: "north", chapterName: "North", roles: ["admin", "vp"] },
];

describe("roster import duplicate matching", () => {
  // Review: an accepted invitation does not prove a current
  // member — the account may have been deleted since — so only a live pending
  // invitation is skipped and the server's account check decides the rest.
  it("skips rows with a pending invitation and leaves accepted, expired and new rows to the server", () => {
    const rows = parseRosterInvitations([
      "email,full_name",
      "pending@example.invalid,Pat Pending",
      "worker@example.invalid,Mo Worker",
      "expired@example.invalid,Ex Pired",
      "new@example.invalid,Nu Person",
    ].join("\n"));
    const matched = matchRosterInvitations(rows, [
      { normalizedEmail: "pending@example.invalid", status: "pending" },
      { normalizedEmail: "worker@example.invalid", status: "pending" },
      { normalizedEmail: "worker@example.invalid", status: "accepted" },
      { normalizedEmail: "expired@example.invalid", status: "expired" },
    ]);
    expect(matched.map((row) => row.state)).toEqual(["invited", "invited", "ready", "ready"]);
    const acceptedOnly = matchRosterInvitations(rows, [{ normalizedEmail: "worker@example.invalid", status: "accepted" }]);
    expect(acceptedOnly.map((row) => row.state)).toEqual(["ready", "ready", "ready", "ready"]);
    expect(matchRosterInvitations(rows, null).map((row) => row.state)).toEqual(["ready", "ready", "ready", "ready"]);
    // A pending invitation the desk holds without an address matches no row.
    expect(matchRosterInvitations(rows, [null, { status: "pending" }]).map((row) => row.state)).toEqual(["ready", "ready", "ready", "ready"]);
  });

  it("shows matched rows in the preview and never sends them", async () => {
    const api = { inviteMember: vi.fn().mockResolvedValue({ accepted: true }) };
    wrap(<RosterInvitations api={api} chapters={[{ id: "chapter-a", name: "Campaign A" }]}
      invitations={[{ normalizedEmail: "pending@example.invalid", status: "pending" }]} />);
    const file = { size: 100, text: async () => "email,full_name\npending@example.invalid,Pat Pending\nnew@example.invalid,Nu Person" };
    fireEvent.change(screen.getByLabelText(/Roster CSV/), { target: { files: [file] } });
    expect(await screen.findByText("2 rows reviewed · 1 ready to invite")).toBeInTheDocument();
    expect(screen.getByText(/Pat Pending — Skipped: already has a pending invitation/)).toBeInTheDocument();
    expect(screen.getByText(t("en", "roster.matched", { count: 1 }))).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Send 1 invitations" }));
    await screen.findByText(/Nu Person — Invitation accepted/);
    expect(api.inviteMember).toHaveBeenCalledTimes(1);
    expect(api.inviteMember.mock.calls[0][0].email).toBe("new@example.invalid");
  });
});

describe("worker directory for officers", () => {
  it("filters listed workers by role, by no staff role, and by campaign", () => {
    expect(filterDirectoryRows(PEOPLE, { role: "steward" }).map((p) => p.userId)).toEqual(["u1"]);
    expect(filterDirectoryRows(PEOPLE, { role: "member" }).map((p) => p.userId)).toEqual(["u2"]);
    expect(filterDirectoryRows(PEOPLE, { chapterId: "north" }).map((p) => p.userId)).toEqual(["u1", "u3"]);
    expect(filterDirectoryRows(PEOPLE, { role: "vp", chapterId: "south" })).toEqual([]);
    expect(filterDirectoryRows(PEOPLE)).toHaveLength(3);
  });

  it("offers role and campaign filters, the roster import and the CSV export", () => {
    wrap(<DirectoryCard initial={{ items: PEOPLE, nextCursor: null }} api={{ loadMemberDirectory: vi.fn(), exportMemberDirectory: vi.fn() }} />);
    const card = screen.getByRole("heading", { name: "Worker directory" }).closest("article");
    expect(within(card).getByRole("link", { name: "Invite a roster from CSV" })).toHaveAttribute("href", expect.stringContaining("/m/admin/roster-import"));
    expect(within(card).getByRole("link", { name: "Invite a worker" })).toHaveAttribute("href", expect.stringContaining("/m/admin/invitations"));
    expect(within(card).getByRole("button", { name: "Export as CSV" })).toBeInTheDocument();
    expect(within(card).getByText(t("en", "admin.command.directoryExportNote"))).toBeInTheDocument();
    expect(within(card).queryByText(/isn't available yet/)).not.toBeInTheDocument();

    fireEvent.change(within(card).getByLabelText("Role"), { target: { value: "admin" } });
    expect(within(card).getByText("Cy Moss")).toBeInTheDocument();
    expect(within(card).queryByText("Ada Stone")).not.toBeInTheDocument();
    expect(within(card).getByText(t("en", "admin.command.directoryFiltered", { shown: 1, total: 3 }))).toBeInTheDocument();

    fireEvent.change(within(card).getByLabelText("Campaign"), { target: { value: "south" } });
    expect(within(card).getByText(t("en", "admin.command.directoryFilterEmpty"))).toBeInTheDocument();
    fireEvent.change(within(card).getByLabelText("Role"), { target: { value: "" } });
    expect(within(card).getByText("Bo Reyes")).toBeInTheDocument();
  });

  // Review: a name search that loads no one from the selected
  // chapter must not hide the chapter filter that is excluding its results.
  it("keeps an active campaign filter visible and clearable after a search loads another campaign", async () => {
    const api = { loadMemberDirectory: vi.fn().mockResolvedValue({ items: [PEOPLE[1]], nextCursor: null }) };
    wrap(<DirectoryCard initial={{ items: PEOPLE, nextCursor: null }} api={api} />);
    const card = screen.getByRole("heading", { name: "Worker directory" }).closest("article");
    fireEvent.change(within(card).getByLabelText("Campaign"), { target: { value: "north" } });
    fireEvent.change(within(card).getByRole("searchbox"), { target: { value: "Bo" } });
    fireEvent.submit(within(card).getByRole("searchbox").closest("form"));
    await waitFor(() => expect(api.loadMemberDirectory).toHaveBeenCalledWith("Bo", null));
    expect(await within(card).findByText(t("en", "admin.command.directoryFilterEmpty"))).toBeInTheDocument();
    const chapter = within(card).getByLabelText("Campaign");
    expect(chapter).toHaveValue("north");
    expect(within(chapter).getByRole("option", { name: "North" })).toBeInTheDocument();
    fireEvent.change(chapter, { target: { value: "" } });
    expect(within(card).getByText("Bo Reyes")).toBeInTheDocument();
  });

});

describe("finding the roster import", () => {
  it("is its own admin desk page, after invitations", () => {
    const admin = STAFF_ROLE_NAVIGATION.admin;
    const page = admin.find((item) => item.key === "admin-roster-import");
    expect(page).toMatchObject({ path: "/m/admin/roster-import", sectionId: "admin-roster-import", labelKey: "roster.importTitle" });
    expect(admin.indexOf(page)).toBe(admin.findIndex((item) => item.key === "admin-invitations") + 1);
  });

  it("is named in the admin Site guide, with the directory, in both languages", () => {
    for (const lang of ["en", "es"]) {
      const guide = buildSiteGuide({ t: (key, values) => t(lang, key, values), roles: ["admin", "vp"] });
      const admin = guide.sections.find((section) => section.key === "admin");
      expect(admin.destinations.map((item) => item.path)).toEqual(expect.arrayContaining(["/m/admin/roster-import", "/m/admin/member-directory"]));
      expect(admin.body).toContain(t(lang, "admin.command.directoryTitle"));
      expect(admin.body).toContain(t(lang, "roster.importTitle"));
      expect(admin.steps[0]).toContain(t(lang, "roster.importTitle"));
      const vp = guide.sections.find((section) => section.key === "vp");
      expect(vp.body).toContain(t(lang, "admin.command.directoryTitle"));
      // A President invites plain members on their own desk; only
      // the roster import stays with the administrator .
      expect(vp.body).toContain(t(lang, "admin.inviteTitle"));
      expect(vp.body).toContain(t(lang, "roster.importTitle"));
      expect(vp.destinations.map((item) => item.path)).toContain("/m/vp/member-directory");
    }
  });
});
