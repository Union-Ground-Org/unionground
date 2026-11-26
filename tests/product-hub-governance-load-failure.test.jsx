import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "../src/App.jsx";
import { createMemberSessionLoader } from "../src/lib/memberSessionLoader.js";
import { LanguageProvider } from "../src/lib/LanguageContext.jsx";
import { ProductHubView } from "../src/views/ProductHubView.jsx";
import { t } from "../src/lib/i18n.js";
import { expectHeldWriteFocus } from "./helpers/busyWriteFocus.js";

const harness = vi.hoisted(() => {
  const user = { id: "member-1", email: "governance@example.test" };
  const session = { user, access_token: "fictional-test-token" };
  const state = { failure: null, roles: [], operations: [], queries: [], pending: [] };
  const request = { id: "request-1", request_type: "correction", status: "submitted", details: "Correct my fictional contact record." };
  const execute = async (resource, calls = []) => {
    state.operations.push(resource);
    if (resource === "table:chapter_governance_requests") {
      state.queries.push(calls);
      if (state.failure === "hang") return new Promise(resolve => state.pending.push(resolve));
      if (state.failure === "reject") throw new Error("private driver detail");
      if (state.failure) return { data: null, error: { code: state.failure, message: "private driver detail" } };
      return { data: [request], error: null };
    }
    if (resource === "table:member_profiles") return { data: { id: user.id, first_name: "Fictional", full_name: "Fictional President", language: "en", chapter_id: "chapter-1" }, error: null };
    if (resource === "table:member_roles") return { data: state.roles.map(role => ({ role })), error: null };
    return { data: resource.startsWith("rpc:") ? null : [], error: null };
  };
  const client = {
    from(table) {
      const calls = [];
      let query;
      query = new Proxy({}, { get(_target, key) {
        if (key === "then") return (resolve, reject) => execute(`table:${table}`, calls).then(resolve, reject);
        return (...args) => { calls.push([key, args]); return query; };
      } });
      return query;
    },
    rpc(name) { return execute(`rpc:${name}`); },
    auth: {
      getSession: async () => ({ data: { session }, error: null }),
      onAuthStateChange: () => ({ data: { subscription: { unsubscribe() {} } } }),
      mfa: { getAuthenticatorAssuranceLevel: async () => ({ data: { currentLevel: "aal1", nextLevel: "aal1" }, error: null }) },
    },
    channel() { const channel = { on: () => channel, subscribe: () => channel, unsubscribe() {} }; return channel; },
    removeChannel() {}, realtime: { setAuth() {} },
  };
  return { state, user, client, request };
});

vi.mock("../src/lib/supabase.js", async importOriginal => ({
  ...await importOriginal(), appBackendKind: "live", hasAppBackend: true,
  appAuthStorageUnavailable: false, appSupabase: harness.client,
}));

beforeEach(() => {
  vi.stubEnv("MODE", "authenticated-test");
  Object.assign(harness.state, { failure: null, roles: [], operations: [], queries: [], pending: [] });
  localStorage.clear(); sessionStorage.clear();
  window.history.replaceState({}, "", "/m/organize/governance");
  window.scrollTo = vi.fn();
  vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("offline test")));
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllEnvs(); vi.unstubAllGlobals(); });

