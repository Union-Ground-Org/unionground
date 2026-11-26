// BUG-UG-WEB-CHANNEL-POLL-NO-VOTE-CONTROL-20261003: a channel post
// said "Vote below" but the web thread dialog showed no poll at all; only the
// phone app read get_channel_poll_tally and called cast_channel_poll_vote.
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { castChannelPollVote, channelPollIsClosed, loadThreadChannelPolls } from "../src/features/messaging/channelPollsApi.js";
import { clearDeviceParityState } from "../src/lib/deviceParity.js";
import { t } from "../src/lib/i18n.js";
import { LanguageProvider } from "../src/lib/LanguageContext.jsx";
import { ProductHubView } from "../src/views/ProductHubView.jsx";

beforeEach(() => { Element.prototype.scrollIntoView = vi.fn(); });
afterEach(() => {
  delete Element.prototype.scrollIntoView;
  window.history.replaceState({}, "", "/m");
  clearDeviceParityState();
});

const thread = {
  id: "thread-1", title: "Shift swap policy", kind: "issue", status: "open", space_id: "space-1",
  posts: [
    { id: "post-1", thread_id: "thread-1", author_id: "user-2", body: "Which option do you prefer? Vote below — closes Sunday.", created_at: "2026-10-01T12:00:00Z" },
    { id: "post-2", thread_id: "thread-1", author_id: "user-3", body: "Option B for me", created_at: "2026-10-01T13:00:00Z" },
  ],
};
const data = {
  member: { id: "user-1", initials: "MV", fullName: "Member Voice" },
  roles: [], conversations: [], broadcasts: [],
  product: { spaces: [{ id: "space-1", name: "Workplace issues", description: "", visibility: "chapter", threads: [thread] }], documents: [], records: [], intake: [], handshakes: [], governance: [], partnerOrgs: [] },
};
const openPoll = {
  pollId: "poll-1", postId: "post-1", question: "Which swap rule?", closesAt: "2099-10-11T23:00:00Z", total: 3, mine: null,
  options: [{ id: "opt-a", label: "Option A", votes: 1 }, { id: "opt-b", label: "Option B", votes: 2 }],
};

function renderThread(messagingApi, lang = "en") {
  window.history.replaceState({}, "", "/m/organize?thread=thread-1");
  return render(
    <LanguageProvider lang={lang}>
      <ProductHubView data={data} onSendPost={vi.fn()} onCreateTask={vi.fn()} onCreateSpace={vi.fn()} onCreateThread={vi.fn()} messagingApi={messagingApi} />
    </LanguageProvider>,
  );
}

