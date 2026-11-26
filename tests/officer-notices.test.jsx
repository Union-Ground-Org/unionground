// REQ-UG-OFFICER-NOTICES-WITH-READ-RECEIPTS-20261030: officers post a
// notice members mark as read, from the Announcements tab, and see who read it.
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { NOTICE_HATS, OfficerNoticeDesk, OfficerNoticeHint } from "../src/features/notices/OfficerNoticeDesk.jsx";
import { LanguageProvider } from "../src/lib/LanguageContext.jsx";
import { getMemberNoticeReceipts, listMyMemberNotices } from "../src/lib/memberApi.js";
import { memberMutationResources } from "../src/lib/memberSessionLoader.js";
import { expectHeldWriteFocus, expectOneWriteFromOneTick } from "./helpers/busyWriteFocus.js";

const NOTICE = { id: "bc-1", title: "Shift swap rules", body: "Read before Friday", locale: "en", audience: "chapter", publishedAt: "2026-10-30T15:00:00Z", retracted: false, readCount: 1, audienceCount: 5 };

const page = (notices, hasMore = false) => ({ notices, hasMore });

function deskApi(overrides = {}) {
  return {
    loadAudiences: vi.fn().mockResolvedValue([{ value: "chapter", kind: "chapter", chapterId: "chapter-a", name: "" }, { value: "organization", kind: "organization", chapterId: "chapter-a", name: "" }]),
    publish: vi.fn().mockResolvedValue({ broadcastId: "bc-2" }),
    listMine: vi.fn().mockResolvedValue(page([NOTICE])),
    receipts: vi.fn().mockResolvedValue({ readCount: 1, audienceCount: 5, readers: [{ name: "Rosa Diaz", readAt: "2026-10-30T16:00:00Z" }, { name: null, readAt: "2026-10-30T17:00:00Z" }] }),
    listDrafts: vi.fn().mockResolvedValue([]),
    resolveDraft: vi.fn().mockResolvedValue({}),
    ...overrides,
  };
}

function renderDesk(props, lang = "en") {
  return render(<LanguageProvider lang={lang}><OfficerNoticeDesk {...props} /></LanguageProvider>);
}

async function fillComposer(title, body) {
  fireEvent.change(screen.getByLabelText("Title"), { target: { value: title } });
  fireEvent.change(screen.getByLabelText("Notice"), { target: { value: body } });
  await waitFor(() => expect(screen.getByRole("button", { name: "Post notice" })).toBeEnabled());
}

