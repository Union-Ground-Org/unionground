import { capturedAppClientFixture } from "./helpers/capturedAppClientFixture.js";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { App } from "../src/App.jsx";

// Real App switch callbacks, session loader and AdminView. Only transport and
// the rail's presentation are controlled; responses freeze at request time.
const backend = await vi.hoisted(async () => {
  const { createMemberBackendHarness } = await import("./helpers/memberBackendHarness.js");
  const harness = createMemberBackendHarness();
  const originalRpc = harness.client.rpc;
  harness.client.rpc = async (name, args) => {
    if (["create_member_event", "create_member_event_model"].includes(name)) {
      harness.state.createCalls += 1;
      if (harness.state.holdCreate) await new Promise(resolve => { harness.state.releaseCreate = resolve; });
      if (harness.state.failCreate) return { data: null, error: { code: "42501", message: "event refused" } };
      harness.state.createdChapters.push(harness.state.chapter);
      return { data: { created: true }, error: null };
    }
    // Staff-only drafts file under the chapter selected when the save runs.
    if (name === "list_member_event_drafts") return { data: [], error: null };
    if (name === "save_member_event_draft") {
      harness.state.draftCalls += 1;
      if (harness.state.holdDraft) await new Promise(resolve => { harness.state.releaseDraft = resolve; });
      harness.state.draftChapters.push(harness.state.chapter);
      return { data: { id: "draft-1", fields: args.p_fields }, error: null };
    }
    if (name !== "switch_my_chapter") return originalRpc(name, args);
    harness.state.switchCalls += 1;
    if (harness.state.refuseSwitch) return { data: null, error: { code: "42501", message: "chapter refused" }, status: 403 };
    harness.state.chapter = args.p_chapter_id;
    harness.state.rows["rpc:get_my_chapter_memberships"].forEach(row => { row.selected = row.chapterId === args.p_chapter_id; });
    if (harness.state.loseSwitchResponse) throw new Error("network disconnected after commit");
    if (harness.state.holdSwitch) await new Promise(resolve => { harness.state.releaseSwitch = resolve; });
    return { data: { chapterId: args.p_chapter_id }, error: null };
  };
  return harness;
});
vi.mock("../src/lib/supabase.js", async original => ({
  ...await original(), appBackendKind: "live", hasAppBackend: true,
  appAuthStorageUnavailable: false, appSupabase: backend.client,
  createCapturedAppSessionRpcClient: () => capturedAppClientFixture(backend.client),
}));
vi.mock("../src/lib/memberSessionLoader.js", async original => {
  const implementation = await original();
  return { ...implementation, createMemberSessionLoader(client, user, options) {
    let loader;
    const scoped = backend.scopedClient(user, () => loader);
    const from = scoped.from;
    scoped.from = table => {
      if (table !== "member_profiles") return from(table);
      const profile = { id: user.id, first_name: "Model", full_name: "Model Member", language: "en", chapter_id: backend.state.chapter };
      let query;
      query = new Proxy({}, { get(_target, key) {
        if (key === "then") return (resolve, reject) => {
          const response = { data: profile, error: null };
          const promise = backend.state.holdProfile
            ? new Promise(done => backend.state.profiles.push({ response, done }))
            : Promise.resolve(response);
          return promise.then(resolve, reject);
        };
        return () => query;
      } });
      return query;
    };
    loader = implementation.createMemberSessionLoader(scoped, user, { ...options, concurrency: 8 });
    backend.state.loader = loader;
    return loader;
  } };
});
vi.mock("../src/lib/memberApi.js", async original => {
  const implementation = await original();
  const { fallbackData } = await import("./fixtures/retired-pre-bot/src/data/fallback.js");
  return { ...implementation, loadAdminDesk: async () => ({
    ...structuredClone(fallbackData.adminDesk),
    events: [{ ...fallbackData.adminDesk.events[0], title: `Event in chapter ${backend.state.chapter}` }],
  }), loadEventsDesk: async () => ({
    events: [{ ...fallbackData.adminDesk.events[0], title: `Desk event in chapter ${backend.state.chapter}` }],
  }) };
});
vi.mock("../src/views/AdminView.jsx", async original => {
  const { AdminView } = await original();
  return { AdminView: props => {
    backend.state.adminApi = props.api;
    return <AdminView {...props} />;
  } };
});
vi.mock("../src/lib/chapterRail.js", async original => {
  const implementation = await original();
  return { ...implementation, createLiveChapterSelector: readOptions => {
    const select = implementation.createLiveChapterSelector(readOptions);
    backend.state.selectChapter = select;
    return select;
  } };
});