describe("web channel poll", () => {
  it.each([
    ["en", "Vote counts are withheld."],
    ["es", "Los recuentos de votos están ocultos."],
  ])("keeps withheld polls votable without displaying zeros in %s", async (lang, message) => {
    const withheld = { ...openPoll, total: null, options: openPoll.options.map((option) => ({ ...option, votes: null })) };
    const voteChannelPoll = vi.fn().mockResolvedValueOnce({ ...withheld, mine: "opt-a" }).mockResolvedValueOnce(withheld);
    renderThread({ loadThreadPolls: vi.fn().mockResolvedValue([withheld]), voteChannelPoll }, lang);
    const button = await screen.findByRole("button", { name: "Option A" });
    const poll = button.closest("section");
    expect(poll).toHaveTextContent(message);
    expect(poll).not.toHaveTextContent(/0 votes|0 votos|0%/);
    fireEvent.click(button);
    await waitFor(() => expect(button).toHaveAttribute("aria-pressed", "true"));
    expect(voteChannelPoll).toHaveBeenLastCalledWith("poll-1", "opt-a");
    fireEvent.click(button);
    await waitFor(() => expect(button).toHaveAttribute("aria-pressed", "false"));
    expect(voteChannelPoll).toHaveBeenLastCalledWith("poll-1", null);
  });

  it("shows the poll's options and tally under its post, and voting sends the choice", async () => {
    const loadThreadPolls = vi.fn().mockResolvedValue([openPoll]);
    const voteChannelPoll = vi.fn().mockResolvedValue({ ...openPoll, total: 4, mine: "opt-a", options: [{ id: "opt-a", label: "Option A", votes: 2 }, { id: "opt-b", label: "Option B", votes: 2 }] });
    renderThread({ loadThreadPolls, voteChannelPoll });
    const dialog = await screen.findByRole("dialog", { name: "Shift swap policy" });
    const poll = await within(dialog).findByRole("region", { name: "Poll: Which swap rule?" });
    expect(loadThreadPolls).toHaveBeenCalledWith({ spaceId: "space-1", postIds: ["post-1", "post-2"] });
    // The poll renders inside the post that carries it.
    expect(poll.closest("article")).toHaveTextContent("Vote below");
    const optionA = within(poll).getByRole("button", { name: "Option A · 1 vote (33%)" });
    expect(within(poll).getByRole("button", { name: "Option B · 2 votes (67%)" })).toHaveAttribute("aria-pressed", "false");
    expect(poll).toHaveTextContent("3 votes so far. Voting closes");
    fireEvent.click(optionA);
    expect(voteChannelPoll).toHaveBeenCalledWith("poll-1", "opt-a");
    await waitFor(() => expect(within(poll).getByRole("button", { name: "Option A · 2 votes (50%)" })).toHaveAttribute("aria-pressed", "true"));
    // Pressing the current choice again takes the vote back.
    fireEvent.click(within(poll).getByRole("button", { name: "Option A · 2 votes (50%)" }));
    expect(voteChannelPoll).toHaveBeenLastCalledWith("poll-1", null);
  });

  it("shows a closed poll's results without any vote control", async () => {
    const voteChannelPoll = vi.fn();
    renderThread({ loadThreadPolls: vi.fn().mockResolvedValue([{ ...openPoll, closesAt: "2026-01-01T00:00:00Z", mine: "opt-b" }]), voteChannelPoll });
    const poll = await screen.findByRole("region", { name: "Poll: Which swap rule?" });
    expect(within(poll).queryByRole("button")).toBeNull();
    expect(within(poll).getByText("Option B · 2 votes (67%)")).toBeVisible();
    expect(poll).toHaveTextContent("This poll has closed. 3 votes in total.");
    expect(voteChannelPoll).not.toHaveBeenCalled();
  });

  it.each(["en", "es"])("announces a server-side close and preserves the tally (%s)", async (lang) => {
    const client = { rpc: vi.fn().mockResolvedValue({ data: null, error: { code: "22023", message: "poll closed" } }) };
    renderThread({ loadThreadPolls: vi.fn().mockResolvedValue([openPoll]), voteChannelPoll: (id, option) => castChannelPollVote(client, id, option) }, lang);
    const poll = await screen.findByRole("region", { name: t(lang, "channelPoll.aria", { question: openPoll.question }) });
    const option = within(poll).getByRole("button", { name: /^Option A/ });
    const tally = option.textContent;
    fireEvent.click(option);
    expect(client.rpc).toHaveBeenCalledWith("cast_channel_poll_vote", { p_poll_id: "poll-1", p_option_id: "opt-a" });
    expect(await within(poll).findByRole("alert")).toHaveTextContent(t(lang, "channelPoll.closed"));
    expect(within(poll).queryByRole("button")).toBeNull();
    expect(within(poll).getByText(tally)).toBeVisible();
    expect(poll).toHaveTextContent(t(lang, "channelPoll.inTotal.many", { count: 3 }));
  });

  it.each([
    [{ code: "22023", message: "option does not belong to poll" }, "inbox.actionNotConfirmed"],
    [{ code: "42501", message: "poll closed" }, "inbox.actionNotConfirmed"],
    [{ message: "TypeError: Failed to fetch" }, "offline.unconfirmed"],
  ])("keeps the controls for a different vote error: $error", async (error, key) => {
    const client = { rpc: vi.fn().mockResolvedValue({ data: null, error }) };
    renderThread({ loadThreadPolls: vi.fn().mockResolvedValue([openPoll]), voteChannelPoll: (id, option) => castChannelPollVote(client, id, option) });
    const poll = await screen.findByRole("region", { name: "Poll: Which swap rule?" });
    fireEvent.click(within(poll).getByRole("button", { name: /^Option A/ }));
    expect(await within(poll).findByRole("alert")).toHaveTextContent(t("en", key));
    expect(within(poll).getByRole("button", { name: /^Option A/ })).toBeEnabled();
  });

  it.each([
    ["en", "authentication required", "Sign in and complete the second verification step to continue."],
    ["es", "authentication required", "Inicia sesión y completa el segundo paso de verificación para continuar."],
    ["es", "permission denied for function cast_channel_poll_vote", "Acción no confirmada. Inténtalo de nuevo."],
  ])("explains a channel poll vote refusal (%s, %s)", async (lang, message, expected) => {
    const client = { rpc: vi.fn().mockResolvedValue({ error: { code: "42501", message } }) };
    renderThread({ loadThreadPolls: vi.fn().mockResolvedValue([openPoll]), voteChannelPoll: (id, option) => castChannelPollVote(client, id, option) }, lang);
    const poll = await screen.findByRole("region", { name: t(lang, "channelPoll.aria", { question: openPoll.question }) });
    const option = within(poll).getByRole("button", { name: /^Option A/ });
    fireEvent.click(option);
    expect(client.rpc).toHaveBeenCalledWith("cast_channel_poll_vote", { p_poll_id: "poll-1", p_option_id: "opt-a" });
    expect(await within(poll).findByRole("alert")).toHaveTextContent(expected);
    expect(option).toBeEnabled();
    expect(option).toHaveAttribute("aria-pressed", "false");
  });

  it("shows no poll when the api cannot read polls", async () => {
    renderThread({});
    await screen.findByRole("dialog", { name: "Shift swap policy" });
    expect(screen.queryByRole("region", { name: /Poll:/ })).toBeNull();
  });
});

