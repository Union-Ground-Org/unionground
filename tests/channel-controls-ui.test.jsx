// REQ-UG-CHANNEL-CONTROLS-RESTORED-20261001 — responsive-web surfaces:
// the per-channel settings dialog, highlighted bodies, the mention picker,
// mention search and the pin toggle. Each control has a role and a name, is
// disabled while its write is in flight, and shows "saved" only after the
// server answers.
import { act, fireEvent, render, renderHook, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { expectHeldWriteFocus, expectPendingFocus } from "./helpers/busyWriteFocus.js";
import { LanguageProvider } from "../src/lib/LanguageContext.jsx";
import { t as translate } from "../src/lib/i18n.js";
import { ChannelPostBody, ChannelSettingsDialog, MentionPicker, MentionSearchPanel, PinToggle, channelHasAnyControl } from "../src/features/messaging/ChannelControls.jsx";
import { normalizeChannelSetting } from "../src/features/messaging/channelControls.js";
import { createChannelControlsApi, useChannelControls } from "../src/features/messaging/channelControlsApi.js";

const t = (key, vars) => translate("en", key, vars);
const ON = { channelPinning: true, notificationLevels: true, channelMute: true, mentions: true, hereMentions: true, mentionSearch: true, keywordAlerts: true };

function controls(overrides = {}) {
  return { available: true, organizationId: "org", switches: ON, keywordLimit: 10, keywordCount: 1, canPin: false, spaces: { s1: { spaceId: "s1", level: "mentions", muted: false, mutedUntil: null, keywords: ["overtime"] } }, ...overrides };
}

function renderDialog(api, value = controls()) {
  const onSaved = vi.fn();
  render(
    <LanguageProvider lang="en">
      <ChannelSettingsDialog t={t} lang="en" space={{ id: "s1", name: "Shop floor" }} controls={value} api={api} onSaved={onSaved} onClose={() => {}} />
    </LanguageProvider>,
  );
  return onSaved;
}

afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

describe("channel control responses and scoped loading", () => {
  it("uses acknowledged settings and clears a mute expiry when unmuting", async () => {
    expect(createChannelControlsApi(null)).toBeNull();
    const rpc = vi.fn(async (name, args) => ({ error: null, data:
      name === "get_my_channel_controls" ? controls()
        : name === "set_channel_notification_level" ? { level: args.p_level }
          : name === "set_channel_mute" ? { muted: args.p_muted, mutedUntil: args.p_muted_until }
            : name === "set_channel_keyword_alerts" ? { keywords: args.p_keywords }
              : { pinned: true },
    }));
    const api = createChannelControlsApi({ rpc });
    expect(await api.load()).toMatchObject({ available: true, keywordCount: 1 });
    expect(await api.setLevel("s1", "none")).toMatchObject({ spaceId: "s1", level: "none" });
    expect(await api.setMute("s1", true)).toMatchObject({ muted: true, mutedUntil: null });
    expect(await api.setMute("s1", false, "2099-01-01T00:00:00Z")).toMatchObject({ muted: false, mutedUntil: null });
    expect(rpc).toHaveBeenLastCalledWith("set_channel_mute", { p_space_id: "s1", p_muted: false, p_muted_until: null });
    expect(await api.setKeywords("s1", ["safety"])).toMatchObject({ keywords: ["safety"] });
    expect(await api.setPinned("thread", true)).toEqual({ pinned: true });
    const denied = { code: "42501" };
    rpc.mockResolvedValueOnce({ data: null, error: denied });
    await expect(api.setLevel("s1", "all")).rejects.toBe(denied);
  });

  it("drops malformed mention results and bounds queries and presence on the server", async () => {
    const rpc = vi.fn().mockResolvedValue({ data: { unexpected: true }, error: null });
    const api = createChannelControlsApi({ rpc });
    expect(await api.mentionCandidates("s1", "")).toEqual([]);
    expect(rpc).toHaveBeenLastCalledWith("list_channel_mention_candidates", { p_space_id: "s1", p_query: null, p_limit: 8 });
    const person = { id: "member", name: "Test member" };
    rpc.mockResolvedValueOnce({ data: [person], error: null });
    expect(await api.mentionCandidates("s1", "Test")).toEqual([person]);
    expect(await api.searchMentions("")).toEqual([]);
    expect(rpc).toHaveBeenLastCalledWith("search_my_channel_mentions", { p_query: null, p_limit: 30 });
    rpc.mockResolvedValueOnce({ data: [{ postId: "post" }], error: null });
    expect(await api.searchMentions("safety")).toEqual([{ postId: "post" }]);
    await api.heartbeat();
    expect(rpc).toHaveBeenLastCalledWith("heartbeat_member_presence", { p_status: "online" });
    await api.heartbeat("away");
    expect(rpc).toHaveBeenLastCalledWith("heartbeat_member_presence", { p_status: "away" });
  });

  it("updates the acknowledged keyword budget and clears settings after access is refused", async () => {
    const api = { load: vi.fn().mockResolvedValue(controls()), heartbeat: vi.fn().mockResolvedValue(null) };
    const { result } = renderHook(() => useChannelControls(api, "member-org"));
    await waitFor(() => expect(result.current.status).toBe("ready"));
    act(() => result.current.applySetting("s1", normalizeChannelSetting({ keywords: ["one", "two", "three"] }, "s1")));
    expect(result.current.controls.keywordCount).toBe(3);
    act(() => result.current.applySetting("s1", normalizeChannelSetting({ keywords: [] }, "s1")));
    expect(result.current.controls.keywordCount).toBe(0);
    api.load.mockRejectedValueOnce(new Error("access revoked"));
    await act(async () => result.current.reload());
    expect(result.current.status).toBe("error");
    expect(result.current.controls.available).toBe(false);
    expect(result.current.controls.spaces).toEqual({});
  });

  it.each(["resolve", "reject"])("ignores an old scope's late %s after the new scope is ready", async (completion) => {
    let finish;
    const pending = new Promise((resolve, reject) => { finish = completion === "resolve" ? resolve : reject; });
    const next = controls({ organizationId: "next-org" });
    const api = { load: vi.fn().mockReturnValueOnce(pending).mockResolvedValue(next), heartbeat: vi.fn().mockResolvedValue(null) };
    const { result, rerender } = renderHook(({ scope }) => useChannelControls(api, scope), { initialProps: { scope: "old" } });
    rerender({ scope: "next" });
    await waitFor(() => expect(result.current.controls.organizationId).toBe("next-org"));
    await act(async () => finish(completion === "resolve" ? controls() : new Error("old refusal")));
    expect(result.current.status).toBe("ready");
    expect(result.current.controls.organizationId).toBe("next-org");
  });

  it("keeps controls unavailable without a client and reports hidden-page presence as away", async () => {
    const empty = renderHook(() => useChannelControls(null, "preview"));
    expect(empty.result.current.status).toBe("unavailable");
    expect(empty.result.current.controls.available).toBe(false);
    empty.unmount();
    vi.spyOn(document, "hidden", "get").mockReturnValue(true);
    const api = { load: vi.fn().mockResolvedValue(controls()), heartbeat: vi.fn().mockRejectedValue(new Error("offline")) };
    const mounted = renderHook(() => useChannelControls(api, "member-org"));
    await waitFor(() => expect(mounted.result.current.status).toBe("ready"));
    expect(api.heartbeat).toHaveBeenCalledWith("away");
    mounted.unmount();
  });
});

describe("channel settings dialog", () => {
  it.each([null, "2099-01-01T00:00:00Z"])("unmutes an acknowledged permanent or timed mute (%s)", async (mutedUntil) => {
    const api = { setMute: vi.fn().mockResolvedValue(normalizeChannelSetting({ muted: false }, "s1")) };
    const onSaved = renderDialog(api, controls({ spaces: { s1: { spaceId: "s1", level: "mentions", muted: true, mutedUntil, keywords: [] } } }));
    await act(async () => fireEvent.click(screen.getByRole("button", { name: t("channelControls.unmute") })));
    expect(api.setMute).toHaveBeenCalledWith("s1", false);
    expect(onSaved).toHaveBeenCalledWith("s1", expect.objectContaining({ muted: false }));
  });
  it("offers the three levels as a keyboard radio group and saves through the server", async () => {
    const api = { setLevel: vi.fn(async (spaceId, level) => normalizeChannelSetting({ spaceId, level }, spaceId)) };
    const onSaved = renderDialog(api);
    const group = screen.getByRole("radiogroup", { name: "Notify me about" });
    const radios = within(group).getAllByRole("radio");
    expect(radios.map((radio) => radio.getAttribute("aria-checked"))).toEqual(["false", "true", "false"]);
    await act(async () => { fireEvent.click(within(group).getByRole("radio", { name: /Every post/ })); });
    expect(api.setLevel).toHaveBeenCalledWith("s1", "all");
    expect(onSaved).toHaveBeenCalledWith("s1", expect.objectContaining({ level: "all" }));
    expect(await screen.findByRole("status")).toHaveTextContent("Saved.");
  });

  it("mutes for a chosen length and explains what a mute never silences", async () => {
    const api = { setMute: vi.fn(async (spaceId, muted, until) => normalizeChannelSetting({ spaceId, muted, mutedUntil: until, muteActive: true }, spaceId)) };
    renderDialog(api);
    fireEvent.change(screen.getByLabelText("Mute for"), { target: { value: "forever" } });
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Mute channel" })); });
    expect(api.setMute).toHaveBeenCalledWith("s1", true, null);
    expect(screen.getByText(/Direct messages, task conversations, announcements and urgent notices are never muted/)).toBeInTheDocument();
  });

  it("keeps Mute channel focused while the mute is saved, and saves it once (#8435)", async () => {
    const api = { setMute: vi.fn(async (spaceId, muted, until) => normalizeChannelSetting({ spaceId, muted, mutedUntil: until, muteActive: true }, spaceId)) };
    renderDialog(api);
    fireEvent.change(screen.getByLabelText("Mute for"), { target: { value: "forever" } });
    await expectHeldWriteFocus(api.setMute, screen.getByRole("button", { name: "Mute channel" }));
    expect(api.setMute).toHaveBeenCalledTimes(1);
  });

  it("adds and removes keywords inside the organization's budget", async () => {
    const api = { setKeywords: vi.fn(async (spaceId, keywords) => normalizeChannelSetting({ spaceId, keywords }, spaceId)) };
    renderDialog(api, controls({ keywordLimit: 2 }));
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Remove keyword overtime" })); });
    expect(api.setKeywords).toHaveBeenCalledWith("s1", []);
    fireEvent.change(screen.getByLabelText("New keyword"), { target: { value: "  Safety " } });
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Add keyword" })); });
    expect(api.setKeywords).toHaveBeenLastCalledWith("s1", ["overtime", "safety"]);
  });

  it("keeps a typed keyword in the box when its save fails, and clears it once saved (#9469)", async () => {
    const api = { setKeywords: vi.fn(async () => { throw new Error("offline"); }) };
    renderDialog(api);
    fireEvent.change(screen.getByLabelText("New keyword"), { target: { value: "layoff" } });
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Add keyword" })); });
    expect(screen.getByRole("alert")).toBeInTheDocument();
    expect(screen.getByLabelText("New keyword")).toHaveValue("layoff");
    api.setKeywords.mockImplementation(async (spaceId, keywords) => normalizeChannelSetting({ spaceId, keywords }, spaceId));
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Add keyword" })); });
    expect(screen.getByLabelText("New keyword")).toHaveValue("");
  });

  it("refuses a keyword past the organization's limit before calling the server", async () => {
    const api = { setKeywords: vi.fn() };
    renderDialog(api, controls({ keywordLimit: 1 }));
    fireEvent.change(screen.getByLabelText("New keyword"), { target: { value: "layoff" } });
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Add keyword" })); });
    expect(api.setKeywords).not.toHaveBeenCalled();
    expect(screen.getByRole("alert")).toHaveTextContent("keyword limit");
  });

  it("says when the organization turned a control off, and hides switched-off sections", async () => {
    const api = { setLevel: vi.fn(async () => { throw { code: "42501", details: "feature-disabled" }; }) };
    renderDialog(api, controls({ switches: { ...ON, channelMute: false, keywordAlerts: false } }));
    expect(screen.queryByRole("button", { name: "Mute channel" })).toBeNull();
    expect(screen.queryByLabelText("New keyword")).toBeNull();
    await act(async () => { fireEvent.click(screen.getByRole("radio", { name: /Nothing/ })); });
    expect(screen.getByRole("alert")).toHaveTextContent("Your organization has turned this off.");
    expect(channelHasAnyControl(controls({ switches: { ...ON, notificationLevels: false, channelMute: false, keywordAlerts: false } }))).toBe(false);
  });
});

describe("post bodies, mentions, search and pins", () => {
  it.each([
    [new Error("provider failed"), "channelControls.searchFailed"],
    [{ code: "42501", details: "feature-disabled" }, "channelControls.turnedOff"],
  ])("shows an honest search refusal and can retry without stale results", async (failure, key) => {
    const api = { searchMentions: vi.fn().mockRejectedValueOnce(failure).mockResolvedValue([]) };
    render(<MentionSearchPanel t={t} lang="en" api={api} onOpenPost={vi.fn()} />);
    expect(await screen.findByText(t(key))).toBeVisible();
    fireEvent.change(screen.getByLabelText(t("channelControls.mentionSearchQuery")), { target: { value: "safety" } });
    fireEvent.submit(screen.getByRole("search"));
    expect(await screen.findByText(t("channelControls.noMentions"))).toBeVisible();
    expect(api.searchMentions).toHaveBeenLastCalledWith("safety");
  });

  it.each([false, true])("distinguishes an empty mention picker from a failed lookup (%s)", async (failed) => {
    const api = { mentionCandidates: failed ? vi.fn().mockRejectedValue(new Error("denied")) : vi.fn().mockResolvedValue([]) };
    render(<MentionPicker t={t} api={api} spaceId="s1" onPick={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: t("channelControls.mention") }));
    expect(await screen.findByText(t(failed ? "channelControls.mentionFailed" : "channelControls.mentionWhoAppearsMember"))).toBeVisible();
    fireEvent.keyDown(screen.getByLabelText(t("channelControls.mentionSearchLabel")), { key: "Escape" });
    expect(screen.getByRole("button", { name: t("channelControls.mention") })).toBeVisible();
    expect(channelHasAnyControl(null)).toBe(false);
  });
  it("marks keyword and @here hits without changing the words, and flags a mention of the reader", () => {
    render(<ChannelPostBody t={t} body="@here the overtime list is up" keywords={["overtime"]} here mentionsMe />);
    const marks = document.querySelectorAll("mark");
    expect([...marks].map((mark) => mark.textContent)).toEqual(["@here", "overtime"]);
    expect(document.querySelector("p").textContent).toBe("@here the overtime list is up");
    expect(screen.getByText("Mentions you")).toBeInTheDocument();
  });

  it("finds people who can read the channel and hands the pick back", async () => {
    vi.useFakeTimers();
    const api = { mentionCandidates: vi.fn(async () => [{ id: "u1", name: "Ana Diaz", initials: "AD" }]) };
    const onPick = vi.fn();
    render(<MentionPicker t={t} api={api} spaceId="s1" onPick={onPick} />);
    fireEvent.click(screen.getByRole("button", { name: "Mention someone" }));
    fireEvent.change(screen.getByLabelText("Find a person to mention"), { target: { value: "an" } });
    await act(async () => { await vi.advanceTimersByTimeAsync(250); });
    vi.useRealTimers();
    expect(api.mentionCandidates).toHaveBeenCalledWith("s1", "an");
    fireEvent.click(await screen.findByRole("button", { name: "Mention Ana Diaz" }));
    expect(onPick).toHaveBeenCalledWith({ id: "u1", name: "Ana Diaz", initials: "AD" });
  });

  it("lists mentions and opens the post", async () => {
    const hit = { postId: "p1", threadId: "t1", spaceId: "s1", threadTitle: "Breaks", spaceName: "Shop floor", body: "@Ana Diaz can you cover", authorName: "Bo Kim", createdAt: "2026-10-02T12:00:00Z", reason: "mention" };
    const api = { searchMentions: vi.fn(async () => [hit]) };
    const onOpenPost = vi.fn();
    render(<MentionSearchPanel t={t} lang="en" api={api} onOpenPost={onOpenPost} />);
    expect(screen.getByRole("search")).toBeInTheDocument();
    fireEvent.click(await screen.findByRole("button", { name: /Breaks/ }));
    expect(onOpenPost).toHaveBeenCalledWith(hit);
  });

  it("keeps the pin control focusable while its write runs (#8435)", async () => {
    render(<PinToggle t={t} thread={{ id: "t1", pinned_at: null }} onToggle={vi.fn()} busy />);
    await expectPendingFocus(screen.getByRole("button", { name: "Pin thread" }));
  });

  it("names the pin action by what it will do", () => {
    const onToggle = vi.fn();
    const { rerender } = render(<PinToggle t={t} thread={{ id: "t1", pinned_at: null }} onToggle={onToggle} />);
    fireEvent.click(screen.getByRole("button", { name: "Pin thread" }));
    expect(onToggle).toHaveBeenCalledWith({ id: "t1", pinned_at: null }, true);
    rerender(<PinToggle t={t} thread={{ id: "t1", pinned_at: "2026-10-02T12:00:00Z" }} onToggle={onToggle} busy />);
    expect(screen.getByRole("button", { name: "Unpin thread" })).toHaveAttribute("aria-disabled", "true");
  });
});

describe("Spanish copy", () => {
  it("renders the dialog in Spanish", async () => {
    render(
      <LanguageProvider lang="es">
        <ChannelSettingsDialog t={(key, vars) => translate("es", key, vars)} lang="es" space={{ id: "s1", name: "Taller" }} controls={controls()} api={{}} onSaved={() => {}} onClose={() => {}} />
      </LanguageProvider>,
    );
    await waitFor(() => expect(screen.getByRole("radiogroup", { name: "Avisarme sobre" })).toBeInTheDocument());
    expect(screen.getByRole("button", { name: "Silenciar canal" })).toBeInTheDocument();
  });
});
