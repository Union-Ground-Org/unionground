import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { App } from "../src/App.jsx";
import { readActingHat, writeActingHat } from "../src/lib/actingHat.js";

// REQ-UG-TYPED-ADDRESS-ROLE-DESK-BOUNCE-20261030 (Codex P1 on #6594):
// a real reload starts signed out and authenticates cold, and the identity
// change from no account to the member used to reset the worn hat to Member
// before the live roles arrived. The same account's chosen hat now survives
// that transition and is checked against the live roles; another account's
// hat is still dropped. Backend seam as in staff-route-refusal-roles-soft-fail.
const backend = vi.hoisted(() => {
  const state = { calls: [], rows: {}, fail: null, chapter: "chapter-1", chapterOptions: null };
  const respond = (resource) => {
    state.calls.push(resource);
    const fail = state.fail === resource;
    const data = resource === "table:member_profiles"
      ? { id: "member-1", first_name: "Model", full_name: "Model Member", initials: "MM", language: "en", chapter_id: state.chapter }
      : state.rows[resource] ?? (resource.startsWith("rpc:") ? null : []);
    return Promise.resolve(fail
      ? { data: null, error: { message: "lookup unavailable", code: "08006" } }
      : { data: structuredClone(data), error: null });
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
    rpc: (name, args) => {
      if (name !== "switch_my_chapter") return respond(`rpc:${name}`);
      state.chapter = args.p_chapter_id;
      return Promise.resolve({ data: { chapterId: args.p_chapter_id }, error: null });
    },
    auth: {
      getSession: async () => ({ data: { session: state.session }, error: null }),
      onAuthStateChange() { return { data: { subscription: { unsubscribe() {} } } }; },
      mfa: { getAuthenticatorAssuranceLevel: async () => ({ data: { currentLevel: "aal1", nextLevel: "aal1" }, error: null }) },
    },
    channel() {
      const channel = { on() { return channel; }, subscribe() { return channel; }, unsubscribe() {} };
      return channel;
    },
    removeChannel() {}, realtime: { setAuth() {} },
  };
  return { state, client };
});
vi.mock("../src/lib/supabase.js", async (original) => ({
  ...await original(), appBackendKind: "live", hasAppBackend: true,
  appAuthStorageUnavailable: false, appSupabase: backend.client,
}));
// The Hub's chapter selector is the one place a member starts a scope reset.
// Its options are App's real switchChapter and reload callbacks; capturing
// them runs the same reset without leaving the page the refusal is bound to.
vi.mock("../src/lib/chapterRail.js", async (original) => {
  const implementation = await original();
  return { ...implementation, createLiveChapterSelector(readOptions) {
    backend.state.chapterOptions = readOptions;
    return implementation.createLiveChapterSelector(readOptions);
  } };
});

const DESK_SENTENCE = "Campaigns opens from your Admin desk. Switch to Admin and it opens there.";
const SLOW = { timeout: 10000 };

beforeEach(() => {
  vi.stubEnv("MODE", "authenticated-model");
  vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("inert backend")));
  vi.stubGlobal("matchMedia", (query) => ({ matches: query.includes("min-width"), media: query, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} }));
  localStorage.clear(); sessionStorage.clear();
  window.scrollTo = vi.fn(); window.history.replaceState({}, "", "/m/campaigns");
  Object.assign(backend.state, {
    session: { user: { id: "member-1", email: "member-1@example.test" }, access_token: "token" },
    calls: [], fail: null, chapter: "chapter-1", chapterOptions: null,
    rows: {
      "table:member_roles": [{ role: "admin" }],
      "rpc:get_my_chapter_memberships": [],
      "rpc:get_member_rewards_summary": { totalPoints: 0 },
    },
  });
});
afterEach(() => { cleanup(); vi.unstubAllEnvs(); vi.unstubAllGlobals(); });

it("reloads a shared tool in the hat the same account chose, through the cold sign-in", { timeout: 60000 }, async () => {
  writeActingHat("member-1", "admin");
  render(<App />);
  await waitFor(() => expect(backend.state.calls).toContain("table:member_roles"), SLOW);
  await waitFor(() => expect(backend.state.chapterOptions).toBeTruthy(), SLOW);
  expect(window.location.pathname).toBe("/m/campaigns");
  expect(screen.queryByText(DESK_SENTENCE)).toBeNull();
  expect(readActingHat()).toEqual({ userId: "member-1", hat: "admin" });
});

it("drops a hat another account chose in this tab at the sign-in", { timeout: 60000 }, async () => {
  writeActingHat("member-2", "admin");
  render(<App />);
  expect(await screen.findByText(DESK_SENTENCE, {}, SLOW)).toBeInTheDocument();
  await waitFor(() => expect(window.location.pathname).toBe("/m"), SLOW);
  await waitFor(() => expect(readActingHat()).toEqual({ userId: "member-1", hat: "member" }), SLOW);
});

it("drops the same account's hat once the live roles no longer hold it", { timeout: 60000 }, async () => {
  writeActingHat("member-1", "admin");
  backend.state.rows["table:member_roles"] = [{ role: "steward" }];
  render(<App />);
  await waitFor(() => expect(window.location.pathname).toBe("/m"), SLOW);
  await waitFor(() => expect(readActingHat()).toEqual({ userId: "member-1", hat: "member" }), SLOW);
});
