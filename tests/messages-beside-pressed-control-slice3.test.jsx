// #9466 slice 3: a failure inside a phone-width thread or a campaign confirmation is said there.
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MessagesView } from "../src/views/MessagesView.jsx";
import { CampaignsView } from "../src/views/CampaignsView.jsx";
import { LanguageProvider } from "../src/lib/LanguageContext.jsx";
import { catalogue } from "../src/lib/i18n/allLanguages.js";
import { MemberApiError } from "../src/lib/memberApi.js";
import { engagementApi } from "../src/features/engagement/api.js";

afterEach(() => { cleanup(); vi.restoreAllMocks(); });
const en = catalogue.en;
const off = () => new Error("offline");
const noSteward = () => new MemberApiError("Share resource", { message: "no steward assigned", code: "22023", details: "no_steward_assigned" });

function phoneThread({ api = {}, scheduled = [], staff = false, lang = "en" }) {
  const messagingApi = { toggleReaction: vi.fn(), toggleSaved: vi.fn(), remind: vi.fn(), ...api };
  const data = {
    member: { id: "member-1" },
    conversations: [{ id: "conv-1", counterpartRole: "steward", sender: "Chapter steward", preview: "Step 2 answer is due.", dateLabel: "Jul 12", unread: 0, scheduled,
      messages: [{ id: "m1", sender_kind: "member", sender_name: "Member", body: "Step 2 answer is due.", created_at: "2026-07-12T10:00:00Z", read_at: "2026-07-12T10:05:00Z" }] }],
    broadcasts: [],
    product: { spaces: [], documents: [{ id: "doc-1", title: "Overtime policy", status: "published" }] },
  };
  const onNotice = vi.fn();
  render(<LanguageProvider lang={lang}><MessagesView data={data} messagingApi={messagingApi} staffAccess={staff} engagementSession={staff ? { access_token: "token" } : null} engagementClient={staff ? { rpc: vi.fn() } : null} onNotice={onNotice} onSendMessage={vi.fn()} onReadConversation={vi.fn().mockResolvedValue(null)} onReadBroadcast={vi.fn()} onOpenTopics={vi.fn()} /></LanguageProvider>);
  fireEvent.click(screen.getByText("Step 2 answer is due.", { selector: ".inbox-row__preview" }));
  return { dialog: within(screen.getByRole("dialog")), onNotice };
}
const brief = (dialog) => fireEvent.click(dialog.getByRole("region", { name: en["inbox.compassBriefing"] }).querySelector("button"));

