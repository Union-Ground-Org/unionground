import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { StaffEngagement } from "../src/features/engagement/StaffEngagement.jsx";
import { LanguageProvider } from "../src/lib/LanguageContext.jsx";
import { engagementApi } from "../src/features/engagement/api.js";

// BUG-UG-WEB-ENGAGEMENT-CHANNEL-CARDS-OMIT-CHAPTER-20261002.
//
// Every chapter has the same four spaces, so the Channels tab drew about 80
// identical settings cards and staff could not tell which chapter a control
// changes. The snapshot now names each space's chapter: the cards are grouped
// by chapter and every card names its chapter.

const client = {};
const space = (chapterId, chapterName, name, index) => ({
  spaceId: `${chapterId}-${index}`,
  name,
  chapterId,
  chapterName,
  postingMode: "members",
  slowModeSeconds: 0,
  approvalsRequired: false,
});
const NAMES = ["Actions & turnout", "Contract talk", "General", "Organizing"];
const channels = [
  ...NAMES.map((name, index) => space("worcester", "Harborview Care United", name, index)),
  ...NAMES.map((name, index) => space("boston", "Boston DMH", name, index)),
];

async function renderChannels(snapshotChannels, lang = "en") {
  vi.spyOn(engagementApi, "loadStaff").mockResolvedValue({ surveys: [], livePolls: [], pulsePrompts: [], channels: snapshotChannels });
  render(<LanguageProvider lang={lang}><StaffEngagement client={client} /></LanguageProvider>);
  await screen.findByTestId("staff-engagement");
  fireEvent.click(screen.getByRole("button", { name: lang === "es" ? "Canales" : "Channels" }));
}

beforeEach(() => {
  vi.spyOn(engagementApi, "loadOrganizationSwitches").mockResolvedValue({ switches: {} });
  vi.spyOn(engagementApi, "setChannelControls").mockResolvedValue({});
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

describe("engagement channel cards name their chapter", () => {
  it("labels two same-named spaces with their chapters so they are distinguishable", async () => {
    await renderChannels(channels);
    const worcester = screen.getByRole("article", { name: "Actions & turnout, Harborview Care United" });
    const boston = screen.getByRole("article", { name: "Actions & turnout, Boston DMH" });
    expect(worcester).not.toBe(boston);
    expect(within(worcester).getByText("Campaign: Harborview Care United")).toBeInTheDocument();
    expect(within(boston).getByText("Campaign: Boston DMH")).toBeInTheDocument();
    expect(screen.getAllByRole("article", { name: /^Actions & turnout, / })).toHaveLength(2);
  });

  it("groups the cards by chapter, the first group open and the rest collapsed", async () => {
    await renderChannels(channels);
    const groups = [...document.querySelectorAll("details.eng-channel-group")];
    expect(groups.map((group) => group.querySelector("summary").textContent)).toEqual(["Harborview Care United (4)", "Boston DMH (4)"]);
    expect(groups.map((group) => group.open)).toEqual([true, false]);
    for (const [group, chapter] of [[groups[0], "Harborview Care United"], [groups[1], "Boston DMH"]]) {
      const cards = within(group).getAllByRole("article");
      expect(cards).toHaveLength(4);
      expect(cards.every((card) => card.getAttribute("aria-label").endsWith(`, ${chapter}`))).toBe(true);
    }
    expect(screen.getByRole("article", { name: "General, Boston DMH" })).not.toBeVisible();
    fireEvent.click(within(groups[1]).getByText("Boston DMH (4)"));
    expect(screen.getByRole("article", { name: "General, Boston DMH" })).toBeVisible();
  });

  it("changes the control of the chapter whose card was used", async () => {
    await renderChannels(channels);
    const boston = screen.getByRole("article", { name: "Actions & turnout, Boston DMH" });
    fireEvent.change(within(boston).getByLabelText("Posting"), { target: { value: "staff_only" } });
    await waitFor(() => expect(engagementApi.setChannelControls).toHaveBeenCalledTimes(1));
    expect(engagementApi.setChannelControls.mock.calls[0][1]).toBe("boston-0");
    expect(engagementApi.setChannelControls.mock.calls[0][2].postingMode).toBe("staff_only");
  });

  it("keeps the flat list for a snapshot that carries no chapter", async () => {
    await renderChannels(channels.slice(0, 2).map(({ chapterId: _id, chapterName: _name, ...rest }) => rest));
    expect(document.querySelector("details.eng-channel-group")).toBeNull();
    expect(screen.getByRole("heading", { name: "Actions & turnout" })).toBeVisible();
    expect(screen.queryByText(/^Campaign:/)).toBeNull();
  });

  it("names the chapter in Spanish", async () => {
    await renderChannels(channels, "es");
    expect(screen.getByRole("article", { name: "General, Boston DMH" })).toBeInTheDocument();
    expect(screen.getAllByText("Campaña: Harborview Care United")).toHaveLength(4);
  });
});
