// @vitest-environment node
import { createHash } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import handler from "../api/google-drive.js";
import { PORTAL_HOST, PORTAL_ORIGIN, SUPABASE_ORIGIN, SUPABASE_REF } from "./helpers/fictional-provider.js";
vi.mock("../src/lib/trustedBackends.js", async () => (await import("./helpers/fictional-provider.js")).trustedBackendsModule());

const redirectUri = `${PORTAL_ORIGIN}/api/google-drive?action=callback`;
const backendUrl = SUPABASE_ORIGIN;
// The starting browser's binding cookie (#9557); a callback without it is refused.
const binding = "B".repeat(43);
let fetcher;

function reply(body, status = 200) {
  return new Response(JSON.stringify(body), { status });
}

async function invoke({ method = "POST", query = { action: "list" }, body, headers = {}, url } = {}) {
  const response = {
    statusCode: 0, headers: {}, body: undefined,
    status(code) { this.statusCode = code; return this; },
    setHeader(name, value) { this.headers[name] = value; return this; },
    end(value) { this.body = value === undefined ? undefined : JSON.parse(value); },
  };
  await handler({ method, query, body, url, headers: {
    host: PORTAL_HOST, origin: PORTAL_ORIGIN, authorization: "Bearer fixture-user-token", cookie: `google_drive_oauth_binding=${binding}`, ...headers,
  } }, response);
  expect(response.headers["Cache-Control"]).toBe("no-store");
  return response;
}

function idToken(claims) {
  const segment = (value) => Buffer.from(JSON.stringify(value)).toString("base64url");
  return `${segment({ alg: "RS256" })}.${segment(claims)}.signature`;
}

function authorize({ authorization = { organizationId: "fixture-organization", rootFolderId: "authorized-root" }, credential = { refreshToken: "fixture-refresh", rootFolderId: "credential-root" } } = {}) {
  fetcher.mockResolvedValueOnce(reply(authorization))
    .mockResolvedValueOnce(reply(credential))
    .mockResolvedValueOnce(reply({ access_token: "fixture-access" }));
}

beforeEach(() => {
  for (const [key, value] of Object.entries({
    VITE_SUPABASE_URL: backendUrl, UNIONGROUND_SUPABASE_PROJECT_REF: SUPABASE_REF, VITE_SUPABASE_PUBLISHABLE_KEY: "sb_publishable_fixture",
    SUPABASE_SERVICE_ROLE_KEY: "sb_secret_fixture", GOOGLE_DRIVE_CLIENT_ID: "fixture-client",
    GOOGLE_DRIVE_CLIENT_SECRET: "fixture-secret", GOOGLE_DRIVE_REDIRECT_URI: redirectUri,
  })) vi.stubEnv(key, value);
  fetcher = vi.fn(() => { throw new Error("Unexpected external request"); });
  vi.stubGlobal("fetch", fetcher);
});
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); });

