// BUG-UG-STEWARD-SCREENS-CALL-READS-REFUSED-FOR-UNIT-STEWARDS-20261115 (#8921).
//
// Since #7663/#7664 a steward limited to a unit may not send chapter-wide
// notices, and the server refuses such a steward the chapter's announcement
// drafts; the organization-wide engagement snapshot admits only an
// organization-wide staff role.
// The steward broadcasts desk, the Messages announcements reads and the
// engagement studio used to call both anyway, so a newly granted steward saw a
// 403 in the console and no drafts. These pins keep each caller asking first.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { listAnnouncementDrafts } from "../src/lib/memberApi.js";
import { StaffEngagement } from "../src/features/engagement/StaffEngagement.jsx";
import { CampaignsView } from "../src/views/CampaignsView.jsx";
import { engagementApi } from "../src/features/engagement/api.js";
import { LanguageProvider } from "../src/lib/LanguageContext.jsx";

const DRAFT = { id: "draft-1", title: "Upcoming: Contract town hall", body: "Location: Union hall", eventId: "event-1", createdAt: "2026-11-15T12:00:00Z" };
const office = (fields) => ({ chapterId: "tv-alder", notices: true, scopes: [], ...fields });

function client(answers) {
  return {
    rpc: vi.fn(async (name) => {
      if (!(name in answers)) throw new Error(`unexpected rpc ${name}`);
      const answer = answers[name];
      return answer instanceof Error ? { data: null, error: { code: "42501", message: answer.message } } : { data: answer, error: null };
    }),
  };
}
const source = (path) => readFileSync(resolve(process.cwd(), path), "utf8");
const called = (rpc) => rpc.mock.calls.map(([name]) => name);

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("announcement drafts read for the steward desk and Messages", () => {
  it("never calls the drafts read for a steward who may send only to a unit", async () => {
    const c = client({ get_chapter_office_access: office({ unscopedNotices: false, scopes: [{ role: "steward", notices: true, unitId: "u-1", name: "Unit A" }] }) });
    expect(await listAnnouncementDrafts(c, { chapterNotices: true })).toEqual([]);
    expect(called(c.rpc)).toEqual(["get_chapter_office_access"]);
  });

  it("reads the drafts for a caller who may send to the whole chapter", async () => {
    const c = client({ get_chapter_office_access: office({ unscopedNotices: true }), list_announcement_drafts: { organizationId: "org", drafts: [DRAFT] } });
    expect(await listAnnouncementDrafts(c, { chapterNotices: true })).toEqual([DRAFT]);
    expect(called(c.rpc)).toEqual(["get_chapter_office_access", "list_announcement_drafts"]);
  });

  it("goes ahead with the drafts read when the office read fails, as the chapter office panel does", async () => {
    const c = client({ get_chapter_office_access: new Error("chapter context required"), list_announcement_drafts: { organizationId: "org", drafts: [DRAFT] } });
    expect(await listAnnouncementDrafts(c, { chapterNotices: true })).toEqual([DRAFT]);
    expect(called(c.rpc)).toEqual(["get_chapter_office_access", "list_announcement_drafts"]);
  });

  it("keeps the chapter office panel's direct read, which already checks before calling", async () => {
    const c = client({ list_announcement_drafts: { organizationId: "org", drafts: [DRAFT] } });
    expect(await listAnnouncementDrafts(c)).toEqual([DRAFT]);
    expect(called(c.rpc)).toEqual(["list_announcement_drafts"]);
    const panel = source("src/features/chapterAccess/ChapterOfficePanel.jsx");
    expect(panel).toContain("listDrafts: () => unscopedNotices ? listAnnouncementDrafts(client) : Promise.resolve([]),");
  });

  it("asks first at both App callers: the steward broadcasts desk and the Messages announcements reads", () => {
    const app = source("src/App.jsx");
    const calls = [...app.matchAll(/listDrafts: \(\) => listAnnouncementDrafts\(([^)]*)\)/g)].map((match) => match[1]);
    expect(calls).toEqual(["supabase, { chapterNotices: true }", "supabase, { chapterNotices: true }"]);
    const steward = app.slice(app.indexOf("const stewardApi = {"));
    expect(steward.slice(0, steward.indexOf("\n};"))).toContain("listDrafts: () => listAnnouncementDrafts(supabase, { chapterNotices: true }),");
    const messages = app.slice(app.indexOf("const noticeReadApi = {"));
    expect(messages.slice(0, messages.indexOf("\n};"))).toContain("listDrafts: () => listAnnouncementDrafts(supabase, { chapterNotices: true }),");
  });
});