async function openAdmin() {
  await act(async () => {
    window.history.pushState({}, "", "/m/admin/events");
    window.dispatchEvent(new PopStateEvent("popstate"));
  });
}

beforeEach(() => {
  vi.stubEnv("MODE", "authenticated-model");
  vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("inert model backend")));
  localStorage.clear(); sessionStorage.clear(); window.scrollTo = vi.fn();
  window.history.replaceState({}, "", "/m/admin/events");
  Object.assign(backend.state, {
    session: { user: backend.user("model-a"), access_token: "model-token" },
    chapter: "a", loader: null, profiles: [], holdProfile: false, holdSwitch: false,
    switchCalls: 0, refuseSwitch: false, loseSwitchResponse: false,
    createCalls: 0, holdCreate: false, failCreate: false, createdChapters: [],
    draftCalls: 0, holdDraft: false, draftChapters: [],
    pending: [], operations: [], hold: false, holdResource: null, fail: null,
    subscribers: [], namedSubscribers: {}, feeds: [], liveSequences: new Map(),
    rows: {
      "table:member_roles": [{ role: "admin" }],
      "table:chapters": [{ id: "a", name: "Chapter A" }, { id: "b", name: "Chapter B" }],
      "rpc:get_my_chapter_memberships": [
        { chapterId: "a", organizationId: "org", name: "Chapter A", selected: true, roles: ["admin"], organizationRoles: ["admin"] },
        { chapterId: "b", organizationId: "org", name: "Chapter B", selected: false, roles: ["admin"], organizationRoles: ["admin"] },
      ],
    },
  });
});
afterEach(() => { cleanup(); vi.unstubAllEnvs(); vi.unstubAllGlobals(); });

function startCreate() {
  fireEvent.click(screen.getByRole("button", { name: "New meeting" }));
  fireEvent.change(screen.getByLabelText("Web name"), { target: { value: "chapter-event" } });
  fireEvent.change(screen.getByLabelText("Title"), { target: { value: "Chapter event" } });
  fireEvent.change(screen.getByLabelText("Starts"), { target: { value: "2026-10-20T12:30" } });
  fireEvent.change(screen.getByLabelText("Location"), { target: { value: "Hall" } });
  fireEvent.change(screen.getByLabelText("Summary"), { target: { value: "Chapter meeting agenda" } });
  fireEvent.change(screen.getByLabelText("Check-in code (SG-…)"), { target: { value: "SG-CHAPTER" } });
  fireEvent.submit(screen.getByRole("button", { name: "Save" }).closest("form"));
}

it.each(["admin", "rail"])("%s refusal restores the current chapter desk without requiring a profile refresh", async entry => {
  render(<App />);
  await screen.findByText("Event in chapter a", {}, { timeout: 5000 });
  backend.state.refuseSwitch = true;
  backend.state.holdProfile = true;
  await act(async () => {
    await (entry === "admin"
      ? backend.state.adminApi.switchMyChapter("b")
      : backend.state.selectChapter({ id: "b", name: "Chapter B" })).catch(() => false);
  });
  expect(await screen.findByText("Event in chapter a")).toBeVisible();
  expect(screen.getByRole("button", { name: "New meeting" })).toBeEnabled();
  expect(backend.state.chapter).toBe("a");
  expect(backend.state.profiles).toHaveLength(0);
});

it("keeps an unknown switch outcome fenced until it re-reads the authenticated chapter", async () => {
  render(<App />);
  await screen.findByText("Event in chapter a");
  backend.state.loseSwitchResponse = true;
  await act(async () => { await backend.state.adminApi.switchMyChapter("b").catch(() => false); });
  expect(screen.queryByRole("button", { name: "New meeting" })).toBeNull();
  fireEvent.click(await screen.findByRole("button", { name: "Try again" }));
  expect(await screen.findByText("Event in chapter b")).toBeVisible();
  expect(backend.state.switchCalls).toBe(1);
});

it.each(["admin", "rail"])("%s switch waits for the submitted event to finish in its original chapter", async entry => {
  render(<App />);
  await screen.findByText("Event in chapter a");
  backend.state.holdCreate = true;
  startCreate();
  await waitFor(() => expect(backend.state.createCalls).toBe(1));
  const oldApi = backend.state.adminApi;
  let switching;
  await act(async () => {
    switching = entry === "admin"
      ? oldApi.switchMyChapter("b")
      : backend.state.selectChapter({ id: "b", name: "Chapter B" });
  });
  expect(backend.state.switchCalls).toBe(0);
  expect(screen.queryByRole("button", { name: "New meeting" })).toBeNull();
  await expect(oldApi.createEvent({})).rejects.toThrow();
  expect(backend.state.createCalls).toBe(1);
  await act(async () => { backend.state.releaseCreate(); await switching; });
  expect(backend.state.createdChapters).toEqual(["a"]);
  await openAdmin();
  expect(await screen.findByText("Event in chapter b")).toBeVisible();
});

