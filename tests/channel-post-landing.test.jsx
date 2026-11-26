import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { applyDeviceParityState, clearDeviceParityState, deviceParityValue } from "../src/lib/deviceParity.js";
import { catalogue } from "../src/lib/i18n.js";
import { LanguageProvider } from "../src/lib/LanguageContext.jsx";
import { ProductHubView } from "../src/views/ProductHubView.jsx";
import { explicitHatAllowsView } from "../src/App.jsx";
import { workflowDestination } from "../src/features/connectedWorkflows/navigation.js";

// REQ-UG-CONNECTED-WORKFLOW-SHORTCUTS-20260928, second wave. A channel post's
// source link is /m/organize?thread=<uuid>&post=<uuid>. The boot snapshot holds only
// the newest threads and posts, so absence from it proves nothing: a thread or post
// it lacks is read, under the member's own row security, through
// messagingApi.loadChannelLanding({ threadId, postId, window? }) -> { thread, post }
// (or nothing when unavailable), merged into place and focused once. A source that is
// gone or refused says so; an answer nobody wants any more changes nothing; no hat is
// switched, and no post text enters the shared dialog value.

let scrollIntoView;
beforeEach(() => {
  scrollIntoView = vi.fn();
  Element.prototype.scrollIntoView = scrollIntoView;
});
afterEach(() => {
  delete Element.prototype.scrollIntoView;
  window.history.replaceState({}, "", "/m");
  clearDeviceParityState();
});

