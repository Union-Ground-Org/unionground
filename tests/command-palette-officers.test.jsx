import { capturedAppClientFixture } from "./helpers/capturedAppClientFixture.js";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { App } from "../src/App.jsx";
import { keepKeyboardShortcutsOn } from "./helpers/keyboardShortcuts.js";

keepKeyboardShortcutsOn();

// The command palette indexed only the shared
// snapshot, and nothing put the member's union chart there, so Ctrl/Cmd+K
// never found an officer the Search page could. Opening the palette now reads
// the same member-safe projection once per member scope.
const backend = vi.hoisted(() => {
  const state = { calls: [], rows: {}, live: {} };
  const respond = (resource) => {
    state.calls.push(resource);
    const fail = state.fail === resource;
    const data = resource === "table:member_profiles"
      ? { id: "member-1", first_name: "Model", full_name: "Model Member", initials: "MM", language: "en", chapter_id: "chapter-1" }
      : (typeof state.rows[resource] === "function" ? state.rows[resource]() : state.rows[resource]) ?? (resource.startsWith("rpc:") ? null : []);
    const result = fail ? { data: null, error: { message: "lookup unavailable", code: "08006" } } : { data: structuredClone(data), error: null };
    return state.hold?.resource === resource ? state.hold.promise.then(() => result) : Promise.resolve(result);
  };
  const client = {
    from(table) {
      let query;
      query = new Proxy({}, { get(_target, key) {
        if (key === "then") return (resolve, reject) => respond(`table:${table}`).then(resolve, reject);
        return () => query;
      } });
      return query;
    },
    rpc: (name) => respond(`rpc:${name}`),
    auth: {
      getSession: async () => ({ data: { session: state.session }, error: null }),
      onAuthStateChange(callback) { state.auth = callback; return { data: { subscription: { unsubscribe() {} } } }; },
      mfa: { getAuthenticatorAssuranceLevel: async () => ({ data: { currentLevel: "aal1", nextLevel: "aal1" }, error: null }) },
    },
    channel() {
      const channel = { on(_type, filter, handler) { state.live[filter?.table] = handler; return channel; }, subscribe() { return channel; }, unsubscribe() {} };
      return channel;
    },
    removeChannel() {}, realtime: { setAuth() {} },
  };
  return { state, client };
});
vi.mock("../src/lib/supabase.js", async (original) => ({
  ...await original(), appBackendKind: "live", hasAppBackend: true,
  appAuthStorageUnavailable: false, appSupabase: backend.client,
  createCapturedAppSessionRpcClient: () => capturedAppClientFixture(backend.client),
}));

const STRUCTURE = {
  organizationId: "org-1", chapterId: "chapter-1", generatedAt: "2026-10-07T00:00:00.000Z",
  charts: [{ chartKind: "union", nodes: [
    { id: "officer-1", parentId: null, chapterId: "chapter-1", nodeKind: "person", label: "Dolores Whitcombe", subtitle: "President", sortOrder: 1 },
  ], edges: [] }],
};

beforeEach(() => {
  vi.stubEnv("MODE", "authenticated-model");
  vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("inert backend")));
  vi.stubGlobal("matchMedia", (query) => ({ matches: query.includes("min-width"), media: query, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} }));
  localStorage.clear(); sessionStorage.clear();
  window.scrollTo = vi.fn(); window.history.replaceState({}, "", "/m");
  Object.assign(backend.state, {
    session: { user: { id: "member-1", email: "member-1@example.test" }, access_token: "token" },
    calls: [], fail: null, hold: null, live: {},
    rows: {
      "rpc:get_my_chapter_memberships": [{ chapterId: "chapter-1", organizationId: "org-1", name: "Chapter one", selected: true, roles: [], organizationRoles: [], chapterRoles: [] }],
      "rpc:get_member_organization_structure": STRUCTURE,
      "rpc:get_member_rewards_summary": { totalPoints: 0 },
    },
  });
});
afterEach(() => { cleanup(); vi.unstubAllEnvs(); vi.unstubAllGlobals(); });

// The mutation dry run executes this suite under instrumentation, where a
// full App render is several times slower than in the plain web lane.
const SLOW = { timeout: 10000 };
const structureReads = () => backend.state.calls.filter((call) => call === "rpc:get_member_organization_structure").length;
// App keys the palette by session generation, so a keypress that lands while
// the session is still settling can be remounted away. Press again until the
// dialog stays open.
async function openPalette() {
  await waitFor(() => {
    if (!screen.queryByRole("dialog", { name: "Command palette" })) fireEvent.keyDown(window, { key: "k", ctrlKey: true });
    expect(screen.getByRole("dialog", { name: "Command palette" })).toBeInTheDocument();
  }, SLOW);
  return screen.getByRole("dialog", { name: "Command palette" });
}