describe("the officer notice desk", () => {
  it("names the selected unit or committee instead of promising chapter-wide delivery", async () => {
    const api = deskApi(); renderDesk({ api, chapterAudienceLabel: "Garage A" });
    expect(await screen.findByLabelText("Garage A")).toBeChecked(); expect(screen.queryByLabelText("My campaign")).not.toBeInTheDocument();
    await fillComposer("Unit meeting", "For the Garage A audience"); fireEvent.click(screen.getByRole("button", { name: "Post notice" }));
    await waitFor(() => expect(api.publish).toHaveBeenCalledWith("Unit meeting", "For the Garage A audience", "en", "chapter", expect.any(String)));
  });
  it("posts to the whole organization when the role allows it and refreshes the poster's notices", async () => {
    const api = deskApi();
    const onNotice = vi.fn();
    renderDesk({ api, canPostOrganization: true, onNotice });
    expect(await screen.findByText("Read by 1 of 5")).toBeVisible();
    await fillComposer("Contract vote", "Vote by Tuesday");
    fireEvent.click(screen.getByLabelText("The whole organization"));
    fireEvent.click(screen.getByRole("button", { name: "Post notice" }));
    await waitFor(() => expect(api.publish).toHaveBeenCalledWith("Contract vote", "Vote by Tuesday", "en", "organization", expect.any(String)));
    await waitFor(() => expect(onNotice).toHaveBeenCalledWith("Notice posted. Workers see it under Announcements."));
    expect(api.listMine).toHaveBeenCalledTimes(2);
  });

  it("offers only the campaign audience without an organization role", async () => {
    const api = deskApi();
    renderDesk({ api, canPostOrganization: false });
    await screen.findByText("Read by 1 of 5");
    expect(screen.queryByLabelText("The whole organization")).toBeNull();
    await fillComposer("Shop meeting", "Thursday 6pm");
    fireEvent.change(screen.getByLabelText("Language"), { target: { value: "es" } });
    fireEvent.click(screen.getByRole("button", { name: "Post notice" }));
    await waitFor(() => expect(api.publish).toHaveBeenCalledWith("Shop meeting", "Thursday 6pm", "es", "chapter", expect.any(String)));
  });

  it("publishes an meeting draft and marks it published", async () => {
    const draft = { id: "draft-1", title: "Upcoming: Committee meeting", body: "Committee meeting\n\nRSVP in the app under Meetings." };
    const api = deskApi({ listDrafts: vi.fn().mockResolvedValue([draft]) });
    renderDesk({ api });
    fireEvent.click(await screen.findByRole("button", { name: "Use draft: Upcoming: Committee meeting" }));
    expect(screen.getByLabelText("Title")).toHaveValue("Upcoming: Committee meeting");
    fireEvent.click(screen.getByRole("button", { name: "Post notice" }));
    await waitFor(() => expect(api.resolveDraft).toHaveBeenCalledWith("draft-1", "published"));
    expect(api.publish).toHaveBeenCalledWith("Upcoming: Committee meeting", draft.body, "en", "chapter", expect.any(String));
  });

  it("says when a notice could not be posted and keeps the text", async () => {
    const api = deskApi({ publish: vi.fn().mockRejectedValue(new Error("broadcast limit reached: 5 per committee worker per day")) });
    const onNotice = vi.fn();
    renderDesk({ api, onNotice });
    await fillComposer("Too many", "Body");
    fireEvent.click(screen.getByRole("button", { name: "Post notice" }));
    await waitFor(() => expect(onNotice).toHaveBeenCalledWith("The notice could not be posted. Check it and try again."));
    expect(screen.getByLabelText("Title")).toHaveValue("Too many");
  });

  it("shows who has read a notice, and hides the list again", async () => {
    const api = deskApi();
    renderDesk({ api });
    const toggle = await screen.findByRole("button", { name: "Who has read it" });
    fireEvent.click(toggle);
    const list = await screen.findByRole("status");
    await waitFor(() => expect(within(list).getByText("Rosa Diaz")).toBeVisible());
    expect(within(list).getByText("A worker")).toBeVisible();
    expect(api.receipts).toHaveBeenCalledWith("bc-1");
    fireEvent.click(screen.getByRole("button", { name: "Hide readers" }));
    expect(screen.queryByText("Rosa Diaz")).toBeNull();
  });

  // The count line stayed at the value loaded with the
  // page while the reader list showed newer reads.
  it("keeps the count in step with the reader list and refreshes on request", async () => {
    const api = deskApi({
      receipts: vi.fn().mockResolvedValue({ readCount: 3, audienceCount: 6, readers: [{ name: "Rosa Diaz", readAt: "2026-10-30T16:00:00Z" }] }),
    });
    renderDesk({ api });
    expect(await screen.findByText("Read by 1 of 5")).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Who has read it" }));
    expect(await screen.findByText("Read by 3 of 6")).toBeVisible();
    api.listMine.mockResolvedValueOnce(page([{ ...NOTICE, readCount: 4, audienceCount: 6 }]));
    fireEvent.click(screen.getByRole("button", { name: "Refresh counts" }));
    expect(await screen.findByText("Read by 4 of 6")).toBeVisible();
  });

  it("says when nobody has read it yet, or when the readers cannot be loaded", async () => {
    const api = deskApi({ receipts: vi.fn().mockResolvedValueOnce({ readCount: 0, audienceCount: 5, readers: [] }).mockRejectedValueOnce(new Error("offline")) });
    renderDesk({ api });
    fireEvent.click(await screen.findByRole("button", { name: "Who has read it" }));
    expect(await screen.findByText("No one has read it yet.")).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Hide readers" }));
    fireEvent.click(screen.getByRole("button", { name: "Who has read it" }));
    expect(await screen.findByText("The reader list could not be loaded.")).toBeVisible();
  });

  // Sol final on: notices past the first page stayed unreachable.
  it("pages to older notices from the last one shown", async () => {
    const older = { ...NOTICE, id: "bc-0", title: "Older notice", publishedAt: "2026-10-01T15:00:00Z" };
    const api = deskApi({
      listMine: vi.fn()
        .mockResolvedValueOnce(page([NOTICE], true))
        .mockRejectedValueOnce(new Error("offline"))
        .mockResolvedValueOnce(page([NOTICE, older], false)),
    });
    renderDesk({ api });
    fireEvent.click(await screen.findByRole("button", { name: "Show older notices" }));
    expect(await screen.findByText("Older notices could not be loaded.")).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Show older notices" }));
    expect(await screen.findByText("Older notice")).toBeVisible();
    expect(api.listMine).toHaveBeenNthCalledWith(1, null);
    expect(api.listMine).toHaveBeenLastCalledWith({ publishedAt: NOTICE.publishedAt, id: NOTICE.id });
    expect(screen.getAllByText("Shift swap rules")).toHaveLength(1);
    expect(screen.queryByRole("button", { name: "Show older notices" })).toBeNull();
  });

  // An older page asked for before a refresh was
  // appended to the refreshed list.
  it("drops an older page that arrives after the list was refreshed", async () => {
    let finishOlder;
    const older = { ...NOTICE, id: "bc-0", title: "Older notice", publishedAt: "2026-10-01T15:00:00Z" };
    const api = deskApi({
      listMine: vi.fn()
        .mockResolvedValueOnce(page([NOTICE], true))
        .mockImplementationOnce(() => new Promise((resolve) => { finishOlder = resolve; }))
        .mockResolvedValueOnce(page([{ ...NOTICE, readCount: 2 }], true)),
    });
    renderDesk({ api });
    fireEvent.click(await screen.findByRole("button", { name: "Show older notices" }));
    fireEvent.click(screen.getByRole("button", { name: "Refresh counts" }));
    expect(await screen.findByText("Read by 2 of 5")).toBeVisible();
    finishOlder(page([older], false));
    await new Promise((done) => setTimeout(done, 0));
    expect(screen.queryByText("Older notice")).toBeNull();
    expect(screen.getByRole("button", { name: "Show older notices" })).toBeEnabled();
  });

  // Sol final on  (P2): a late answer reopened a list the officer closed.
  it("ignores a reader list that arrives after it was hidden", async () => {
    let resolve;
    const api = deskApi({ receipts: vi.fn(() => new Promise((done) => { resolve = done; })) });
    renderDesk({ api });
    fireEvent.click(await screen.findByRole("button", { name: "Who has read it" }));
    fireEvent.click(screen.getByRole("button", { name: "Hide readers" }));
    resolve({ readCount: 9, audienceCount: 9, readers: [{ name: "Late Reader", readAt: "2026-10-30T16:00:00Z" }] });
    await new Promise((done) => setTimeout(done, 0));
    expect(screen.queryByText("Late Reader")).toBeNull();
    expect(screen.getByRole("button", { name: "Who has read it" })).toHaveAttribute("aria-expanded", "false");
    expect(screen.getByText("Read by 1 of 5")).toBeVisible();
  });

  it("names an empty or unavailable list of the poster's own notices", async () => {
    const empty = renderDesk({ api: deskApi({ listMine: vi.fn().mockResolvedValue(page([])) }) });
    expect(await screen.findByText("You have not posted a notice yet.")).toBeVisible();
    empty.unmount();
    renderDesk({ api: deskApi({ listMine: vi.fn().mockRejectedValue(new Error("42501")) }) });
    expect(await screen.findByText("Your notices could not be loaded.")).toBeVisible();
  });

  it("shows a count without a total and marks a withdrawn notice", async () => {
    renderDesk({ api: deskApi({ listMine: vi.fn().mockResolvedValue(page([{ ...NOTICE, audience: "organization", audienceCount: null, readCount: 3, retracted: true }])) }) });
    expect(await screen.findByText("Read by 3")).toBeVisible();
    expect(screen.getByText("Withdrawn")).toBeVisible();
    expect(screen.getByText("Organization")).toBeVisible();
  });

  it("speaks Spanish", async () => {
    renderDesk({ api: deskApi(), canPostOrganization: true }, "es");
    expect(await screen.findByRole("heading", { name: "Publicar un aviso" })).toBeVisible();
    expect(screen.getByText("Leído por 1 de 5")).toBeVisible();
    expect(screen.getByLabelText("Toda la organización")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Publicar aviso" })).toBeVisible();
  });
});

describe("the offer to act in a role that posts notices", () => {
  it("offers each held posting role and wears the chosen one", () => {
    const onWear = vi.fn();
    render(<LanguageProvider lang="en"><OfficerNoticeHint hats={["admin", "vp", "coordinator"]} onWear={onWear} /></LanguageProvider>);
    expect(screen.getByRole("note")).toHaveTextContent("You can post notices, and see who has read them, in one of your staff roles.");
    expect(screen.queryByRole("button", { name: "Act as Campaign lead here" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Act as Campaign chair here" }));
    expect(onWear).toHaveBeenCalledWith("vp");
    expect(screen.getByRole("button", { name: "Act as Admin here" })).toBeVisible();
  });

  it("renders nothing without a posting role or a way to wear it", () => {
    const none = render(<LanguageProvider lang="en"><OfficerNoticeHint hats={["coordinator"]} onWear={vi.fn()} /></LanguageProvider>);
    expect(none.container).toBeEmptyDOMElement();
    none.unmount();
    const noWear = render(<LanguageProvider lang="en"><OfficerNoticeHint hats={["admin"]} onWear={null} /></LanguageProvider>);
    expect(noWear.container).toBeEmptyDOMElement();
  });

  it("names the roles that post notices", () => {
    expect(NOTICE_HATS).toEqual(["steward", "admin", "vp"]);
  });
});

// Codex P2 on: a posted notice must reach the Announcements list the
// poster is reading, so publishing refreshes the shared broadcast reads.
describe("after a notice is posted", () => {
  it("refreshes the broadcasts and their receipts", () => {
    expect(memberMutationResources("publishMemberBroadcast")).toEqual(expect.arrayContaining(["table:member_broadcasts", "table:member_broadcast_receipts"]));
  });
});

describe("the notice reads", () => {
  it("maps the poster's notices and drops malformed rows", async () => {
    const rpc = vi.fn().mockResolvedValue({ data: { notices: [
      { id: "bc-1", title: "A", body: "B", locale: "es", audience: "organization", publishedAt: "2026-10-30T15:00:00Z", retractedAt: null, readCount: 2, audienceCount: 9 },
      { id: "bc-2", title: "C", body: null, locale: "fr", audience: "chapter", retractedAt: "2026-10-30T16:00:00Z", readCount: -1, audienceCount: "x" },
      { id: 3, title: "bad" },
      null,
    ] }, error: null });
    expect(await listMyMemberNotices({ rpc })).toEqual({ hasMore: false, notices: [
      { id: "bc-1", title: "A", body: "B", locale: "es", audience: "organization", publishedAt: "2026-10-30T15:00:00Z", retracted: false, readCount: 2, audienceCount: 9 },
      { id: "bc-2", title: "C", body: "", locale: "en", audience: "chapter", publishedAt: null, retracted: true, readCount: null, audienceCount: null },
    ] });
    expect(rpc).toHaveBeenCalledWith("list_my_member_notices", { p_limit: 20, p_before_published: null, p_before_id: null });
    rpc.mockResolvedValueOnce({ data: { notices: [], hasMore: true }, error: null });
    expect(await listMyMemberNotices({ rpc }, { publishedAt: "2026-10-30T15:00:00Z", id: "bc-1" })).toEqual({ notices: [], hasMore: true });
    expect(rpc).toHaveBeenLastCalledWith("list_my_member_notices", { p_limit: 20, p_before_published: "2026-10-30T15:00:00Z", p_before_id: "bc-1" });
  });

  it("maps receipts and surfaces a refusal", async () => {
    const rpc = vi.fn()
      .mockResolvedValueOnce({ data: { readCount: 1, audienceCount: 4, readers: [{ name: " Rosa ", readAt: "2026-10-30T16:00:00Z" }, { name: "", readAt: "2026-10-30T17:00:00Z" }, { name: "No time" }] }, error: null })
      .mockResolvedValueOnce({ data: null, error: { message: "notice not found or not yours", code: "22023" } })
      .mockResolvedValueOnce({ data: null, error: null });
    expect(await getMemberNoticeReceipts({ rpc }, "bc-1")).toEqual({
      readCount: 1,
      audienceCount: 4,
      readers: [{ name: "Rosa", readAt: "2026-10-30T16:00:00Z" }, { name: null, readAt: "2026-10-30T17:00:00Z" }],
    });
    expect(rpc).toHaveBeenCalledWith("get_member_notice_receipts", { p_broadcast_id: "bc-1" });
    await expect(getMemberNoticeReceipts({ rpc }, "bc-x")).rejects.toThrow(/notice not found or not yours/u);
    expect(await getMemberNoticeReceipts({ rpc }, "bc-y")).toEqual({ readCount: null, audienceCount: null, readers: [] });
    expect(await listMyMemberNotices({ rpc: vi.fn().mockResolvedValue({ data: null, error: null }) }, { id: 5 })).toEqual({ notices: [], hasMore: false });
  });
});

// Record 8435: Post notice keeps focus while the notice is published, and a
// second activation in the same tick publishes nothing more to members.
describe("the officer notice desk while a notice is posted", () => {
  const ready = async () => {
    await fillComposer("Unit meeting", "For the Garage A audience");
    const post = screen.getByRole("button", { name: "Post notice" });
    await waitFor(() => expect(post).not.toHaveAttribute("aria-disabled"));
    return post;
  };

  it("keeps Post notice focused while it publishes, and publishes once", async () => {
    const api = deskApi({ publish: vi.fn(async () => ({ broadcastId: "bc-2" })) });
    renderDesk({ api, chapterAudienceLabel: "Garage A" });
    await expectHeldWriteFocus(api.publish, await ready());
    expect(api.publish).toHaveBeenCalledTimes(1);
  });

  it("publishes once when Post notice is activated twice in one tick", async () => {
    const api = deskApi({ publish: vi.fn(async () => ({ broadcastId: "bc-2" })) });
    renderDesk({ api, chapterAudienceLabel: "Garage A" });
    const post = await ready();
    await expectOneWriteFromOneTick(api.publish, [() => fireEvent.click(post), () => fireEvent.click(post)]);
  });
});

