import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { LanguageProvider } from "../src/lib/LanguageContext.jsx";
import { ProductHubView } from "../src/views/ProductHubView.jsx";
import { loadMemberApp } from "../src/lib/memberApi.js";
import { postgrestPage } from "./helpers/silentTruncation.js";

// BUG-UG-WEB-CHANNEL-HIDES-POSTS-PAST-NEWEST-1000-20261110: the web
// thread dialog of a thread the member load's window cut off pages back to
// its first post (messagingApi.loadEarlierChannelPosts), keeps the reader in
// place and states the start. Fictional Tamarack posts only.

const BASE = Date.parse("2026-09-01T12:00:00.000Z");
const post = (number) => ({
  id: `post-${String(number).padStart(4, "0")}`, thread_id: "thread-1", author_id: "user-2",
  body: `Tamarack post ${String(number).padStart(4, "0")}`, created_at: new Date(BASE + number * 60_000).toISOString(),
});
const range = (from, to) => Array.from({ length: to - from + 1 }, (_unused, index) => post(from + index));
const cursorOf = (row) => ({ createdAt: row.created_at, id: row.id });
const bodies = (scope) => [...scope.querySelectorAll("article")].map((node) => node.querySelector("p")?.textContent);

let height = 0;
beforeEach(() => {
  Element.prototype.scrollIntoView = vi.fn();
  height = 0;
  Object.defineProperty(document.documentElement, "scrollHeight", { configurable: true, get: () => height });
  document.documentElement.scrollTop = 0;
});
afterEach(() => {
  delete Element.prototype.scrollIntoView;
  delete document.documentElement.scrollHeight;
  window.history.replaceState({}, "", "/m");
});

function renderThread({ cursor = cursorOf(post(401)), loadEarlierChannelPosts }) {
  window.history.replaceState({}, "", "/m/organize?thread=thread-1");
  const thread = { id: "thread-1", title: "Overtime scheduling", kind: "issue", status: "open", space_id: "space-1", posts: range(401, 403), earlierCursor: cursor };
  const data = {
    member: { id: "user-1", initials: "MV", fullName: "Member Voice" },
    roles: [], conversations: [], broadcasts: [],
    product: { spaces: [{ id: "space-1", name: "Workplace issues", description: "", visibility: "chapter", threads: [thread] }], documents: [], records: [], intake: [], handshakes: [], governance: [], partnerOrgs: [] },
  };
  const api = { toggleReaction: vi.fn(), toggleSaved: vi.fn(), remind: vi.fn(), loadChannelLanding: vi.fn(), loadEarlierChannelPosts };
  const build = () => (
    <LanguageProvider lang="en">
      <ProductHubView data={data} onSendPost={vi.fn()} onCreateTask={vi.fn()} onCreateSpace={vi.fn()} onCreateThread={vi.fn()} messagingApi={api} />
    </LanguageProvider>
  );
  const view = render(build());
  return { ...view, rebuild: build };
}

it("opens earlier posts above the loaded ones, oldest first, keeps the reader in place and states the start", async () => {
  let finish;
  const loadEarlierChannelPosts = vi.fn(() => new Promise((resolve) => { finish = resolve; }));
  const view = renderThread({ loadEarlierChannelPosts });
  const dialog = await screen.findByRole("dialog", { name: "Overtime scheduling" });
  expect(bodies(dialog)).toEqual(range(401, 403).map((row) => row.body));
  height = 2_000;
  document.documentElement.scrollTop = 40;
  fireEvent.click(within(dialog).getByRole("button", { name: "Show earlier messages" }));
  expect(within(dialog).getByRole("button", { name: "Loading earlier messages" })).toHaveAttribute("aria-busy", "true");
  expect(loadEarlierChannelPosts).toHaveBeenCalledWith({ threadId: "thread-1", before: cursorOf(post(401)) });
  // The loading state lays out first and changes the height above the reader.
  height = 1_982;
  view.rerender(view.rebuild());
  expect(document.documentElement.scrollTop).toBe(22);
  height = 2_982;
  await act(async () => { finish({ posts: range(1, 400), earlierCursor: null }); });
  expect(bodies(dialog)).toEqual(range(1, 403).map((row) => row.body));
  expect(document.documentElement.scrollTop).toBe(1_022);
  expect(within(dialog).getByText("This is the start of this thread.")).toBeInTheDocument();
  expect(within(dialog).getByRole("status")).toHaveTextContent("400 earlier messages shown above.");
});

