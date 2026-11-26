// SAMPLE retains backend isolation and authenticated sessions, but no shared-persona bootstrap.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  SAMPLE_BACKEND,
  defaultSamplePersona,
  isSamplePersonaEmail,
  samplePersonaForHat,
  samplePersonas,
  retireRefusedSession,
} from "../src/lib/sampleBackend.js";
import {
  boundedSampleFetch,
  SAMPLE_REQUEST_TIMEOUT_MS,
  SAMPLE_REST_REQUEST_TIMEOUT_MS,
} from "../src/lib/sampleRequest.js";
import {
  beginSampleHatChoice,
  createSampleHatTransitionQueue,
  resolveSampleHatRollback,
} from "../src/lib/sampleHatTransition.js";
import { STAFF_PLANES, planeRoles } from "../src/lib/staffPlanes.js";
import { PORTAL_HOST, SAMPLE_HOST, SUPABASE_ORIGIN, SUPABASE_REF } from "./helpers/fictional-provider.js";
import { DENIED_PRODUCTION_REF, deniedSupabaseOrigin } from "./helpers/denied-identity-fixtures.js";

// A fictional Union Ground backend pair, so the SaaS-origin client can be
// exercised; shipped code pins none.
vi.mock("../src/lib/trustedBackends.js", async () => (await import("./helpers/fictional-provider.js")).trustedBackendsModule());

// The visible boot copy and the Worker-home heading a fresh SAMPLE visit lands on.
const LOADING_COPY = /Loading Union Ground/;
const COMMITTEE_DESK = "Committee desk";
import { currentLegalVersions } from "../src/lib/legalInstruments.js";

const contract = JSON.parse(readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), "../config/sample-backend.json"),
  "utf8",
));

function withLocation(hostname, search, run, pathname = "/m") {
  const previous = window.location;
  const previousHref = previous.href;
  window.history.replaceState({}, "", `${pathname}${search}`);
  Object.defineProperty(window, "location", {
    configurable: true,
    value: { ...previous, hostname, get search() { return previous.search; }, get pathname() { return previous.pathname; }, get hash() { return previous.hash; } },
  });
  return Promise.resolve()
    .then(run)
    .finally(() => {
      Object.defineProperty(window, "location", { configurable: true, value: previous });
      window.history.replaceState({}, "", previousHref);
    });
}

describe("seeded demo personas", () => {
  it("recognizes exactly the public edition's seven fictional tour personas", () => {
    const addresses = [
      "darnell.foster@example.invalid", "elena.cruz@example.invalid", "maya.thompson@example.invalid",
      "andre.lewis@example.invalid", "priya.shah@example.invalid", "rosa.martinez@example.invalid",
      "jordan.kim@example.invalid",
    ];
    expect(samplePersonas().map((persona) => persona.email).sort()).toEqual([...addresses].sort());
    for (const email of addresses) expect(isSamplePersonaEmail(email)).toBe(true);
    for (const email of ["kayla.doyle@loadtest.demo.example.com", "member@example.org", "", null, undefined]) {
      expect(isSamplePersonaEmail(email)).toBe(false);
    }
  });

  it("keeps the JSON registry and the browser module in lockstep, without the seed password", () => {
    expect(contract.samplePersonas).toEqual(SAMPLE_BACKEND.samplePersonas.map((persona) => ({
      hat: persona.hat,
      email: persona.email,
      firstName: persona.firstName,
      fullName: persona.fullName,
      roles: [...persona.roles],
    })));
    // The persona password is seed machinery only; it never ships to the
    // browser (: no member-facing password path).
    expect(SAMPLE_BACKEND).not.toHaveProperty("samplePersonaPassword");
  });

  it("accepts exactly the retained fictional SAMPLE account domain, never a wildcard", () => {
    const fixture = JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), "fixtures/retired-pre-bot/stress/uniondemo-config.json"), "utf8"));
    expect(SAMPLE_BACKEND.sampleAccountEmailDomains).toEqual([fixture.emailDomain]);
    for (const domain of SAMPLE_BACKEND.sampleAccountEmailDomains) {
      expect(domain).toMatch(/^[a-z0-9-]+(\.[a-z0-9-]+)+$/);
      // A fictional account domain is never a real organization's or the SaaS host.
      expect(domain).not.toBe(PORTAL_HOST);
      expect(domain.endsWith(".unionground.net")).toBe(false);
    }
  });

  it("covers Worker plus every staff plane, each holding exactly its plane's role", () => {
    const hats = samplePersonas().map((persona) => persona.hat);
    expect(hats).toEqual(["member", ...STAFF_PLANES.map((plane) => plane.key)]);
    // A fresh preview visit wears Worker: the person taking a first organizing
    // step, holding no role row.
    expect(defaultSamplePersona().hat).toBe("member");
    expect(defaultSamplePersona().roles).toEqual([]);
    for (const plane of STAFF_PLANES) {
      // Every plane is worn by exactly one role. The organize plane is the
      // Organizer persona, which holds the organizer role row, never a staff role.
      expect(samplePersonaForHat(plane.key)?.roles).toEqual([planeRoles(plane)[0]]);
    }
    expect(samplePersonaForHat("organize").roles).toEqual(["organizer"]);
    // The native app's "organizer" hat key names the same persona.
    expect(samplePersonaForHat("organizer")).toBe(samplePersonaForHat("organize"));
    expect(samplePersonaForHat("not-a-hat")).toBeNull();
  });

  it("carries no SAMPLE or PREVIEW labels in any user-visible persona field", () => {
    for (const persona of samplePersonas()) {
      expect(persona.fullName).not.toMatch(/sample|preview/i);
      expect(persona.firstName).not.toMatch(/sample|preview/i);
      expect(persona.email).not.toMatch(/sample|preview/i);
    }
  });
});

describe("SAMPLE hat transition coordination", () => {
  const hats = [
    { key: "member", view: "today", path: "/m" },
    ...STAFF_PLANES,
  ];

  it("derives overlapping rollback from the authenticated persona rather than optimistic selection", () => {
    expect(resolveSampleHatRollback({
      selectedHat: "coordinator",
      // The Committee-desk (steward) persona from Union Ground's own
      // fictional SAMPLE registry, never a sibling-product address.
      currentEmail: samplePersonaForHat("steward").email,
      currentView: "coordinator",
      currentPath: "/m/coordinator?demo=1",
      demo: true,
      personas: [{ hat: "steward", email: samplePersonaForHat("steward").email }],
      hats,
    })).toEqual({
      previousHat: "steward",
      previousView: "steward",
      previousPath: "/m/steward?demo=1",
    });
  });

  it("supersedes an older mint even when the final choice needs no new authentication", () => {
    const sequenceRef = { current: 0 };
    const abandonedMint = beginSampleHatChoice(sequenceRef);
    const returnToAuthenticatedHat = beginSampleHatChoice(sequenceRef);
    expect(abandonedMint.stillWanted()).toBe(false);
    expect(returnToAuthenticatedHat.stillWanted()).toBe(true);
    expect(returnToAuthenticatedHat.sequence).toBe(2);
  });

  it("serializes an in-flight verification so the latest choice repairs its session side effect", async () => {
    const queue = createSampleHatTransitionQueue();
    const sequenceRef = { current: 0 };
    const firstChoice = beginSampleHatChoice(sequenceRef);
    let releaseFirst;
    let markFirstStarted;
    const firstStarted = new Promise((resolve) => { markFirstStarted = resolve; });
    let authenticatedHat = "steward";

    const first = queue.enqueue(async () => {
      if (!firstChoice.stillWanted()) return;
      markFirstStarted();
      await new Promise((resolve) => { releaseFirst = resolve; });
      // Models verifyOtp: once begun, this side effect cannot be cancelled.
      authenticatedHat = "coordinator";
    });
    await firstStarted;
    const latestChoice = beginSampleHatChoice(sequenceRef);
    const latest = queue.enqueue(async () => {
      if (!latestChoice.stillWanted()) return;
      expect(authenticatedHat).toBe("coordinator");
      authenticatedHat = "steward";
    });

    releaseFirst();
    await Promise.all([first, latest]);
    expect(authenticatedHat).toBe("steward");
  });
});

