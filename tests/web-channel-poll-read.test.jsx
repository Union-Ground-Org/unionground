import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { clearDeviceParityState } from "../src/lib/deviceParity.js";
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

function threadView(messagingApi, lang = "en", snapshot = data) {
  return (
    <LanguageProvider lang={lang}>
      <ProductHubView data={snapshot} onSendPost={vi.fn()} onCreateTask={vi.fn()} onCreateSpace={vi.fn()} onCreateThread={vi.fn()} messagingApi={{ pollScope: "user-1:session-1", ...messagingApi }} />
    </LanguageProvider>
  );
}

function renderThread(messagingApi, lang = "en") {
  window.history.replaceState({}, "", "/m/organize?thread=thread-1");
  return render(threadView(messagingApi, lang));
}

function withNewPost() {
  const space = data.product.spaces[0];
  const post = { id: "post-3", thread_id: "thread-1", author_id: "user-1", body: "Voted", created_at: "2026-10-01T14:00:00Z" };
  return { ...data, product: { ...data.product, spaces: [{ ...space, threads: [{ ...thread, posts: [...thread.posts, post] }] }] } };
}

describe("web topic poll reads", () => {
  it.each([
    ["en", "Topic polls could not be loaded.", "Try again"],
    ["es", "No se pudieron cargar las encuestas del tema.", "Reintentar"],
  ])("separates a failed poll read from a successful retry in %s", async (lang, failed, retry) => {
    const loadThreadPolls = vi.fn().mockRejectedValueOnce(new Error("offline")).mockResolvedValueOnce([openPoll]);
    renderThread({ loadThreadPolls, voteChannelPoll: vi.fn() }, lang);
    const message = await screen.findByText(failed);
    expect(message.closest('[aria-live="polite"]')).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: retry }));
    expect(await screen.findByRole("region", { name: /Which swap rule/ })).toBeVisible();
    expect(screen.queryByText(failed)).not.toBeInTheDocument();
  });

  it.each(["user-2:session-1", "user-1:session-2"])("drops old poll rows and late responses when the scope changes to %s", async (pollScope) => {
    let finishOldRead;
    let finishNewRead;
    const selected = { ...openPoll, mine: "opt-a" };
    const loadThreadPolls = vi.fn()
      .mockResolvedValueOnce([selected])
      .mockImplementationOnce(() => new Promise((resolve) => { finishOldRead = resolve; }))
      .mockImplementationOnce(() => new Promise((resolve) => { finishNewRead = resolve; }));
    const api = { loadThreadPolls, voteChannelPoll: vi.fn() };
    const { rerender } = renderThread(api);
    const option = await screen.findByRole("button", { name: /^Option A/ });
    expect(option).toHaveAttribute("aria-pressed", "true");
    const snapshot = withNewPost();
    rerender(threadView(api, "en", snapshot));
    await waitFor(() => expect(finishOldRead).toBeTypeOf("function"));
    rerender(threadView({ ...api, pollScope }, "en", snapshot));
    expect(screen.queryByRole("region", { name: /Which swap rule/ })).toBeNull();
    await waitFor(() => expect(finishNewRead).toBeTypeOf("function"));
    await act(async () => { finishOldRead([selected]); });
    expect(screen.queryByRole("region", { name: /Which swap rule/ })).toBeNull();
    await act(async () => { finishNewRead([openPoll]); });
    expect(await screen.findByRole("button", { name: /^Option A/ })).toHaveAttribute("aria-pressed", "false");
  });

  it("clears the poll when App explicitly clears the session scope", async () => {
    const loadThreadPolls = vi.fn().mockResolvedValue([openPoll]);
    const api = { loadThreadPolls, voteChannelPoll: vi.fn() };
    const { rerender } = renderThread(api);
    expect(await screen.findByRole("region", { name: /Which swap rule/ })).toBeVisible();
    rerender(threadView({ ...api, pollScope: null }));
    expect(screen.queryByRole("region", { name: /Which swap rule/ })).toBeNull();
    expect(loadThreadPolls).toHaveBeenCalledTimes(1);
  });

  it("keeps the previous tally and controls while a same-scope read refreshes", async () => {
    let finishRefresh;
    const loadThreadPolls = vi.fn()
      .mockResolvedValueOnce([openPoll])
      .mockImplementationOnce(() => new Promise((resolve) => { finishRefresh = resolve; }));
    const api = { loadThreadPolls, voteChannelPoll: vi.fn() };
    const { rerender } = renderThread(api);
    const poll = await screen.findByRole("region", { name: "Poll: Which swap rule?" });
    expect(within(poll).getByRole("button", { name: "Option A · 1 vote (33%)" })).toBeVisible();
    // A new post in the thread re-reads its polls.
    rerender(threadView(api, "en", withNewPost()));
    await waitFor(() => expect(finishRefresh).toBeTypeOf("function"));
    const pendingOption = screen.getByRole("button", { name: "Option A · 1 vote (33%)" });
    expect(pendingOption).toBeVisible();
    expect(pendingOption).toBeEnabled();
    await act(async () => { finishRefresh([{ ...openPoll, total: 5, options: [{ id: "opt-a", label: "Option A", votes: 3 }, { id: "opt-b", label: "Option B", votes: 2 }] }]); });
    await waitFor(() => expect(within(screen.getByRole("region", { name: "Poll: Which swap rule?" })).getByRole("button", { name: "Option A · 3 votes (60%)" })).toBeVisible());
  });
});