describe("Google Drive handler behavior behind the Origin boundary", () => {
  it.each([
    [{ headers: { origin: "https://attacker.invalid" } }, 403, "untrusted-origin"],
    [{ method: "DELETE" }, 405, "method not allowed"],
    [{ method: "GET" }, 405, "method not allowed"],
    [{ query: { action: "start" }, headers: { authorization: "" } }, 401, "not authorized"],
    [{ query: { action: "callback" } }, 405, "method not allowed"],
    [{ headers: { authorization: "" } }, 401, "not authorized"],
  ])("rejects invalid access before provider work (%j)", async (request, status, error) => {
    expect(await invoke(request)).toMatchObject({ statusCode: status, body: { error } });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("requires all provider configuration and an HTTPS callback for consent", async () => {
    vi.stubEnv("GOOGLE_DRIVE_CLIENT_SECRET", "");
    expect(await invoke()).toMatchObject({ statusCode: 503, body: { error: "google drive is not configured" } });
    vi.stubEnv("GOOGLE_DRIVE_CLIENT_SECRET", "fixture-secret");
    vi.stubEnv("GOOGLE_DRIVE_REDIRECT_URI", `http://${PORTAL_HOST}/callback`);
    expect(await invoke({ query: { action: "start" } })).toMatchObject({ statusCode: 503, body: { error: "google drive redirect is not configured" } });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("persists hashed state and PKCE under the user's token before returning consent", async () => {
    fetcher.mockResolvedValueOnce(reply(true));
    const response = await invoke({ query: { action: ["start", "ignored"] } });
    expect(response.statusCode).toBe(200);
    const consent = new URL(response.body.authorizationUrl);
    const [url, options] = fetcher.mock.calls[0];
    const saved = JSON.parse(options.body);
    expect(url).toBe(`${backendUrl}/rest/v1/rpc/begin_google_drive_oauth`);
    expect(options.headers.Authorization).toBe("Bearer fixture-user-token");
    const startedBinding = /^google_drive_oauth_binding=([A-Za-z0-9_-]{43});/.exec(response.headers["Set-Cookie"])[1];
    expect(saved.p_state_hash).toBe(createHash("sha256").update(`${consent.searchParams.get("state")}.${startedBinding}`).digest("hex"));
    expect(consent.searchParams.get("code_challenge")).toBe(createHash("sha256").update(saved.p_code_verifier).digest("base64url"));
    expect(saved.p_redirect_uri).toBe(redirectUri);
    expect(Date.parse(saved.p_expires_at) - Date.now()).toBeGreaterThan(590_000);
    expect(consent.origin).toBe("https://accounts.google.com");
    expect(consent.searchParams.get("client_id")).toBe("fixture-client");
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it.each([[401, "not authorized"], [403, "not authorized"], [404, "not configured"], [413, "google drive file is too large for this screen"], [429, "google drive is busy; try again later"], [502, "google drive request failed"]])("maps consent RPC failure %i to a bounded public response", async (status, error) => {
    fetcher.mockResolvedValueOnce(reply({ sensitive: "provider details" }, status));
    expect(await invoke({ query: { action: "start" } })).toMatchObject({ statusCode: status, body: { error } });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("redirects incomplete and mismatched callbacks without exchanging credentials", async () => {
    const missing = await invoke({ method: "GET", query: { action: "callback", code: [""] } });
    expect(missing).toMatchObject({ statusCode: 302, headers: { Location: `${PORTAL_ORIGIN}/m/organize?drive=failed` } });
    expect(fetcher).not.toHaveBeenCalled();
    fetcher.mockResolvedValueOnce(reply({ redirectUri: "https://other.invalid/callback" }));
    const mismatch = await invoke({ method: "GET", query: {}, url: "/api/google-drive?action=callback&code=fixture-code&state=fixture-state" });
    expect(mismatch.headers.Location).toBe(missing.headers.Location);
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(JSON.parse(fetcher.mock.calls[0][1].body)).toEqual({ p_state: `fixture-state.${binding}` });
  });

  it.each([
    ["invalid_callback", { action: "callback", state: "fixture-state" }, []],
    ["provider_denied", { action: "callback", error: "access_denied", state: "fixture-state" }, []],
    ["state_claim_failed", { action: "callback", code: "fixture-code", state: "fixture-state" }, [reply({ message: "fixture-body" }, 400)]],
    ["redirect_mismatch", { action: "callback", code: "fixture-code", state: "fixture-state" }, [reply({ redirectUri: "https://other.invalid/callback" })]],
    ["code_exchange_failed", { action: "callback", code: "fixture-code", state: "fixture-state" }, [
      reply({ redirectUri, codeVerifier: "fixture-verifier", organizationId: "fixture-org", userId: "fixture-user" }),
      reply({ error: "invalid_grant" }, 400),
    ]],
    ["root_folder_failed", { action: "callback", code: "fixture-code", state: "fixture-state" }, [
      reply({ redirectUri, codeVerifier: "fixture-verifier", organizationId: "fixture-org", userId: "fixture-user" }),
      reply({ access_token: "fixture-access", refresh_token: "fixture-refresh", scope: "drive.file" }),
      reply({ error: "fixture-body" }, 500),
    ]],
    ["credential_store_failed", { action: "callback", code: "fixture-code", state: "fixture-state" }, [
      reply({ redirectUri, codeVerifier: "fixture-verifier", organizationId: "fixture-org", userId: "fixture-user" }),
      reply({ access_token: "fixture-access", refresh_token: "fixture-refresh", scope: "drive.file" }),
      reply({ files: [{ id: "fixture-root" }] }),
      reply({ message: "fixture-body" }, 500),
    ]],
  ])("logs the %s callback failure class without OAuth or identity values", async (reason, query, replies) => {
    const logger = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      for (const fixture of replies) fetcher.mockResolvedValueOnce(fixture);
      const failed = await invoke({ method: "GET", query });
      expect(failed.headers.Location).toBe(`${PORTAL_ORIGIN}/m/organize?drive=failed`);
      expect(logger).toHaveBeenCalledTimes(1);
      expect(logger).toHaveBeenCalledWith("[google-drive]", { kind: "callback_refused", reason });
      expect(JSON.stringify(logger.mock.calls)).not.toMatch(/fixture-(code|state|verifier|org|user|access|refresh|body|secret)|invalid_grant/);
    } finally {
      logger.mockRestore();
    }
  });

  it("completes an OAuth callback with claimed identity, PKCE, and a folder scoped credential", async () => {
    fetcher.mockResolvedValueOnce(reply({ redirectUri, codeVerifier: "fixture-verifier", organizationId: "fixture-org", userId: "fixture-user" }))
      .mockResolvedValueOnce(reply({
        access_token: "fixture-access", refresh_token: "fixture-refresh", scope: "drive.file",
        id_token: idToken({
          iss: "https://accounts.google.com", aud: "fixture-client", email_verified: true,
          email: "Steward@Example.Test", exp: Math.floor(Date.now() / 1000) + 300,
        }),
      }))
      .mockResolvedValueOnce(reply({ files: [{ id: "fixture-root" }] }))
      .mockResolvedValueOnce(reply(true));
    expect(await invoke({ method: "GET", query: { action: "callback", code: "fixture-code", state: "fixture-state" } })).toMatchObject({
      statusCode: 302, headers: { Location: `${PORTAL_ORIGIN}/m/organize?drive=connected` },
    });
    const exchange = fetcher.mock.calls[1][1].body;
    expect(exchange.get("code")).toBe("fixture-code");
    expect(exchange.get("code_verifier")).toBe("fixture-verifier");
    const [url, options] = fetcher.mock.calls[3];
    expect(url).toBe(`${backendUrl}/rest/v1/rpc/complete_google_drive_oauth`);
    expect(options.headers.apikey).toBe("sb_secret_fixture");
    expect(options.headers.Authorization).toBeUndefined();
    expect(JSON.parse(options.body)).toEqual({ p_organization_id: "fixture-org", p_user_id: "fixture-user", p_refresh_token: "fixture-refresh", p_scopes: "drive.file", p_account_email: "steward@example.test", p_root_folder_id: "fixture-root" });
  });

  it("stores no account identity when the callback identity token is unusable", async () => {
    fetcher.mockResolvedValueOnce(reply({ redirectUri, codeVerifier: "fixture-verifier", organizationId: "fixture-org", userId: "fixture-user" }))
      .mockResolvedValueOnce(reply({
        access_token: "fixture-access", refresh_token: "fixture-refresh", scope: "drive.file",
        id_token: idToken({
          iss: "https://accounts.google.com", aud: "other-client", email_verified: true,
          email: "attacker@example.test", exp: Math.floor(Date.now() / 1000) + 300,
        }),
      }))
      .mockResolvedValueOnce(reply({ files: [{ id: "fixture-root" }] }))
      .mockResolvedValueOnce(reply(true));
    expect(await invoke({ method: "GET", query: { action: "callback", code: "fixture-code", state: "fixture-state" } })).toMatchObject({
      statusCode: 302, headers: { Location: `${PORTAL_ORIGIN}/m/organize?drive=connected` },
    });
    expect(JSON.parse(fetcher.mock.calls[3][1].body).p_account_email).toBe("");
  });

  it("authorizes the requested operation before reading a service credential and listing", async () => {
    authorize();
    fetcher.mockResolvedValueOnce(reply({ files: [{ id: "fixture-file", name: "Notes", mimeType: "text/plain", size: "4", webViewLink: "https://drive.google.com/fixture" }] }));
    expect(await invoke({ query: {} })).toMatchObject({ statusCode: 200, body: { files: [{ id: "fixture-file", name: "Notes", mimeType: "text/plain", size: 4, modifiedTime: null, webViewLink: "https://drive.google.com/fixture" }] } });
    expect(JSON.parse(fetcher.mock.calls[0][1].body)).toEqual({ p_action: "list" });
    expect(fetcher.mock.calls[0][1].headers.Authorization).toBe("Bearer fixture-user-token");
    expect(JSON.parse(fetcher.mock.calls[1][1].body)).toEqual({ p_organization_id: "fixture-organization" });
    expect(fetcher.mock.calls[1][1].headers.apikey).toBe("sb_secret_fixture");
    expect(fetcher.mock.calls[2][1].body.get("refresh_token")).toBe("fixture-refresh");
    expect(new URL(fetcher.mock.calls[3][0]).searchParams.get("q")).toContain("'authorized-root' in parents");
  });

  it("stops rate-limited callers before reading service credentials", async () => {
    fetcher.mockResolvedValueOnce(reply({ rateLimited: true }));
    expect(await invoke()).toMatchObject({ statusCode: 429, body: { error: "google drive is busy; try again later" } });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("returns bounded failures for missing folder configuration and transport errors", async () => {
    authorize({ authorization: { organizationId: "fixture-org" }, credential: { refreshToken: "fixture-refresh" } });
    expect(await invoke()).toMatchObject({ statusCode: 503, body: { error: "google drive request failed" } });
    fetcher.mockRejectedValueOnce(new Error("sensitive transport details"));
    expect(await invoke()).toMatchObject({ statusCode: 500, body: { error: "google drive request failed" } });
  });

  it.each([undefined, "!invalid", "A".repeat(4 * 1024 * 1024 + 4)])("rejects invalid upload content without sending a file", async (contentBase64) => {
    authorize();
    expect(await invoke({ query: { action: "upload" }, body: { contentBase64 } })).toMatchObject({ statusCode: 413, body: { error: "drive upload must be between 1 byte and 3 MB" } });
    expect(fetcher).toHaveBeenCalledTimes(3);
  });

  it("uploads decoded bytes into the credential folder when authorization has no folder", async () => {
    authorize({ authorization: { organizationId: "fixture-org" } });
    fetcher.mockResolvedValueOnce(reply({ id: "uploaded-file", name: "notes.txt" }));
    expect(await invoke({ query: { action: "upload" }, body: { contentBase64: "bm90ZXM=", name: "notes.txt", mimeType: "text/plain" } })).toMatchObject({ statusCode: 200, body: { file: { id: "uploaded-file", name: "notes.txt" } } });
    const [url, options] = fetcher.mock.calls[3];
    expect(url).toContain("upload/drive/v3/files?uploadType=multipart");
    expect(options.headers.Authorization).toBe("Bearer fixture-access");
    expect(options.body.toString()).toContain('"parents":["credential-root"]');
    expect(options.body.toString()).toContain("\r\n\r\nnotes\r\n");
  });

  it("returns base64 only after verifying download membership in the authorized folder", async () => {
    authorize();
    fetcher.mockResolvedValueOnce(reply({ parents: ["authorized-root"], size: "5" }))
      .mockResolvedValueOnce(new Response("notes"));
    expect(await invoke({ query: { action: "download" }, body: { fileId: "fixture-file" } })).toMatchObject({ statusCode: 200, body: { contentBase64: "bm90ZXM=" } });
    expect(String(fetcher.mock.calls[3][0])).toContain("fixture-file?fields=id,parents,size");
    expect(String(fetcher.mock.calls[4][0])).toContain("fixture-file?alt=media");
  });

  it("returns an explicit unknown-action response after authorization", async () => {
    authorize();
    expect(await invoke({ query: { action: "unknown" } })).toMatchObject({ statusCode: 404, body: { error: "unknown google drive action" } });
    expect(JSON.parse(fetcher.mock.calls[0][1].body)).toEqual({ p_action: "unknown" });
    expect(fetcher).toHaveBeenCalledTimes(3);
  });
});