it("finds a member-visible officer from Ctrl/Cmd+K and opens the chart on that officer", { timeout: 60000 }, async () => {
  render(<App />);
  await screen.findByRole("navigation", { name: "Primary" }, SLOW);
  expect(structureReads()).toBe(0);
  const palette = await openPalette();
  await waitFor(() => expect(structureReads()).toBeGreaterThan(0), SLOW);
  fireEvent.change(within(palette).getByRole("combobox"), { target: { value: "dolores" } });
  fireEvent.click(await within(palette).findByRole("option", { name: /Dolores Whitcombe/ }, SLOW));
  await waitFor(() => expect(window.location.pathname).toBe("/m/org-structure"), SLOW);
  await waitFor(() => expect(screen.queryByRole("dialog", { name: "Command palette" })).toBeNull(), SLOW);
  // The chart page is lazy and reads its own copy of the projection on mount.
  // Wait until that read has landed (the chart controls render only once it
  // resolves) so it is not counted against the palette's second open below.
  await screen.findByRole("group", { name: "Choose a chart" }, SLOW);

  // A second open reuses the snapshot already held for this member scope.
  const readsBefore = structureReads();
  await openPalette();
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(structureReads()).toBe(readsBefore);
});

it("keeps the palette's other results when the officer lookup fails", { timeout: 60000 }, async () => {
  backend.state.fail = "rpc:get_member_organization_structure";
  render(<App />);
  await screen.findByRole("navigation", { name: "Primary" }, SLOW);
  const palette = await openPalette();
  await waitFor(() => expect(structureReads()).toBeGreaterThan(0), SLOW);
  fireEvent.change(within(palette).getByRole("combobox"), { target: { value: "voting" } });
  // The page is offered as a destination and again as a search result.
  expect((await within(palette).findAllByRole("option", { name: /Voting/ }, SLOW))[0]).toBeVisible();
  expect(within(palette).queryByRole("alert")).toBeNull();
  // Union Ground has no contract yet, so the palette offers no clauses page.
  fireEvent.change(within(palette).getByRole("combobox"), { target: { value: "contract clauses" } });
  await waitFor(() => expect(within(palette).queryByRole("option", { name: /^Contract clauses/ })).toBeNull(), SLOW);
});

// The palette awaited the chart before committing
// its search snapshot, so a notification that arrived during that call was
// written back over with the older rows. The snapshot now lands first.
it("keeps a notification that arrives while the officer lookup is running", { timeout: 60000 }, async () => {
  let release;
  backend.state.hold = { resource: "rpc:get_member_organization_structure", promise: new Promise((resolve) => { release = resolve; }) };
  render(<App />);
  await screen.findByRole("navigation", { name: "Primary" }, SLOW);
  const palette = await openPalette();
  await waitFor(() => expect(structureReads()).toBeGreaterThan(0), SLOW);
  act(() => backend.state.live.member_notifications({ new: {
    id: "notification-live", user_id: "member-1", kind: "general", title: "Ballot opens Friday",
    body: "Vote in the chapter ballot", created_at: new Date().toISOString(), read_at: null,
  } }));
  fireEvent.change(within(palette).getByRole("combobox"), { target: { value: "ballot opens friday" } });
  expect(await within(palette).findByRole("option", { name: /Ballot opens Friday/ }, SLOW)).toBeVisible();
  await act(async () => { release(); await backend.state.hold.promise; await new Promise((resolve) => setTimeout(resolve, 50)); });
  expect(within(palette).getByRole("option", { name: /Ballot opens Friday/ })).toBeVisible();
});

// BUG-UG-DROP-COMMAND-PALETTE-S-HELD-OFFICER-CHART-SIGN-20261013
//: the chart was held beside the snapshot and keyed
// by member id, so clearing the snapshot at sign-out left it in place and the
// same member's next sign-in reused the previous visit's officers. A removed
// or renamed officer stayed listed until the chapter or organization changed.
it("refetches the chart after the same member signs out and back in, so a renamed officer is not listed from the previous visit", { timeout: 60000 }, async () => {
  render(<App />);
  await screen.findByRole("navigation", { name: "Primary" }, SLOW);
  let palette = await openPalette();
  await waitFor(() => expect(structureReads()).toBe(1), SLOW);
  fireEvent.change(within(palette).getByRole("combobox"), { target: { value: "dolores" } });
  expect(await within(palette).findByRole("option", { name: /Dolores Whitcombe/ }, SLOW)).toBeVisible();
  fireEvent.keyDown(palette, { key: "Escape" });
  await waitFor(() => expect(screen.queryByRole("dialog", { name: "Command palette" })).toBeNull(), SLOW);

  // The member signs out; the chapter renames its president meanwhile.
  await act(async () => { backend.state.session = null; backend.state.auth("SIGNED_OUT", null); });
  await waitFor(() => expect(screen.queryByRole("navigation", { name: "Primary" })).toBeNull(), SLOW);
  backend.state.rows["rpc:get_member_organization_structure"] = {
    ...STRUCTURE,
    charts: [{ chartKind: "union", nodes: [{ ...STRUCTURE.charts[0].nodes[0], label: "Rosa Lindqvist" }], edges: [] }],
  };
  await act(async () => {
    backend.state.session = { user: { id: "member-1", email: "member-1@example.test" }, access_token: "token-second-visit" };
    backend.state.auth("SIGNED_IN", backend.state.session);
  });
  await screen.findByRole("navigation", { name: "Primary" }, SLOW);

  // The next palette open reads the chart again instead of the held copy.
  palette = await openPalette();
  await waitFor(() => expect(structureReads()).toBe(2), SLOW);
  fireEvent.change(within(palette).getByRole("combobox"), { target: { value: "president" } });
  expect(await within(palette).findByRole("option", { name: /Rosa Lindqvist/ }, SLOW)).toBeVisible();
  expect(within(palette).queryByRole("option", { name: /Dolores Whitcombe/ })).toBeNull();
});
