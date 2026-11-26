// BUG-UG-DEMO-PRESIDENT-INVITE-PAGE-BLANK-20261124 (#9775), through
// the whole app: a demo President session on the SAMPLE origin opens
// /m/vp/invitations to the demo sentence and the chapter's invitations, with
// no form; a real President session on the live backend gets the form. Modelled
// on bootSampleLiveApp in tests/sample-prod-parity.test.jsx.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, within } from "@testing-library/react";
import { samplePersonaForHat } from "../src/lib/sampleBackend.js";
import { currentLegalVersions } from "../src/lib/legalInstruments.js";
import { PORTAL_HOST, SAMPLE_HOST } from "./helpers/fictional-provider.js";

// The official service's hosts are not in this edition; the fictional provider stands in.
vi.mock("../src/lib/trustedBackends.js", async () => (await import("./helpers/fictional-provider.js")).trustedBackendsModule());

function tokenWithEmail(email) {
  const payload = Buffer.from(JSON.stringify({ email, session_id: "11111111-1111-4111-8111-111111111111" })).toString("base64url");
  return `header.${payload}.signature`;
}

function withLocation(hostname, pathname, run) {
  const previous = window.location;
  const previousHref = previous.href;
  window.history.replaceState({}, "", `${pathname}?shell=classic`);
  Object.defineProperty(window, "location", {
    configurable: true,
    value: { ...previous, hostname, get search() { return previous.search; }, get pathname() { return previous.pathname; }, get hash() { return previous.hash; } },
  });
  return Promise.resolve().then(run).finally(() => {
    Object.defineProperty(window, "location", { configurable: true, value: previous });
    window.history.replaceState({}, "", previousHref);
  });
}

const chapter = { id: "tv-alder-falls", name: "Alder Falls Residential", grantsAccess: false };
const invitation = { id: "44444444-4444-4444-8444-444444444444", kind: "provision", fullName: "Rosa Delgado", normalizedEmail: "rosa.delgado@example.test", chapterId: chapter.id, chapterName: chapter.name, initialRole: null, locale: "en", status: "pending", deliveryVersion: 1, createdAt: "2026-11-20T15:00:00Z", expiresAt: "2026-12-04T15:00:00Z" };

async function bootApp(kind, session) {
  vi.doUnmock("../src/lib/demoVoiceParity.js");
  vi.stubGlobal("fetch", vi.fn(() => { throw new Error("No request leaves the test"); }));
  const chain = { on: () => chain, subscribe: () => chain, unsubscribe: () => {} };
  const rpc = vi.fn(async (name) => {
    if (name === "get_my_legal_acceptance_state") return { data: { versions: currentLegalVersions(), acceptedAt: null }, error: null };
    if (name === "get_member_invitations") return { data: { chapter, chapters: [chapter], items: [invitation] }, error: null };
    return { data: [], error: null };
  });
  const client = {
    rpc,
    auth: {
      getSession: async () => ({ data: { session }, error: null }),
      onAuthStateChange: () => ({ data: { subscription: { unsubscribe() {} } } }),
      signOut: vi.fn(async () => ({ error: null })),
      mfa: {
        listFactors: async () => ({ data: { all: [{ id: "proof-factor", factor_type: "totp", status: "verified" }], totp: [{ id: "proof-factor", factor_type: "totp", status: "verified" }] }, error: null }),
        getAuthenticatorAssuranceLevel: async () => ({ data: { currentLevel: "aal2", nextLevel: "aal2" }, error: null }),
      },
    },
    channel: () => chain,
    removeChannel() {},
  };
  const sample = kind === "sample";
  vi.doMock("../src/lib/supabase.js", () => ({
    supabase: sample ? null : client, hasSupabaseConfig: !sample,
    sampleSupabase: sample ? client : null, hasSampleSupabaseConfig: sample,
    appSupabase: client, hasAppBackend: true, appBackendKind: kind, appBackendIsSampleProject: sample,
    appAuthStorageKey: `${kind}-auth-storage`, appAuthStorageUnavailable: false,
    appAuthSessionIsClosed: () => false,
    authStorageAdapter: () => globalThis.localStorage,
    clearCapturedAppSessionLocally: vi.fn(async () => true),
    clearRefusedAppSessionLocally: vi.fn(async () => true),
    createCapturedAppSessionRpcClient: () => client,
    verifyCapturedAppSession: async () => ({ data: { user: session.user }, error: null }),
  }));
  const { fallbackData } = await import("./fixtures/retired-pre-bot/src/data/fallback.js");
  vi.doMock("../src/lib/memberApi.js", async (importOriginal) => ({
    ...(await importOriginal()),
    loadMemberApp: vi.fn(async (_client, user) => ({
      ...fallbackData,
      member: { ...fallbackData.member, id: user.id, email: user.email, chapterRoles: ["vp"], fullName: "Fictional President", firstName: "Fictional", organizationId: "fictional-org", chapterId: chapter.id, membershipStatus: "active" },
      roles: ["vp"],
    })),
  }));
  const { App } = await import("../src/App.jsx");
  return { App, rpc };
}

describe("the President's Invite a worker page in the whole app", () => {
  beforeEach(() => { vi.resetModules(); cleanup(); vi.stubEnv("MODE", "production"); });
  afterEach(() => { cleanup(); vi.unstubAllEnvs(); vi.unstubAllGlobals(); vi.doUnmock("../src/lib/supabase.js"); vi.doUnmock("../src/lib/memberApi.js"); });

  it("opens a demo President session to the demo sentence and the chapter's invitations, with no form", async () => {
    const president = samplePersonaForHat("vp");
    const session = { user: { id: "persona-vp", email: president.email }, access_token: tokenWithEmail(president.email) };
    await withLocation(SAMPLE_HOST, "/m/vp/invitations", async () => {
      const { App, rpc } = await bootApp("sample", session);
      render(<App />);
      const region = await screen.findByRole("region", { name: "Invite a worker" }, { timeout: 8000 });
      expect(within(region).getByText("This demo does not send invitations.")).toBeVisible();
      expect(await within(region).findByText("Rosa Delgado")).toBeVisible();
      expect(within(region).queryByRole("button", { name: "Send invitation" })).toBeNull();
      expect(within(region).queryByRole("button", { name: "Resend" })).toBeNull();
      expect(rpc).toHaveBeenCalledWith("get_member_invitations", { p_limit: 50 });
    });
  }, 20000);

  it("gives a real President session on the live backend the invitation form", async () => {
    const email = "fictional.president@example.test";
    const session = { user: { id: "real-vp", email }, access_token: tokenWithEmail(email) };
    await withLocation(PORTAL_HOST, "/m/vp/invitations", async () => {
      const { App } = await bootApp("live", session);
      render(<App />);
      const region = await screen.findByRole("region", { name: "Invite a worker" }, { timeout: 8000 });
      expect(await within(region).findByRole("button", { name: "Send invitation" })).toBeVisible();
      expect(within(region).queryByText("This demo does not send invitations.")).toBeNull();
      expect(within(region).getByText("Rosa Delgado")).toBeVisible();
    });
  }, 20000);
});