const tick = (ms = 20) => act(async () => { await new Promise((resolve) => setTimeout(resolve, ms)); });
const deferred = () => {
  let resolve; let reject;
  const promise = new Promise((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
};
const refusal = (code) => Object.assign(new Error("refused"), { code });
const bodiesIn = (scope) => [...scope.querySelectorAll("article p")].map((node) => node.textContent);
const closed = () => waitFor(() => expect(document.querySelector(".sg-detail-layer")).toBeNull());

const COLD_THREAD = "5b1f6a53-2c6e-4d0a-8f29-7d3d6f0a1b01";
const COLD_POST = "c2a7d4f0-9a6b-4b6e-a3f5-0e7b8f2d9c02";

const loadedThread = {
  id: "thread-1", title: "Overtime scheduling", kind: "issue", status: "open", space_id: "space-1",
  posts: [
    { id: "post-1", thread_id: "thread-1", author_id: "user-2", body: "Initial report", created_at: "2026-07-27T12:00:00Z" },
    { id: "post-2", thread_id: "thread-1", author_id: "user-1", body: "My reply", created_at: "2026-07-27T13:00:00Z" },
  ],
};
const hubData = (memberId = "user-1") => ({
  member: { id: memberId, initials: "MV", fullName: "Member Voice" },
  roles: [], conversations: [], broadcasts: [],
  product: { spaces: [{ id: "space-1", name: "Workplace issues", description: "", visibility: "chapter", threads: [loadedThread] }], documents: [], records: [], intake: [], handshakes: [], governance: [], partnerOrgs: [] },
});

// A thread the boot snapshot never carried, as loadChannelLanding returns it.
const coldPost = { id: COLD_POST, thread_id: COLD_THREAD, author_id: "user-9", body: "Who cleans the break room fridge?", created_at: "2026-03-01T10:00:00.000Z" };
const coldNeighbour = { id: "post-cold-2", thread_id: COLD_THREAD, author_id: "user-8", body: "The night shift, I think", created_at: "2026-03-01T11:00:00.000Z" };
const coldThread = { id: COLD_THREAD, space_id: "space-1", title: "Break room refrigerator", kind: "question", status: "open", created_at: "2026-03-01T10:00:00.000Z", updated_at: "2026-03-01T11:00:00.000Z", unreadCount: 0, posts: [coldPost, coldNeighbour] };
const coldAnswer = { thread: coldThread, post: coldPost };
// A post of a thread the snapshot does carry, older than the posts it holds.
const olderPost = { id: "post-old", thread_id: "thread-1", author_id: "user-3", body: "The earliest report of all", created_at: "2026-05-01T09:00:00Z" };
const olderAnswer = { thread: { ...loadedThread, posts: [olderPost] }, post: olderPost };

const baseApi = () => ({ toggleReaction: vi.fn(), toggleSaved: vi.fn(), remind: vi.fn() });

function renderHub({ url, data = hubData(), loadChannelLanding, messagingApi, ...props } = {}) {
  if (url) window.history.replaceState({}, "", url);
  const api = loadChannelLanding ? { ...(messagingApi ?? {}), loadChannelLanding } : messagingApi;
  const build = (next = data, lang = "en", override = {}) => (
    <LanguageProvider lang={lang}>
      <ProductHubView data={next} onSendPost={vi.fn()} onCreateTask={vi.fn()} onCreateSpace={vi.fn()} onCreateThread={vi.fn()} messagingApi={api} {...props} {...override} />
    </LanguageProvider>
  );
  const view = render(build());
  return { ...view, api, rebuild: build };
}

describe("the channel-post route with what the snapshot already holds", () => {
  it("opens the exact thread and focuses the exact post, asking no one", async () => {
    const loadChannelLanding = vi.fn();
    renderHub({ url: "/m/organize?thread=thread-1&post=post-2", loadChannelLanding });
    const dialog = await screen.findByRole("dialog", { name: "Overtime scheduling" });
    await waitFor(() => expect(within(dialog).getByText("My reply").closest("article")).toHaveFocus());
    expect(within(dialog).getByText("Initial report").closest("article")).not.toHaveAttribute("tabindex");
    expect(scrollIntoView).toHaveBeenCalledTimes(1);
    await tick();
    expect(loadChannelLanding).not.toHaveBeenCalled();
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.queryByRole("status")).toBeNull();
  });

  it("opens the thread alone when no post is named", async () => {
    renderHub({ url: "/m/organize?thread=thread-1", loadChannelLanding: vi.fn() });
    const dialog = await screen.findByRole("dialog", { name: "Overtime scheduling" });
    expect(bodiesIn(dialog)).toEqual(["Initial report", "My reply"]);
    await tick();
    expect(scrollIntoView).not.toHaveBeenCalled();
  });

  // BUG-UG-WEB-CHANNEL-FROM-MESSAGES-DOES-NOT-OPEN-THREAD-20261003:
  // Messages > Channels hands the thread over as a focus on /m/organize; the
  // hub then normalises the address to its Topics tab, and the App's navigate
  // clears the focus. The thread dialog must survive both.
  it("keeps the handed-over thread open on the normalised Topics address after the focus clears", async () => {
    const view = renderHub({ url: "/m/organize/organize", focus: { view: "hub", threadId: "thread-1" }, loadChannelLanding: vi.fn() });
    const dialog = await screen.findByRole("dialog", { name: "Overtime scheduling" });
    view.rerender(view.rebuild(undefined, "en", { focus: null }));
    await tick();
    expect(dialog).toBeInTheDocument();
    expect(screen.getByRole("dialog", { name: "Overtime scheduling" })).toBeVisible();
  });

  // BUG-UG-WEB-CHANNEL-FROM-MESSAGES-DOES-NOT-OPEN-THREAD-RECURRENCE-20261009:
  // the first fix closed only the path where the handed-over thread is already
  // in the loaded product spaces. A channel the snapshot never carried (or one
  // handed over before the snapshot arrived) left the member on the normalised
  // Topics address with nothing open: the focus effect returned early, and the
  // normalisation then cleared the focus for good. The handoff is held as an
  // intent instead, and resolved either by asking for that one thread or by the
  // next snapshot that carries it.
  it("asks for a handed-over thread the loaded spaces do not carry, and opens it after the focus clears", async () => {
    const loadChannelLanding = vi.fn().mockResolvedValue(coldAnswer);
    const view = renderHub({ url: "/m/organize", focus: { view: "hub", threadId: COLD_THREAD }, loadChannelLanding });
    // The hub normalises the address to its Topics tab, and App's navigate
    // clears the focus, while the answer is still in flight.
    view.rerender(view.rebuild(undefined, "en", { focus: null }));
    const dialog = await screen.findByRole("dialog", { name: "Break room refrigerator" });
    expect(dialog).toBeVisible();
    expect(loadChannelLanding).toHaveBeenCalledTimes(1);
    expect(loadChannelLanding).toHaveBeenCalledWith({ threadId: COLD_THREAD, postId: null });
  });

  it("keeps a handed-over thread pending until a later snapshot carries it, with no loader to ask", async () => {
    const view = renderHub({ url: "/m/organize", focus: { view: "hub", threadId: COLD_THREAD } });
    await tick();
    expect(screen.queryByRole("dialog")).toBeNull();
    // The focus is already gone by the time the channel arrives.
    const warm = hubData();
    warm.product.spaces[0].threads = [loadedThread, coldThread];
    view.rerender(view.rebuild(warm, "en", { focus: null }));
    expect(await screen.findByRole("dialog", { name: "Break room refrigerator" })).toBeVisible();
  });

  // Gate round 1 (Sol): a latched handoff is the member's last request only
  // until she makes another one, and only for the reader it was made for.
  it("drops a pending handoff once the member opens another thread by hand", async () => {
    const view = renderHub({ url: "/m/organize", focus: { view: "hub", threadId: COLD_THREAD } });
    await tick();
    view.rerender(view.rebuild(undefined, "en", { focus: null }));
    fireEvent.click(screen.getAllByText("Overtime scheduling")[0].closest("button"));
    const manual = await screen.findByRole("dialog", { name: "Overtime scheduling" });
    // Closed again before the snapshot moves: the abandoned handoff stays void.
    fireEvent.click(within(manual).getByRole("button", { name: "Close" }));
    await closed();
    const warm = hubData();
    warm.product.spaces[0].threads = [loadedThread, coldThread];
    view.rerender(view.rebuild(warm, "en", { focus: null }));
    await tick();
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("lets a newer handoff win over an older one the same snapshot makes resolvable", async () => {
    const view = renderHub({ url: "/m/organize", focus: { view: "hub", threadId: COLD_THREAD } });
    await tick();
    view.rerender(view.rebuild(undefined, "en", { focus: null }));
    const warm = hubData();
    warm.product.spaces[0].threads = [loadedThread, coldThread];
    view.rerender(view.rebuild(warm, "en", { focus: { view: "hub", threadId: "thread-1" } }));
    expect(await screen.findByRole("dialog", { name: "Overtime scheduling" })).toBeVisible();
    await tick();
    expect(screen.queryByRole("dialog", { name: "Break room refrigerator" })).toBeNull();
  });

  it("never resolves a pending handoff for the next signed-in reader", async () => {
    const loadChannelLanding = vi.fn().mockResolvedValue(coldAnswer);
    const view = renderHub({ url: "/m/organize", focus: { view: "hub", threadId: COLD_THREAD } });
    await tick();
    const next = hubData("user-2");
    next.product.spaces[0].threads = [loadedThread, coldThread];
    view.rerender(view.rebuild(next, "en", { focus: null, messagingApi: { loadChannelLanding } }));
    await tick();
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(loadChannelLanding).not.toHaveBeenCalled();
  });

  it("lands on a post named by a search hit, too", async () => {
    renderHub({ focus: { threadId: "thread-1", postId: "post-1", nonce: 1 }, loadChannelLanding: vi.fn() });
    const dialog = await screen.findByRole("dialog", { name: "Overtime scheduling" });
    await waitFor(() => expect(within(dialog).getByText("Initial report").closest("article")).toHaveFocus());
  });

  it("leaves an unknown thread link silent when the surface has no loader", async () => {
    renderHub({ url: `/m/organize?thread=${COLD_THREAD}&post=${COLD_POST}` });
    await tick();
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.queryByRole("status")).toBeNull();
    expect(screen.getByRole("button", { name: /Overtime scheduling/ })).toBeInTheDocument();
  });

  it("does not ask a messaging api that lacks the method", async () => {
    renderHub({ url: `/m/organize?thread=${COLD_THREAD}&post=${COLD_POST}`, messagingApi: baseApi() });
    await tick();
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(screen.queryByRole("status")).toBeNull();
  });
});

describe("a thread the snapshot never carried is hydrated, not assumed absent", () => {
  it("opens the thread from the loader's answer, focuses the exact post, and asks once", async () => {
    const loadChannelLanding = vi.fn().mockResolvedValue(coldAnswer);
    const view = renderHub({ url: `/m/organize?thread=${COLD_THREAD}&post=${COLD_POST}`, loadChannelLanding });
    const dialog = await screen.findByRole("dialog", { name: "Break room refrigerator" });
    const article = await waitFor(() => {
      const found = within(dialog).getByText(coldPost.body).closest("article");
      expect(found).toHaveFocus();
      return found;
    });
    expect(loadChannelLanding).toHaveBeenCalledTimes(1);
    expect(loadChannelLanding).toHaveBeenCalledWith({ threadId: COLD_THREAD, postId: COLD_POST });
    expect(scrollIntoView.mock.contexts[0]).toBe(article);
    expect(bodiesIn(dialog)).toEqual([coldPost.body, coldNeighbour.body]);
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.queryByRole("status")).toBeNull();

    // A refresh of the same snapshot, and of a fresh one, never asks again.
    view.rerender(view.rebuild());
    view.rerender(view.rebuild(hubData()));
    await tick();
    expect(loadChannelLanding).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("dialog", { name: "Break room refrigerator" })).toBeInTheDocument();
  });

  it("puts no post text in the value the paired panes share", async () => {
    renderHub({ url: `/m/organize?thread=${COLD_THREAD}&post=${COLD_POST}`, loadChannelLanding: vi.fn().mockResolvedValue(coldAnswer) });
    await screen.findByRole("dialog", { name: "Break room refrigerator" });
    const shared = JSON.stringify(deviceParityValue("hub.dialog"));
    expect(shared).toContain(COLD_THREAD);
    expect(shared).not.toContain(coldPost.body);
    expect(shared).not.toContain(coldNeighbour.body);
  });

  it("opens the thread that owns a post named alone", async () => {
    const loadChannelLanding = vi.fn().mockResolvedValue(coldAnswer);
    renderHub({ url: `/m/organize?post=${COLD_POST}`, loadChannelLanding });
    const dialog = await screen.findByRole("dialog", { name: "Break room refrigerator" });
    await waitFor(() => expect(within(dialog).getByText(coldPost.body).closest("article")).toHaveFocus());
    expect(loadChannelLanding).toHaveBeenCalledWith({ threadId: null, postId: COLD_POST });
  });

  it("opens an unknown thread named without a post, from its bounded window, focusing nothing", async () => {
    const loadChannelLanding = vi.fn().mockResolvedValue({ thread: coldThread, post: null });
    renderHub({ url: `/m/organize?thread=${COLD_THREAD}`, loadChannelLanding });
    const dialog = await screen.findByRole("dialog", { name: "Break room refrigerator" });
    expect(await within(dialog).findByText(coldPost.body)).toBeInTheDocument();
    expect(loadChannelLanding).toHaveBeenCalledWith({ threadId: COLD_THREAD, postId: null });
    await tick();
    expect(scrollIntoView).not.toHaveBeenCalled();
    expect(loadChannelLanding).toHaveBeenCalledTimes(1);
  });

  it("shows the request while it is pending, in a status the reader hears", async () => {
    const pending = deferred();
    renderHub({ url: `/m/organize?thread=${COLD_THREAD}&post=${COLD_POST}`, loadChannelLanding: vi.fn(() => pending.promise) });
    expect(await screen.findByRole("status")).toHaveTextContent("Opening the linked conversation…");
    expect(screen.queryByRole("dialog")).toBeNull();
    await act(async () => pending.resolve(coldAnswer));
    await screen.findByRole("dialog", { name: "Break room refrigerator" });
    await waitFor(() => expect(screen.queryByRole("status")).toBeNull());
  });

  it("hands the hydrated exact post to the common connected control", async () => {
    const seen = [];
    const renderConnectedActions = (kind, record) => { seen.push(`${kind}|${record.id}|${record.thread_id}`); return <button type="button">Actions</button>; };
    renderHub({ url: `/m/organize?thread=${COLD_THREAD}&post=${COLD_POST}`, loadChannelLanding: vi.fn().mockResolvedValue(coldAnswer), renderConnectedActions, messagingApi: baseApi() });
    const dialog = await screen.findByRole("dialog", { name: "Break room refrigerator" });
    expect(within(within(dialog).getByText(coldPost.body).closest("article")).getByRole("button", { name: "Actions" })).toBeInTheDocument();
    expect(new Set(seen)).toEqual(new Set([`channel_post|${COLD_POST}|${COLD_THREAD}`, `channel_post|post-cold-2|${COLD_THREAD}`]));
  });

  it("keeps a closed thread closed across refreshes", async () => {
    const view = renderHub({ url: `/m/organize?thread=${COLD_THREAD}&post=${COLD_POST}`, loadChannelLanding: vi.fn().mockResolvedValue(coldAnswer) });
    const dialog = await screen.findByRole("dialog", { name: "Break room refrigerator" });
    fireEvent.click(within(dialog).getByRole("button", { name: "Close" }));
    await closed();
    view.rerender(view.rebuild(hubData()));
    await tick();
    expect(screen.queryByRole("dialog")).toBeNull();
  });
});

