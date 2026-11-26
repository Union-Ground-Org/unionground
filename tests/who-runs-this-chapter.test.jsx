import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { LanguageProvider } from "../src/lib/LanguageContext.jsx";
import { leadershipRoleLine } from "../src/lib/chapterLeadership.js";
import { t } from "../src/lib/i18n.js";
import { getChapterLeadership } from "../src/lib/memberApi.js";
import { buildSearchIndex, searchEntries } from "../src/lib/searchIndex.js";
import { SearchView } from "../src/views/SearchView.jsx";
import { SettingsView } from "../src/views/SettingsView.jsx";
import { fallbackData } from "./fixtures/retired-pre-bot/src/data/fallback.js";

// REQ-UG-WHO-RUNS-THIS-CHAPTER-AND-ONE-WORD-FOR-STAFF-20261006:
// nobody could tell what "Staff" means or who runs their chapter, and search
// did not find officers by name. One card lists the chapter's officers,
// President and administrators and defines "staff" and "staff role" once;
// Search finds those people by name.

const tEn = (key, vars) => t("en", key, vars);
const TIMEOUT = { data: null, error: { message: "canceling statement due to statement timeout", code: "57014" } };
const ROSTER = {
  chapterId: "cpl-main",
  chapterName: "Main Branch",
  people: [
    { id: "u-dee", name: "Dolores Whitcombe", title: "President", president: true, administrator: false, organizationAdministrator: false },
    { id: "u-samuel", name: "Samuel Adeyemi", title: "Secretary-Treasurer", president: false, administrator: false, organizationAdministrator: false },
    { id: "u-callum", name: "Callum Reyes", title: null, president: false, administrator: true, organizationAdministrator: true },
  ],
};

function clientWith(responses) {
  return { rpc: vi.fn((name) => Promise.resolve(responses[name])) };
}

describe("chapter leadership API", () => {
  it("reads the caller's own chapter with no chapter id and keeps only named people", async () => {
    const client = clientWith({ get_chapter_leadership: { data: { ...ROSTER, people: [...ROSTER.people, { id: "u-blank", name: "  " }, { name: "No Id" }] }, error: null } });
    // REQ-UG-MEMBER-OFFICER-MESSAGING-AND-VISIBILITY-20261030: an
    // older payload without canMessage or contact reads as not messageable
    // and nothing shared.
    await expect(getChapterLeadership(client)).resolves.toEqual({
      ...ROSTER,
      people: ROSTER.people.map((person) => ({ ...person, treasurer: false, canMessage: false, contact: { email: null, phone: null } })),
    });
    expect(client.rpc).toHaveBeenCalledWith("get_chapter_leadership");
  });

  it("rejects a failed read instead of showing an empty chapter", async () => {
    await expect(getChapterLeadership(clientWith({ get_chapter_leadership: TIMEOUT })))
      .rejects.toMatchObject({ name: "MemberApiError", label: "Chapter leadership", code: "57014" });
  });

  it("names a title once when it repeats the role", () => {
    expect(leadershipRoleLine(ROSTER.people[0], tEn)).toBe("President");
    expect(leadershipRoleLine(ROSTER.people[1], tEn)).toBe("Secretary-Treasurer");
    expect(leadershipRoleLine(ROSTER.people[2], tEn)).toBe("Campaign administrator · Organization administrator");
  });

  it("shows actual Treasurer access independently of a person's display title", async () => {
    const client=clientWith({get_chapter_leadership:{data:{...ROSTER,people:[{id:"fictional-treasurer",name:"Fictional Treasurer",title:"Finance officer",treasurer:true}]},error:null}});
    const result=await getChapterLeadership(client);
    expect(leadershipRoleLine(result.people[0],tEn)).toBe("Finance officer · Treasurer");
    expect(leadershipRoleLine({...result.people[0],title:"Treasurer"},tEn)).toBe("Treasurer");
    expect(leadershipRoleLine({...result.people[0],title:null},key=>t("es",key))).toBe("Tesorero/a");
  });
});

