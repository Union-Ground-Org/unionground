// @vitest-environment node
import { createHash } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import customerApi from "../api/customer-api.js";
import scimApi from "../api/scim.js";
import { SUPABASE_ORIGIN, SUPABASE_REF } from "./helpers/fictional-provider.js";
vi.mock("../src/lib/trustedBackends.js", async () =>
  (await import("./helpers/fictional-provider.js")).trustedBackendsModule());

const backend = SUPABASE_ORIGIN;
const organizationId = "11111111-1111-4111-8111-111111111111";
const groupId = "22222222-2222-4222-8222-222222222222";
const schemes = ["Bearer", "bearer", "BEARER", "bEaReR"];
const endpoints = [
  { name: "customer API", handler: customerApi, token: `ug_live_${"ab".repeat(24)}`, method: "GET", status: 200, rpc: "authenticate_integration_api_key", field: "p_key_hash" },
  { name: "SCIM", handler: scimApi, token: `ug_scim_${"cd".repeat(24)}`, method: "DELETE", status: 204, rpc: "scim_authenticate", field: "p_token_hash" },
];
let fetcher;

async function invoke(endpoint, authorization, headers = {}) {
  const response = {
    statusCode: 0, headers: {},
    status(code) { this.statusCode = code; return this; },
    setHeader(name, value) { this.headers[name] = value; return this; },
    end(value) { this.body = value === undefined ? undefined : JSON.parse(value); },
  };
  await endpoint.handler({ method: endpoint.method, url: `/scim/v2/Groups/${groupId}`,
    headers: { host: "app.unionground.test", authorization, ...headers },
  }, response);
  return response;
}

beforeEach(() => {
  for (const [key, value] of Object.entries({
    VITE_SUPABASE_URL: backend, UNIONGROUND_SUPABASE_PROJECT_REF: SUPABASE_REF, VITE_SUPABASE_PUBLISHABLE_KEY: "sb_publishable_fixture",
    SUPABASE_SERVICE_ROLE_KEY: "sb_secret_fixture", RESEND_API_KEY: "re_fixture",
    NOTIFY_FROM_ADDRESS: "no-reply@unionground.test", INVITATION_APP_ORIGIN: "https://app.unionground.test",
  })) vi.stubEnv(key, value);
  fetcher = vi.fn(async (url) => {
    const result = url.endsWith("/scim_authenticate") ? { state: "ok", organizationId }
      : url.endsWith("/authenticate_integration_api_key") ? { organizationId, keyId: "fixture-key" }
        : url.endsWith("/scim_delete_group") ? { deleted: true } : undefined;
    if (!result) throw new Error("Unexpected external request");
    return new Response(JSON.stringify(result));
  });
  vi.stubGlobal("fetch", fetcher);
});
afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); });

describe.each(endpoints)("$name bearer scheme through the actual handler", (endpoint) => {
  it.each(schemes)("authenticates %s without changing the credential digest", async (scheme) => {
    const result = await invoke(endpoint, `${scheme} ${endpoint.token}`);
    expect(result.statusCode).toBe(endpoint.status);
    expect(result.headers["Cache-Control"]).toBe("no-store");
    expect(fetcher.mock.calls[0][0]).toBe(`${backend}/rest/v1/rpc/${endpoint.rpc}`);
    expect(JSON.parse(fetcher.mock.calls[0][1].body)).toEqual({
      [endpoint.field]: createHash("sha256").update(endpoint.token).digest("hex"),
    });
    if (endpoint.name === "SCIM") {
      expect(JSON.parse(fetcher.mock.calls[1][1].body)).toEqual({ p_organization_id: organizationId, p_group_id: groupId });
    }
    expect(fetcher).toHaveBeenCalledTimes(endpoint.name === "SCIM" ? 2 : 1);
  });

  it.each(["", "Basic credential", "Bearer ", "Bearer", "Bearer\tcredential", "Bearers credential"])("rejects a missing or malformed credential (%s)", async (authorization) => {
    // A trusted Origin reaches token validation even for a malformed scheme.
    expect((await invoke(endpoint, authorization, { origin: "https://app.unionground.test" })).statusCode).toBe(401);
    expect(fetcher).not.toHaveBeenCalled();
  });
});

describe("SCIM browser mutations with scheme variants", () => {
  it.each(schemes)("keeps Origin and Fetch Metadata refusals authoritative for %s", async (scheme) => {
    const endpoint = endpoints[1];
    for (const headers of [
      { origin: "https://attacker.invalid" }, { cookie: "session=fixture" },
      { referer: "https://app.unionground.test/m" }, { "sec-fetch-site": "same-origin" },
      { "sec-fetch-mode": "cors" }, { "sec-fetch-dest": "empty" },
    ]) {
      expect((await invoke(endpoint, `${scheme} ${endpoint.token}`, headers)).statusCode).toBe(403);
    }
    expect(fetcher).not.toHaveBeenCalled();
  });
});