describe("a post older than the loaded posts of a known thread is hydrated inside its dialog", () => {
  it("merges the post into its chronological place, focuses it, and asks once with a bounded window", async () => {
    const loadChannelLanding = vi.fn().mockResolvedValue(olderAnswer);
    const view = renderHub({ url: `/m/organize?thread=thread-1&post=${olderPost.id}`, loadChannelLanding });
    const dialog = await screen.findByRole("dialog", { name: "Overtime scheduling" });
    const article = await waitFor(() => {
      const found = within(dialog).getByText(olderPost.body).closest("article");
      expect(found).toHaveFocus();
      return found;
    });
    expect(loadChannelLanding).toHaveBeenCalledTimes(1);
    expect(loadChannelLanding).toHaveBeenCalledWith({ threadId: "thread-1", postId: olderPost.id, window: 0 });
    expect(scrollIntoView.mock.contexts[0]).toBe(article);
    expect(bodiesIn(dialog)).toEqual([olderPost.body, "Initial report", "My reply"]);
    view.rerender(view.rebuild());
    view.rerender(view.rebuild(hubData()));
    await tick();
    expect(loadChannelLanding).toHaveBeenCalledTimes(1);
  });

  it("does the same for a post named by a search hit", async () => {
    const loadChannelLanding = vi.fn().mockResolvedValue(olderAnswer);
    renderHub({ focus: { threadId: "thread-1", postId: olderPost.id, nonce: 1 }, loadChannelLanding });
    const dialog = await screen.findByRole("dialog", { name: "Overtime scheduling" });
    await waitFor(() => expect(within(dialog).getByText(olderPost.body).closest("article")).toHaveFocus());
    expect(loadChannelLanding).toHaveBeenCalledWith({ threadId: "thread-1", postId: olderPost.id, window: 0 });
  });

  it("names an unreadable post inside a thread that opened normally, without a retry", async () => {
    const loadChannelLanding = vi.fn().mockResolvedValue(null);
    renderHub({ url: `/m/organize?thread=thread-1&post=${olderPost.id}`, loadChannelLanding });
    const dialog = await screen.findByRole("dialog", { name: "Overtime scheduling" });
    expect(await within(dialog).findByRole("alert")).toHaveTextContent("That message is no longer available, or you no longer have access to it.");
    expect(within(dialog).queryByRole("button", { name: "Try again" })).toBeNull();
    expect(bodiesIn(dialog)).toEqual(["Initial report", "My reply"]);
    for (const article of dialog.querySelectorAll("article")) expect(article).not.toHaveAttribute("tabindex");
    await tick();
    expect(loadChannelLanding).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["an answer for another thread", () => Promise.resolve({ thread: { ...coldThread }, post: { ...olderPost, thread_id: COLD_THREAD } })],
    ["an answer that omits the named post", () => Promise.resolve({ thread: loadedThread, post: null })],
    ["a refusal", () => Promise.reject(refusal("42501"))],
  ])("treats %s as unavailable inside the dialog", async (_label, answer) => {
    renderHub({ url: `/m/organize?thread=thread-1&post=${olderPost.id}`, loadChannelLanding: vi.fn(answer) });
    const dialog = await screen.findByRole("dialog", { name: "Overtime scheduling" });
    expect(await within(dialog).findByRole("alert")).toHaveTextContent("no longer available");
    expect(bodiesIn(dialog)).toEqual(["Initial report", "My reply"]);
  });

  it("retries a failed fetch inside the dialog only when pressed", async () => {
    const loadChannelLanding = vi.fn()
      .mockRejectedValueOnce(Object.assign(new Error("reset"), { code: "08006" }))
      .mockResolvedValueOnce(olderAnswer);
    renderHub({ url: `/m/organize?thread=thread-1&post=${olderPost.id}`, loadChannelLanding });
    const dialog = await screen.findByRole("dialog", { name: "Overtime scheduling" });
    const alert = await within(dialog).findByRole("alert");
    expect(alert).toHaveTextContent("The linked message could not be loaded.");
    expect(alert).not.toHaveTextContent("reset");
    await tick();
    expect(loadChannelLanding).toHaveBeenCalledTimes(1);
    fireEvent.click(within(alert).getByRole("button", { name: "Try again" }));
    await waitFor(() => expect(within(dialog).getByText(olderPost.body).closest("article")).toHaveFocus());
    expect(loadChannelLanding).toHaveBeenCalledTimes(2);
  });
});