describe("a private conversation at phone width", () => {
  it("says inside the window why a shared document was refused", async () => {
    const { dialog, onNotice } = phoneThread({ api: { schedule: vi.fn(), sendResource: vi.fn().mockRejectedValue(noSteward()) } });
    fireEvent.change(dialog.getByLabelText(en["inbox.shareResource"]), { target: { value: "doc-1" } });
    fireEvent.click(dialog.getByRole("button", { name: en["inbox.send"] }));
    expect(await dialog.findByRole("alert")).toHaveTextContent(en["rpcError.no_steward_assigned"]);
    expect(dialog.getAllByRole("alert")).toHaveLength(1);
    expect(onNotice).toHaveBeenCalledWith(en["rpcError.no_steward_assigned"]);
  });

  it("says a general share failure, and a schedule refusal with the text kept in the box", async () => {
    const { dialog } = phoneThread({ api: { schedule: vi.fn().mockRejectedValue(noSteward()), sendResource: vi.fn().mockRejectedValue(off()) }, lang: "es" });
    const es = catalogue.es;
    fireEvent.change(dialog.getByLabelText(es["inbox.shareResource"]), { target: { value: "doc-1" } });
    fireEvent.click(dialog.getByRole("button", { name: es["inbox.send"] }));
    expect(await dialog.findByRole("alert")).toHaveTextContent(es["inbox.actionFailed"]);
    fireEvent.change(dialog.getByLabelText(es["inbox.shareResource"]), { target: { value: "" } });
    fireEvent.change(dialog.getByLabelText(es["inbox.composerPlaceholder"]), { target: { value: "Más tarde" } });
    fireEvent.change(dialog.getByLabelText(es["inbox.scheduleFor"]), { target: { value: "2099-08-12T12:30" } });
    fireEvent.click(dialog.getByRole("button", { name: es["inbox.send"] }));
    await waitFor(() => expect(dialog.getByRole("alert")).toHaveTextContent(es["inbox.notSent"]));
    expect(dialog.getAllByRole("alert")).toHaveLength(1);
    expect(dialog.getByRole("alert")).toHaveTextContent(es["rpcError.no_steward_assigned"]);
  });

  it("says in its row that a scheduled message could not be cancelled, until a cancel works", async () => {
    const cancelScheduled = vi.fn().mockRejectedValueOnce(off()).mockResolvedValueOnce({ cancelled: true });
    const scheduled = [{ id: "sched-1", conversation_id: "conv-1", body: "Send tonight", scheduled_for: "2099-09-18T02:00:00.000Z", status: "pending" }];
    const { dialog } = phoneThread({ api: { cancelScheduled }, scheduled });
    const row = dialog.getByText(/Send tonight/).closest(".inbox-scheduled__row");
    fireEvent.click(within(row).getByRole("button", { name: en["inbox.cancelScheduled"] }));
    expect(await within(row).findByRole("alert")).toHaveTextContent(en["inbox.actionFailed"]);
    fireEvent.click(within(row).getByRole("button", { name: en["inbox.cancelScheduled"] }));
    await waitFor(() => expect(dialog.queryByText(/Send tonight/)).toBeNull());
    expect(dialog.queryByRole("alert")).toBeNull();
  });

  it("says inside the window that Compass could not summarize the thread", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue({ ok: false, status: 500, json: async () => ({ code: "something_new" }) });
    const { dialog } = phoneThread({ staff: true });
    brief(dialog);
    expect(await dialog.findByRole("alert")).toHaveTextContent(en["inbox.compassBriefFailed"]);
  });

  it("says inside the window that a linked task could not be prepared or decided", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue({ ok: true, json: async () => ({ briefing: { summary: "Answer due.", actionItems: ["Track it"] } }) });
    vi.spyOn(engagementApi, "proposeAction").mockRejectedValueOnce(off()).mockResolvedValueOnce({ id: "a1", title: "Track it", state: "proposed" });
    vi.spyOn(engagementApi, "decideAction").mockRejectedValue(off());
    const { dialog } = phoneThread({ staff: true });
    brief(dialog);
    fireEvent.click(await dialog.findByRole("button", { name: en["inbox.compassPrepareTask"] }));
    expect(await dialog.findByRole("alert")).toHaveTextContent(en["inbox.compassTaskPrepareFailed"]);
    fireEvent.click(dialog.getByRole("button", { name: en["inbox.compassPrepareTask"] }));
    fireEvent.click(await dialog.findByRole("button", { name: en["inbox.compassCreateTask"] }));
    await waitFor(() => expect(dialog.getByRole("alert")).toHaveTextContent(en["inbox.compassDecisionFailed"]));
    expect(dialog.getAllByRole("alert")).toHaveLength(1);
  });
});

describe("a campaign confirmation (W4-12, missed 4)", () => {
  const draft = { id: "ballot-draft", kind: "ballot", scope: "chapter", chapterId: "wor", titleEn: "Contract vote", closesAt: new Date(Date.now() + 86400000).toISOString(), quorumTarget: 125, state: "draft", active: false, options: [{ id: "yes", labelEn: "Yes", orderIndex: 1 }, { id: "no", labelEn: "No", orderIndex: 2 }] };

  it("says inside the open window that the publish failed, and a new confirmation starts clear", async () => {
    const api = { load: vi.fn().mockResolvedValue({ campaigns: [draft], canManageUnion: false, chapterId: "wor" }), publish: vi.fn().mockRejectedValue(off()) };
    render(<LanguageProvider lang="en"><CampaignsView api={api} /></LanguageProvider>);
    fireEvent.click(await screen.findByRole("button", { name: /Publish Contract vote/ }));
    const dialog = within(screen.getByRole("dialog", { name: "Publish campaign?" }));
    fireEvent.click(dialog.getByRole("button", { name: "Publish now" }));
    expect(await dialog.findByRole("alert")).toHaveTextContent(en["campaigns.saveError"]);
    expect(dialog.getAllByRole("alert")).toHaveLength(1);
    fireEvent.click(dialog.getByRole("button", { name: en["campaigns.cancel"] }));
    fireEvent.transitionEnd(document.querySelector(".cam-dialog-layer"));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    fireEvent.click(screen.getByRole("button", { name: /Publish Contract vote/ }));
    expect(within(screen.getByRole("dialog", { name: "Publish campaign?" })).queryByRole("alert")).toBeNull();
  });
});
