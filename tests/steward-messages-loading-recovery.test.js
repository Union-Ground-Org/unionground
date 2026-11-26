// REQ-UG-STEWARD-MESSAGES-LOADING-FOLLOWUP-20261102 (#6799).
// /m/steward/messages is the steward route. App.jsx re-renders on every
// loader notification and on each committed projection, then re-projects the
// route; "shown" below is the route state that the latest render displayed.
import { readFileSync } from "node:fs";
import { afterEach, expect, it, vi } from "vitest";
import { createMemberSessionLoader } from "../src/lib/memberSessionLoader.js";

afterEach(() => vi.useRealTimers());

function stewardClient({ hang = null, fail = null, offline = null, rows = {} } = {}) {
  const released = [];
  const answer = (name, data) => {
    if (name === hang) return new Promise((resolve) => released.push(() => resolve({ data, error: null })));
    if (name === fail) return Promise.resolve({ data: null, error: { message: "permission denied", code: "42501" } });
    if (name === offline) return Promise.reject(new TypeError("Failed to fetch"));
    return Promise.resolve({ data, error: null });
  };
  return {
    released,
    from(table) {
      let query;
      query = new Proxy({}, { get(_target, key) {
        if (key === "then") return (resolve, reject) => answer(table, table === "member_roles" ? [{ role: "steward" }] : rows[table] ?? []).then(resolve, reject);
        return () => query;
      } });
      return query;
    },
    rpc: (name) => answer(name, null),
  };
}

function mountRoute(client) {
  const loader = createMemberSessionLoader(client, { id: "fictional-steward" });
  const view = { shown: loader.stateForRoute("steward") };
  const render = () => { view.shown = loader.stateForRoute("steward"); };
  const project = () => loader.loadRoute("steward").then((data) => { if (data) render(); }, () => {});
  loader.subscribe(() => { render(); project(); });
  project();
  return { loader, view, render };
}

it("shows a successful steward route, with or without conversations, without waiting for the deadline", async () => {
  vi.useFakeTimers();
  for (const rows of [{}, { member_conversations: [{ id: "c1", user_id: "fictional-member" }] }]) {
    const { loader, view } = mountRoute(stewardClient({ rows }));
    await vi.advanceTimersByTimeAsync(50);
    expect(view.shown.status).toBe("loaded");
    loader.dispose();
  }
});

it("ends a rejected or unreachable required read in the retryable error state", async () => {
  vi.useFakeTimers();
  for (const options of [{ fail: "member_conversations" }, { offline: "member_conversations" }]) {
    const { loader, view } = mountRoute(stewardClient(options));
    await vi.advanceTimersByTimeAsync(50);
    expect(view.shown.status).toBe("error");
    loader.dispose();
  }
});

// The reactions read is the RPC over the loaded message ids (#7210), so one
// loaded post makes the route issue it.
it.each(["member_conversations", "list_member_message_reactions", "get_steward_badge_counts", "list_intake_triage_owners"])(
  "keeps a hung %s read in the error state after any later render, instead of returning to loading",
  async (hang) => {
    vi.useFakeTimers();
    const { loader, view, render } = mountRoute(stewardClient({ hang, rows: { chapter_thread_posts: [{ id: "fictional-post" }] } }));
    await vi.advanceTimersByTimeAsync(9_000);
    expect(view.shown.status).toBe("loading");
    await vi.advanceTimersByTimeAsync(1_000);
    expect(view.shown).toMatchObject({ status: "error", error: "Request timed out" });
    // Before the fix an unrelated render here (clock, badge, focus) restored
    // "Loading Union Ground..." and no later notice ever arrived.
    for (const at of [2_000, 8_000, 20_000, 270_000]) {
      await vi.advanceTimersByTimeAsync(at);
      render();
      expect(view.shown.status).toBe("error");
    }
    loader.dispose();
  },
);

it("Try again gives a hung read a fresh deadline, and a late answer clears the error", async () => {
  vi.useFakeTimers();
  const client = stewardClient({ hang: "member_conversations" });
  const { loader, view } = mountRoute(client);
  await vi.advanceTimersByTimeAsync(10_000);
  expect(view.shown.status).toBe("error");
  // Try again (App.refresh) invalidates the route resources and re-projects.
  loader.invalidateResources(loader.resourcesForRoute("steward"));
  await vi.advanceTimersByTimeAsync(50);
  expect(view.shown.status).toBe("loading");
  await vi.advanceTimersByTimeAsync(10_000);
  expect(view.shown.status).toBe("error");
  for (const release of client.released) release();
  await vi.advanceTimersByTimeAsync(50);
  expect(view.shown.status).toBe("loaded");
  loader.dispose();
});

it("disposing the loader clears every pending read deadline", async () => {
  vi.useFakeTimers();
  const { loader } = mountRoute(stewardClient({ hang: "member_conversations" }));
  await vi.advanceTimersByTimeAsync(50);
  const listener = vi.fn();
  loader.subscribe(listener);
  loader.dispose();
  await vi.advanceTimersByTimeAsync(60_000);
  expect(listener).not.toHaveBeenCalled();
  expect(vi.getTimerCount()).toBe(0);
});

it("keeps the loading logo, words and retry together as one centred group", () => {
  const css = readFileSync("src/styles.css", "utf8");
  expect(css).toMatch(/\.view-loading \{[^}]*display: grid;[^}]*align-content: center;[^}]*min-height: 55vh;/);
});