describe("a link followed while the hub is already mounted", () => {
  // The app's navigate() changes the address without remounting a view that is
  // already on screen, so the hub applies an address that changed underneath it.
  const follow = (view, url) => {
    window.history.pushState({}, "", url);
    view.rerender(view.rebuild());
  };

  it("opens and hydrates a thread the snapshot never carried", async () => {
    const loadChannelLanding = vi.fn().mockResolvedValue(coldAnswer);
    const view = renderHub({ url: "/m/organize", loadChannelLanding });
    await tick();
    expect(screen.queryByRole("dialog")).toBeNull();
    follow(view, `/m/organize?thread=${COLD_THREAD}&post=${COLD_POST}`);
    const dialog = await screen.findByRole("dialog", { name: "Break room refrigerator" });
    await waitFor(() => expect(within(dialog).getByText(coldPost.body).closest("article")).toHaveFocus());
    expect(loadChannelLanding).toHaveBeenCalledTimes(1);
    view.rerender(view.rebuild());
    await tick();
    expect(loadChannelLanding).toHaveBeenCalledTimes(1);
  });

  it("opens a thread the snapshot holds and focuses the post", async () => {
    const view = renderHub({ url: "/m/organize", loadChannelLanding: vi.fn() });
    follow(view, "/m/organize?thread=thread-1&post=post-1");
    const dialog = await screen.findByRole("dialog", { name: "Overtime scheduling" });
    await waitFor(() => expect(within(dialog).getByText("Initial report").closest("article")).toHaveFocus());
  });

  it("does not re-apply an address that has not changed", async () => {
    const view = renderHub({ url: "/m/organize?thread=thread-1", loadChannelLanding: vi.fn() });
    const dialog = await screen.findByRole("dialog", { name: "Overtime scheduling" });
    fireEvent.click(within(dialog).getByRole("button", { name: "Close" }));
    await closed();
    view.rerender(view.rebuild());
    view.rerender(view.rebuild(hubData()));
    await tick();
    expect(screen.queryByRole("dialog")).toBeNull();
  });
});

