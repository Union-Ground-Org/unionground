import { render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

// Gate round 2 on #7004 (r2g1, r2s1): the way to a new stop-updates link must
// not depend on which root page a visitor would see. /stop-updates is a
// standalone route outside the member app, so a signed-in visitor and one
// whose tab just signed out both get the request form there.
const session = {
  access_token: `header.${btoa(JSON.stringify({ session_id: "10000000-0000-4000-8000-000000000001" }))}.sig`,
  refresh_token: "test-refresh-token",
  user: { id: "00000000-0000-4000-8000-000000007004", email: "member@example.test", app_metadata: { roles: ["member"] }, user_metadata: {} },
};
const auth = vi.hoisted(() => ({ session: null }));
const supabase = {
  auth: {
    getSession: vi.fn(async () => ({ data: { session: auth.session }, error: null })),
    onAuthStateChange: vi.fn(() => ({ data: { subscription: { unsubscribe: vi.fn() } } })),
    signOut: vi.fn().mockResolvedValue({ error: null }),
  },
  realtime: { setAuth: vi.fn().mockResolvedValue(undefined) },
  rpc: vi.fn().mockResolvedValue({ data: null, error: null }),
};

vi.mock("../src/lib/supabase.js", () => ({
  appBackendKind: "live",
  appBackendIsSampleProject: false,
  appAuthStorageKey: "test-auth-key",
  appAuthStorageUnavailable: false,
  appAuthSessionIsClosed: () => false,
  authStorageAdapter: () => localStorage,
  clearCapturedAppSessionLocally: vi.fn().mockResolvedValue(true),
  createCapturedAppSessionRpcClient: vi.fn(() => ({ rpc: vi.fn().mockResolvedValue({ data: null, error: null }) })),
  verifyCapturedAppSession: vi.fn(),
  hasAppBackend: true,
  appSupabase: supabase,
  supabase,
}));

const { App } = await import("../src/AppRouter.jsx");

afterEach(() => {
  auth.session = null;
  window.sessionStorage.clear();
  window.history.replaceState({}, "", "/");
});

describe("stop-updates recovery for every visitor", () => {
  it.each([
    ["signed in", () => { auth.session = session; }],
    ["just signed out", () => { window.sessionStorage.setItem("test-auth-key.explicit-sign-out-visit", "1"); }],
    ["signed out", () => {}],
  ])("offers a new link on /stop-updates when the visitor is %s", async (_label, arrange) => {
    arrange();
    window.history.replaceState({}, "", "/stop-updates");
    render(<App />);
    expect(await screen.findByRole("heading", { level: 1, name: "Stop Union Ground public updates" })).toBeInTheDocument();
    expect(await screen.findByRole("button", { name: "Send me a new link" })).toBeInTheDocument();
    expect(screen.getByLabelText("Email to remove")).toBeInTheDocument();
    expect(document.querySelector('a[href="/#stop-updates"]')).toBeNull();
  });
});