describe("engagement studio snapshot read", () => {
  const workspace = {
    organizationId: "00000000-0000-4000-a000-000000000001", chapterId: "tv-alder",
    policy: { enabled: false, cadence_days: 7, minimum_pool_size: 3, selection_count: 1, priority_rule: "support_then_oldest" },
    items: [{ id: "q-1", body: "Alder weekly prompt", options: ["Yes", "No"], editorialState: "submitted", score: 0 }], nextCursor: null,
  };
  const weekly = () => {
    vi.spyOn(engagementApi, "loadWeeklySelection").mockResolvedValue(workspace);
    vi.spyOn(engagementApi, "loadWeeklySelectionPage").mockResolvedValue({ items: [], nextCursor: null });
  };

  it("goes straight to the Weekly pool without the snapshot call when the account holds no organization-wide staff role", async () => {
    const loadStaff = vi.spyOn(engagementApi, "loadStaff").mockResolvedValue({});
    weekly();
    render(<LanguageProvider lang="en"><StaffEngagement client={{ rpc: vi.fn() }} organizationSnapshot={false} /></LanguageProvider>);
    expect(await screen.findByTestId("engagement-role-limited")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Weekly pool" })).toHaveAttribute("aria-pressed", "true");
    expect(loadStaff).not.toHaveBeenCalled();
  });

  it("still reads the snapshot by default", async () => {
    const loadStaff = vi.spyOn(engagementApi, "loadStaff").mockResolvedValue({ surveys: [], members: [], chapters: [] });
    vi.spyOn(engagementApi, "loadLivePollMeetings").mockResolvedValue([]);
    render(<LanguageProvider lang="en"><StaffEngagement client={{ rpc: vi.fn() }} /></LanguageProvider>);
    expect(await screen.findByTestId("staff-engagement")).toBeInTheDocument();
    expect(loadStaff).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["a chapter-only steward", { roles: ["steward"], member: { organizationId: "00000000-0000-4000-a000-000000000001", organizationRoles: [], chapterRoles: ["steward"] } }, 0],
    ["an organization admin", { roles: ["admin"], member: { organizationId: "00000000-0000-4000-a000-000000000001", organizationRoles: ["admin"], chapterRoles: [] } }, 1],
    ["an organization steward", { roles: ["steward"], member: { organizationId: "00000000-0000-4000-a000-000000000001", organizationRoles: ["steward"], chapterRoles: [] } }, 1],
    ["an organization coordinator", { roles: ["coordinator"], member: { organizationId: "00000000-0000-4000-a000-000000000001", organizationRoles: ["coordinator"], chapterRoles: [] } }, 1],
    ["an organization advisor", { roles: ["advisor"], member: { organizationId: "00000000-0000-4000-a000-000000000001", organizationRoles: ["advisor"], chapterRoles: [] } }, 1],
    ["an organization vp", { roles: ["vp"], member: { organizationId: "00000000-0000-4000-a000-000000000001", organizationRoles: ["vp"], chapterRoles: [] } }, 1],
    ["an account whose roles read failed", { roles: [], rolesUnknown: true, member: { organizationId: "00000000-0000-4000-a000-000000000001", organizationRoles: [] } }, 1],
    ["an account with no selected organization in its data", { roles: ["steward"], member: { organizationId: null, organizationRoles: [], chapterRoles: [] } }, 1],
    ["a view rendered without account data", null, 1],
  ])("the Campaigns view asks for the snapshot only when it can be admitted: %s", async (_label, data, calls) => {
    const loadStaff = vi.spyOn(engagementApi, "loadStaff").mockResolvedValue({ surveys: [], members: [], chapters: [] });
    vi.spyOn(engagementApi, "loadLivePollMeetings").mockResolvedValue([]);
    weekly();
    const api = { load: vi.fn().mockResolvedValue({ campaigns: [], canManageUnion: false, chapterId: "tv-alder" }) };
    render(<LanguageProvider lang="en"><CampaignsView api={api} data={data} engagementClient={{ rpc: vi.fn() }} /></LanguageProvider>);
    expect(await screen.findByTestId("staff-engagement")).toBeInTheDocument();
    expect(loadStaff).toHaveBeenCalledTimes(calls);
  });
});