it("releases a pending chapter switch when the submitted event is refused", async () => {
  render(<App />);
  await screen.findByText("Event in chapter a");
  backend.state.holdCreate = true;
  backend.state.failCreate = true;
  startCreate();
  await waitFor(() => expect(backend.state.createCalls).toBe(1));
  let switching;
  await act(async () => { switching = backend.state.adminApi.switchMyChapter("b"); });
  expect(backend.state.switchCalls).toBe(0);
  await act(async () => { backend.state.releaseCreate(); await switching; });
  expect(backend.state.createdChapters).toEqual([]);
  expect(await screen.findByText("Event in chapter b")).toBeVisible();
});

// Gate round 1 on: a draft save in flight holds a chapter switch, so
// the draft cannot land in the chapter selected next; once the switch is
// under way a new draft save is refused like a create.
it("holds a chapter switch until a submitted staff-only draft has saved", async () => {
  render(<App />);
  await screen.findByText("Event in chapter a");
  backend.state.holdDraft = true;
  fireEvent.click(screen.getByRole("button", { name: "New meeting" }));
  fireEvent.change(screen.getByLabelText("Title"), { target: { value: "Steward huddle" } });
  fireEvent.click(screen.getByRole("button", { name: "Save as staff-only draft" }));
  await waitFor(() => expect(backend.state.draftCalls).toBe(1));
  let switching;
  await act(async () => { switching = backend.state.adminApi.switchMyChapter("b"); });
  expect(backend.state.switchCalls).toBe(0);
  await expect(backend.state.adminApi.saveEventDraft(null, { title: "Late" })).rejects.toThrow("Chapter switch in progress");
  await act(async () => { backend.state.releaseDraft(); await switching; });
  expect(backend.state.draftChapters).toEqual(["a"]);
  expect(backend.state.draftCalls).toBe(1);
  expect(await screen.findByText("Event in chapter b")).toBeVisible();
});

it.each(["admin", "rail"])("%s switch fences the old desk before the RPC settles and through delayed refresh", async entry => {
  render(<App />);
  expect(await screen.findByText("Event in chapter a")).toBeVisible();
  expect(screen.getByRole("button", { name: "New meeting" })).toBeEnabled();
  backend.state.holdProfile = true;
  backend.state.holdSwitch = true;
  let switching;
  await act(async () => {
    switching = entry === "admin"
      ? backend.state.adminApi.switchMyChapter("b")
      : backend.state.selectChapter({ id: "b", name: "Chapter B" });
  });
  expect(backend.state.chapter).toBe("b");
  expect(screen.queryByRole("button", { name: "New meeting" })).toBeNull();
  expect(screen.queryByText("Event in chapter a")).toBeNull();
  await act(async () => { backend.state.releaseSwitch(); });
  await waitFor(() => expect(backend.state.profiles).toHaveLength(1));
  expect(screen.queryByRole("button", { name: "New meeting" })).toBeNull();
  await act(async () => {
    backend.state.holdProfile = false;
    const pending = backend.state.profiles.shift(); pending.done(pending.response);
    await switching;
  });
  await openAdmin();
  expect(await screen.findByText("Event in chapter b")).toBeVisible();
  expect(screen.getByRole("button", { name: "New meeting" })).toBeEnabled();
});

it.each(["admin", "rail"])("%s switch keeps a failed refresh fenced until an explicit refresh succeeds", async entry => {
  render(<App />);
  await screen.findByText("Event in chapter a");
  backend.state.holdProfile = true;
  let switching;
  await act(async () => {
    switching = (entry === "admin"
      ? backend.state.adminApi.switchMyChapter("b")
      : backend.state.selectChapter({ id: "b", name: "Chapter B" })).catch(() => false);
  });
  await waitFor(() => expect(backend.state.profiles).toHaveLength(1));
  await act(async () => {
    backend.state.profiles.shift().done({ data: null, error: { message: "profile unavailable" } });
    await switching;
  });
  backend.state.holdProfile = false;
  await openAdmin();
  // A failed shell profile also has its own route error. Recovering that read
  // must not silently release the outstanding chapter transition.
  fireEvent.click(await screen.findByRole("button", { name: "Try again" }));
  await screen.findByText("The selected campaign could not be refreshed. Try again before using admin tools.");
  expect(screen.queryByRole("button", { name: "New meeting" })).toBeNull();
  const retry = await screen.findByRole("button", { name: "Try again" });
  fireEvent.click(retry);
  expect(await screen.findByText("Event in chapter b")).toBeVisible();
  expect(backend.state.switchCalls).toBe(1);
});

