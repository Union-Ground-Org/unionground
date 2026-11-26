// @vitest-environment node
import { afterEach, describe, expect, it, vi } from "vitest";
import { DENIED_PRODUCTION_REF, deniedSupabaseOrigin } from "./helpers/denied-identity-fixtures.js";
import {
  CRON_SECRET_MIN_LENGTH,
  authorizeCronRequest,
  unionGroundProvider,
  safeSecretEqual,
  supabaseAuthHeaders,
  supabaseRpc,
} from "../api/_lib/http.js";
// The handler reaches only an approved backend (api/_lib/providerBoundary.js).
vi.mock("../src/lib/trustedBackends.js", async () => (await import("./helpers/fictional-provider.js")).trustedBackendsModule("https://unionground.supabase.co"));

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("Supabase authorization headers", () => {
  it("sends opaque secret keys only as apikey credentials", async () => {
    const opaqueKey = ["sb", "secret", "fixture"].join("_");
    expect(supabaseAuthHeaders(opaqueKey, opaqueKey)).toEqual({
      apikey: opaqueKey,
    });
    global.fetch = vi.fn().mockResolvedValueOnce({
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ ok: true }),
    });
    await supabaseRpc(
      "https://project.supabase.co",
      opaqueKey,
      opaqueKey,
      "test_rpc",
    );
    expect(global.fetch.mock.calls[0][1].headers).toMatchObject({
      apikey: opaqueKey,
      "Content-Type": "application/json",
    });
    expect(global.fetch.mock.calls[0][1].headers).not.toHaveProperty("Authorization");
  });

  it("keeps member access tokens and legacy service JWTs in Bearer authorization", () => {
    const publishableKey = ["sb", "publishable", "fixture"].join("_");
    expect(supabaseAuthHeaders(publishableKey, "member.jwt.value")).toEqual({
      apikey: publishableKey,
      Authorization: "Bearer member.jwt.value",
    });
    expect(supabaseAuthHeaders("legacy-service-jwt", "legacy-service-jwt")).toEqual({
      apikey: "legacy-service-jwt",
      Authorization: "Bearer legacy-service-jwt",
    });
  });
});

// supabaseRpc's 204-vs-empty-200 contract is pinned in
// tests/http-empty-response.test.js; this file covers the header, secret and
// provider helpers.
describe("cron authorization", () => {
  const strongSecret = "a".repeat(CRON_SECRET_MIN_LENGTH);
  const authorized = { headers: { authorization: `Bearer ${strongSecret}` } };

  it("compares secrets of different lengths without throwing", () => {
    // timingSafeEqual rejects buffers of unequal length; hashing first is what
    // makes an attacker-chosen short token a plain `false` instead of a 500.
    expect(safeSecretEqual("short", strongSecret)).toBe(false);
    expect(safeSecretEqual(strongSecret, strongSecret)).toBe(true);
    expect(safeSecretEqual("", "")).toBe(true);
  });

  it("authorizes only an exact match of a long-enough secret", () => {
    vi.stubEnv("CRON_SECRET", strongSecret);
    expect(authorizeCronRequest(authorized)).toBe(true);
    expect(authorizeCronRequest({ headers: { authorization: `Bearer ${"b".repeat(CRON_SECRET_MIN_LENGTH)}` } })).toBe(false);
    expect(authorizeCronRequest({ headers: {} })).toBe(false);
    // A bare secret with no "Bearer " prefix is not a credential this API accepts.
    expect(authorizeCronRequest({ headers: { authorization: strongSecret } })).toBe(false);
  });

  it("authorizes nobody when CRON_SECRET is unset, empty, or under the floor", () => {
    for (const secret of [undefined, "", "x", "a".repeat(CRON_SECRET_MIN_LENGTH - 1)]) {
      vi.stubEnv("CRON_SECRET", secret);
      // Including a request that presents exactly the configured weak secret:
      // a weak secret must not be usable, not merely hard to guess.
      expect(authorizeCronRequest({ headers: { authorization: `Bearer ${secret ?? ""}` } })).toBe(false);
    }
  });
});

describe("provider preamble", () => {
  it("reports ok only for the configured Union Ground project", () => {
    vi.stubEnv("VITE_SUPABASE_URL", "https://unionground.supabase.co");
    vi.stubEnv("UNIONGROUND_SUPABASE_PROJECT_REF", "unionground");
    vi.stubEnv("VITE_SUPABASE_PUBLISHABLE_KEY", "publishable-value");
    vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", "service-role-value");
    expect(unionGroundProvider()).toMatchObject({
      ok: true,
      reason: "",
      supabaseUrl: "https://unionground.supabase.co",
      publishableKey: "publishable-value",
      serviceRoleKey: "service-role-value",
    });
  });

  it("fails closed on a sibling product's project and explains why to the log, not the caller", () => {
    vi.stubEnv("VITE_SUPABASE_URL", deniedSupabaseOrigin(DENIED_PRODUCTION_REF));
    vi.stubEnv("UNIONGROUND_SUPABASE_PROJECT_REF", DENIED_PRODUCTION_REF);
    const provider = unionGroundProvider();
    expect(provider.ok).toBe(false);
    expect(provider.reason).toContain("Sibling product Supabase project");
    // The reason is for operator logs: it must never carry a key.
    expect(provider.reason).not.toContain("service-role");
  });

  it("fails closed when the URL and the expected ref disagree", () => {
    vi.stubEnv("VITE_SUPABASE_URL", "https://someoneelse.supabase.co");
    vi.stubEnv("UNIONGROUND_SUPABASE_PROJECT_REF", "unionground");
    expect(unionGroundProvider().ok).toBe(false);
  });
});
