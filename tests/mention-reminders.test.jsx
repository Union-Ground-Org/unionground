// REQ-UG-MENTION-REMINDERS-20261030: the person mentioned turns a
// mention into their own reminder from "Your mentions", through the existing
// channel message reminder (create_member_message_reminder: owner-only, 20
// pending per message, 500 in all), so no new server capability is needed.
import "@testing-library/jest-dom/vitest";
import { readFileSync } from "node:fs";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MentionSearchPanel } from "../src/features/messaging/ChannelControls.jsx";
import { catalogue } from "../src/lib/i18n/allLanguages.js";
import { t as translate } from "../src/lib/i18n.js";
import { LanguageProvider } from "../src/lib/LanguageContext.jsx";

const hit = { postId: "p1", threadId: "t1", spaceId: "s1", threadTitle: "Holdover rest", spaceName: "Night shift", body: "@Ana can you check?", authorName: "Bo", authorInitials: "B", createdAt: "2026-10-30T12:00:00Z", reason: "mention" };
const en = catalogue.en;

function panel({ lang = "en", onRemind = vi.fn().mockResolvedValue({ id: "r1" }), onOpenPost = vi.fn() } = {}) {
  render(<LanguageProvider lang={lang}><MentionSearchPanel t={(key, vars) => translate(lang, key, vars)} lang={lang} api={{ searchMentions: vi.fn().mockResolvedValue([hit]) }} onOpenPost={onOpenPost} onRemind={onRemind} /></LanguageProvider>);
  return { onRemind, onOpenPost };
}

afterEach(cleanup);

describe("a reminder from a mention", () => {
  it("opens the reminder picker for that mention and saves the reader's own reminder", async () => {
    const { onRemind, onOpenPost } = panel();
    const open = await screen.findByRole("button", { name: "Remind me about Holdover rest" });
    expect(open).toHaveTextContent(en["inbox.remindMe"]);
    fireEvent.click(open);
    expect(screen.getByText("Remind me about Holdover rest", { selector: "strong" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: en["inbox.remindPicker.tomorrow"] }));
    fireEvent.click(screen.getByRole("button", { name: en["inbox.remindPicker.confirm"] }));
    await waitFor(() => expect(onRemind).toHaveBeenCalledWith(hit, expect.any(String)));
    expect(Number.isNaN(Date.parse(onRemind.mock.calls[0][1]))).toBe(false);
    expect(await screen.findByRole("status", { name: "" })).toHaveTextContent(en["inbox.reminderSet"]);
    expect(screen.getByRole("button", { name: "Remind me about Holdover rest" })).toBeInTheDocument();
    expect(onOpenPost).not.toHaveBeenCalled();
  });

  it("keeps the picker open and says so when the reminder is refused, and cancels cleanly", async () => {
    panel({ onRemind: vi.fn().mockRejectedValue(Object.assign(new Error("reminder limit reached: 20 pending per message"), { code: "54000" })) });
    fireEvent.click(await screen.findByRole("button", { name: "Remind me about Holdover rest" }));
    fireEvent.click(screen.getByRole("button", { name: en["inbox.remindPicker.tomorrow"] }));
    fireEvent.click(screen.getByRole("button", { name: en["inbox.remindPicker.confirm"] }));
    expect(await screen.findByRole("alert")).toHaveTextContent(en["inbox.actionFailed"]);
    expect(screen.getByRole("button", { name: en["inbox.remindPicker.confirm"] })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: en["inbox.cancel"] }));
    expect(screen.queryByRole("button", { name: en["inbox.remindPicker.confirm"] })).toBeNull();
  });

  it("names an untitled @here hit plainly and still sets its reminder", async () => {
    const here = { ...hit, postId: "p2", threadTitle: "", authorName: "", reason: "here" };
    const onRemind = vi.fn().mockResolvedValue({ id: "r2" });
    render(<LanguageProvider lang="en"><MentionSearchPanel t={(key, vars) => translate("en", key, vars)} lang="en" api={{ searchMentions: vi.fn().mockResolvedValue([here]) }} onOpenPost={vi.fn()} onRemind={onRemind} /></LanguageProvider>);
    const untitled = translate("en", "channelControls.remindFromMention", { title: "" }).trim();
    const open = await screen.findByRole("button", { name: untitled });
    expect(screen.getByText(new RegExp(translate("en", "channelControls.reasonHere", { name: "" }).trim().slice(0, 12)))).toBeInTheDocument();
    fireEvent.click(open);
    expect(screen.getByText(untitled, { selector: "strong" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: en["inbox.remindPicker.tomorrow"] }));
    fireEvent.click(screen.getByRole("button", { name: en["inbox.remindPicker.confirm"] }));
    await waitFor(() => expect(onRemind).toHaveBeenCalledWith(here, expect.any(String)));
  });

  it("offers nothing without a reminder handler, and still opens the post", async () => {
    const onOpenPost = vi.fn();
    render(<LanguageProvider lang="en"><MentionSearchPanel t={(key, vars) => translate("en", key, vars)} lang="en" api={{ searchMentions: vi.fn().mockResolvedValue([hit]) }} onOpenPost={onOpenPost} /></LanguageProvider>);
    const row = await screen.findByRole("button", { name: /Holdover rest/ });
    expect(screen.queryByRole("button", { name: /Remind me/ })).toBeNull();
    fireEvent.click(row);
    expect(onOpenPost).toHaveBeenCalledWith(hit);
  });

  it("reads in Spanish", async () => {
    panel({ lang: "es" });
    const open = await screen.findByRole("button", { name: "Recuérdame sobre Holdover rest" });
    expect(open).toHaveTextContent(catalogue.es["inbox.remindMe"]);
    expect(catalogue.es["channelControls.remindFromMention"]).toBeTruthy();
    expect(catalogue.en["channelControls.remindFromMention"]).toBeTruthy();
  });

  it("routes the hub's reminder through the channel message reminder", () => {
    const hub = readFileSync("src/views/ProductHubView.jsx", "utf8");
    expect(hub).toContain('onRemind={messagingApi?.remind ? (hit, remindAt) => messagingApi.remind("channel", hit.postId, remindAt) : null}');
    expect(within(document.body).queryByRole("alert")).toBeNull();
  });
});
