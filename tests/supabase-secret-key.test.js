// @vitest-environment node
import { afterEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { supabaseHeaders, supabaseRpc } from "../api/_lib/http.js";

const MODERN_SECRET = ["sb", "secret", "example"].join("_");
const MODERN_PUBLISHABLE = ["sb", "publishable", "example"].join("_");

describe("Supabase opaque API-key transport", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("keeps legacy service-role JWTs in both headers", () => {
    expect(supabaseHeaders("legacy-jwt")).toEqual({
      apikey: "legacy-jwt",
      Authorization: "Bearer legacy-jwt",
    });
  });

  it("never presents a modern secret key as a bearer JWT", () => {
    expect(supabaseHeaders(MODERN_SECRET)).toEqual({
      apikey: MODERN_SECRET,
      "User-Agent": "UnionGround-Server/1.0",
    });
  });

  it("keeps a member JWT in Authorization beside a modern publishable key", () => {
    expect(supabaseHeaders(MODERN_PUBLISHABLE, "member-jwt")).toEqual({
      apikey: MODERN_PUBLISHABLE,
      Authorization: "Bearer member-jwt",
    });
  });

  it("uses API-key-only transport for privileged RPCs with a modern secret", async () => {
    const fetchMock = vi.fn(async () => ({
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ valid: false }),
    }));
    vi.stubGlobal("fetch", fetchMock);

    await supabaseRpc("https://project.supabase.co", MODERN_SECRET, MODERN_SECRET, "probe");
    expect(fetchMock).toHaveBeenCalledWith(
      "https://project.supabase.co/rest/v1/rpc/probe",
      expect.objectContaining({
        headers: {
          apikey: MODERN_SECRET,
          "User-Agent": "UnionGround-Server/1.0",
          "Content-Type": "application/json",
        },
      }),
    );
  });

  it("routes every direct privileged server call through the shared header helper", () => {
    for (const path of ["api/sensitive-content.js", "api/sensitive-case-files.js", "api/_lib/sensitiveCaseDocuments.js"]) {
      const source = readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
      expect(source).toContain("createSensitiveServiceClient(backend.url, backend.serviceRoleKey)");
      expect(source).not.toMatch(/createClient\(backend\.url, backend\.serviceRoleKey/);
    }
    const admin = readFileSync(new URL("../api/admin-mfa-reset.js", import.meta.url), "utf8");
    const invitationAdmin = readFileSync(new URL("../api/admin-invitations.js", import.meta.url), "utf8");
    const invitationAccept = readFileSync(new URL("../api/accept-invitation.js", import.meta.url), "utf8");
    const invitationHelpers = readFileSync(new URL("../api/_lib/memberInvitations.js", import.meta.url), "utf8");
    const recoveryAdmin = readFileSync(new URL("../api/admin-signin-recovery.js", import.meta.url), "utf8");
    const recoveryHelpers = readFileSync(new URL("../api/_lib/memberSigninRecovery.js", import.meta.url), "utf8");
    const dispatcher = readFileSync(new URL("../api/notifications-dispatch.js", import.meta.url), "utf8");
    const demoSession = readFileSync(new URL("../api/demo-session.js", import.meta.url), "utf8");
    expect(admin).toContain("...supabaseHeaders(serviceRoleKey)");
    expect(dispatcher).toContain("supabaseHeaders(serviceKey, serviceKey, { Prefer:");
    expect(admin).not.toContain("Authorization: `Bearer ${serviceRoleKey}`");
    expect(dispatcher).not.toContain("Authorization: `Bearer ${serviceKey}`");
    expect(invitationAdmin).not.toContain("SUPABASE_SERVICE_ROLE_KEY");
    expect(invitationAccept).not.toContain("import.meta.env");
    expect(invitationHelpers).toContain("...supabaseHeaders(serviceKey)");
    expect(invitationHelpers).not.toContain("Authorization: `Bearer ${serviceKey}`");
    expect(recoveryAdmin).not.toContain("import.meta.env");
    expect(recoveryHelpers).toContain("...supabaseHeaders(serviceRoleKey)");
    expect(recoveryHelpers).not.toContain("Authorization: `Bearer ${serviceRoleKey}`");
    // The restored SAMPLE entry mints through the shared admin header helper
    // (UB-UG-DEMO-STRAIGHT-IN-ENTRY-RESTORED-20261107).
    expect(demoSession).toContain('step("/admin/generate_link", authAdminHeaders(backend.serviceRoleKey),');
    expect(demoSession).not.toContain("demo-retired");
    expect(demoSession).not.toContain("Authorization: `Bearer ${backend.serviceRoleKey}`");
  });

  it("normalizes actual SDK RPC, table and Storage requests for opaque secrets", async () => {
    const { createSensitiveServiceClient } = await import("../api/_lib/sensitiveSupabase.js");
    const fetcher = vi.fn(async () => new Response("[]", { headers: { "Content-Type": "application/json" } }));
    vi.stubGlobal("fetch", fetcher);
    const client = createSensitiveServiceClient("https://synthetic.invalid", MODERN_SECRET);
    await client.rpc("probe");
    await client.from("probe").select("id");
    await client.storage.from("case-files").upload("synthetic", new Uint8Array([1]));
    expect(fetcher).toHaveBeenCalledTimes(3);
    for (const [, init] of fetcher.mock.calls) {
      const headers = new Headers(init.headers);
      expect(headers.get("apikey")).toBe(MODERN_SECRET);
      expect(headers.has("authorization")).toBe(false);
      expect(headers.get("user-agent")).toBe("UnionGround-Server/1.0");
    }
  });

  it.each([
    [MODERN_SECRET, MODERN_SECRET, null, 'UnionGround-Server/1.0'],
    [MODERN_PUBLISHABLE, 'member-jwt', 'Bearer member-jwt', null],
    ['legacy-jwt', 'legacy-jwt', 'Bearer legacy-jwt', null],
  ])('normalizes ENC Storage upload, removal and raw download for %s', async (key, token, authorization, agent) => {
    const { createSensitiveStorage } = await import('../api/_lib/sensitiveStorage.js');
    const fetcher = vi.fn(async () => new Response('[]', { headers: { 'Content-Type': 'application/json' } }));
    const storage = createSensitiveStorage('https://synthetic.invalid', key, { token, fetch: fetcher });
    await storage.upload('synthetic', new Uint8Array([1]));
    await storage.remove(['synthetic']);
    await storage.download('synthetic');
    expect(fetcher).toHaveBeenCalledTimes(3);
    for (const [, init] of fetcher.mock.calls) {
      const headers = new Headers(init.headers);
      expect(headers.get('apikey')).toBe(key);
      expect(headers.get('authorization')).toBe(authorization);
      expect(headers.get('user-agent')).toBe(agent);
    }
    const source = readFileSync(new URL('../api/_lib/sensitiveStorage.js', import.meta.url), 'utf8');
    expect(source).toContain('sensitiveSupabaseFetch(key, token, fetcher)');
    expect(source).not.toContain('Authorization: `Bearer ${token}`');
  });
});