describe("a channel link that cannot be shown says so", () => {
  const unavailable = "That conversation is no longer available, or you no longer have access to it.";

  it.each([
    ["removed or unauthorized (nothing)", () => Promise.resolve(null)],
    ["refused with 42501", () => Promise.reject(refusal("42501"))],
    ["refused with not_authorized", () => Promise.reject(refusal("not_authorized"))],
    ["gone with source_unavailable", () => Promise.reject(refusal("source_unavailable"))],
    ["an answer without a thread", () => Promise.resolve({ thread: null, post: null })],
    ["an answer for another thread", () => Promise.resolve({ thread: { ...coldThread, id: "thread-other" }, post: { ...coldPost, thread_id: "thread-other" } })],
    ["an answer that omits the named post", () => Promise.resolve({ thread: coldThread, post: null })],
    ["an answer for another post", () => Promise.resolve({ thread: coldThread, post: coldNeighbour })],
  ])("names a link that is %s, without retry, and keeps the ordinary hub", async (_label, answer) => {
    const loadChannelLanding = vi.fn(answer);
    renderHub({ url: `/m/organize?thread=${COLD_THREAD}&post=${COLD_POST}`, loadChannelLanding });
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent(unavailable);
    expect(within(alert).queryByRole("button", { name: "Try again" })).toBeNull();
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(document.body.textContent).not.toContain(coldPost.body);
    expect(document.body.textContent).not.toContain("Break room refrigerator");
    expect(screen.getByRole("button", { name: /Overtime scheduling/ })).toBeInTheDocument();
    await tick();
    expect(loadChannelLanding).toHaveBeenCalledTimes(1);
    fireEvent.click(within(alert).getByRole("button", { name: "Dismiss" }));
    expect(screen.queryByRole("alert")).toBeNull();
    await tick();
    expect(loadChannelLanding).toHaveBeenCalledTimes(1);
  });

  it("offers a retry for a failure that says nothing about access, and asks again only when pressed", async () => {
    const loadChannelLanding = vi.fn()
      .mockRejectedValueOnce(Object.assign(new Error("connection reset"), { code: "08006" }))
      .mockResolvedValueOnce(coldAnswer);
    renderHub({ url: `/m/organize?thread=${COLD_THREAD}&post=${COLD_POST}`, loadChannelLanding });
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("The linked conversation could not be loaded.");
    expect(alert).not.toHaveTextContent("connection reset");
    await tick();
    expect(loadChannelLanding).toHaveBeenCalledTimes(1);
    fireEvent.click(within(alert).getByRole("button", { name: "Try again" }));
    const dialog = await screen.findByRole("dialog", { name: "Break room refrigerator" });
    await waitFor(() => expect(within(dialog).getByText(coldPost.body).closest("article")).toHaveFocus());
    expect(loadChannelLanding).toHaveBeenCalledTimes(2);
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("reads its states in Spanish", async () => {
    const es = catalogue.es;
    const view = renderHub({ url: `/m/organize?thread=${COLD_THREAD}&post=${COLD_POST}`, loadChannelLanding: vi.fn().mockResolvedValue(null) });
    view.rerender(view.rebuild(hubData(), "es"));
    expect(await screen.findByRole("alert")).toHaveTextContent(es["linkedSource.unavailable"]);
    expect(screen.getByRole("button", { name: es["linkedMessage.dismiss"] })).toBeInTheDocument();
  });
});

describe("an answer that is no longer wanted changes nothing", () => {
  it("drops a late result after the member opened another thread by hand", async () => {
    const pending = deferred();
    const loadChannelLanding = vi.fn(() => pending.promise);
    renderHub({ url: `/m/organize?thread=${COLD_THREAD}&post=${COLD_POST}`, loadChannelLanding });
    expect(await screen.findByRole("status")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /Overtime scheduling/ }));
    await screen.findByRole("dialog", { name: "Overtime scheduling" });
    // An open dialog hides the page behind it from role queries, so ask the DOM:
    // the superseded request must not linger in the notice.
    expect(document.querySelector(".hub2-landing-notice")).toBeNull();

    await act(async () => pending.resolve(coldAnswer));
    await tick();
    expect(screen.getByRole("dialog", { name: "Overtime scheduling" })).toBeInTheDocument();
    expect(screen.queryByRole("dialog", { name: "Break room refrigerator" })).toBeNull();
    expect(document.body.textContent).not.toContain(coldPost.body);
    expect(loadChannelLanding).toHaveBeenCalledTimes(1);
  });

  it("drops a late refusal after a manual open too, without a stale alert", async () => {
    const pending = deferred();
    renderHub({ url: `/m/organize?thread=${COLD_THREAD}&post=${COLD_POST}`, loadChannelLanding: vi.fn(() => pending.promise) });
    expect(await screen.findByRole("status")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /Overtime scheduling/ }));
    await screen.findByRole("dialog", { name: "Overtime scheduling" });
    await act(async () => pending.reject(refusal("42501")));
    await tick();
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.getByRole("dialog", { name: "Overtime scheduling" })).toBeInTheDocument();
  });

  it("drops a late result after the member switched tabs", async () => {
    const pending = deferred();
    renderHub({ url: `/m/organize?thread=${COLD_THREAD}&post=${COLD_POST}`, loadChannelLanding: vi.fn(() => pending.promise) });
    expect(await screen.findByRole("status")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Be heard" }));
    await act(async () => pending.resolve(coldAnswer));
    await tick();
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(screen.queryByRole("status")).toBeNull();
    expect(document.body.textContent).not.toContain(coldPost.body);
  });

  it("drops a late result after a search hit opened another thread, and stops announcing the superseded request", async () => {
    const pending = deferred();
    const loadChannelLanding = vi.fn(() => pending.promise);
    const view = renderHub({ url: `/m/organize?thread=${COLD_THREAD}&post=${COLD_POST}`, loadChannelLanding });
    expect(await screen.findByRole("status")).toBeInTheDocument();
    view.rerender(view.rebuild(hubData(), "en", { focus: { threadId: "thread-1", nonce: 1 } }));
    await screen.findByRole("dialog", { name: "Overtime scheduling" });
    expect(document.querySelector(".hub2-landing-notice")).toBeNull();
    await act(async () => pending.resolve(coldAnswer));
    await tick();
    expect(screen.getByRole("dialog", { name: "Overtime scheduling" })).toBeInTheDocument();
    expect(screen.queryByRole("dialog", { name: "Break room refrigerator" })).toBeNull();
    expect(document.body.textContent).not.toContain(coldPost.body);
    expect(loadChannelLanding).toHaveBeenCalledTimes(1);
  });

  it("drops a late result after the paired pane opened something else", async () => {
    const pending = deferred();
    renderHub({ url: `/m/organize?thread=${COLD_THREAD}&post=${COLD_POST}`, loadChannelLanding: vi.fn(() => pending.promise) });
    expect(await screen.findByRole("status")).toBeInTheDocument();
    act(() => {
      applyDeviceParityState("hub.dialog", { type: "documentDetail", document: { id: "doc-1", title: "Fictional grievance guide", document_type: "policy", status: "published", version: 1, summary: "A summary.", body: "A body.", visibility: "chapter" } });
    });
    await screen.findByRole("dialog", { name: "Fictional grievance guide" });
    await act(async () => pending.resolve(coldAnswer));
    await tick();
    expect(screen.getByRole("dialog", { name: "Fictional grievance guide" })).toBeInTheDocument();
    expect(screen.queryByRole("dialog", { name: "Break room refrigerator" })).toBeNull();
    expect(document.querySelector(".hub2-landing-notice")).toBeNull();
  });

  it("drops a late result after a second link opened a thread the snapshot holds", async () => {
    const pending = deferred();
    const loadChannelLanding = vi.fn(() => pending.promise);
    const view = renderHub({ url: `/m/organize?thread=${COLD_THREAD}&post=${COLD_POST}`, loadChannelLanding });
    expect(await screen.findByRole("status")).toBeInTheDocument();
    window.history.replaceState({}, "", "/m/organize?thread=thread-1&post=post-2");
    view.rerender(view.rebuild(hubData()));
    const dialog = await screen.findByRole("dialog", { name: "Overtime scheduling" });
    await waitFor(() => expect(within(dialog).getByText("My reply").closest("article")).toHaveFocus());
    expect(document.querySelector(".hub2-landing-notice")).toBeNull();
    await act(async () => pending.resolve(coldAnswer));
    await tick();
    expect(screen.getByRole("dialog", { name: "Overtime scheduling" })).toBeInTheDocument();
    expect(screen.queryByRole("dialog", { name: "Break room refrigerator" })).toBeNull();
    expect(document.body.textContent).not.toContain(coldPost.body);
  });

  it("drops a late result once the dialog for a known thread was dismissed", async () => {
    const pending = deferred();
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    renderHub({ url: `/m/organize?thread=thread-1&post=${olderPost.id}`, loadChannelLanding: vi.fn(() => pending.promise) });
    const dialog = await screen.findByRole("dialog", { name: "Overtime scheduling" });
    await within(dialog).findByRole("status");
    fireEvent.click(within(dialog).getByRole("button", { name: "Close" }));
    await closed();
    await act(async () => pending.resolve(olderAnswer));
    await tick();
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(scrollIntoView).not.toHaveBeenCalled();
    expect(errors).not.toHaveBeenCalled();
    errors.mockRestore();
  });

  it("drops a late result after the signed-in member changed, and does not ask again as the next member", async () => {
    const pending = deferred();
    const loadChannelLanding = vi.fn(() => pending.promise);
    const view = renderHub({ url: `/m/organize?thread=${COLD_THREAD}&post=${COLD_POST}`, loadChannelLanding });
    expect(await screen.findByRole("status")).toBeInTheDocument();
    view.rerender(view.rebuild(hubData("user-2")));
    await act(async () => pending.resolve(coldAnswer));
    await tick();
    expect(loadChannelLanding).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(screen.queryByRole("status")).toBeNull();
    expect(document.body.textContent).not.toContain(coldPost.body);
  });

  it("closes a thread it hydrated for one member when another signs in", async () => {
    const view = renderHub({ url: `/m/organize?thread=${COLD_THREAD}&post=${COLD_POST}`, loadChannelLanding: vi.fn().mockResolvedValue(coldAnswer) });
    await screen.findByRole("dialog", { name: "Break room refrigerator" });
    view.rerender(view.rebuild(hubData("user-2")));
    await tick();
    expect(document.body.textContent).not.toContain(coldPost.body);
    expect(document.body.textContent).not.toContain("Break room refrigerator");
  });

  it("does not ask again, as the next member, for a post it was fetching for the previous one", async () => {
    const pending = deferred();
    const loadChannelLanding = vi.fn(() => pending.promise);
    const view = renderHub({ url: `/m/organize?thread=thread-1&post=${olderPost.id}`, loadChannelLanding });
    const dialog = await screen.findByRole("dialog", { name: "Overtime scheduling" });
    await within(dialog).findByRole("status");
    // A new sign-in brings its own api object.
    view.rerender(view.rebuild(hubData("user-2"), "en", { messagingApi: { loadChannelLanding } }));
    await act(async () => pending.resolve(olderAnswer));
    await tick();
    expect(loadChannelLanding).toHaveBeenCalledTimes(1);
    expect(document.body.textContent).not.toContain(olderPost.body);
  });

  it("does nothing after the hub is gone", async () => {
    const pending = deferred();
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    const view = renderHub({ url: `/m/organize?thread=${COLD_THREAD}&post=${COLD_POST}`, loadChannelLanding: vi.fn(() => pending.promise) });
    expect(await screen.findByRole("status")).toBeInTheDocument();
    view.unmount();
    await act(async () => pending.resolve(coldAnswer));
    expect(errors).not.toHaveBeenCalled();
    errors.mockRestore();
  });
});