describe("channel poll api", () => {
  function client({ polls, tallies, vote }) {
    const calls = [];
    return {
      calls,
      from(table) {
        const query = {
          select: (columns) => { calls.push(["select", table, columns]); return query; },
          eq: (column, value) => { calls.push(["eq", column, value]); return query; },
          in: (column, values) => { calls.push(["in", column, values]); return query; },
          order: () => query,
          then: (resolve, reject) => Promise.resolve({ data: polls, error: null }).then(resolve, reject),
        };
        return query;
      },
      rpc: async (name, args) => {
        calls.push(["rpc", name, args]);
        if (name === "get_channel_poll_tally") return { data: tallies[args.p_poll_id], error: null };
        return { data: vote, error: null };
      },
    };
  }
  const tally = (id) => ({ poll_id: id, question: "Q", closes_at: null, total: 1, mine: null, options: [{ id: "o1", label: "Yes", position: 1, votes: 1 }] });

  it("preserves withheld nulls on both reads and vote responses, and numeric zero", async () => {
    for (const count of [null, 0]) {
      const value = { ...tally("poll-1"), total: count, mine: "o1", options: [{ id: "o1", label: "Yes", votes: count }] };
      const fake = client({ polls: [{ id: "poll-1", post_id: "post-1" }], tallies: { "poll-1": value }, vote: value });
      for (const normalized of [
        ...(await loadThreadChannelPolls(fake, { spaceId: "space-1", postIds: ["post-1"] })),
        await castChannelPollVote(fake, "poll-1", "o1"),
      ]) expect(normalized).toMatchObject({ total: count, mine: "o1", options: [{ votes: count }] });
    }
  });

  it("reads only the polls attached to the thread's posts, with their tallies", async () => {
    const fake = client({ polls: [{ id: "poll-1", post_id: "post-1" }, { id: "poll-x", post_id: "other-thread-post" }], tallies: { "poll-1": tally("poll-1") } });
    const polls = await loadThreadChannelPolls(fake, { spaceId: "space-1", postIds: ["post-1", "post-2"] });
    expect(polls).toEqual([{ pollId: "poll-1", postId: "post-1", question: "Q", closesAt: null, total: 1, mine: null, options: [{ id: "o1", label: "Yes", votes: 1 }] }]);
    expect(fake.calls).toContainEqual(["eq", "space_id", "space-1"]);
    // The post filter is part of the query, so the row cap never hides this thread's poll.
    expect(fake.calls).toContainEqual(["in", "post_id", ["post-1", "post-2"]]);
    expect(fake.calls.filter((call) => call[0] === "rpc")).toEqual([["rpc", "get_channel_poll_tally", { p_poll_id: "poll-1" }]]);
  });

  it("casts a vote or clears it with a null option and returns the fresh tally", async () => {
    const fake = client({ polls: [], tallies: {}, vote: tally("poll-1") });
    expect((await castChannelPollVote(fake, "poll-1", "o1")).pollId).toBe("poll-1");
    await castChannelPollVote(fake, "poll-1", null);
    expect(fake.calls).toEqual([
      ["rpc", "cast_channel_poll_vote", { p_poll_id: "poll-1", p_option_id: "o1" }],
      ["rpc", "cast_channel_poll_vote", { p_poll_id: "poll-1", p_option_id: null }],
    ]);
  });

  it("returns nothing without a client, a space or posts, and drops unreadable tallies", async () => {
    expect(await loadThreadChannelPolls(null, { spaceId: "space-1", postIds: ["post-1"] })).toEqual([]);
    expect(await loadThreadChannelPolls(client({ polls: [], tallies: {} }), { spaceId: "", postIds: ["post-1"] })).toEqual([]);
    expect(await loadThreadChannelPolls(client({ polls: [], tallies: {} }), { spaceId: "space-1", postIds: [] })).toEqual([]);
    const fake = client({ polls: [{ id: "poll-1", post_id: "post-1" }], tallies: { "poll-1": null } });
    expect(await loadThreadChannelPolls(fake, { spaceId: "space-1", postIds: ["post-1"] })).toEqual([]);
  });

  it("throws a labelled error when a read or a vote is refused", async () => {
    const refused = { message: "permission denied", code: "42501" };
    const failingTable = { from: () => ({ select() { return this; }, eq() { return this; }, in() { return this; }, order() { return this; }, then: (resolve) => resolve({ data: null, error: refused }) }), rpc: async () => ({ data: null, error: refused }) };
    await expect(loadThreadChannelPolls(failingTable, { spaceId: "space-1", postIds: ["post-1"] })).rejects.toMatchObject({ name: "MemberApiError", code: "42501" });
    const failingTally = client({ polls: [{ id: "poll-1", post_id: "post-1" }], tallies: {} });
    failingTally.rpc = async () => ({ data: null, error: refused });
    await expect(loadThreadChannelPolls(failingTally, { spaceId: "space-1", postIds: ["post-1"] })).rejects.toMatchObject({ code: "42501" });
    await expect(castChannelPollVote(failingTally, "poll-1", "o1")).rejects.toMatchObject({ code: "42501" });
  });

  it("judges a poll closed only from a parseable past closing time", () => {
    expect(channelPollIsClosed(null)).toBe(false);
    expect(channelPollIsClosed({ closesAt: null })).toBe(false);
    expect(channelPollIsClosed({ closesAt: "not a date" })).toBe(false);
    expect(channelPollIsClosed({ closesAt: "2026-01-01T00:00:00Z" }, Date.parse("2026-01-02T00:00:00Z"))).toBe(true);
    expect(channelPollIsClosed({ closesAt: "2026-01-03T00:00:00Z" }, Date.parse("2026-01-02T00:00:00Z"))).toBe(false);
  });
});