describe("resolved app client", () => {
  beforeEach(() => vi.resetModules());

  it("resolves no client on the demo origin while no SAMPLE project is pinned, never the production client", async () => {
    // Union Ground pins no SAMPLE project (config/sample-backend.json), so a
    // SAMPLE env naming any project still builds no SAMPLE client, and the demo
    // origin never falls back to the production client.
    vi.stubEnv("VITE_UNIONGROUND_SUPABASE_REF", SUPABASE_REF);
    vi.stubEnv("VITE_SUPABASE_URL", SUPABASE_ORIGIN);
    vi.stubEnv("VITE_SUPABASE_PUBLISHABLE_KEY", "sb_publishable_fixturekey0001");
    vi.stubEnv("VITE_SAMPLE_SUPABASE_URL", "https://psgfixturesample.supabase.co");
    vi.stubEnv("VITE_SAMPLE_SUPABASE_PUBLISHABLE_KEY", "sample-publishable");
    try {
      await withLocation(SAMPLE_HOST, "", async () => {
        const mod = await import("../src/lib/supabase.js");
        expect(mod.supabase).toBeNull();
        expect(mod.hasSupabaseConfig).toBe(false);
        expect(mod.sampleSupabase).toBeNull();
        expect(mod.hasSampleSupabaseConfig).toBe(false);
        expect(mod.appSupabase).toBeNull();
        expect(mod.appBackendKind).toBeNull();
        expect(mod.hasAppBackend).toBe(false);
      });
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("aborts a stalled SAMPLE request at a finite deadline", async () => {
    const stalledFetch = vi.fn((_input, init) => new Promise((_resolve, reject) => {
      init.signal.addEventListener("abort", () => reject(init.signal.reason), { once: true });
    }));
    vi.stubGlobal("fetch", stalledFetch);
    try {
      await expect(boundedSampleFetch("https://sample.invalid/rest/v1/member", {}, 5))
        .rejects.toMatchObject({ name: "TimeoutError", message: "Request timed out" });
      expect(stalledFetch).toHaveBeenCalledOnce();
      expect(stalledFetch.mock.calls[0][1].signal.aborted).toBe(true);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it.each([
    ["an absolute demo-session URL", `https://${SAMPLE_HOST}/api/demo-session`],
    ["the Supabase verify endpoint", "https://sample.invalid/auth/v1/verify"],
  ])("bounds %s", async (_label, url) => {
    const stalledFetch = vi.fn((_input, init) => new Promise((_resolve, reject) => {
      init.signal.addEventListener("abort", () => reject(init.signal.reason), { once: true });
    }));
    vi.stubGlobal("fetch", stalledFetch);
    try {
      await expect(boundedSampleFetch(url, {}, 5)).rejects.toMatchObject({ name: "TimeoutError" });
      expect(stalledFetch.mock.calls[0][1].signal.aborted).toBe(true);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("gives ordinary SAMPLE REST fan-out a longer finite deadline", async () => {
    const stalledFetch = vi.fn((_input, init) => new Promise((_resolve, reject) => {
      init.signal.addEventListener("abort", () => reject(init.signal.reason), { once: true });
    }));
    vi.stubGlobal("fetch", stalledFetch);
    vi.useFakeTimers();
    try {
      const pending = boundedSampleFetch("https://sample.invalid/rest/v1/member");
      const rejection = expect(pending).rejects.toMatchObject({ name: "TimeoutError" });
      await vi.advanceTimersByTimeAsync(SAMPLE_REQUEST_TIMEOUT_MS);
      expect(stalledFetch.mock.calls[0][1].signal.aborted).toBe(false);
      await vi.advanceTimersByTimeAsync(SAMPLE_REST_REQUEST_TIMEOUT_MS - SAMPLE_REQUEST_TIMEOUT_MS);
      await rejection;
      expect(stalledFetch.mock.calls[0][1].signal.aborted).toBe(true);
    } finally {
      vi.useRealTimers();
      vi.unstubAllGlobals();
    }
  });

  it("keeps the deadline active when headers arrive but the SAMPLE body stalls", async () => {
    const stalledBodyFetch = vi.fn((_input, init) => Promise.resolve(new Response(new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('{"partial":'));
        init.signal.addEventListener("abort", () => controller.error(init.signal.reason), { once: true });
      },
    }), {
      headers: { "Content-Type": "application/json" },
      status: 200,
    })));
    vi.stubGlobal("fetch", stalledBodyFetch);
    try {
      await expect(boundedSampleFetch("https://sample.invalid/rest/v1/member", {}, 5))
        .rejects.toMatchObject({ name: "TimeoutError" });
      expect(stalledBodyFetch).toHaveBeenCalledOnce();
      expect(stalledBodyFetch.mock.calls[0][1].signal.aborted).toBe(true);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("returns a reusable buffered response with its fetch metadata intact", async () => {
    const source = new Response('{"member":"ready"}', {
      headers: { "Content-Type": "application/json" },
      status: 201,
      statusText: "Created",
    });
    Object.defineProperties(source, {
      redirected: { configurable: true, value: true },
      type: { configurable: true, value: "cors" },
      url: { configurable: true, value: "https://sample.invalid/rest/v1/member" },
    });
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(source));
    try {
      const response = await boundedSampleFetch("https://sample.invalid/rest/v1/member", {}, 500);
      expect(response).not.toBe(source);
      expect(response.status).toBe(201);
      expect(response.statusText).toBe("Created");
      expect(response.headers.get("Content-Type")).toBe("application/json");
      expect(response.redirected).toBe(true);
      expect(response.type).toBe("cors");
      expect(response.url).toBe("https://sample.invalid/rest/v1/member");
      await expect(response.json()).resolves.toEqual({ member: "ready" });
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("rebuilds a body-forbidden successful response without inventing a body", async () => {
    const source = new Response(null, { status: 204 });
    // A transport shim may expose a readable zero-byte body even though the
    // status forbids one. Model that edge so reconstruction cannot turn an
    // already-completed mutation into a client-side TypeError.
    Object.defineProperties(source, {
      body: { configurable: true, value: new ReadableStream() },
      arrayBuffer: { configurable: true, value: vi.fn().mockResolvedValue(new ArrayBuffer(0)) },
    });
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(source));
    try {
      const response = await boundedSampleFetch("https://sample.invalid/rest/v1/member", {}, 500);
      expect(response.status).toBe(204);
      expect(response.body).toBeNull();
      await expect(response.text()).resolves.toBe("");
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it.each([
    ["Storage", "https://sample.invalid/storage/v1/object/member-files/document.pdf", "document bytes"],
    ["Functions", "https://sample.invalid/functions/v1/compass", '{"answer":"ready"}'],
  ])("does not buffer or impose the short JSON deadline on SAMPLE %s transfers", async (_label, url, payload) => {
    const source = new Response(payload, {
      headers: { "Content-Type": "application/octet-stream" },
      status: 200,
    });
    const storageFetch = vi.fn().mockResolvedValue(source);
    vi.stubGlobal("fetch", storageFetch);
    const transfer = new AbortController();
    try {
      const response = await boundedSampleFetch(
        url,
        { signal: transfer.signal },
        1,
      );
      expect(response).toBe(source);
      expect(storageFetch).toHaveBeenCalledWith(
        url,
        { signal: transfer.signal },
      );
      expect(transfer.signal.aborted).toBe(false);
      await expect(response.text()).resolves.toBe(payload);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("preserves caller cancellation while applying the SAMPLE deadline", async () => {
    const stalledFetch = vi.fn((_input, init) => new Promise((_resolve, reject) => {
      init.signal.addEventListener("abort", () => reject(init.signal.reason), { once: true });
    }));
    vi.stubGlobal("fetch", stalledFetch);
    const request = new AbortController();
    const cancellation = new DOMException("visitor left", "AbortError");
    try {
      const pending = boundedSampleFetch(
        "https://sample.invalid/rest/v1/member",
        { signal: request.signal },
        5_000,
      );
      request.abort(cancellation);
      await expect(pending).rejects.toBe(cancellation);
      expect(stalledFetch.mock.calls[0][1].signal.aborted).toBe(true);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("resolves to the production client on the SaaS origin with no SAMPLE client at all", async () => {
    vi.stubEnv("VITE_UNIONGROUND_SUPABASE_REF", SUPABASE_REF);
    vi.stubEnv("VITE_SUPABASE_URL", SUPABASE_ORIGIN);
    vi.stubEnv("VITE_SUPABASE_PUBLISHABLE_KEY", "sb_publishable_fixturekey0001");
    vi.stubEnv("VITE_SAMPLE_SUPABASE_URL", "https://psgfixturesample.supabase.co");
    vi.stubEnv("VITE_SAMPLE_SUPABASE_PUBLISHABLE_KEY", "sample-publishable");
    try {
      await withLocation(PORTAL_HOST, "", async () => {
        const mod = await import("../src/lib/supabase.js");
        expect(mod.supabase).not.toBeNull();
        expect(mod.sampleSupabase).toBeNull();
        expect(mod.appSupabase).toBe(mod.supabase);
        expect(mod.appBackendKind).toBe("live");
      });
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("gives the production client the same JSON REST deadline as SAMPLE without bounding Storage", async () => {
    const source = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "../src/lib/supabase.js"), "utf8");
    const liveClient = source.slice(source.indexOf("export const supabase ="), source.indexOf("export const sampleSupabase"));
    const sampleClient = source.slice(source.indexOf("export const sampleSupabase"));
    expect(liveClient).toContain("fetch: guardedFetch(boundedSampleFetch),");
    expect(sampleClient).toContain("fetch: guardedFetch(boundedSampleFetch),");
    // Passkey sign-in is left out of Union Ground: no client routes through
    // a passkey proxy.
    expect(source).not.toContain("routePasskeySignInThroughProxy");
    const stalledFetch = vi.fn((_input, init) => new Promise((_resolve, reject) => {
      init.signal.addEventListener("abort", () => reject(init.signal.reason), { once: true });
    }));
    vi.stubGlobal("fetch", stalledFetch);
    try {
      await expect(boundedSampleFetch(`${SUPABASE_ORIGIN}/rest/v1/member`, {}, 5))
        .rejects.toMatchObject({ name: "TimeoutError" });
      const storageSource = new Response("document bytes", { status: 200 });
      stalledFetch.mockResolvedValueOnce(storageSource);
      const storage = await boundedSampleFetch(
        `${SUPABASE_ORIGIN}/storage/v1/object/member-files/document.pdf`,
        {},
        1,
      );
      expect(storage).toBe(storageSource);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("resolves to no client when the demo origin's SAMPLE env names a forbidden ref", async () => {
    vi.stubEnv("VITE_SAMPLE_SUPABASE_URL", deniedSupabaseOrigin(DENIED_PRODUCTION_REF));
    vi.stubEnv("VITE_SAMPLE_SUPABASE_PUBLISHABLE_KEY", "sample-publishable");
    try {
      await withLocation(SAMPLE_HOST, "", async () => {
        const mod = await import("../src/lib/supabase.js");
        expect(mod.appSupabase).toBeNull();
        expect(mod.hasAppBackend).toBe(false);
        expect(mod.appBackendKind).toBeNull();
      });
    } finally {
      vi.unstubAllEnvs();
    }
  });
});

// An access token whose payload carries the given email claim (unsigned; the
// app reads the claim only to compare it with the stored email).
function tokenWithEmail(email) {
  const payload = Buffer.from(JSON.stringify({ email, session_id: "11111111-1111-4111-8111-111111111111" })).toString("base64url");
  return `header.${payload}.signature`;
}

describe("SAMPLE shared-persona retirement", () => {
  beforeEach(() => { vi.resetModules(); cleanup(); });
  afterEach(() => { vi.unstubAllEnvs(); localStorage.removeItem("unionground-lang"); });

  async function bootSampleLiveApp(session = null, restore = Promise.resolve(), roles = [], { clearThrows = false, clearResult = true, member = {}, mfa = false } = {}) {
    vi.doUnmock("../src/lib/demoVoiceParity.js");
    // The refusal on the retired host must run the same device-residue sweep a
    // departed session gets, and must survive a synchronous storage throw.
    const forgetDepartedMemberDevice = vi.fn(async () => undefined);
    vi.doMock("../src/lib/outbox.js", async (importOriginal) => ({ ...(await importOriginal()), forgetDepartedMemberDevice }));
    const fetchMock = vi.fn(() => { throw new Error("No persona endpoint may be contacted"); });
    vi.stubGlobal("fetch", fetchMock);
    const clearLocally = clearThrows
      ? vi.fn(() => { throw new Error("storage quota exceeded"); })
      : vi.fn(async () => clearResult);
    const verifyOtp = vi.fn(() => { throw new Error("No shared token may be verified"); });
    const clientSignOut = vi.fn(async () => ({ error: null }));
    const adminSignOut = vi.fn(async () => ({ data: null, error: null }));
    const chain = { on: () => chain, subscribe: () => chain, unsubscribe: () => {} };
    const client = {
      // A retained member who already accepted the current terms: the web app
      // withholds every view from one who has not (BUG-UNIONGROUND-WEB-LEGAL-
      // REACCEPTANCE-NOT-BLOCKING-20261018), and these cases are about Campaigns.
      rpc: vi.fn(async (name) => (name === "get_my_legal_acceptance_state"
        ? { data: { versions: currentLegalVersions(), acceptedAt: null }, error: null }
        : { data: [], error: null })),
      auth: {
        getSession: async () => { await restore; return { data: { session }, error: null }; },
        onAuthStateChange: () => ({ data: { subscription: { unsubscribe() {} } } }),
        signOut: clientSignOut,
        admin: { signOut: adminSignOut },
        verifyOtp,
        // Staff accounts clear their second factor before a desk opens; the
        // persona and member cases leave this unset as before.
        mfa: mfa ? {
          listFactors: async () => ({ data: { all: [{ id: "proof-factor", factor_type: "totp", status: "verified" }], totp: [{ id: "proof-factor", factor_type: "totp", status: "verified" }] }, error: null }),
          getAuthenticatorAssuranceLevel: async () => ({ data: { currentLevel: "aal2", nextLevel: "aal2" }, error: null }),
        } : {
          listFactors: async () => ({ data: { all: [], totp: [] }, error: null }),
          getAuthenticatorAssuranceLevel: async () => ({ data: { currentLevel: "aal1", nextLevel: "aal1" }, error: null }),
        },
      },
      channel: () => chain,
      removeChannel() {},
    };
    vi.doMock("../src/lib/supabase.js", () => ({
      supabase: null, hasSupabaseConfig: false,
      sampleSupabase: client, hasSampleSupabaseConfig: true,
      appSupabase: client, hasAppBackend: true, appBackendKind: "sample", appBackendIsSampleProject: true,
      appAuthStorageKey: "sample-auth-storage", appAuthStorageUnavailable: false,
      appAuthSessionIsClosed: () => false,
      authStorageAdapter: () => globalThis.localStorage,
      clearCapturedAppSessionLocally: vi.fn(async () => { throw new Error("The refusal must use the refusal-only clear"); }),
      clearRefusedAppSessionLocally: clearLocally,
      createCapturedAppSessionRpcClient: () => client,
      verifyCapturedAppSession: async () => ({ data: { user: session?.user ?? null }, error: null }),
    }));
    const { fallbackData } = await import("./fixtures/retired-pre-bot/src/data/fallback.js");
    const loadMemberApp = vi.fn(async (_client, user) => ({
      ...fallbackData,
      member: { ...fallbackData.member, ...member, id: user.id, email: user.email, chapterRoles: roles },
      roles,
    }));
    vi.doMock("../src/lib/memberApi.js", async (importOriginal) => ({
      ...(await importOriginal()), loadMemberApp,
    }));
    const { App } = await import("../src/App.jsx");
    return { App, client, fetchMock, verifyOtp, loadMemberApp, clearLocally, clientSignOut, adminSignOut, forgetDepartedMemberDevice };
  }

  // BUG-UG-DEMO-HOST-SIGNED-OUT-DEAD-END-20261106: a fresh visit is
  // presented with the sign-in screen for the fictional SAMPLE accounts, never
  // a retirement notice or a minted persona; its way back leads to the public
  // site on the portal origin, not to a SaaS landing page on the demo host.
  it.each([
    ["test", "en", "Sign in to Union Ground"],
    ["production", "en", "Sign in to Union Ground"],
    ["test", "es", "Inicia sesión en Union Ground"],
    ["production", "es", "Inicia sesión en Union Ground"],
  ])("offers sign-in on a fresh SAMPLE visit in %s/%s without minting a persona", async (mode, locale, title) => {
    vi.stubEnv("MODE", mode);
    localStorage.setItem("unionground-lang", locale);
    await withLocation("localhost", "?demo=1", async () => {
      const { App, fetchMock, verifyOtp, loadMemberApp } = await bootSampleLiveApp();
      const { loadLanguage } = await import("../src/lib/i18n.js");
      await loadLanguage(locale);
      render(<App />);
      expect(await screen.findByRole("heading", { name: title, level: 1 })).toBeInTheDocument();
      expect(screen.queryByText(/retired|retirado/i)).toBeNull();
      expect(document.documentElement.lang).toBe(locale);
      expect(fetchMock.mock.calls.map(([url]) => String(url)).filter((url) => url.includes("demo-session"))).toEqual([]);
      expect(verifyOtp).not.toHaveBeenCalled();
      expect(loadMemberApp).not.toHaveBeenCalled();
      const assign = vi.fn();
      window.location.assign = assign;
      const back = document.querySelector(".sgauth-back");
      expect(back).not.toBeNull();
      fireEvent.click(back);
      expect(assign).toHaveBeenCalledWith("/");
      expect(screen.getByRole("heading", { name: title, level: 1 })).toBeInTheDocument();
    });
  });

  it.each([
    ["en", "Sign in to Union Ground", "Sign in | Union Ground"],
    ["es", "Inicia sesión en Union Ground", "Inicia sesión | Union Ground"],
  ])("names the signed-out member entry in the browser tab (%s)", async (locale, heading, title) => {
    vi.stubEnv("MODE", "production");
    localStorage.setItem("unionground-lang", locale);
    document.title = "stale";
    await withLocation(SAMPLE_HOST, "", async () => {
      const { App } = await bootSampleLiveApp();
      const { App: RoutedApp } = await import("../src/AppRouter.jsx");
      expect(RoutedApp).not.toBe(App);
      const { loadLanguage } = await import("../src/lib/i18n.js");
      await loadLanguage(locale);
      render(<RoutedApp />);
      expect(await screen.findByRole("heading", { name: heading, level: 1 })).toBeInTheDocument();
      await waitFor(() => expect(document.title).toBe(title));
      expect(document.head.querySelector('link[rel="canonical"]')).toBeNull();
    }, "/m");
  });

  // UB-UG-DEMO-STRAIGHT-IN-ENTRY-RESTORED-20261107 (OWNER-DECISION-
  // 20261107-0946): the sign-in screen leads with a credentials-free entry
  // that mints the default hat's Tamarack persona session server-side.
  it.each([
    ["en", "Explore the demo\u00a0— no account needed"],
    ["es", "Explora la demostración\u00a0— sin cuenta"],
  ])("enters the SAMPLE demo with one action and no credentials (%s)", async (locale, label) => {
    localStorage.setItem("unionground-lang", locale);
    await withLocation(SAMPLE_HOST, "", async () => {
      const { App, client, fetchMock, verifyOtp, loadMemberApp } = await bootSampleLiveApp();
      const { loadLanguage } = await import("../src/lib/i18n.js");
      await loadLanguage(locale);
      fetchMock.mockImplementation(async () => new Response(JSON.stringify({ accessToken: "persona-access", refreshToken: "persona-refresh" }), { status: 200, headers: { "content-type": "application/json" } }));
      const setSession = vi.fn(async () => ({ data: {}, error: null }));
      client.auth.setSession = setSession;
      render(<App />);
      const entry = await screen.findByRole("button", { name: label });
      expect(screen.queryByRole("textbox", { name: /password/i })).toBeNull();
      expect(loadMemberApp).not.toHaveBeenCalled();
      fireEvent.click(entry);
      await waitFor(() => expect(setSession).toHaveBeenCalledWith({ access_token: "persona-access", refresh_token: "persona-refresh" }));
      expect(verifyOtp).not.toHaveBeenCalled();
      const mints = fetchMock.mock.calls.filter(([url]) => String(url).includes("demo-session"));
      expect(mints).toHaveLength(1);
      const [url, init] = mints[0];
      expect(String(url)).toBe("/api/demo-session");
      expect(init.method).toBe("POST");
      expect(JSON.parse(init.body)).toEqual({ hat: "member" });
      expect(init.body).not.toMatch(/@|password/i);
    }, "/");
  });

  it("reports a failed demo entry on the sign-in screen without verifying anything", async () => {
    localStorage.setItem("unionground-lang", "en");
    await withLocation(SAMPLE_HOST, "", async () => {
      const { App, client, fetchMock } = await bootSampleLiveApp();
      fetchMock.mockImplementation(async () => new Response(JSON.stringify({ error: "persona-unavailable" }), { status: 503, headers: { "content-type": "application/json" } }));
      const setSession = vi.fn();
      client.auth.setSession = setSession;
      render(<App />);
      fireEvent.click(await screen.findByRole("button", { name: "Explore the demo\u00a0— no account needed" }));
      expect(await screen.findByText("The demo could not start. Check your connection and try again.")).toBeInTheDocument();
      expect(setSession).not.toHaveBeenCalled();
      // One retry for the shared single-use link race, then the failure.
      expect(fetchMock.mock.calls.filter(([url]) => String(url).includes("demo-session"))).toHaveLength(2);
      expect(screen.getByRole("heading", { name: "Sign in to Union Ground", level: 1 })).toBeInTheDocument();
    }, "/");
  });

  it("switches a persona session to another seeded hat by minting that hat's persona", async () => {
    const steward = samplePersonaForHat("steward");
    const session = { user: { id: "persona-steward", email: steward.email }, access_token: tokenWithEmail(steward.email) };
    await withLocation(SAMPLE_HOST, "?shell=classic", async () => {
      const { App, client, fetchMock } = await bootSampleLiveApp(session, Promise.resolve(), ["steward"]);
      let releaseMint;
      const mintHeld = new Promise((resolve) => { releaseMint = resolve; });
      fetchMock.mockImplementation(async () => {
        await mintHeld;
        return new Response(JSON.stringify({ accessToken: "admin-access", refreshToken: "admin-refresh" }), { status: 200, headers: { "content-type": "application/json" } });
      });
      const setSession = vi.fn(async () => ({ data: {}, error: null }));
      client.auth.setSession = setSession;
      render(<App />);
      await screen.findByTestId("campaigns-screen");
      const hats = screen.getByRole("combobox", { name: /switch role/i });
      expect([...hats.options].map((option) => option.value)).toEqual(["member", "organize", "steward", "coordinator", "advisor", "admin", "vp"]);
      fireEvent.change(hats, { target: { value: "admin" } });
      // UB-UG-DEMO-HAT-SWITCH-KEEPS-SWITCHER-IN-VIEW-20261107: while
      // the persona signs in, the wait names the hat being opened.
      expect(await screen.findByText("Opening the Admin view…")).toHaveAttribute("role", "status");
      expect(screen.queryByText("Loading Union Ground…")).toBeNull();
      releaseMint();
      await waitFor(() => expect(setSession).toHaveBeenCalledWith({ access_token: "admin-access", refresh_token: "admin-refresh" }));
      const mints = fetchMock.mock.calls.filter(([url]) => String(url).includes("demo-session"));
      expect(mints.map(([, init]) => JSON.parse(init.body))).toEqual([{ hat: "admin" }]);
    }, "/m/campaigns");
  });

  // Gate r1s1/r2s1 on: a hat switch the unsaved-work guard cancels
  // changes nothing: no persona sign-in, no loading gate, the same hat.
  it("leaves the persona, the hat and the screen alone when unsaved work cancels a hat switch", async () => {
    const steward = samplePersonaForHat("steward");
    const session = { user: { id: "persona-steward", email: steward.email }, access_token: tokenWithEmail(steward.email) };
    const cancel = (event) => event.preventDefault();
    window.addEventListener("sg:before-navigate", cancel);
    try {
      await withLocation(SAMPLE_HOST, "?shell=classic", async () => {
        const { App, client, fetchMock } = await bootSampleLiveApp(session, Promise.resolve(), ["steward"]);
        const setSession = vi.fn(async () => ({ data: {}, error: null }));
        client.auth.setSession = setSession;
        render(<App />);
        await screen.findByTestId("campaigns-screen");
        const hats = screen.getByRole("combobox", { name: /switch role/i });
        const before = hats.value;
        fireEvent.change(hats, { target: { value: "member" } });
        await act(async () => { await Promise.resolve(); });
        expect(fetchMock.mock.calls.filter(([url]) => String(url).includes("demo-session"))).toEqual([]);
        expect(setSession).not.toHaveBeenCalled();
        expect(screen.getByTestId("campaigns-screen")).toBeInTheDocument();
        expect(screen.getByRole("combobox", { name: /switch role/i }).value).toBe(before);
        expect(window.location.pathname).toBe("/m/campaigns");
      }, "/m/campaigns");
    } finally {
      window.removeEventListener("sg:before-navigate", cancel);
    }
  });

  // Gate r3s3/r4s3 on: a hat switch in flight is fenced to the persona
  // lineage; a newer non-persona sign-in (another tab) is never overwritten,
  // and the switch's own loading gate comes down.
  it("never adopts an in-flight hat switch over a newer non-persona sign-in", async () => {
    const steward = samplePersonaForHat("steward");
    const session = { user: { id: "persona-steward", email: steward.email }, access_token: tokenWithEmail(steward.email) };
    await withLocation(SAMPLE_HOST, "?shell=classic", async () => {
      const { App, client, fetchMock } = await bootSampleLiveApp(session, Promise.resolve(), ["steward"]);
      let release;
      fetchMock.mockImplementation((url) => (String(url).includes("demo-session")
        ? new Promise((resolve) => { release = () => resolve(new Response(JSON.stringify({ accessToken: "admin-access", refreshToken: "admin-refresh" }), { status: 200, headers: { "content-type": "application/json" } })); })
        : Promise.reject(new Error("unexpected request"))));
      let authChanged;
      client.auth.onAuthStateChange = (callback) => { authChanged = callback; return { data: { subscription: { unsubscribe() {} } } }; };
      const setSession = vi.fn(async () => ({ data: {}, error: null }));
      client.auth.setSession = setSession;
      render(<App />);
      await screen.findByTestId("campaigns-screen");
      fireEvent.change(screen.getByRole("combobox", { name: /switch role/i }), { target: { value: "admin" } });
      await waitFor(() => expect(release).toEqual(expect.any(Function)));
      const account = { user: { id: "org-account", email: "kayla.doyle@loadtest.demo.example.com" }, access_token: tokenWithEmail("kayla.doyle@loadtest.demo.example.com") };
      await act(async () => { authChanged("SIGNED_IN", account); });
      await act(async () => { release(); await new Promise((resolve) => setTimeout(resolve, 0)); });
      expect(setSession).not.toHaveBeenCalled();
      expect(screen.queryByText("Could not switch roles. Try again.")).toBeNull();
    }, "/m/campaigns");
  });

  // Gate r2s4 on: a sign-in that completes while the demo entry is in
  // flight wins; the late persona session is never adopted over it.
  it("never adopts a late demo session over a sign-in that completed meanwhile", async () => {
    localStorage.setItem("unionground-lang", "en");
    await withLocation(SAMPLE_HOST, "", async () => {
      const { App, client, fetchMock } = await bootSampleLiveApp();
      let release;
      fetchMock.mockImplementation((url) => (String(url).includes("demo-session")
        ? new Promise((resolve) => { release = () => resolve(new Response(JSON.stringify({ accessToken: "late-access", refreshToken: "late-refresh" }), { status: 200, headers: { "content-type": "application/json" } })); })
        : Promise.reject(new Error("unexpected request"))));
      let authChanged;
      client.auth.onAuthStateChange = (callback) => { authChanged = callback; return { data: { subscription: { unsubscribe() {} } } }; };
      const setSession = vi.fn(async () => ({ data: {}, error: null }));
      client.auth.setSession = setSession;
      render(<App />);
      fireEvent.click(await screen.findByRole("button", { name: "Explore the demo\u00a0— no account needed" }));
      await waitFor(() => expect(release).toEqual(expect.any(Function)));
      const account = { user: { id: "org-account", email: "kayla.doyle@loadtest.demo.example.com" }, access_token: tokenWithEmail("kayla.doyle@loadtest.demo.example.com") };
      await act(async () => { authChanged("SIGNED_IN", account); });
      await act(async () => { release(); await new Promise((resolve) => setTimeout(resolve, 0)); });
      expect(setSession).not.toHaveBeenCalled();
    }, "/");
  });

  it("loads an existing authenticated SAMPLE account through its real client", async () => {
    const session = { user: { id: "invited-member", email: "invited@example.com" }, access_token: "test-session" };
    await withLocation("localhost", "?demo=1", async () => {
      const { App, fetchMock, verifyOtp, loadMemberApp } = await bootSampleLiveApp(session);
      render(<App />);
      await waitFor(() => expect(loadMemberApp).toHaveBeenCalledWith(
        expect.objectContaining({ rpc: expect.any(Function) }), session.user, expect.anything(),
      ));
      expect(screen.queryByRole("heading", { name: "Sign in to Union Ground" })).not.toBeInTheDocument();
      expect(fetchMock).not.toHaveBeenCalled();
      expect(verifyOtp).not.toHaveBeenCalled();
    });
  });

  // The organizing edition offers no worker PIN or PIN step-up. Both
  // kinds of email-link session still load their own account.
  it.each([
    ["a seeded persona", "persona-member", () => samplePersonaForHat("member").email],
    ["a SAMPLE organization account", "org-account", () => "kayla.doyle@loadtest.demo.example.com"],
  ])("loads %s without consulting a retired PIN restriction", async (_label, id, email) => {
    localStorage.setItem("unionground-lang", "en");
    const address = email();
    const payload = Buffer.from(JSON.stringify({ email: address, session_id: "11111111-1111-4111-8111-111111111111", amr: [{ method: "magiclink", timestamp: 1 }] })).toString("base64url");
    const session = { user: { id, email: address }, access_token: `header.${payload}.signature` };
    await withLocation(SAMPLE_HOST, "?shell=classic", async () => {
      const { App, client, loadMemberApp } = await bootSampleLiveApp(session);
      const answer = client.rpc.getMockImplementation();
      client.rpc.mockImplementation(async (name, ...rest) => (name === "get_my_session_restriction"
        ? { data: null, error: { message: "canceling statement due to statement timeout" } }
        : answer(name, ...rest)));
      const { container } = render(<App />);
      await waitFor(() => expect(loadMemberApp).toHaveBeenCalled());
      await waitFor(() => expect(container.querySelector(".app-column, .ug-wrap, main")).not.toBeNull());
      expect(client.rpc).not.toHaveBeenCalledWith("get_my_session_restriction");
      expect(container.querySelector(".step-up-banner")).toBeNull();
    });
  });

  // BUG-UG-REMOVE-RETIRED-PREVIEW-INVITATION-20261020: on the retired
  // preview host a restored session that is not a seeded persona never loads
  // its account; restoration is still awaited without announcing retirement
  // early, and the retirement screen follows with nothing fetched.
  it("refuses a restored non-persona session on the retired preview host after restoration settles", async () => {
    const session = { user: { id: "retained-member", email: "retained@example.com" }, access_token: "test-session" };
    let finishRestore;
    const restore = new Promise((resolve) => { finishRestore = resolve; });
    await withLocation(SAMPLE_HOST, "?demo=1", async () => {
      const { App, client, loadMemberApp, fetchMock, clearLocally, clientSignOut, adminSignOut, forgetDepartedMemberDevice } = await bootSampleLiveApp(session, restore);
      render(<App />);
      await act(async () => {});
      expect(screen.queryByRole("heading", { name: "Sign in to Union Ground" })).toBeNull();
      expect(loadMemberApp).not.toHaveBeenCalled();
      await act(async () => finishRestore());
      expect(await screen.findByRole("heading", { name: "Sign in to Union Ground", level: 1 })).toBeInTheDocument();
      expect(loadMemberApp).not.toHaveBeenCalled();
      // The sign-in screen's own two capability reads (GET, same origin, no session) are the only requests.
      expect(fetchMock.mock.calls.map(([url]) => String(url)).filter((url) => url !== "/api/auth-pin-signin" && url !== "/api/auth-signin-options")).toEqual([]);
      // Fail closed: the session is retired the way a sign-out retires one.
      // Its push association is torn down on the server through a client that
      // carries its own bearer, its own token is revoked, it is cleared from
      // this browser by lineage, never published, and the departed account's
      // device residue is swept, lineage-aware. The mutable client sign-out,
      // which reads whatever session occupies storage by then, is never used.
      await waitFor(() => expect(client.rpc).toHaveBeenCalledWith("prepare_my_signout", { p_scope: "local", p_expected_user_id: "retained-member" }));
      await waitFor(() => expect(adminSignOut).toHaveBeenCalledWith("test-session", "local"));
      await waitFor(() => expect(clearLocally).toHaveBeenCalledWith(session, { explicitSignOut: true }));
      await waitFor(() => expect(forgetDepartedMemberDevice).toHaveBeenCalledWith(
        expect.anything(), "retained-member", expect.objectContaining({ readActiveSessionLineage: expect.any(Function) }),
      ));
      expect(clientSignOut).not.toHaveBeenCalled();
    });
  });

  it("still refuses and settles when clearing the refused session throws synchronously", async () => {
    const session = { user: { id: "retained-member", email: "retained@example.com" }, access_token: "test-session" };
    await withLocation(SAMPLE_HOST, "?demo=1", async () => {
      const { App, loadMemberApp, clearLocally, forgetDepartedMemberDevice } = await bootSampleLiveApp(session, Promise.resolve(), [], { clearThrows: true });
      render(<App />);
      expect(await screen.findByRole("heading", { name: "Sign in to Union Ground", level: 1 })).toBeInTheDocument();
      await waitFor(() => expect(clearLocally).toHaveBeenCalledOnce());
      expect(loadMemberApp).not.toHaveBeenCalled();
      await waitFor(() => expect(forgetDepartedMemberDevice).toHaveBeenCalled());
    });
  });

  it("yields no persona session from a hand-set dummy token beside a persona email on the production SAMPLE origin", async () => {
    // Storage alone must never mint a persona session: the token carries no
    // readable email claim, so the stored persona email does not count.
    const persona = samplePersonas()[0];
    const session = { user: { id: "persona-member", email: persona.email }, access_token: "hand-set-dummy-token" };
    await withLocation(SAMPLE_HOST, "", async () => {
      const { App, loadMemberApp, fetchMock, clearLocally, clientSignOut, adminSignOut } = await bootSampleLiveApp(session);
      render(<App />);
      expect(await screen.findByRole("heading", { name: "Sign in to Union Ground", level: 1 })).toBeInTheDocument();
      expect(loadMemberApp).not.toHaveBeenCalled();
      // The sign-in screen's own two capability reads (GET, same origin, no session) are the only requests.
      expect(fetchMock.mock.calls.map(([url]) => String(url)).filter((url) => url !== "/api/auth-pin-signin" && url !== "/api/auth-signin-options")).toEqual([]);
      await waitFor(() => expect(clearLocally).toHaveBeenCalledWith(session, { explicitSignOut: true }));
      await waitFor(() => expect(adminSignOut).toHaveBeenCalledWith("hand-set-dummy-token", "local"));
      expect(clientSignOut).not.toHaveBeenCalled();
      // With no Apple or Google on SAMPLE the email form shows directly
      // (BUG-UG-SAMPLE-SIGNIN-LONE-OTHER-OPTIONS-20261106); the
      // stored persona email never pre-fills it. The card reveals the form one
      // commit after the heading (the provider count arrives from an effect,
      // outside act here), so wait for it
      // (TEST-UG-SAMPLE-PARITY-SIGNIN-FORM-LOOKUP-RACES-SECOND-COMMIT-20261108).
      expect(await screen.findByLabelText(/email/i)).toHaveValue("");
    });
  });

  it("leaves a persona session another tab signed in meanwhile untouched while refusing the restored one", async () => {
    // Two tabs: this one restored non-persona session A; before A's retirement
    // ran, another tab persisted allowed persona session B in the shared slot.
    // The lineage compare-and-swap reports the other occupant, so B's storage
    // entry survives, only A's own token is revoked, and the mutable client
    // sign-out (which would have read and revoked B) is never called.
    const refused = { user: { id: "retained-member", email: "retained@example.com" }, access_token: "session-a-token" };
    const replacement = JSON.stringify({ access_token: tokenWithEmail(samplePersonas()[0].email), user: { id: "persona-member" } });
    await withLocation(SAMPLE_HOST, "?demo=1", async () => {
      localStorage.setItem("sample-auth-storage", replacement);
      try {
        const { App, loadMemberApp, clearLocally, clientSignOut, adminSignOut, forgetDepartedMemberDevice } = await bootSampleLiveApp(refused, Promise.resolve(), [], { clearResult: false });
        render(<App />);
        expect(await screen.findByRole("heading", { name: "Sign in to Union Ground", level: 1 })).toBeInTheDocument();
        await waitFor(() => expect(clearLocally).toHaveBeenCalledWith(refused, { explicitSignOut: true }));
        await waitFor(() => expect(forgetDepartedMemberDevice).toHaveBeenCalled());
        expect(adminSignOut).toHaveBeenCalledTimes(1);
        expect(adminSignOut).toHaveBeenCalledWith("session-a-token", "local");
        expect(clientSignOut).not.toHaveBeenCalled();
        expect(localStorage.getItem("sample-auth-storage")).toBe(replacement);
        expect(loadMemberApp).not.toHaveBeenCalled();
      } finally {
        localStorage.removeItem("sample-auth-storage");
      }
    });
  });

  it("refuses a stored persona email whose access token names another account", async () => {
    const persona = samplePersonas()[0];
    const session = { user: { id: "persona-member", email: persona.email }, access_token: tokenWithEmail("retained@example.com") };
    await withLocation(SAMPLE_HOST, "?demo=1", async () => {
      const { App, loadMemberApp, clearLocally } = await bootSampleLiveApp(session);
      render(<App />);
      expect(await screen.findByRole("heading", { name: "Sign in to Union Ground", level: 1 })).toBeInTheDocument();
      expect(loadMemberApp).not.toHaveBeenCalled();
      expect(clearLocally).toHaveBeenCalledWith(session, { explicitSignOut: true });
    });
  });

  it("still loads a restored seeded persona on the retired preview host", async () => {
    const persona = samplePersonas()[0];
    const session = { user: { id: "persona-member", email: persona.email }, access_token: tokenWithEmail(persona.email) };
    await withLocation(SAMPLE_HOST, "?demo=1", async () => {
      const { App, loadMemberApp, clearLocally, clientSignOut } = await bootSampleLiveApp(session);
      render(<App />);
      await waitFor(() => expect(loadMemberApp).toHaveBeenCalled());
      expect(screen.queryByRole("heading", { name: "Sign in to Union Ground" })).not.toBeInTheDocument();
      expect(clearLocally).not.toHaveBeenCalled();
      expect(clientSignOut).not.toHaveBeenCalled();
    });
  });

  //  (demo walk of Nov 24, 2026): the shared Steward demo account had
  // Espanol saved, so every English visitor who switched to it got the whole
  // site in Spanish. A shared demo person shows the visitor's own language,
  // and a language change there stays on the device instead of being saved
  // on the shared account for the next visitor.
  it("shows a shared demo person in the visitor's language and keeps a change on the device", async () => {
    const steward = samplePersonaForHat("steward");
    const session = { user: { id: "persona-steward", email: steward.email }, access_token: tokenWithEmail(steward.email) };
    localStorage.setItem("unionground-lang", "en");
    await withLocation(SAMPLE_HOST, "?shell=classic", async () => {
      const { App, client } = await bootSampleLiveApp(session, Promise.resolve(), ["steward"], { member: { language: "es" } });
      render(<App />);
      const english = await screen.findByRole("switch", { name: "Español" }, { timeout: 10000 });
      expect(english).toHaveAttribute("aria-checked", "false");
      expect(screen.getAllByRole("heading", { name: "Language" }).length).toBeGreaterThan(0);
      fireEvent.click(english);
      await waitFor(() => expect(screen.getByRole("switch", { name: "Español" })).toHaveAttribute("aria-checked", "true"));
      await waitFor(() => expect(screen.getAllByRole("heading", { name: "Idioma" }).length).toBeGreaterThan(0));
      expect(localStorage.getItem("unionground-lang")).toBe("es");
      expect(client.rpc.mock.calls.map(([name]) => name)).not.toContain("update_my_member_profile");
    }, "/m/settings/language");
  });

  //, the other side: a fictional SAMPLE organization account on the
  // demo host is its own person, so its saved language shows and its
  // language change is saved on its profile, as on the product site.
  it("keeps a SAMPLE organization account on its own saved language and saves its change", async () => {
    const email = "kayla.doyle@loadtest.demo.example.com";
    const session = { user: { id: "tamarack-member", email }, access_token: tokenWithEmail(email) };
    localStorage.setItem("unionground-lang", "en");
    await withLocation(SAMPLE_HOST, "?shell=classic", async () => {
      const { App, client } = await bootSampleLiveApp(session, Promise.resolve(), [], { member: { language: "es", fullName: "Kayla Doyle", initials: "KD" } });
      render(<App />);
      const spanish = await screen.findByRole("switch", { name: "Español" }, { timeout: 10000 });
      expect(spanish).toHaveAttribute("aria-checked", "true");
      fireEvent.click(spanish);
      await waitFor(() => expect(client.rpc.mock.calls.map(([name]) => name)).toContain("update_my_member_profile"));
      const save = client.rpc.mock.calls.find(([name]) => name === "update_my_member_profile");
      expect(save[1]).toMatchObject({ p_fields: { language: "en" } });
      expect(localStorage.getItem("unionground-lang")).toBe("en");
    }, "/m/settings/language");
  });

  describe("Messages layout on the demo", () => {
    const preferenceKey = (id) => `unionground:messaging-workflow:v1:${id}`;
    const onboardingKey = (id) => `unionground:messaging-workflow-onboarded:v1:${id}`;
    const accountIds = ["messages-demo-member", "messages-demo-steward", "messages-ordinary-member"];

    afterEach(() => {
      for (const id of accountIds) {
        localStorage.removeItem(preferenceKey(id));
        localStorage.removeItem(onboardingKey(id));
      }
    });

    async function openPage(path, id, email, examine, shell = "classic") {
      const session = { user: { id, email }, access_token: tokenWithEmail(email) };
      await withLocation(SAMPLE_HOST, `?shell=${shell}`, async () => {
        const { App } = await bootSampleLiveApp(session);
        const app = render(<App />);
        try { await examine(); }
        finally { app.unmount(); }
      }, path);
    }

    it.each([
      ["en", "classic", "People"],
      ["es", "alt", "Personas"],
    ])("opens the shared persona's default inbox in %s on the %s shell", async (lang, shell, group) => {
      const [id] = accountIds;
      localStorage.setItem("unionground-lang", lang);
      localStorage.setItem(preferenceKey(id), "attention");
      await openPage("/m/messages", id, samplePersonaForHat("member").email, async () => {
        const messages = await screen.findAllByText(/Write down what they asked/);
        expect(messages[0]).toBeVisible();
        expect(document.querySelector(".message-workflow-onboarding")).toBeNull();
        expect(screen.getByRole("heading", { name: group, exact: true })).toBeVisible();
        expect(localStorage.getItem(preferenceKey(id))).toBe("attention");
        expect(localStorage.getItem(onboardingKey(id))).toBeNull();
      }, shell);
    });

    it("keeps this visit's Settings choice after switching shared demo roles", async () => {
      const [memberId, stewardId] = accountIds;
      const member = samplePersonaForHat("member");
      const steward = samplePersonaForHat("steward");
      const memberSession = { user: { id: memberId, email: member.email }, access_token: tokenWithEmail(member.email) };
      const stewardSession = { user: { id: stewardId, email: steward.email }, access_token: tokenWithEmail(steward.email) };
      localStorage.setItem("unionground-lang", "en");
      await withLocation(SAMPLE_HOST, "?shell=classic", async () => {
        const { App, client, fetchMock, loadMemberApp } = await bootSampleLiveApp(stewardSession, Promise.resolve(), ["steward"]);
        let signedIn = stewardSession;
        let authChanged;
        client.auth.getSession = async () => ({ data: { session: signedIn }, error: null });
        client.auth.onAuthStateChange = (callback) => {
          authChanged = callback;
          return { data: { subscription: { unsubscribe() {} } } };
        };
        client.auth.setSession = async () => {
          signedIn = memberSession;
          authChanged("SIGNED_IN", memberSession);
          return { data: { session: memberSession }, error: null };
        };
        fetchMock.mockImplementation((url) => {
          if (String(url) !== "/api/demo-session") throw new Error("unexpected request");
          return Promise.resolve(Response.json({ accessToken: memberSession.access_token, refreshToken: "test-refresh" }));
        });
        const app = render(<App />);

        const layout = await screen.findByRole("radio", { name: /To-do inbox/ });
        fireEvent.click(layout);
        expect(layout).toHaveAttribute("aria-checked", "true");
        expect(localStorage.getItem(preferenceKey(stewardId))).toBeNull();
        expect(localStorage.getItem(onboardingKey(stewardId))).toBeNull();

        fireEvent.change(screen.getByRole("combobox", { name: /switch role/i }), { target: { value: "member" } });
        await waitFor(() => expect(loadMemberApp).toHaveBeenCalledWith(expect.any(Object), memberSession.user, expect.anything()));
        act(() => {
          window.history.pushState({}, "", "/m/messages?shell=classic");
          window.dispatchEvent(new PopStateEvent("popstate"));
        });
        expect(await screen.findByRole("heading", { name: "Needs you", exact: true })).toBeVisible();
        expect(localStorage.getItem(preferenceKey(memberId))).toBeNull();
        expect(localStorage.getItem(onboardingKey(memberId))).toBeNull();
        app.unmount();
      }, "/m/settings/messages");

      await openPage("/m/messages", stewardId, steward.email, async () => {
        expect(await screen.findByRole("heading", { name: "People", exact: true })).toBeVisible();
      });
    });

    it("keeps the chooser and account-specific Settings choice for an ordinary demo organization account", async () => {
      const id = accountIds[2];
      const email = "kayla.doyle@loadtest.demo.example.com";
      localStorage.setItem("unionground-lang", "en");
      await openPage("/m/messages", id, email, async () => {
        expect(await screen.findByText("Pick a layout for your messages")).toBeVisible();
        fireEvent.click(screen.getByRole("button", { name: "Skip and use the default" }));
        expect(document.querySelector(".message-workflow-onboarding")).toBeNull();
        expect(localStorage.getItem(preferenceKey(id))).toBe("people-spaces-work");
        expect(localStorage.getItem(onboardingKey(id))).toBe("complete");
      });
      await openPage("/m/settings/messages", id, email, async () => {
        const layout = await screen.findByRole("radio", { name: /Workstream Threads/ });
        fireEvent.click(layout);
        expect(layout).toHaveAttribute("aria-checked", "true");
        expect(localStorage.getItem(preferenceKey(id))).toBe("workstreams");
      });
    });
  });

  // BUG-UG-DEMO-HOST-SIGNED-OUT-DEAD-END-20261106: the demo is
  // presented by signing in as the fictional SAMPLE organization accounts.
  it.each(["test", "production"])("loads a fictional SAMPLE organization account on the demo host in %s without the retired shared-demo welcome", async (mode) => {
    vi.stubEnv("MODE", mode);
    const email = "kayla.doyle@loadtest.demo.example.com";
    const session = { user: { id: "tamarack-member", email }, access_token: tokenWithEmail(email) };
    await withLocation(SAMPLE_HOST, "?demo=1", async () => {
      const { App, loadMemberApp, clearLocally, clientSignOut } = await bootSampleLiveApp(session, Promise.resolve(), [], { member: { fullName: "Kayla Doyle", initials: "KD" } });
      render(<App />);
      await waitFor(() => expect(loadMemberApp).toHaveBeenCalled());
      expect(screen.queryByRole("heading", { name: "Sign in to Union Ground" })).not.toBeInTheDocument();
      // The shared-workspace welcome ("entering as Darnell Foster", "no
      // account is needed") is not true for a signed-in SAMPLE account. It is
      // a lazy overlay, so let the shell and its chunks settle first.
      await screen.findByRole("link", { name: "Skip to main content" });
      await act(async () => { await new Promise((resolve) => setTimeout(resolve, 400)); });
      expect(screen.queryByRole("dialog", { name: "Welcome to your Union Ground demo" })).toBeNull();
      expect(screen.queryByText(/No account is needed/)).toBeNull();
      expect(clearLocally).not.toHaveBeenCalled();
      expect(clientSignOut).not.toHaveBeenCalled();
    });
  });

  // The demo bar ("Guided demo ... shared demo workspace"), its Guide (persona
  // rows and the guided tour) and the phone chip belong to the retired shared
  // demo: a signed-in SAMPLE organization account never sees them, a seeded
  // persona session keeps them.
  function stubDesktop(matches) {
    const previous = window.matchMedia;
    window.matchMedia = vi.fn().mockImplementation((query) => ({
      matches, media: query, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {},
    }));
    return () => { window.matchMedia = previous; };
  }

  it.each([
    ["a SAMPLE organization account", "kayla.doyle@loadtest.demo.example.com", true, "/m", false],
    ["a SAMPLE organization account", "kayla.doyle@loadtest.demo.example.com", false, "/m/messages", false],
    ["a seeded persona", null, true, "/m", true],
    ["a seeded persona", null, false, "/m/messages", true],
  ])("retired demo chrome for %s (desktop %s at %s) is shown: %s", async (_label, accountEmail, desktop, path, expected) => {
    const email = accountEmail ?? samplePersonas()[0].email;
    const session = { user: { id: accountEmail ? "tamarack-member" : "persona-member", email }, access_token: tokenWithEmail(email) };
    const restore = stubDesktop(desktop);
    try {
      await withLocation(SAMPLE_HOST, "?demo=1", async () => {
        const { App, loadMemberApp } = await bootSampleLiveApp(session);
        render(<App />);
        await waitFor(() => expect(loadMemberApp).toHaveBeenCalled());
        await screen.findByRole("link", { name: "Skip to main content" });
        await act(async () => { await new Promise((resolve) => setTimeout(resolve, 300)); });
        const chrome = desktop ? document.querySelector(".demo-bar") : document.querySelector(".demo-chip");
        expect(Boolean(chrome)).toBe(expected);
      }, path);
    } finally {
      restore();
    }
  });

  // G6 gate on  (r1s1/r2s1): an admitted SAMPLE organization admin or
  // coordinator, with verified MFA and the held role, must enter its own desk
  // instead of being bounced to /m by persona-only routing.
  it.each(["admin", "coordinator"])("opens a SAMPLE organization %s's own desk on the demo host", async (role) => {
    vi.stubEnv("MODE", "production");
    const email = "staff.proof@loadtest.demo.example.com";
    const session = { user: { id: "fictional-staff-proof", email }, access_token: tokenWithEmail(email) };
    const restore = stubDesktop(true);
    try {
      await withLocation(SAMPLE_HOST, "?shell=classic", async () => {
        const { App, loadMemberApp } = await bootSampleLiveApp(session, Promise.resolve(), [role], {
          mfa: true,
          member: { fullName: "Fictional staff", firstName: "Fictional", organizationId: "fictional-org", membershipStatus: "active" },
        });
        render(<App />);
        await waitFor(() => expect(loadMemberApp).toHaveBeenCalled());
        await screen.findByRole("link", { name: "Skip to main content" });
        await act(async () => { await new Promise((resolve) => setTimeout(resolve, 500)); });
        expect(window.location.pathname).toBe(`/m/${role}`);
      }, `/m/${role}`);
    } finally {
      restore();
    }
  }, 20000);

  it("switches a SAMPLE organization account between its own desks from the rail", async () => {
    vi.stubEnv("MODE", "production");
    const email = "staff.proof@loadtest.demo.example.com";
    const session = { user: { id: "fictional-staff-proof", email }, access_token: tokenWithEmail(email) };
    const restore = stubDesktop(true);
    try {
      await withLocation(SAMPLE_HOST, "?shell=classic", async () => {
        const { App, loadMemberApp } = await bootSampleLiveApp(session, Promise.resolve(), ["admin", "coordinator"], {
          mfa: true,
          member: { fullName: "Fictional staff", firstName: "Fictional", organizationId: "fictional-org", membershipStatus: "active" },
        });
        render(<App />);
        await waitFor(() => expect(loadMemberApp).toHaveBeenCalled());
        await screen.findByRole("link", { name: "Skip to main content" });
        const rail = screen.getByRole("navigation", { name: "Primary" });
        // The member rail offers the account's own desks (none for a persona).
        const desks = [...rail.querySelectorAll("a")].filter((link) => ["/m/admin", "/m/coordinator"].includes(link.getAttribute("href")));
        expect(desks.map((link) => link.getAttribute("href")).sort()).toEqual(["/m/admin", "/m/coordinator"]);
        fireEvent.click(desks.find((link) => link.getAttribute("href") === "/m/coordinator"));
        await waitFor(() => expect(window.location.pathname).toBe("/m/coordinator"));
      }, "/m");
    } finally {
      restore();
    }
  }, 20000);

  //: a role switch abandoned because another tab
  // signed a non-persona account in drops its focus request, so a later open
  // of that desk does not pull focus to the main region.
  it("drops an abandoned role switch's focus request before the next account opens that desk", async () => {
    vi.stubEnv("MODE", "production");
    const steward = samplePersonaForHat("steward");
    const session = { user: { id: "persona-steward", email: steward.email }, access_token: tokenWithEmail(steward.email) };
    const restore = stubDesktop(true);
    try {
      await withLocation(SAMPLE_HOST, "?shell=classic", async () => {
        const { App, client, fetchMock, loadMemberApp } = await bootSampleLiveApp(session, Promise.resolve(), ["admin", "coordinator"], {
          mfa: true,
          member: { fullName: "Fictional staff", firstName: "Fictional", organizationId: "fictional-org", membershipStatus: "active" },
        });
        let release;
        fetchMock.mockImplementation((url) => (String(url).includes("demo-session")
          ? new Promise((resolve) => { release = () => resolve(new Response(JSON.stringify({ accessToken: "admin-access", refreshToken: "admin-refresh" }), { status: 200, headers: { "content-type": "application/json" } })); })
          : Promise.reject(new Error("unexpected request"))));
        let authChanged;
        client.auth.onAuthStateChange = (callback) => { authChanged = callback; return { data: { subscription: { unsubscribe() {} } } }; };
        client.auth.setSession = vi.fn(async () => ({ data: {}, error: null }));
        render(<App />);
        fireEvent.click(await screen.findByRole("button", { name: /^Switch role, current/ }));
        fireEvent.click(await screen.findByRole("menuitemradio", { name: "Admin" }));
        await waitFor(() => expect(release).toEqual(expect.any(Function)));
        const email = "staff.proof@loadtest.demo.example.com";
        await act(async () => { authChanged("SIGNED_IN", { user: { id: "fictional-staff-proof", email }, access_token: tokenWithEmail(email) }); });
        await act(async () => { release(); await new Promise((resolve) => setTimeout(resolve, 0)); });
        await waitFor(() => expect(loadMemberApp.mock.calls.some(([, user]) => user.id === "fictional-staff-proof")).toBe(true));
        const rail = await screen.findByRole("navigation", { name: "Primary" });
        const admin = await waitFor(() => {
          const link = [...rail.querySelectorAll("a")].find((node) => node.getAttribute("href") === "/m/admin");
          expect(link).toBeTruthy();
          return link;
        });
        document.activeElement?.blur?.();
        fireEvent.click(admin);
        await waitFor(() => expect(window.location.pathname).toBe("/m/admin"));
        await act(async () => { await new Promise((resolve) => setTimeout(resolve, 300)); });
        expect(document.activeElement?.id).not.toBe("main-content");
      }, "/m/steward");
    } finally {
      restore();
    }
  }, 20000);

  // G6 gate on  (r1s2/r2s2): the alternate Home's "Demo tour" opened the
  // retired Darnell Foster guide for an organization account.
  it("offers no retired demo tour on the alternate Home to a SAMPLE organization account", async () => {
    vi.stubEnv("MODE", "production");
    const email = "member.proof@loadtest.demo.example.com";
    const session = { user: { id: "fictional-member-proof", email }, access_token: tokenWithEmail(email) };
    const restore = stubDesktop(false);
    try {
      await withLocation(SAMPLE_HOST, "?shell=alt", async () => {
        const { App, loadMemberApp } = await bootSampleLiveApp(session, Promise.resolve(), [], {
          member: { fullName: "Fictional member", firstName: "Fictional", organizationId: "fictional-org", membershipStatus: "active" },
        });
        render(<App />);
        await waitFor(() => expect(loadMemberApp).toHaveBeenCalled());
        await screen.findByRole("link", { name: "Skip to main content" });
        await act(async () => { await new Promise((resolve) => setTimeout(resolve, 300)); });
        expect(screen.queryByRole("button", { name: "Demo tour" })).toBeNull();
        expect(document.querySelector(".guide-dialog")).toBeNull();
        expect(document.body.textContent).not.toContain("Darnell Foster");
      });
    } finally {
      restore();
    }
  }, 20000);

  it("keeps the retired demo tour on the alternate Home for a seeded persona session", async () => {
    vi.stubEnv("MODE", "production");
    const persona = samplePersonas()[0];
    const session = { user: { id: "persona-member", email: persona.email }, access_token: tokenWithEmail(persona.email) };
    const restore = stubDesktop(false);
    try {
      await withLocation(SAMPLE_HOST, "?shell=alt", async () => {
        const { App, loadMemberApp } = await bootSampleLiveApp(session);
        render(<App />);
        await waitFor(() => expect(loadMemberApp).toHaveBeenCalled());
        expect(await screen.findByRole("button", { name: "Demo tour" })).toBeInTheDocument();
      });
    } finally {
      restore();
    }
  }, 20000);

  it.each([
    ["a look-alike suffix", "kayla.doyle@loadtest.demo.example.com.example.net"],
    ["a subdomain", "kayla.doyle@x.loadtest.demo.example.com"],
    ["a prefix", "kayla.doyle@evil-loadtest.demo.example.com"],
  ])("still refuses %s of the SAMPLE account domain on the demo host", async (_label, email) => {
    const session = { user: { id: "look-alike", email }, access_token: tokenWithEmail(email) };
    await withLocation(SAMPLE_HOST, "?demo=1", async () => {
      const { App, loadMemberApp, clearLocally } = await bootSampleLiveApp(session);
      render(<App />);
      expect(await screen.findByRole("heading", { name: "Sign in to Union Ground", level: 1 })).toBeInTheDocument();
      expect(loadMemberApp).not.toHaveBeenCalled();
      await waitFor(() => expect(clearLocally).toHaveBeenCalledWith(session, { explicitSignOut: true }));
    });
  });

  it("refuses a SAMPLE account email whose access token names another account", async () => {
    const session = { user: { id: "mismatch", email: "kayla.doyle@loadtest.demo.example.com" }, access_token: tokenWithEmail("someone@example.com") };
    await withLocation(SAMPLE_HOST, "?demo=1", async () => {
      const { App, loadMemberApp } = await bootSampleLiveApp(session);
      render(<App />);
      expect(await screen.findByRole("heading", { name: "Sign in to Union Ground", level: 1 })).toBeInTheDocument();
      expect(loadMemberApp).not.toHaveBeenCalled();
    });
  });

  // UB-UG-DEMO-STRAIGHT-IN-ENTRY-RESTORED-20261107: a persona
  // session offers every seeded hat again; restoring it mints nothing.
  it.each(["classic", "alt"])("keeps retained Campaigns usable without a retired studio, offering every hat, in %s", async (shell) => {
    const session = { user: { id: "retained-coordinator", email: samplePersonaForHat("coordinator").email }, access_token: tokenWithEmail(samplePersonaForHat("coordinator").email) };
    await withLocation(SAMPLE_HOST, `?demo=1&shell=${shell}`, async () => {
      // Retaining an authenticated staff account does not grant a role. The
      // live member projection must still authorize its Campaigns screen.
      const { App, verifyOtp, fetchMock } = await bootSampleLiveApp(session, Promise.resolve(), ["coordinator"]);
      render(<App />);
      expect(await screen.findByTestId("campaigns-screen")).toBeInTheDocument();
      expect(document.querySelector('.voice-demo-studio')).toBeNull();
      if (shell === "classic") {
        const hats = screen.getByRole("combobox", { name: /switch role/i });
        expect([...hats.options].map((option) => option.value)).toEqual(["member", "organize", "steward", "coordinator", "advisor", "admin", "vp"]);
      }
      expect(verifyOtp).not.toHaveBeenCalled();
      expect(fetchMock).not.toHaveBeenCalled();
    }, "/m/campaigns");
  });

  it.each(["classic", "alt"])("refuses Campaigns for a retained role-less account in %s", async (shell) => {
    const session = { user: { id: "retained-member", email: samplePersonaForHat("coordinator").email }, access_token: tokenWithEmail(samplePersonaForHat("coordinator").email) };
    await withLocation(SAMPLE_HOST, `?demo=1&shell=${shell}`, async () => {
      const { App, verifyOtp, fetchMock, loadMemberApp } = await bootSampleLiveApp(session);
      render(<App />);
      await waitFor(() => expect(loadMemberApp).toHaveBeenCalled());
      await waitFor(() => expect(window.location.pathname).toBe("/m"));
      expect(screen.queryByTestId("campaigns-screen")).toBeNull();
      expect(document.querySelector('.voice-demo-studio')).toBeNull();
      expect(verifyOtp).not.toHaveBeenCalled();
      expect(fetchMock).not.toHaveBeenCalled();
    }, "/m/campaigns");
  });

  // BUG-UG-DEMO-STAFF-SWITCH-STUCK-WITH-COLD-LINK-NOTICE-20261108: a reload
  // at a staff URL (including the automatic one after a deploy replaces the
  // chunks) restores that role's persona. The demo bar said "This link starts
  // as Steward" anyway; it explains only a real Steward fallback.
  it("names no Steward fallback when a reload at a staff URL restores that role's persona", async () => {
    const admin = samplePersonaForHat("admin");
    const session = { user: { id: "persona-admin", email: admin.email }, access_token: tokenWithEmail(admin.email) };
    const restore = stubDesktop(true);
    try {
      await withLocation(SAMPLE_HOST, "?demo=1", async () => {
        const { App, loadMemberApp } = await bootSampleLiveApp(session, Promise.resolve(), ["admin"]);
        render(<App />);
        await waitFor(() => expect(loadMemberApp).toHaveBeenCalled());
        await waitFor(() => expect(document.querySelector(".demo-bar")).not.toBeNull());
        await act(async () => { await new Promise((resolve) => setTimeout(resolve, 300)); });
        expect(document.querySelector(".demo-bar").textContent).toMatch(/Guided demo/);
        expect(document.querySelector(".demo-bar").textContent).not.toMatch(/This link starts as Steward/);
      }, "/m/admin");
    } finally {
      restore();
    }
  });

  it("explains the Worker fallback when the restored persona is Worker on a staff URL", async () => {
    const worker = samplePersonaForHat("member");
    const session = { user: { id: "persona-worker", email: worker.email }, access_token: tokenWithEmail(worker.email) };
    const restore = stubDesktop(true);
    try {
      await withLocation(SAMPLE_HOST, "?demo=1", async () => {
        const { App, loadMemberApp } = await bootSampleLiveApp(session);
        render(<App />);
        await waitFor(() => expect(loadMemberApp).toHaveBeenCalled());
        await waitFor(() => expect(document.querySelector(".demo-bar")?.textContent || "").toMatch(/This link starts as Worker/));
      }, "/m/admin");
    } finally {
      restore();
    }
  });
});

describe("retiring a refused session", () => {
  // The slot is a compare-and-swap: it clears only when it still holds the
  // refused lineage, as exactSessionStorage.removeSessionIfMatches does.
  function slotHolding(initial) {
    const slot = { session: initial };
    return {
      slot,
      clearLocally: async (captured) => {
        if (slot.session?.access_token !== captured.access_token) return false;
        slot.session = null;
        return true;
      },
    };
  }
  const sessionA = { user: { id: "retained-member" }, access_token: "session-a-token" };
  const sessionB = { user: { id: "persona-member" }, access_token: "session-b-token" };

  it("retires the refused session through its own bearer and clears its own lineage", async () => {
    const { slot, clearLocally } = slotHolding(sessionA);
    const prepareSignOut = vi.fn(async () => undefined);
    const revokeToken = vi.fn(async () => undefined);
    const afterCleared = vi.fn(async () => undefined);
    await expect(retireRefusedSession(sessionA, { prepareSignOut, revokeToken, clearLocally, afterCleared })).resolves.toEqual({ cleared: true, revoked: true });
    expect(prepareSignOut).toHaveBeenCalledWith(sessionA);
    expect(revokeToken).toHaveBeenCalledWith("session-a-token");
    expect(afterCleared).toHaveBeenCalledWith(true);
    expect(slot.session).toBeNull();
  });

  it("leaves a replacement session another tab persisted in place and revokes only the refused token", async () => {
    const { slot, clearLocally } = slotHolding(sessionB);
    const revokeToken = vi.fn(async () => undefined);
    const afterCleared = vi.fn(async () => undefined);
    await expect(retireRefusedSession(sessionA, { prepareSignOut: async () => undefined, revokeToken, clearLocally, afterCleared })).resolves.toEqual({ cleared: false, revoked: true });
    expect(revokeToken).toHaveBeenCalledTimes(1);
    expect(revokeToken).toHaveBeenCalledWith("session-a-token");
    expect(afterCleared).toHaveBeenCalledWith(false);
    expect(slot.session).toBe(sessionB);
  });

  it("runs every step even when an earlier one fails, and reports a throwing clear as not cleared", async () => {
    const { slot, clearLocally } = slotHolding(sessionA);
    const revokeToken = vi.fn(async () => { throw new Error("offline"); });
    const afterCleared = vi.fn(async () => undefined);
    await expect(retireRefusedSession(sessionA, {
      prepareSignOut: async () => { throw new Error("rpc refused"); }, revokeToken, clearLocally, afterCleared,
    })).resolves.toEqual({ cleared: true, revoked: false });
    expect(revokeToken).toHaveBeenCalledWith("session-a-token");
    expect(slot.session).toBeNull();
    const sweep = vi.fn(async () => undefined);
    await expect(retireRefusedSession(sessionA, {
      prepareSignOut: async () => undefined, revokeToken: async () => undefined,
      clearLocally: () => { throw new Error("storage quota exceeded"); }, afterCleared: sweep,
    })).resolves.toEqual({ cleared: false, revoked: true });
    expect(sweep).toHaveBeenCalledWith(false);
  });
});