describe("a link never reaches over an unresolved account deletion", () => {
  const holdProps = (onDeleteAccount) => ({ onCreateGovernance: vi.fn(), onGenerateDataExport: vi.fn(), onDeleteAccount, onDeleteIndeterminateClose: vi.fn() });
  async function startPendingDeletion() {
    fireEvent.click(screen.getByRole("button", { name: "Data rights" }));
    fireEvent.click(screen.getByRole("button", { name: "Delete my account" }));
    fireEvent.change(screen.getByRole("textbox", { name: /Type DELETE MY ACCOUNT/ }), { target: { value: "DELETE MY ACCOUNT" } });
    fireEvent.click(screen.getByRole("button", { name: "Permanently delete my account" }));
    await screen.findByRole("button", { name: "Deleting account…" });
  }

  it("drops an answer that arrives once the member started deleting their account", async () => {
    const pending = deferred();
    const settle = {};
    const onDeleteAccount = vi.fn(() => new Promise((resolve, reject) => { settle.resolve = resolve; settle.reject = reject; }));
    renderHub({ url: `/m/organize?thread=${COLD_THREAD}&post=${COLD_POST}`, loadChannelLanding: vi.fn(() => pending.promise), ...holdProps(onDeleteAccount) });
    expect(await screen.findByRole("status")).toBeInTheDocument();
    await startPendingDeletion();
    await act(async () => pending.resolve(coldAnswer));
    await tick();
    expect(screen.getByRole("dialog", { name: "Permanently delete your account" })).toBeInTheDocument();
    expect(screen.queryByRole("dialog", { name: "Break room refrigerator" })).toBeNull();
    await act(async () => settle.reject(new Error("delete-failed")));
  });

  it("consumes and drops a link that arrives while the deletion is unresolved, never surfacing it afterwards", async () => {
    const settle = {};
    const onDeleteAccount = vi.fn(() => new Promise((resolve, reject) => { settle.resolve = resolve; settle.reject = reject; }));
    const loadChannelLanding = vi.fn().mockResolvedValue(coldAnswer);
    const view = renderHub({ url: "/m/organize", loadChannelLanding, ...holdProps(onDeleteAccount) });
    await startPendingDeletion();
    window.history.replaceState({}, "", `/m/organize?thread=${COLD_THREAD}&post=${COLD_POST}`);
    view.rerender(view.rebuild(hubData()));
    await tick();
    expect(loadChannelLanding).not.toHaveBeenCalled();
    expect(screen.getByRole("dialog", { name: "Permanently delete your account" })).toBeInTheDocument();

    await act(async () => settle.reject(new Error("delete-failed")));
    view.rerender(view.rebuild(hubData()));
    await tick();
    expect(loadChannelLanding).not.toHaveBeenCalled();
    expect(screen.queryByRole("dialog", { name: "Break room refrigerator" })).toBeNull();
  });
});

