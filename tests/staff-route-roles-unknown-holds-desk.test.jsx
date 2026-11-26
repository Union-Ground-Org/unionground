import { capturedAppClientFixture } from "./helpers/capturedAppClientFixture.js";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { App } from "../src/App.jsx";
import { samplePersonaForHat } from "../src/lib/sampleBackend.js";
import { SAMPLE_HOST, SAMPLE_ORIGIN } from "./helpers/fictional-provider.js";

// The official service's hosts are not in this edition; the fictional provider stands in.
vi.mock("../src/lib/trustedBackends.js", async () => (await import("./helpers/fictional-provider.js")).trustedBackendsModule());

// The retired preview host adopts a seeded persona only when the access token's
// own email claim names it (BUG-UG-REMOVE-RETIRED-PREVIEW-INVITATION-20261020),
// so these fixtures carry a JWT-shaped token with the persona claim.
function tokenWithEmail(email) {
  return `header.${Buffer.from(JSON.stringify({ email, session_id: "11111111-1111-4111-8111-111111111111" })).toString("base64url")}.signature`;
}

// BUG-UG-SAMPLE-COORDINATOR-SURVEY-NAVIGATION-LANDS-ON-HOME-20261019:
// SAMPLE bot-08 wore the Coordinator desk and opened the Campaigns surveys
// route, and its retained snapshot showed Member Home with Member navigation,
// no desks and no refusal. Those three together are what a role read that
// soft-failed renders: `rolesUnknown` publishes no roles, the gates hold the
// URL and the hat, but the view region resolved to Member Today. The region
// now holds the route (nothing staff-only renders) and re-reads the roles.
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
  ...await original(), get appBackendKind() { return backend.state.kind; }, hasAppBackend: true,
  appAuthStorageUnavailable: false, appSupabase: backend.client,
  createCapturedAppSessionRpcClient: () => capturedAppClientFixture(backend.client),
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

const SLOW = { timeout: 15000 };
const roleReads = () => backend.state.calls.filter((call) => call === "table:member_roles").length;

beforeEach(() => {
  vi.stubEnv("MODE", "authenticated-model");
  vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("inert backend")));
  vi.stubGlobal("matchMedia", (query) => ({ matches: query.includes("min-width"), media: query, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} }));
  localStorage.clear(); sessionStorage.clear();
  window.scrollTo = vi.fn(); window.history.replaceState({}, "", "/m/coordinator");
  Object.assign(backend.state, {
    kind: "live",
    session: { user: { id: "member-1", email: "member-1@example.test" }, access_token: "token" },
    calls: [], fail: null, chapter: "chapter-1", chapterOptions: null,
    rows: {
      "table:member_roles": [{ role: "coordinator" }],
      "rpc:get_my_chapter_memberships": [],
      "rpc:get_member_rewards_summary": { totalPoints: 0 },
    },
  });
});
afterEach(() => {
  cleanup(); vi.unstubAllEnvs(); vi.unstubAllGlobals();
  globalThis.jsdom.reconfigure({ url: "http://localhost:3000/" });
});

const memberHome = () => screen.queryByRole("heading", { level: 1, name: /Welcome back/ });
const pending = () => document.querySelector("[data-roles-pending]");


it("holds a worn Coordinator desk route through a soft-failed role read, then lands on it", { timeout: 90000 }, async () => {
  render(<App />);
  // /m/coordinator is the Coordinator plane: the account holds the role, so
  // the route wears the hat.
  await waitFor(() => expect(screen.getAllByRole("link", { name: "Campaigns" }).length).toBeGreaterThan(0), SLOW);
  await act(async () => { screen.getAllByRole("link", { name: "Campaigns" })[0].click(); });
  await waitFor(() => expect(window.location.pathname).toBe("/m/campaigns"), SLOW);
  await waitFor(() => expect(backend.state.chapterOptions).toBeTruthy(), SLOW);
  expect(pending()).toBeNull();
  const readsBefore = roleReads();

  // A chapter switch resets the member scope; the role read fails this time.
  backend.state.fail = "table:member_roles";
  const options = backend.state.chapterOptions();
  await act(async () => {
    await options.switchChapter("chapter-2");
    await options.reload().catch(() => {});
  });
  await waitFor(() => expect(roleReads()).toBeGreaterThan(readsBefore), SLOW);
  await waitFor(() => expect(pending()).not.toBeNull(), SLOW);

  // Fail closed and in place: the URL holds, Member Home does not render
  // under it, and no role was granted.
  expect(window.location.pathname).toBe("/m/campaigns");
  expect(memberHome()).toBeNull();
  expect(screen.getByRole("button", { name: "Try again" })).toBeInTheDocument();

  // The read recovers; the bounded re-read settles the route on its desk.
  backend.state.fail = null;
  await waitFor(() => expect(pending()).toBeNull(), { timeout: 20000 });
  expect(window.location.pathname).toBe("/m/campaigns");
  expect(memberHome()).toBeNull();
  expect(screen.getAllByRole("link", { name: "Campaigns" }).some((link) => link.getAttribute("aria-current") === "page")).toBe(true);
});

it.each(["live", "sample"])("still refuses a staff route for %s when roles read back empty", { timeout: 90000 }, async (kind) => {
  if (kind === "sample") {
    globalThis.jsdom.reconfigure({ url: `${SAMPLE_ORIGIN}/` });
    backend.state.kind = kind;
    backend.state.session.user.email = samplePersonaForHat("coordinator").email;
    backend.state.session.access_token = tokenWithEmail(backend.state.session.user.email);
  }
  backend.state.rows["table:member_roles"] = [];
  window.history.replaceState({}, "", "/m/campaigns");
  render(<App />);
  await waitFor(() => expect(window.location.pathname).toBe("/m"), SLOW);
  expect(pending()).toBeNull();
  expect(screen.queryByRole("link", { name: "Campaigns" })).toBeNull();
});