// The switch commits chapter B, then an optional
// read fails. That section degrades on its own; the desk must not stay fenced.
const OPTIONAL_ADMIN_READS = ["rpc:get_staff_mfa_standing", "table:chapter_tasks"];
const FENCE = "The selected campaign could not be refreshed. Try again before using admin tools.";

it.each(OPTIONAL_ADMIN_READS)("a committed switch is not fenced when optional %s fails", async resource => {
  render(<App />);
  await screen.findByText("Event in chapter a");
  backend.state.fail = resource;
  await act(async () => { await backend.state.adminApi.switchMyChapter("b"); });
  expect(backend.state.chapter).toBe("b");
  expect(backend.state.loader.stateForRoute("admin").status).toBe("loaded");
  expect(await screen.findByText("Event in chapter b")).toBeVisible();
  expect(screen.queryByText(FENCE)).toBeNull();
  expect(screen.getByRole("button", { name: "New meeting" })).toBeEnabled();
});

it.each(OPTIONAL_ADMIN_READS)("Try again recovers a fenced switch while optional %s fails", async resource => {
  render(<App />);
  await screen.findByText("Event in chapter a");
  backend.state.holdProfile = true;
  let switching;
  await act(async () => { switching = backend.state.adminApi.switchMyChapter("b").catch(() => false); });
  await waitFor(() => expect(backend.state.profiles).toHaveLength(1));
  await act(async () => {
    backend.state.profiles.shift().done({ data: null, error: { message: "profile unavailable" } });
    await switching;
  });
  backend.state.holdProfile = false;
  backend.state.fail = resource;
  await openAdmin();
  // The failed shell profile first shows its own route error, as above.
  fireEvent.click(await screen.findByRole("button", { name: "Try again" }));
  const fence = await screen.findByText(FENCE);
  expect(fence).toBeVisible();
  fireEvent.click(within(fence.parentElement).getByRole("button", { name: "Try again" }));
  expect(await screen.findByText("Event in chapter b")).toBeVisible();
  expect(screen.queryByText(FENCE)).toBeNull();
  expect(screen.getByRole("button", { name: "New meeting" })).toBeEnabled();
  expect(backend.state.switchCalls).toBe(1);
});

// The standalone events desk shares the chapter
// fence, and a committed switch mounts a fresh desk for the new chapter.
// The rail navigates away on its own, so these switch in place.
async function openEventsDesk() {
  await act(async () => {
    window.history.pushState({}, "", "/m/events-desk");
    window.dispatchEvent(new PopStateEvent("popstate"));
  });
  return screen.findByText("Desk event in chapter a");
}

it("events desk is fenced through a chapter switch and remounts in the new chapter", async () => {
  render(<App />);
  await screen.findByText("Event in chapter a");
  await openEventsDesk();
  backend.state.holdProfile = true;
  let switching;
  await act(async () => { switching = backend.state.adminApi.switchMyChapter("b"); });
  await waitFor(() => expect(backend.state.profiles).toHaveLength(1));
  expect(screen.queryByText("Desk event in chapter a")).toBeNull();
  expect(screen.queryByRole("button", { name: "New meeting" })).toBeNull();
  await act(async () => {
    backend.state.holdProfile = false;
    const pending = backend.state.profiles.shift(); pending.done(pending.response);
    await switching;
  });
  expect(await screen.findByText("Desk event in chapter b")).toBeVisible();
  expect(screen.getByRole("button", { name: "New meeting" })).toBeEnabled();
});

it("events desk keeps a failed chapter refresh fenced until Try again commits it", async () => {
  render(<App />);
  await screen.findByText("Event in chapter a");
  await openEventsDesk();
  backend.state.holdProfile = true;
  let switching;
  await act(async () => { switching = backend.state.adminApi.switchMyChapter("b").catch(() => false); });
  await waitFor(() => expect(backend.state.profiles).toHaveLength(1));
  await act(async () => {
    backend.state.profiles.shift().done({ data: null, error: { message: "profile unavailable" } });
    await switching;
  });
  backend.state.holdProfile = false;
  // The failed shell profile first shows its own route error.
  fireEvent.click(await screen.findByRole("button", { name: "Try again" }));
  const fence = await screen.findByText("The selected campaign could not be refreshed. Try again before managing meetings.");
  expect(screen.queryByRole("button", { name: "New meeting" })).toBeNull();
  fireEvent.click(within(fence.parentElement).getByRole("button", { name: "Try again" }));
  expect(await screen.findByText("Desk event in chapter b")).toBeVisible();
  expect(backend.state.switchCalls).toBe(1);
});
