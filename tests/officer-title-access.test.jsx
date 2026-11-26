// REQ-UG-SCOPED-ROLES-AND-OFFICER-ACCESS-20261030 (#6560, findings 69
// and 76): an officer title is a display title. Someone titled President
// without President access must not read as the chapter's President on any
// leadership surface, and has a visible path to the access: they see who can
// give it, and a chapter administrator can give it from the card.
import { expectHeldWriteFocus, expectOneWriteFromOneTick } from "./helpers/busyWriteFocus.js";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { leadershipRoleLine, ROLE_TITLE_WORDS, titleOnlyRole } from "../src/lib/chapterLeadership.js";
import { chapterLeadershipApiFor } from "../src/lib/chapterLeadershipApi.js";
import { t } from "../src/lib/i18n.js";
import { LanguageProvider } from "../src/lib/LanguageContext.jsx";
import { buildSearchIndex } from "../src/lib/searchIndex.js";
import { SettingsView } from "../src/views/SettingsView.jsx";

const tEn = (key, vars) => t("en", key, vars);
const DEVON = { id: "u-devon", name: "Devon Achterberg", title: "President", president: false, administrator: false, organizationAdministrator: false };
const ROSA = { id: "u-rosa", name: "Rosa Lindqvist", title: null, president: false, administrator: true, organizationAdministrator: false };
const OMAR = { id: "u-omar", name: "Omar Haddad", title: "Administrator", president: false, administrator: false, organizationAdministrator: true };
const roster = (people) => ({ chapterId: "hb-main", chapterName: "Harrow Bay Main", people });

describe("display titles that name a role", () => {
  it("marks a role's name as a title only when the person lacks that role, in either language", () => {
    expect(titleOnlyRole(DEVON)).toBe("president");
    expect(titleOnlyRole({ ...DEVON, president: true })).toBeNull();
    expect(titleOnlyRole({ ...DEVON, title: "  presidenta " })).toBe("president");
    expect(titleOnlyRole({ ...DEVON, title: "Presidente/a" })).toBe("president");
    expect(titleOnlyRole({ ...DEVON, title: "Admin" })).toBe("administrator");
    // An organization administrator holds the administrator role.
    expect(titleOnlyRole(OMAR)).toBeNull();
    expect(titleOnlyRole({ ...DEVON, title: "Secretary-Treasurer" })).toBeNull();
    expect(titleOnlyRole({ ...DEVON, title: null })).toBeNull();
    expect(titleOnlyRole(null)).toBeNull();
  });

  it("knows every catalogue label of both roles, in both languages, without reading the catalogues", () => {
    for (const lang of ["en", "es"]) {
      expect(ROLE_TITLE_WORDS.president).toContain(t(lang, "settings.leadershipPresident").trim().toLocaleLowerCase());
      expect(ROLE_TITLE_WORDS.administrator).toContain(t(lang, "settings.leadershipAdministrator").trim().toLocaleLowerCase());
    }
    expect(titleOnlyRole({ ...DEVON, title: "Administrador/a de la campaña" })).toBe("administrator");
  });

  it("reads a title the same under any host locale", () => {
    // Turkish casing, simulated: a locale-aware lower-casing turns I into a dotless ı.
    const original = String.prototype.toLocaleLowerCase;
    String.prototype.toLocaleLowerCase = function turkish() { return original.call(this, "tr-TR"); };
    try {
      expect("PRESIDENT".toLocaleLowerCase()).toBe("presıdent");
      expect(titleOnlyRole({ ...DEVON, title: "PRESIDENT" })).toBe("president");
      expect(titleOnlyRole({ ...DEVON, title: "ADMIN" })).toBe("administrator");
    } finally {
      String.prototype.toLocaleLowerCase = original;
    }
  });

  it("never names a title-only President as President, in Settings or Search", () => {
    expect(leadershipRoleLine(DEVON, tEn)).toBe("President · title only, no access");
    expect(leadershipRoleLine({ ...DEVON, president: true }, tEn)).toBe("President");
    expect(leadershipRoleLine(DEVON, (key, vars) => t("es", key, vars))).toBe("President · solo título, sin acceso");
    const entries = buildSearchIndex({
      member: { id: "u-member", organizationId: "org-1", chapterId: "hb-main" },
      chapterLeadership: roster([DEVON]),
    }, tEn);
    const devon = entries.find((entry) => entry.id === "person:leader:u-devon");
    expect(devon.snippet).toBe("President · title only, no access");
  });
});

