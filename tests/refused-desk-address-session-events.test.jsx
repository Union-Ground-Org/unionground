import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "../src/App.jsx";

// Ledger 51 (G7 P2 on #8285, Refs #8218): the remembered refused address was
// cleared on every session event, so a token refresh for the same person
// lost it and the desk switch opened the overview again. It belongs to the
// person who was refused it: a token refresh keeps it, another person's
// sign-in drops it. Live session, as in command-palette-officers.test.jsx.
const backend = vi.hoisted(() => {
  const state = { rows: {}, session: null, auth: null };
  const respond = (resource) => {
    const data = resource === "table:member_profiles"
      ? { id: state.session?.user.id ?? "member-1", first_name: "Model", full_name: "Model Worker", initials: "MM", language: "en", chapter_id: "chapter-1" }
      : state.rows[resource] ?? (resource.startsWith("rpc:") ? null : []);
    return Promise.resolve({ data: structuredClone(data), error: null });
  };
  const client = {
    from(table) {
      const query = new Proxy({}, { get(_target, key) {
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
    channel() { const channel = { on() { return channel; }, subscribe() { return channel; }, unsubscribe() {} }; return channel; },
    removeChannel() {}, realtime: { setAuth() {} },
  };
  return { state, client };
});
vi.mock("../src/lib/supabase.js", async (original) => ({
  ...await original(), appBackendKind: "live", hasAppBackend: true,
  appAuthStorageUnavailable: false, appSupabase: backend.client,
}));

const sessionFor = (id, token) => ({ user: { id, email: `${id}@example.test` }, access_token: token });

beforeEach(() => {
  vi.stubEnv("MODE", "authenticated-model");
  vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("inert backend")));
  localStorage.clear(); sessionStorage.clear();
  window.scrollTo = vi.fn();
  backend.state.session = sessionFor("member-1", "token-1");
  backend.state.rows = {
    "rpc:get_my_chapter_memberships": [{ chapterId: "chapter-1", organizationId: "org-1", name: "Campaign one", selected: true, roles: ["vp"], organizationRoles: ["vp"], chapterRoles: [] }],
  };
});
afterEach(() => { cleanup(); vi.unstubAllEnvs(); vi.unstubAllGlobals(); });

const desks = () => within(screen.getByRole("navigation", { name: "Desks" }));

async function refusedTasks() {
  window.history.replaceState({}, "", "/m/tasks?view=list");
  render(<App />);
  await waitFor(() => expect(window.location.pathname).toBe("/m"), { timeout: 10000 });
  await screen.findByRole("navigation", { name: "Desks" }, { timeout: 10000 });
}

describe("the remembered refused address across session meetings", () => {
  it("survives a token refresh for the same person: the switch still opens the refused page", async () => {
    await refusedTasks();
    backend.state.session = sessionFor("member-1", "token-2");
    await act(async () => { backend.state.auth("TOKEN_REFRESHED", backend.state.session); });
    fireEvent.click(desks().getByRole("button", { name: "Campaign chair" }));
    await waitFor(() => expect(window.location.pathname).toBe("/m/tasks"), { timeout: 10000 });
    expect(window.location.search).toBe("?view=list");
  }, 20000);

  it("is dropped when another person signs in: the switch opens the desk overview", async () => {
    await refusedTasks();
    backend.state.session = sessionFor("member-2", "token-3");
    await act(async () => { backend.state.auth("SIGNED_IN", backend.state.session); });
    await screen.findByRole("navigation", { name: "Desks" }, { timeout: 10000 });
    fireEvent.click(desks().getByRole("button", { name: "Campaign chair" }));
    await waitFor(() => expect(window.location.pathname).toBe("/m/vp"), { timeout: 10000 });
  }, 20000);
});
