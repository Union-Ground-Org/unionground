import { render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "../src/App.jsx";
import { fallbackData } from "./fixtures/retired-pre-bot/src/data/fallback.js";
import { primeDemoData } from "../src/data/demoData.js";
import { MemberOperations } from "../src/features/memberOperations/MemberOperations.jsx";

const { rpc } = vi.hoisted(() => ({ rpc: vi.fn() }));
// This hat-projection test boots the historical UI fixture, whose session has
// no real bearer. Supply its explicit writer fixture; real Auth-lock races are
// covered by web-online-writer-app.session.test.jsx.
vi.mock("../src/lib/sessionBoundWriter.js", async (original) => {
  const actual = await original();
  return { ...actual, createSessionBoundWriter(options) {
    const session = { ...options.session, access_token: "fixture-only-token" };
    return actual.createSessionBoundWriter({ ...options, session, sharedClient: { auth: { getSession: async () => ({ data: { session }, error: null }) } } });
  } };
});
vi.mock("../src/lib/supabase.js", async (original) => ({
  ...await original(),
  appSupabase: { rpc },
  createCapturedAppSessionRpcClient: () => ({ rpc }),
}));
// Isolate the unrelated Admin desk loader while exercising App's real route,
// selected hat and actor projection into the real MemberOperations component.
vi.mock("../src/views/AdminView.jsx", () => ({
  AdminView: ({ memberOperationsActor, memberOperationsClient }) => <>
    <h1>{memberOperationsActor.selectedHat} desk</h1>
    <MemberOperations actor={memberOperationsActor} client={memberOperationsClient} />
  </>,
}));

beforeEach(() => {
  window.history.replaceState({}, "", "/m/admin/member-operations/directory");
  window.scrollTo = vi.fn();
  vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("offline fixture")));
  rpc.mockReset().mockResolvedValue({ data: { state: "ready", organizationId: "fixture-org", directory: { items: [] } } });
});
afterEach(() => { primeDemoData(fallbackData); vi.unstubAllGlobals(); });

function boot(organizationRoles) {
  primeDemoData({ ...fallbackData, roles: ["admin"], member: {
    ...fallbackData.member,
    organizationId: "fixture-org",
    organizationRoles,
    chapterRoles: ["admin"],
    membershipStatus: "active",
  } });
  render(<App />);
}

describe("App member-operations hat and scope wiring", () => {
  it("preserves the canonical authorized Admin desk entrance and loads the directory", async () => {
    boot(["admin"]);
    expect(await screen.findByRole("heading", { name: "admin desk" })).toBeInTheDocument();
    expect(await screen.findByRole("heading", { name: "Worker directory" })).toBeInTheDocument();
    expect(window.location.pathname).toBe("/m/admin/member-operations/directory");
    expect(rpc).toHaveBeenCalledWith("get_member_operations_workspace", undefined);
  });

  it("does not promote a chapter-only Admin into organization member operations", async () => {
    boot([]);
    expect(await screen.findByRole("heading", { name: "admin desk" })).toBeInTheDocument();
    expect(await screen.findByText(/Worker operations access could not be verified/)).toBeInTheDocument();
    expect(rpc).not.toHaveBeenCalledWith("get_member_operations_workspace", undefined);
    expect(screen.queryByRole("heading", { name: "Worker directory" })).not.toBeInTheDocument();
  });
});
