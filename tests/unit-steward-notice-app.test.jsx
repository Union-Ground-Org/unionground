import { capturedAppClientFixture } from "./helpers/capturedAppClientFixture.js";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { App } from "../src/App.jsx";
import { writeActingHat } from "../src/lib/actingHat.js";

// REQ-UG-STEWARD-NOTICES-LIMITED-TO-UNIT-20261109 (#7664): App's
// notice desk publishes a steward's notice to the unit the server grants, never
// to the whole chapter. Backend seam as in acting-hat-session-transition.
const backend = vi.hoisted(() => {
  const state = { calls: [], published: [], rows: {} };
  const respond = (resource) => {
    state.calls.push(resource);
    const data = resource === "table:member_profiles"
      ? { id: "member-1", first_name: "Model", full_name: "Model Member", initials: "MM", language: "en", chapter_id: "chapter-1" }
      : state.rows[resource] ?? (resource.startsWith("rpc:") ? null : []);
    return Promise.resolve({ data: structuredClone(data), error: null });
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
      if (name === "publish_chapter_office_notice" || name === "publish_member_broadcast") {
        state.published.push({ name, args });
        return Promise.resolve({ data: { broadcastId: "bc-unit" }, error: null });
      }
      return respond(`rpc:${name}`);
    },
    auth: {
      getSession: async () => ({ data: { session: state.session }, error: null }),
      onAuthStateChange() { return { data: { subscription: { unsubscribe() {} } } }; },
      mfa: { getAuthenticatorAssuranceLevel: async () => ({ data: { currentLevel: "aal2", nextLevel: "aal2" }, error: null }) },
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

const SLOW = { timeout: 10000 };

beforeEach(() => {
  vi.stubEnv("MODE", "authenticated-model");
  vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("inert backend")));
  vi.stubGlobal("matchMedia", (query) => ({ matches: query.includes("min-width"), media: query, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} }));
  localStorage.clear(); sessionStorage.clear();
  window.scrollTo = vi.fn(); window.history.replaceState({}, "", "/m/messages?filter=announcement");
  Object.assign(backend.state, {
    session: { user: { id: "member-1", email: "member-1@example.test" }, access_token: "token" },
    calls: [], published: [],
    rows: {
      "table:member_roles": [{ role: "steward" }],
      "rpc:get_my_chapter_memberships": [],
      "rpc:get_member_rewards_summary": { totalPoints: 0 },
      "rpc:list_my_member_notices": { notices: [], hasMore: false },
      "rpc:get_chapter_office_access": {
        chapterId: "chapter-1", records: false, documents: false, notices: true, unscopedNotices: false,
        unscopedRecords: false, unscopedDocuments: false,
        scopes: [{ role: "steward", unitId: "unit-a", committeeId: null, name: "Garage A", records: false, notices: true, documents: false }],
      },
    },
  });
});
afterEach(() => { cleanup(); vi.unstubAllEnvs(); vi.unstubAllGlobals(); });

it("posts a steward's notice to the granted unit through the chapter office writer", { timeout: 60000 }, async () => {
  writeActingHat("member-1", "steward");
  render(<App />);
  const desk = (await screen.findByRole("heading", { name: "Post a notice" }, SLOW)).closest("section");
  const unit = await within(desk).findByRole("radio", { name: /Garage A/u }, SLOW);
  expect(within(desk).queryByRole("radio", { name: /chapter/iu })).toBeNull();
  fireEvent.click(unit);
  fireEvent.change(within(desk).getByLabelText("Title"), { target: { value: "Garage A meeting" } });
  fireEvent.change(within(desk).getByLabelText("Notice"), { target: { value: "For Garage A only" } });
  await waitFor(() => expect(within(desk).getByRole("button", { name: "Post notice" })).toBeEnabled(), SLOW);
  fireEvent.click(within(desk).getByRole("button", { name: "Post notice" }));
  await waitFor(() => expect(backend.state.published).toEqual([{ name: "publish_chapter_office_notice", args: {
    p_chapter: "chapter-1", p_title: "Garage A meeting", p_body: "For Garage A only", p_locale: "en", p_unit: "unit-a", p_committee: null,
    p_idempotency_key: expect.any(String),
  } }]), SLOW);
});
