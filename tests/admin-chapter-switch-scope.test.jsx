import { capturedAppClientFixture } from "./helpers/capturedAppClientFixture.js";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { App } from "../src/App.jsx";
import { applyDeviceParityState } from "../src/lib/deviceParity.js";

const backend = await vi.hoisted(async () => {
  const { createMemberBackendHarness } = await import("./helpers/memberBackendHarness.js");
  const harness = createMemberBackendHarness();
  const originalRpc = harness.client.rpc;
  harness.client.rpc = async (name, args) => {
    if (name !== "switch_my_chapter") return originalRpc(name, args);
    harness.state.chapter = args.p_chapter_id;
    harness.state.rows["rpc:list_weekly_questions"] = [{ id: "question-b", body: "Chapter B question" }];
    harness.state.rows["rpc:get_my_chapter_memberships"].forEach(row => { row.selected = row.chapterId === args.p_chapter_id; });
    return { data: { chapterId: args.p_chapter_id }, error: null };
  };
  return harness;
});
vi.mock("../src/lib/supabase.js", async original => ({
  ...await original(), appBackendKind: "live", hasAppBackend: true,
  appAuthStorageUnavailable: false, createCapturedAppSessionRpcClient: () => capturedAppClientFixture(backend.client), appSupabase: backend.client,
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
        if (key === "then") return (resolve, reject) => Promise.resolve({ data: profile, error: null }).then(resolve, reject);
        return () => query;
      } });
      return query;
    };
    loader = implementation.createMemberSessionLoader(scoped, user, { ...options, concurrency: 8 });
    backend.state.loader = loader;
    return loader;
  } };
});
// Keep the shell, API wrapper and loader real; isolate presentation so this
// regression exercises cross-route scope changes without unrelated desk RPCs.
vi.mock("../src/views/AdminView.jsx", () => ({ AdminView: ({ api, data }) => <>
  <h1>Admin chapter {data.member.chapterId}</h1>
  <button onClick={async () => { await api.switchMyChapter("b"); backend.state.switchResolved = true; }}>Switch to chapter B</button>
</> }));
vi.mock("../src/views/VoiceView.jsx", () => ({ VoiceView: ({ data, weeklyQuestions }) => <>
  <h1>Voice chapter {data.member.chapterId}</h1>
  {weeklyQuestions.map(row => <p key={row.id}>{row.body}</p>)}
</> }));

async function go(view) {
  if (view === "voice") await act(async () => {
    window.history.pushState({}, "", "/m");
    window.dispatchEvent(new PopStateEvent("popstate"));
  });
  await act(async () => {
    applyDeviceParityState("app.selectedStaffHat", view === "admin" ? "admin" : "member");
  });
  await act(async () => {
    window.history.pushState({}, "", `/m/${view}`);
    window.dispatchEvent(new PopStateEvent("popstate"));
  });
}
beforeEach(() => {
  vi.stubEnv("MODE", "authenticated-model");
  vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("inert model backend")));
  localStorage.clear(); sessionStorage.clear(); window.scrollTo = vi.fn();
  window.history.replaceState({}, "", "/m/voice");
  Object.assign(backend.state, {
    session: { user: backend.user("model-a"), access_token: "model-token" },
    chapter: "a", switchResolved: false, loader: null, pending: [], operations: [],
    hold: false, holdResource: null, fail: null, subscribers: [], namedSubscribers: {}, feeds: [], liveSequences: new Map(),
    rows: {
      "table:member_roles": [{ role: "admin" }],
      "table:chapters": [{ id: "a", name: "Chapter A" }, { id: "b", name: "Chapter B" }],
      "rpc:get_my_chapter_memberships": [
        { chapterId: "a", organizationId: "org", name: "Chapter A", selected: true, roles: ["admin"], organizationRoles: ["admin"] },
        { chapterId: "b", organizationId: "org", name: "Chapter B", selected: false, roles: ["admin"], organizationRoles: ["admin"] },
      ],
      "rpc:list_weekly_questions": [{ id: "question-a", body: "Chapter A question" }],
    },
  });
});
afterEach(() => { cleanup(); vi.unstubAllEnvs(); vi.unstubAllGlobals(); });

it.each([false, true])("switching from Admin retires Voice's old chapter cache; failed B questions=%s", async failQuestions => {
  render(<App />);
  expect(await screen.findByText("Chapter A question")).toBeVisible();
  const oldLoader = backend.state.loader;
  await go("admin");
  await screen.findByRole("heading", { name: "Admin chapter a" });
  backend.state.fail = failQuestions ? "rpc:list_weekly_questions" : null;
  fireEvent.click(screen.getByRole("button", { name: "Switch to chapter B" }));
  await screen.findByRole("heading", { name: "Admin chapter b" });
  await waitFor(() => expect(backend.state.switchResolved).toBe(true));
  await go("voice");
  await screen.findByRole("heading", { name: "Voice chapter b" });
  if (!failQuestions) expect(await screen.findByText("Chapter B question")).toBeVisible();
  else await waitFor(() => expect(backend.state.loader.failuresForResources(["rpc:list_weekly_questions"])).toHaveLength(1));
  expect(screen.queryByText("Chapter A question")).toBeNull();
  expect(oldLoader.inspect().size).toBe(0);
  expect(backend.state.operations.filter(op => op.resource === "rpc:list_weekly_questions")).toHaveLength(2);
});