// #9524: a task or reminder made from a channel post stores its source as
// /m/messages?channel=<thread>&post=<post>. On the website that address opened
// the Messages inbox, which never reads channel or post. The connected
// navigation now sends it here, the way the phone opens /channel/:id?post=.
describe("a stored /m/messages channel-post source link", () => {
  const sourceAddress = (stored, selectedHat = "member") => {
    const destination = workflowDestination(stored, { selectedHat, staffAccess: selectedHat !== "member" });
    expect(destination?.view).toBe("hub");
    expect(explicitHatAllowsView(selectedHat, destination.view, false, selectedHat === "member" ? [] : [selectedHat], false, destination.href)).toBe(true);
    return destination.href;
  };

  it.each(["member", "steward", "coordinator", "secretary"])("opens the post in its topic, in view and marked, under the %s hat", async (hat) => {
    renderHub({ url: sourceAddress("/m/messages?channel=thread-1&post=post-2", hat), loadChannelLanding: vi.fn() });
    const dialog = await screen.findByRole("dialog", { name: "Overtime scheduling" });
    await waitFor(() => expect(within(dialog).getByText("My reply").closest("article")).toHaveFocus());
    expect(scrollIntoView).toHaveBeenCalled();
  });

  it("opens a post the snapshot never carried, read under the reader's own access", async () => {
    const loadChannelLanding = vi.fn().mockResolvedValue(coldAnswer);
    renderHub({ url: sourceAddress(`/m/messages?channel=${COLD_THREAD}&post=${COLD_POST}`), loadChannelLanding });
    const dialog = await screen.findByRole("dialog", { name: "Break room refrigerator" });
    await waitFor(() => expect(within(dialog).getByText(coldPost.body).closest("article")).toHaveFocus());
    expect(loadChannelLanding).toHaveBeenCalledWith(expect.objectContaining({ threadId: COLD_THREAD, postId: COLD_POST }));
  });

  it.each([
    ["refused", () => Promise.reject(refusal("42501"))],
    ["gone", () => Promise.resolve(null)],
  ])("tells a reader who can no longer read that channel or post so in a sentence (%s), showing nobody else's content", async (_label, answer) => {
    renderHub({ url: sourceAddress(`/m/messages?channel=${COLD_THREAD}&post=${COLD_POST}`), loadChannelLanding: vi.fn(answer) });
    expect(await screen.findByRole("alert")).toHaveTextContent("That conversation is no longer available, or you no longer have access to it.");
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(document.body.textContent).not.toContain(coldPost.body);
    expect(document.body.textContent).not.toContain("Break room refrigerator");
  });

  it("says it in Spanish too", async () => {
    const view = renderHub({ url: sourceAddress(`/m/messages?channel=${COLD_THREAD}&post=${COLD_POST}`), loadChannelLanding: vi.fn().mockResolvedValue(null) });
    view.rerender(view.rebuild(hubData(), "es"));
    expect(await screen.findByRole("alert")).toHaveTextContent(catalogue.es["linkedSource.unavailable"]);
  });
});