describe("Data rights through the authenticated member hub", () => {
  it.each([[], ["admin"]])("loads the member's requests without calling the admin desk for grants %j", async roles => {
    harness.state.roles = roles;
    render(<App />);
    expect(await screen.findByText(harness.request.details)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Privacy" })).toHaveAttribute("href", "/privacy");
    expect(harness.state.operations).not.toContain("rpc:get_admin_governance_requests");
    expect(harness.state.queries[0]).toEqual(expect.arrayContaining([
      ["order", ["created_at", { ascending: false }]], ["limit", [100]],
    ]));
  });

  it.each(["XX000", "42501", "reject"])("shows a safe read failure and retries after %s", async failure => {
    harness.state.failure = failure;
    render(<App />);
    await screen.findByRole("heading", { name: "Privacy and data rights" });
    const retry = await screen.findByRole("button", { name: "Try again" });
    expect(screen.getByRole("alert")).toHaveTextContent("Load failed");
    expect(document.body).not.toHaveTextContent("private driver detail");
    const initialQueries = harness.state.operations.length;
    harness.state.failure = null;
    fireEvent.click(retry);
    expect(await screen.findByText(harness.request.details)).toBeInTheDocument();
    expect(harness.state.operations.slice(initialQueries)).toEqual(["table:chapter_governance_requests"]);
    await waitFor(() => expect(screen.queryByRole("button", { name: "Try again" })).not.toBeInTheDocument());
  });
});

describe("governance transport deadline", () => {
  it("retains last-confirmed requests with an explicit failure until the scoped retry succeeds", async () => {
    const loader = createMemberSessionLoader(harness.client, harness.user);
    try {
      await loader.loadRoute("hub");
      harness.state.failure = "XX000";
      loader.invalidateResources(["table:chapter_governance_requests"]);
      const failed = await loader.loadRoute("hub");
      expect(failed.product.governance).toEqual([harness.request]);
      expect(failed.product.governanceUnavailable).toBe(true);
      const count = harness.state.operations.length;
      await loader.loadRoute("hub");
      expect(harness.state.operations).toHaveLength(count);
      harness.state.failure = null;
      loader.retryFailedResources(["table:chapter_governance_requests"]);
      expect((await loader.loadRoute("hub")).product.governanceUnavailable).toBe(false);
      expect(harness.state.operations.slice(count)).toEqual(["table:chapter_governance_requests"]);
    } finally { loader.dispose(); }
  });

  it("settles a hung read within five seconds, aborts it and ignores its late result after retry", async () => {
    vi.useFakeTimers();
    harness.state.failure = "hang";
    const loader = createMemberSessionLoader(harness.client, harness.user);
    try {
      const pending = loader.loadRoute("hub");
      let result;
      pending.then(value => { result = value; });
      await act(async () => { await vi.advanceTimersByTimeAsync(5_001); });
      expect(result?.product.governanceUnavailable).toBe(true);
      expect(loader.stateForRoute("hub").status).toBe("loaded");
      const signal = harness.state.queries[0].find(([key]) => key === "abortSignal")?.[1][0];
      expect(signal?.aborted).toBe(true);
      harness.state.failure = null;
      loader.retryFailedResources(["table:chapter_governance_requests"]);
      const recovered = await loader.loadRoute("hub");
      expect(recovered.product.governanceUnavailable).toBe(false);
      expect(recovered.product.governance).toEqual([harness.request]);
      harness.state.pending[0]({ data: [{ ...harness.request, details: "Stale request" }], error: null });
      await vi.advanceTimersByTimeAsync(1);
      expect((await loader.loadRoute("hub")).product.governance).toEqual([harness.request]);
    } finally { loader.dispose(); }
  });
});

it("announces the failure in Spanish and refuses repeated retry while pending", async () => {
  let rejectRetry;
  const retry = vi.fn(() => new Promise((_, reject) => { rejectRetry = reject; }));
  render(<LanguageProvider lang="es"><ProductHubView
    data={{ member: { id: "member-1" }, roles: [], product: { governance: [], governanceUnavailable: true } }}
    onRetryGovernance={retry}
  /></LanguageProvider>);
  fireEvent.click(screen.getByRole("button", { name: t("es", "hub.tab.governance") }));
  const button = screen.getByRole("button", { name: "Reintentar" });
  expect(screen.getByRole("alert")).not.toHaveTextContent("Load failed");
  fireEvent.click(button);
  // #9927 (carved from #8435): unavailable while it retries, but still focusable (pending).
  expect(button).toHaveAttribute("aria-disabled", "true");
  expect(button).toBeEnabled();
  fireEvent.click(button);
  expect(retry).toHaveBeenCalledTimes(1);
  await act(async () => rejectRetry(new Error("private driver detail")));
  expect(screen.getByRole("button", { name: "Reintentar" })).toBeEnabled();
  expect(screen.getByRole("button", { name: "Reintentar" })).not.toHaveAttribute("aria-disabled");
  expect(document.body).not.toHaveTextContent("private driver detail");
});

// #9927 (carved from #8435): Try again was natively disabled while its own retry ran, so a
// keyboard user who pressed it lost focus to the page.
it("keeps focus on Try again while the governance list reloads, and a second press retries nothing", async () => {
  const retry = vi.fn(async () => {});
  render(<LanguageProvider lang="en"><ProductHubView
    data={{ member: { id: "member-1" }, roles: [], product: { governance: [], governanceUnavailable: true } }}
    onRetryGovernance={retry}
  /></LanguageProvider>);
  fireEvent.click(screen.getByRole("button", { name: t("en", "hub.tab.governance") }));
  await expectHeldWriteFocus(retry, screen.getByRole("button", { name: t("en", "app.tryAgain") }));
});