it("keeps the posts shown when an earlier page fails, and Try again asks for the same page", async () => {
  const loadEarlierChannelPosts = vi.fn()
    .mockRejectedValueOnce(new Error("offline"))
    .mockResolvedValueOnce({ posts: range(201, 400), earlierCursor: cursorOf(post(201)) })
    .mockResolvedValueOnce({ posts: range(1, 200), earlierCursor: null });
  renderThread({ loadEarlierChannelPosts });
  const dialog = await screen.findByRole("dialog", { name: "Overtime scheduling" });
  fireEvent.click(within(dialog).getByRole("button", { name: "Show earlier messages" }));
  expect(await within(dialog).findByRole("alert")).toHaveTextContent("Earlier messages did not load. The messages shown stay here. Try again.");
  expect(bodies(dialog)).toHaveLength(3);
  fireEvent.click(within(dialog).getByRole("button", { name: "Try again" }));
  await waitFor(() => expect(bodies(dialog)).toHaveLength(203));
  fireEvent.click(within(dialog).getByRole("button", { name: "Show earlier messages" }));
  await waitFor(() => expect(bodies(dialog)).toHaveLength(403));
  expect(loadEarlierChannelPosts.mock.calls.map((call) => call[0].before)).toEqual([cursorOf(post(401)), cursorOf(post(401)), cursorOf(post(201))]);
});

it("shows no earlier control while the window holds the whole thread", async () => {
  const loadEarlierChannelPosts = vi.fn();
  renderThread({ cursor: null, loadEarlierChannelPosts });
  const dialog = await screen.findByRole("dialog", { name: "Overtime scheduling" });
  expect(within(dialog).queryByRole("button", { name: "Show earlier messages" })).toBeNull();
  expect(within(dialog).queryByText("This is the start of this thread.")).toBeNull();
  expect(loadEarlierChannelPosts).not.toHaveBeenCalled();
});

// End to end: a chapter with more posts than one API answer carries (1,000
// rows, supabase/config.toml max_rows) loads through a client that answers
// like PostgREST, and the thread dialog offers its earlier posts (#8144, Grok
// G7: a 1,001-row probe was cut to 1,000 and the control never showed).
it("offers earlier posts for a chapter with more posts than one API answer carries", async () => {
  vi.spyOn(console, "warn").mockImplementation(() => {});
  const posts = Array.from({ length: 1_500 }, (_unused, index) => post(1_500 - index));
  const chainable = (result) => {
    let limit = Infinity;
    const proxy = new Proxy(function () {}, { get(_target, prop) {
      if (prop === "then") {
        const answer = Array.isArray(result.data) ? { ...result, data: postgrestPage(result.data, limit) } : result;
        return (...args) => Promise.resolve(answer).then(...args);
      }
      if (prop === "limit") return (value) => { limit = value; return proxy; };
      return () => proxy;
    } });
    return proxy;
  };
  const tables = {
    member_profiles: { data: { id: "user-1", first_name: "Member", full_name: "Member Voice", initials: "MV", role_line: "Member", member_since: 2023, language: "en", notification_prefs: {}, chapter_id: "wor" }, error: null },
    chapters: { data: [{ id: "wor", name: "Tamarack Valley" }], error: null },
    chapter_spaces: { data: [{ id: "space-1", name: "Workplace issues", visibility: "chapter" }], error: null },
    chapter_threads: { data: [{ id: "thread-1", space_id: "space-1", title: "Overtime scheduling", kind: "issue", status: "open" }], error: null },
    chapter_thread_posts: { data: posts, error: null },
  };
  const loaded = await loadMemberApp({ from: (table) => chainable(tables[table] ?? { data: [], error: null }), rpc: () => Promise.resolve({ data: null, error: null }) }, { id: "user-1", email: "proof@example.invalid" });
  window.history.replaceState({}, "", "/m/organize?thread=thread-1");
  const data = { member: { id: "user-1", initials: "MV", fullName: "Member Voice" }, roles: [], conversations: [], broadcasts: [], product: loaded.product };
  const api = { toggleReaction: vi.fn(), toggleSaved: vi.fn(), remind: vi.fn(), loadChannelLanding: vi.fn(), loadEarlierChannelPosts: vi.fn() };
  render(<LanguageProvider lang="en"><ProductHubView data={data} onSendPost={vi.fn()} onCreateTask={vi.fn()} onCreateSpace={vi.fn()} onCreateThread={vi.fn()} messagingApi={api} /></LanguageProvider>);
  const dialog = await screen.findByRole("dialog", { name: "Overtime scheduling" });
  expect(bodies(dialog)).toHaveLength(999);
  expect(within(dialog).getByRole("button", { name: "Show earlier messages" })).toBeInTheDocument();
  vi.restoreAllMocks();
}, 30_000);
