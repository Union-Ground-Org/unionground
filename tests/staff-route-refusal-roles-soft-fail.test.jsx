import { capturedAppClientFixture } from "./helpers/capturedAppClientFixture.js";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { App } from "../src/App.jsx";

// UX-UG-BRIEF-ROLE-READ-FAILURE-REWRITES-CORRECT-OPENS-ADMIN-20261013
//: the refusal card rebuilt its sentence from the
// live role projection on every render. An ordinary refresh retains the last
// good roles, but a scope reset (a chapter switch) reads every shell resource
// afresh, and a role read that fails there publishes `rolesUnknown` with no
// roles at all. An Admin who had typed /m/campaigns under the Member hat was
// first told the page opens from the Admin desk and then, after that brief
// read failure, that it is only for chapter staff. The refusal now keeps the
// roles it was decided with and shows that sentence while roles are unknown.
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
  appAuthStorageUnavailable: false, createCapturedAppSessionRpcClient: () => capturedAppClientFixture(backend.client), appSupabase: backend.client,
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
const STAFF_ONLY_SENTENCE = "Campaigns is only for chapter staff, so Home opened instead.";
const SLOW = { timeout: 10000 };
const roleReads = () => backend.state.calls.filter((call) => call === "table:member_roles").length;

beforeEach(() => {
  vi.stubEnv("MODE", "authenticated-model");
  vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("inert backend")));
  vi.stubGlobal("matchMedia", (query) => ({ matches: query.includes("min-width"), media: query, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} }));
  localStorage.clear(); sessionStorage.clear();
  window.scrollTo = vi.fn(); window.history.replaceState({}, "", "/m/campaigns");
  Object.assign(backend.state, {
    session: { user: { id: "member-1", email: "member-1@example.test" }, access_token: "token" },
    calls: [], fail: null, chapter: "chapter-1", chapterOptions: null,
    // An ownerless account: its roles come from member_roles, and no
    // membership row means no organization to re-bind the card to.
    rows: {
      "table:member_roles": [{ role: "admin" }],
      "rpc:get_my_chapter_memberships": [],
      "rpc:get_member_rewards_summary": { totalPoints: 0 },
    },
  });
});
afterEach(() => { cleanup(); vi.unstubAllEnvs(); vi.unstubAllGlobals(); });

it("keeps the Admin desk sentence after a scope reset soft-fails the role read", { timeout: 60000 }, async () => {
  render(<App />);
  expect(await screen.findByText(DESK_SENTENCE, {}, SLOW)).toBeInTheDocument();
  await waitFor(() => expect(window.location.pathname).toBe("/m"), SLOW);
  await waitFor(() => expect(backend.state.chapterOptions).toBeTruthy(), SLOW);
  const readsBefore = roleReads();

  // A chapter switch resets the member scope: every shell resource is read
  // again, and this time the role read fails.
  backend.state.fail = "table:member_roles";
  const options = backend.state.chapterOptions();
  await act(async () => {
    await options.switchChapter("chapter-2");
    await options.reload().catch(() => {});
  });
  await waitFor(() => expect(roleReads()).toBeGreaterThan(readsBefore), SLOW);
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 50)); });

  expect(window.location.pathname).toBe("/m");
  expect(screen.getByText(DESK_SENTENCE)).toBeInTheDocument();
  expect(screen.queryByText(STAFF_ONLY_SENTENCE)).toBeNull();
});