describe("Who runs this campaign: the way to the access a title names", () => {
  function renderCard(api, lang = "en", { adminHatWorn = false } = {}) {
    return render(
      <LanguageProvider lang={lang}>
        <SettingsView
          data={{ member: { id: api.selfId ?? "u-member", fullName: "Viewer", initials: "VW", chapterName: "Harrow Bay Main" }, roles: [], metrics: {}, cases: [], events: [], forms: [], product: { spaces: [] } }}
          onNavigate={vi.fn()} onProfile={vi.fn()} onAssistant={vi.fn()} lang={lang} onLanguage={vi.fn()}
          chapterLeadershipApi={api} adminHatWorn={adminHatWorn}
        />
      </LanguageProvider>,
    );
  }
  const card = async (heading = "Who runs this campaign") => (await screen.findByRole("heading", { name: heading })).closest("section");


  it("points to an organization administrator when the chapter has no administrator, in Spanish too", async () => {
    renderCard({ load: async () => roster([DEVON, OMAR]), selfId: "u-devon" }, "es");
    const section = await card("Quién dirige esta campaña");
    expect(await within(section).findByText("Aquí tu título es President, pero un título no da acceso. Pide acceso de Líder de la campaña a quien administra la organización.")).toBeInTheDocument();
  });

  it("lets a chapter administrator give the access, then reads the roster again", async () => {
    // Settings may read the roster more than once while it mounts, so the
    // proof is one more read after the grant, not a fixed call count.
    let readsAtGrant = null;
    const load = vi.fn(async () => roster(readsAtGrant === null ? [DEVON, ROSA] : [{ ...DEVON, president: true }, ROSA]));
    const grantPresident = vi.fn(async () => { readsAtGrant = load.mock.calls.length; return { changed: true }; });
    renderCard({ load, selfId: "u-rosa", grantPresident }, "en", { adminHatWorn: true });
    const section = await card();
    fireEvent.click(await within(section).findByRole("button", { name: "Give Devon Achterberg campaign lead access" }));
    await waitFor(() => expect(grantPresident).toHaveBeenCalledWith("u-devon", "hb-main"));
    expect(await within(section).findByRole("status")).toHaveTextContent("Devon Achterberg now has campaign lead access.");
    await waitFor(() => expect(load.mock.calls.length).toBeGreaterThan(readsAtGrant));
    await waitFor(() => expect(within(section).queryByRole("button", { name: /campaign lead access/i })).toBeNull());
    expect(within(section).getAllByRole("listitem")[0]).toHaveTextContent(/^Devon AchterbergPresident$/);
  });

  it("says so when the access could not be given", async () => {
    renderCard({ load: async () => roster([DEVON, OMAR]), selfId: "u-omar", grantPresident: vi.fn().mockRejectedValue(new Error("refused")) }, "en", { adminHatWorn: true });
    const section = await card();
    fireEvent.click(await within(section).findByRole("button", { name: "Give Devon Achterberg campaign lead access" }));
    expect(await within(section).findByRole("alert")).toHaveTextContent("Campaign lead access could not be given. Try again.");
  });

  // Record 8435, slice 8: the grant keeps focus while it runs, and two
  // presses in one tick give the access once.
  it("gives the access once when the grant is pressed twice in one tick, and keeps it focused", async () => {
    const grantPresident = vi.fn(async () => ({ changed: false }));
    renderCard({ load: async () => roster([DEVON, ROSA]), selfId: "u-rosa", grantPresident }, "en", { adminHatWorn: true });
    const section = await card();
    const grant = await within(section).findByRole("button", { name: "Give Devon Achterberg campaign lead access" });
    await expectOneWriteFromOneTick(grantPresident, [() => fireEvent.click(grant), () => fireEvent.click(grant)]);
    const again = await within(section).findByRole("button", { name: "Give Devon Achterberg campaign lead access" });
    await waitFor(() => expect(again).not.toHaveAttribute("aria-disabled"));
    await expectHeldWriteFocus(grantPresident, again);
  });

  // Review of slice 8 (F2): the lock ends with granting, so a grant that
  // throws at once leaves a ready button whose next press grants.
  it("grants again from an immediate press after a grant that throws at once", async () => {
    const grantPresident = vi.fn(() => { throw new Error("refused at once"); });
    renderCard({ load: async () => roster([DEVON, ROSA]), selfId: "u-rosa", grantPresident }, "en", { adminHatWorn: true });
    const section = await card();
    const grant = await within(section).findByRole("button", { name: "Give Devon Achterberg campaign lead access" });
    fireEvent.click(grant);
    expect(grant).not.toHaveAttribute("aria-disabled");
    fireEvent.click(grant);
    expect(grantPresident).toHaveBeenCalledTimes(2);
    await act(async () => {});
  });

  it("trusts the viewer's own administrator role when the capped roster leaves them out", async () => {
    const grantPresident = vi.fn().mockResolvedValue({ changed: true });
    render(
      <LanguageProvider lang="en">
        <SettingsView
          data={{ member: { id: "u-late-admin", fullName: "Late Admin", initials: "LA", chapterName: "Harrow Bay Main" }, roles: ["admin"], metrics: {}, cases: [], events: [], forms: [], product: { spaces: [] } }}
          onNavigate={vi.fn()} onProfile={vi.fn()} onAssistant={vi.fn()} lang="en" onLanguage={vi.fn()}
          chapterLeadershipApi={{ load: async () => roster([DEVON]), selfId: "u-late-admin", grantPresident }} adminHatWorn
        />
      </LanguageProvider>,
    );
    const section = await card();
    fireEvent.click(await within(section).findByRole("button", { name: "Give Devon Achterberg campaign lead access" }));
    await waitFor(() => expect(grantPresident).toHaveBeenCalledWith("u-devon", "hb-main"));
  });

  // Codex review on #6666: giving access is a chapter-administration action,
  // so an administrator reading Settings under the Member hat (or any hat but
  // Admin) gets the roster without it.
  it("offers the grant only under the explicitly worn Admin hat", async () => {
    const grantPresident = vi.fn();
    const { unmount } = renderCard({ load: async () => roster([DEVON, ROSA]), selfId: "u-rosa", grantPresident });
    const memberHat = await card();
    expect(await within(memberHat).findByText("President · title only, no access")).toBeInTheDocument();
    expect(within(memberHat).queryByRole("button", { name: /campaign lead access/i })).toBeNull();
    unmount();
    renderCard({ load: async () => roster([DEVON, ROSA]), selfId: "u-rosa", grantPresident }, "en", { adminHatWorn: true });
    const adminHat = await card();
    expect(await within(adminHat).findByRole("button", { name: "Give Devon Achterberg campaign lead access" })).toBeInTheDocument();
    expect(grantPresident).not.toHaveBeenCalled();
  });

  it("offers nothing more to a member who is neither the titled person nor an administrator", async () => {
    renderCard({ load: async () => roster([DEVON, ROSA]), selfId: "u-member", grantPresident: vi.fn() });
    const section = await card();
    expect(await within(section).findByText("President · title only, no access")).toBeInTheDocument();
    expect(within(section).queryByRole("button")).toBeNull();
    expect(within(section).queryByText(/Your title here is/)).toBeNull();
  });
});

describe("the leadership card's API", () => {
  it("reads the roster, knows the signed-in member when asked, and gives President through set_member_chapter_role", async () => {
    const rpc = vi.fn((name) => Promise.resolve(name === "get_chapter_leadership"
      ? { data: roster([DEVON]), error: null }
      : { data: { changed: true }, error: null }));
    const sessionRef = { current: null };
    const api = chapterLeadershipApiFor({ rpc }, sessionRef);
    expect(api.selfId).toBeNull();
    sessionRef.current = { user: { id: "u-rosa" } };
    expect(api.selfId).toBe("u-rosa");
    await expect(api.load()).resolves.toMatchObject({ chapterId: "hb-main", people: [{ id: "u-devon", title: "President" }] });
    await api.grantPresident("u-devon", "hb-main");
    expect(rpc).toHaveBeenLastCalledWith("set_member_chapter_role", { p_user_id: "u-devon", p_chapter_id: "hb-main", p_role: "vp", p_enabled: true });
    expect(chapterLeadershipApiFor({ rpc }, undefined).selfId).toBeNull();
  });
});