describe("channel poll card over time", () => {
  afterEach(() => { vi.useRealTimers(); });

  it("closes itself when the closing time passes while it is open", async () => {
    vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"], now: new Date("2026-10-05T12:00:00Z") });
    renderThread({ loadThreadPolls: vi.fn().mockResolvedValue([{ ...openPoll, closesAt: "2026-10-05T12:01:00Z" }]), voteChannelPoll: vi.fn() });
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    const poll = screen.getByRole("region", { name: "Poll: Which swap rule?" });
    expect(within(poll).getAllByRole("button")).toHaveLength(2);
    await act(async () => { await vi.advanceTimersByTimeAsync(61_000); });
    expect(within(poll).queryByRole("button")).toBeNull();
    expect(poll).toHaveTextContent("This poll has closed.");
  });

  it("shows a refreshed tally when the thread's polls are read again", async () => {
    const loadThreadPolls = vi.fn()
      .mockResolvedValueOnce([openPoll])
      .mockResolvedValueOnce([{ ...openPoll, total: 5, options: [{ id: "opt-a", label: "Option A", votes: 3 }, { id: "opt-b", label: "Option B", votes: 2 }] }]);
    const { rerender } = renderThread({ loadThreadPolls, voteChannelPoll: vi.fn() });
    const poll = await screen.findByRole("region", { name: "Poll: Which swap rule?" });
    expect(within(poll).getByRole("button", { name: "Option A · 1 vote (33%)" })).toBeVisible();
    // A new post in the thread re-reads its polls.
    const next = { ...data, product: { ...data.product, spaces: [{ ...data.product.spaces[0], threads: [{ ...thread, posts: [...thread.posts, { id: "post-3", thread_id: "thread-1", author_id: "user-1", body: "Voted", created_at: "2026-10-01T14:00:00Z" }] }] }] } };
    rerender(<LanguageProvider lang="en"><ProductHubView data={next} onSendPost={vi.fn()} onCreateTask={vi.fn()} onCreateSpace={vi.fn()} onCreateThread={vi.fn()} messagingApi={{ loadThreadPolls, voteChannelPoll: vi.fn() }} /></LanguageProvider>);
    await waitFor(() => expect(within(screen.getByRole("region", { name: "Poll: Which swap rule?" })).getByRole("button", { name: "Option A · 3 votes (60%)" })).toBeVisible());
  });
});

