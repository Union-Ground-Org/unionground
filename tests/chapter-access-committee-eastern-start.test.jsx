// #8568 part A, gate stage 222 r1s1: a new committee made with the form's
// defaults starts on today's Eastern date. The committee readers now count the
// Eastern day, so a start prefilled with the UTC date (tomorrow from 7 PM
// Eastern) would keep the committee's access closed until Eastern midnight.
// The form and the real chapter access API run here, at 7:30 PM Eastern on
// November 14, 2026 (00:30 UTC on November 15), over a fake RPC client.
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LanguageProvider } from "../src/lib/LanguageContext.jsx";
import { ChapterAccessPanel } from "../src/features/chapterAccess/ChapterAccessPanel.jsx";

// Unit settings and the notice desk have their own suites; this client carries none.
vi.mock("../src/lib/unitSettings.js", async (original) => ({ ...(await original()), createUnitSettingsApi: () => null }));
vi.mock("../src/features/notices/OfficerNoticeDesk.jsx", () => ({ OfficerNoticeDesk: () => null }));
vi.mock("../src/lib/memberApi.js", async (original) => ({ ...(await original()), listMyMemberNotices: vi.fn(), getMemberNoticeReceipts: vi.fn(), listAnnouncementDrafts: vi.fn(), resolveAnnouncementDraft: vi.fn() }));

const EVENING = new Date("2026-11-15T00:30:00Z");
const workspace = () => ({
  policy: { steward_grievances: true, steward_breadth: "chapter" },
  members: [{ id: "m", name: "Fictional Mira" }], units: [], committees: [], grants: [], roles: [], settings: [],
  grantableRoles: ["secretary"], hasMoreMembers: false, hasMoreUnits: false, hasMoreCommittees: false,
});

describe("a new committee made with the form defaults at an Eastern evening instant", () => {
  beforeEach(() => { vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(EVENING); });
  afterEach(() => { vi.useRealTimers(); });

  it("prefills today's Eastern date and sends it to save_chapter_committee", async () => {
    const calls = [];
    const client = {
      rpc: vi.fn(async (name, fields) => {
        calls.push({ name, fields });
        return { data: name === "get_chapter_access_workspace" ? workspace() : {}, error: null };
      }),
    };
    render(<LanguageProvider lang="en"><ChapterAccessPanel client={client} chapterId="ch" /></LanguageProvider>);
    fireEvent.click(await screen.findByRole("button", { name: "New committee" }));
    expect(screen.getByLabelText("Starts")).toHaveValue("2026-11-14");
    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Evening committee" } });
    fireEvent.change(screen.getByLabelText("Purpose"), { target: { value: "Made after 7 PM Eastern" } });
    fireEvent.submit(screen.getByLabelText("Name").closest("form"));
    await waitFor(() => expect(calls.some((call) => call.name === "save_chapter_committee")).toBe(true));
    expect(calls.find((call) => call.name === "save_chapter_committee").fields).toMatchObject({
      p_chapter: "ch", p_name: "Evening committee", p_starts_on: "2026-11-14", p_ends_on: null,
    });
  });
});