describe("Who runs this campaign card", () => {
  function renderSettings(props) {
    return render(
      <LanguageProvider lang="en">
        <SettingsView
          data={{ member: { id: "u-member", fullName: "Imani Clarke", initials: "IC", chapterName: "Main Branch" }, roles: [], metrics: {}, cases: [], events: [], forms: [], product: { spaces: [] } }}
          onNavigate={vi.fn()}
          onProfile={vi.fn()}
          onAssistant={vi.fn()}
          lang="en"
          onLanguage={vi.fn()}
          {...props}
        />
      </LanguageProvider>,
    );
  }

  it("lists officers, the President and administrators on one screen and defines staff once", async () => {
    renderSettings({ chapterLeadershipApi: { load: async () => ROSTER } });
    const card = (await screen.findByRole("heading", { name: "Who runs this campaign" })).closest("section");
    const rows = await within(card).findAllByRole("listitem");
    expect(rows.map((row) => row.textContent)).toEqual([
      "Dolores WhitcombePresident",
      "Samuel AdeyemiSecretary-Treasurer",
      "Callum ReyesCampaign administrator · Organization administrator",
    ]);
    expect(within(card).getByText(/In this app, staff means anyone with a committee member, campaign lead, advisor, administrator or campaign chair role\. Your staff role is the one you are acting in/)).toBeInTheDocument();
  });

  it("says when nobody is listed and when the roster could not be loaded, keeping the definition", async () => {
    const { unmount } = renderSettings({ chapterLeadershipApi: { load: async () => ({ ...ROSTER, people: [] }) } });
    expect(await screen.findByText("No leaders or administrators are listed for this campaign yet.")).toBeInTheDocument();
    unmount();
    renderSettings({ chapterLeadershipApi: { load: async () => { throw new Error("offline"); } } });
    expect(await screen.findByText(/could not be loaded/)).toHaveAttribute("role", "alert");
    expect(screen.getByText(/In this app, staff means/)).toBeInTheDocument();
  });

  // Union Ground has no member PIN or step-up session, so the only gate
  // left is a backend that can read the roster.
  it("is not offered without a backend", () => {
    renderSettings({ chapterLeadershipApi: null });
    expect(screen.queryByRole("heading", { name: "Who runs this campaign" })).toBeNull();
  });
});

describe("search finds the chapter's officers by name", () => {
  const member = { id: "u-member", organizationId: "org-1", chapterId: "cpl-main" };

  it("indexes each leader by name, title and role, opening the profile page card", () => {
    const people = buildSearchIndex({ member, chapterLeadership: ROSTER }, tEn).filter((item) => item.type === "person");
    expect(people.map((item) => item.title)).toEqual(["Dolores Whitcombe", "Samuel Adeyemi", "Callum Reyes"]);
    const [samuel] = searchEntries(people, "Samuel Adeyemi").flatMap((group) => group.items);
    expect(samuel).toMatchObject({ snippet: "Secretary-Treasurer", meta: "Who runs this campaign", focus: { view: "settings", path: "/m/settings/profile" } });
    expect(searchEntries(people, "treasurer").flatMap((group) => group.items).map((item) => item.title)).toEqual(["Samuel Adeyemi"]);
  });

  it("never indexes another chapter's roster and keeps one entry for a person already listed", () => {
    expect(buildSearchIndex({ member: { ...member, chapterId: "cpl-east" }, chapterLeadership: ROSTER }, tEn)
      .filter((item) => item.type === "person")).toEqual([]);
    const chapterStewards = [{ id: "u-samuel", name: "Samuel Adeyemi", roleLabel: "steward", chapterLabel: "Main Branch", contact: { conversation: true } }];
    const memberOrgStructure = { organizationId: "org-1", chapterId: "cpl-main", charts: [{ chartKind: "union", nodes: [
      { id: "seat-president", nodeKind: "role", label: "President", subtitle: "Dolores Whitcombe", chapterId: null },
    ] }] };
    const people = buildSearchIndex({ member, chapterLeadership: ROSTER, chapterStewards, memberOrgStructure }, tEn).filter((item) => item.type === "person");
    expect(people.filter((item) => item.title === "Samuel Adeyemi")).toEqual([expect.objectContaining({ focus: { view: "today", path: "/m" } })]);
    expect(people.filter((item) => /Dolores Whitcombe/.test(`${item.title} ${item.snippet}`))).toEqual([expect.objectContaining({ title: "President", focus: expect.objectContaining({ view: "orgStructure" }) })]);
    expect(people.filter((item) => item.title === "Callum Reyes")).toHaveLength(1);
  });
});

describe("Search view loads the roster on its own", () => {
  const member = { ...fallbackData.member, id: "u-member", organizationId: "org-1", chapterId: "cpl-main" };

  function renderSearch(rpc) {
    const onOpenResult = vi.fn();
    render(
      <LanguageProvider lang="en">
        <SearchView data={{ ...fallbackData, member }} onOpenResult={onOpenResult} onAskCompass={vi.fn()} chapterLeadershipClient={{ rpc }} />
      </LanguageProvider>,
    );
    return onOpenResult;
  }

  it("finds an officer by name and opens the card", async () => {
    const rpc = vi.fn().mockResolvedValue({ data: ROSTER, error: null });
    const onOpenResult = renderSearch(rpc);
    fireEvent.change(screen.getByRole("searchbox"), { target: { value: "samuel" } });
    fireEvent.click(await screen.findByRole("button", { name: /Samuel Adeyemi/ }));
    expect(rpc).toHaveBeenCalledWith("get_chapter_leadership");
    expect(onOpenResult).toHaveBeenCalledWith({ view: "settings", path: "/m/settings/profile" });
  });

  it("keeps every other result when the roster cannot be read", async () => {
    const rpc = vi.fn().mockResolvedValue(TIMEOUT);
    renderSearch(rpc);
    // A rights lesson stands in for the "other result": Union Ground has no
    // contract clauses to search until a first contract exists.
    fireEvent.change(screen.getByRole("searchbox"), { target: { value: "signing a card" } });
    expect(await screen.findByRole("button", { name: /What signing a card means/ })).toBeInTheDocument();
    expect(rpc).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("alert")).toBeNull();
  });
});
