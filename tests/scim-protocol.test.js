// @vitest-environment node
//
// REQ-UG-SCIM-PROVISIONING-20261001: SCIM 2.0 protocol conformance for
// api/scim.js and api/_lib/scim.js with a mocked database. The live
// provisioning semantics (invitations, deprovisioning, tenant isolation) are
// proven against a disposable database in tests/scim-provisioning-db.test.js.
import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { PORTAL_HOST, PORTAL_ORIGIN, SAMPLE_HOST } from "./helpers/fictional-provider.js";
import { createScimHandler } from "../api/scim.js";
import {
  SCHEMA_ERROR, SCHEMA_GROUP, SCHEMA_LIST, SCHEMA_USER, applyGroupPatch, applyUserPatch, normalizeUser,
  parseFilter, routeOf,
} from "../api/_lib/scim.js";

// Union Ground ships no trusted backend pair; the fictional pair stands in.
vi.mock("../src/lib/trustedBackends.js", async () => (await import("./helpers/fictional-provider.js")).trustedBackendsModule("https://project.supabase.co"));

const ORG = "11111111-1111-4111-8111-111111111111";
const USER_ID = "22222222-2222-4222-8222-222222222222";
const GROUP_ID = "33333333-3333-4333-8333-333333333333";
const TOKEN = `ug_scim_${"ab".repeat(24)}`;
const ENV = {
  VITE_SUPABASE_URL: "https://project.supabase.co", UNIONGROUND_SUPABASE_PROJECT_REF: "project",
  VITE_SUPABASE_PUBLISHABLE_KEY: "sb_publishable_test",
  SUPABASE_SERVICE_ROLE_KEY: "sb_secret_test",
  RESEND_API_KEY: "re_test",
  NOTIFY_FROM_ADDRESS: `Union Ground <no-reply@${PORTAL_HOST}>`,
  INVITATION_APP_ORIGIN: PORTAL_ORIGIN,
};

function userRow(overrides = {}) {
  return {
    id: USER_ID, externalId: "00u1", userName: "ana@example.org", givenName: "Ana", familyName: "Example",
    displayName: "Ana Example", active: true, locale: "en", state: "invited", stateReason: null, version: 1,
    createdAt: "2026-10-02T10:00:00Z", updatedAt: "2026-10-02T10:00:00Z", ...overrides,
  };
}

function groupRow(overrides = {}) {
  return {
    id: GROUP_ID, externalId: null, displayName: "Stewards", version: 1,
    createdAt: "2026-10-02T10:00:00Z", updatedAt: "2026-10-02T10:00:00Z",
    members: [{ value: USER_ID, display: "Ana Example" }], ...overrides,
  };
}

function setup(rpcResults = {}, { authenticate = { state: "ok", organizationId: ORG, tokenId: "t" } } = {}) {
  const calls = [];
  const rpc = vi.fn(async (_url, _key, _token, name, body) => {
    calls.push({ name, body });
    if (name === "scim_authenticate") return authenticate;
    const result = rpcResults[name];
    if (result instanceof Error) throw result;
    return typeof result === "function" ? result(body) : result ?? null;
  });
  const sendInvitation = vi.fn(async () => true);
  const handler = createScimHandler({ rpc, sendInvitation, env: ENV });
  return { handler, rpc, calls, sendInvitation };
}

async function request(handler, { method = "GET", path = "Users", query = {}, body, headers = {} } = {}) {
  const response = {
    statusCode: 0, headers: {}, body: undefined,
    status(code) { this.statusCode = code; return this; },
    setHeader(name, value) { this.headers[name.toLowerCase()] = value; return this; },
    end(payload) { this.body = payload === undefined ? undefined : JSON.parse(payload); return this; },
  };
  await handler({
    method,
    url: `/scim/v2/${path}`,
    query: { scimPath: path, ...query },
    headers: { host: PORTAL_HOST, authorization: `Bearer ${TOKEN}`, "content-type": "application/scim+json", ...headers },
    body,
  }, response);
  return response;
}

describe("SCIM endpoint authentication", () => {
  it("demands the bearer token and digests it before the database sees it", async () => {
    const { handler, calls } = setup();
    const missing = await request(handler, { headers: { authorization: "" } });
    expect(missing.statusCode).toBe(401);
    expect(missing.headers["www-authenticate"]).toBe("Bearer");
    expect(missing.body.schemas).toEqual([SCHEMA_ERROR]);
    const malformed = await request(handler, { headers: { authorization: "Bearer ug_live_123" } });
    expect(malformed.statusCode).toBe(401);
    expect(calls).toHaveLength(0);

    await request(handler, { query: {} });
    expect(calls[0]).toEqual({ name: "scim_authenticate", body: { p_token_hash: createHash("sha256").update(TOKEN).digest("hex") } });
    expect(JSON.stringify(calls)).not.toContain(TOKEN);
  });

  it("answers 401 for an unknown token, 403 when switched off and 429 over the budget", async () => {
    expect((await request(setup({}, { authenticate: null }).handler)).statusCode).toBe(401);
    const off = await request(setup({}, { authenticate: { state: "disabled" } }).handler);
    expect(off.statusCode).toBe(403);
    expect(off.body.detail).toContain("switched off");
    const limited = await request(setup({}, { authenticate: { state: "limited" } }).handler);
    expect(limited.statusCode).toBe(429);
    expect(limited.headers["retry-after"]).toBe("60");
    const down = setup();
    down.rpc.mockRejectedValueOnce(new Error("down"));
    expect((await request(down.handler)).statusCode).toBe(503);
  });

  it("refuses a browser-origin request and the SAMPLE host", async () => {
    const { handler, calls } = setup();
    const browser = await request(handler, { method: "POST", headers: { origin: "https://evil.example", cookie: "a=b" }, body: {} });
    expect(browser.statusCode).toBe(403);
    const sample = await request(handler, { headers: { host: SAMPLE_HOST } });
    expect(sample.statusCode).toBe(404);
    expect(calls).toHaveLength(0);
  });

  it("never accepts an organization from the caller", async () => {
    const { handler, calls } = setup({ scim_list_users: { totalResults: 0, items: [] } });
    await request(handler, { query: { organizationId: "99999999-9999-4999-8999-999999999999", filter: 'userName eq "a@b.org"' } });
    expect(calls[1].body.p_organization_id).toBe(ORG);
  });
});

describe("SCIM discovery", () => {
  it("serves ServiceProviderConfig, ResourceTypes and Schemas", async () => {
    const { handler } = setup();
    const config = await request(handler, { path: "ServiceProviderConfig" });
    expect(config.statusCode).toBe(200);
    expect(config.headers["content-type"]).toBe("application/scim+json");
    expect(config.body).toMatchObject({ patch: { supported: true }, bulk: { supported: false }, filter: { supported: true, maxResults: 200 } });
    expect(config.body.authenticationSchemes[0].type).toBe("oauthbearertoken");
    const types = await request(handler, { path: "ResourceTypes" });
    expect(types.body.schemas).toEqual([SCHEMA_LIST]);
    expect(types.body.Resources.map((item) => item.endpoint)).toEqual(["/Users", "/Groups"]);
    expect((await request(handler, { path: "ResourceTypes/User" })).body.schema).toBe(SCHEMA_USER);
    const schema = await request(handler, { path: `Schemas/${SCHEMA_GROUP}` });
    expect(schema.body.attributes.map((item) => item.name)).toEqual(["displayName", "externalId", "members"]);
    const userSchema = await request(handler, { path: `Schemas/${SCHEMA_USER}` });
    expect(userSchema.body.attributes.find((item) => item.name === "emails")).toMatchObject({
      mutability: "readWrite", description: expect.stringContaining("shared with userName"),
    });
    expect((await request(handler, { method: "POST", path: "Schemas", body: {} })).statusCode).toBe(405);
    expect((await request(handler, { path: "Bulk" })).statusCode).toBe(404);
  });
});

describe("SCIM resource path validation", () => {
  it.each(["Users/%", "Users/%E0%A4", "Groups/%ZZ", "Schemas/%C3%28"])("answers a SCIM error instead of throwing for %s", async (path) => {
    const { handler, calls } = setup();
    const res = await request(handler, { path });
    expect(res.statusCode).toBe(404);
    expect(res.headers["content-type"]).toBe("application/scim+json");
    expect(res.headers["cache-control"]).toBe("no-store");
    expect(res.body).toEqual({ schemas: [SCHEMA_ERROR], status: "404", detail: "unknown SCIM resource" });
    expect(calls.map((call) => call.name)).toEqual(["scim_authenticate"]);
  });

  it("still resolves a valid percent-encoded User id through the scoped RPC", async () => {
    const { handler, calls } = setup({ scim_get_user: userRow() });
    const res = await request(handler, { path: `Users/%32${USER_ID.slice(1)}` });
    expect(res.statusCode).toBe(200);
    expect(res.body.id).toBe(USER_ID);
    expect(calls[1]).toEqual({ name: "scim_get_user", body: { p_organization_id: ORG, p_user_id: USER_ID } });
  });

  it("still discovers a percent-encoded schema identifier", async () => {
    const { handler } = setup();
    const res = await request(handler, { path: `Schemas/${encodeURIComponent(SCHEMA_USER)}` });
    expect(res.statusCode).toBe(200);
    expect(res.body.id).toBe(SCHEMA_USER);
  });
});

describe("SCIM Users", () => {
  it("lists with the userName eq filter and 1-based paging", async () => {
    const { handler, calls } = setup({ scim_list_users: { totalResults: 1, items: [userRow()] } });
    const listed = await request(handler, { query: { filter: 'userName eq "Ana@Example.org"', startIndex: "1", count: "500" } });
    expect(listed.statusCode).toBe(200);
    expect(calls[1].body).toEqual({ p_organization_id: ORG, p_field: "userName", p_value: "ana@example.org", p_start_index: 1, p_count: 200 });
    expect(listed.body).toMatchObject({ schemas: [SCHEMA_LIST], totalResults: 1, startIndex: 1, itemsPerPage: 1 });
    const resource = listed.body.Resources[0];
    expect(resource).toMatchObject({
      schemas: [SCHEMA_USER], id: USER_ID, userName: "ana@example.org", active: true,
      name: { givenName: "Ana", familyName: "Example" },
      emails: [{ value: "ana@example.org", type: "work", primary: true }],
      meta: { resourceType: "User", location: `${PORTAL_ORIGIN}/scim/v2/Users/${USER_ID}`, version: 'W/"1"' },
    });
    const bad = await request(handler, { query: { filter: 'userName co "ana"' } });
    expect(bad.statusCode).toBe(400);
    expect(bad.body.scimType).toBe("invalidFilter");
  });

  it("creates a user, emails the invitation and records delivery without exposing the invitation secret", async () => {
    const { handler, calls, sendInvitation } = setup({
      scim_upsert_user: { outcome: "created", user: userRow(), invitation: { send: true, invitationId: "44444444-4444-4444-8444-444444444444", deliveryVersion: 1, email: "ana@example.org", locale: "es" } },
      scim_record_invitation_delivery: { recorded: true },
    });
    const created = await request(handler, {
      method: "POST", path: "Users",
      body: { schemas: [SCHEMA_USER], userName: "Ana@Example.org", name: { givenName: "Ana", familyName: "Example" }, preferredLanguage: "es-US", externalId: "00u1" },
    });
    expect(created.statusCode).toBe(201);
    expect(created.headers.location).toBe(`${PORTAL_ORIGIN}/scim/v2/Users/${USER_ID}`);
    const upsert = calls.find((call) => call.name === "scim_upsert_user").body;
    expect(upsert).toMatchObject({ p_organization_id: ORG, p_user_id: null, p_user: { userName: "ana@example.org", locale: "es", active: true, externalId: "00u1" } });
    expect(upsert.p_token_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(sendInvitation).toHaveBeenCalledTimes(1);
    const mail = sendInvitation.mock.calls[0][0];
    expect(mail).toMatchObject({ to: "ana@example.org", locale: "es", appOrigin: PORTAL_ORIGIN, deliveryVersion: 1 });
    expect(mail.names).toEqual({ source: "scim" });
    expect(mail.organizationLookup).toEqual({
      supabaseUrl: ENV.VITE_SUPABASE_URL, serviceKey: ENV.SUPABASE_SERVICE_ROLE_KEY, organizationId: ORG,
    });
    const secret = new URL(mail.link).hash.replace("#invite=", "");
    expect(createHash("sha256").update(secret).digest("hex")).toBe(upsert.p_token_hash);
    expect(JSON.stringify(created.body)).not.toContain(secret);
    expect(calls.find((call) => call.name === "scim_record_invitation_delivery").body).toMatchObject({ p_outcome: "sent", p_organization_id: ORG });
  });

  it("records a failed delivery and still answers the provider", async () => {
    const { handler, calls, sendInvitation } = setup({
      scim_upsert_user: { outcome: "created", user: userRow(), invitation: { send: true, invitationId: "44444444-4444-4444-8444-444444444444", deliveryVersion: 1, email: "ana@example.org", locale: "en" } },
    });
    sendInvitation.mockResolvedValueOnce(false);
    const created = await request(handler, { method: "POST", path: "Users", body: { userName: "ana@example.org" } });
    expect(created.statusCode).toBe(201);
    expect(calls.find((call) => call.name === "scim_record_invitation_delivery").body.p_outcome).toBe("failed");
  });

  // BUG-UG-SCIM-CONCURRENT-GROUP-PATCH-LOST-MEMBERS-20261020: two PATCHes
  // that read the same snapshot must not let the later replacement drop the
  // earlier one's member. The fake follows the database contract: a write that
  // names a stale version changes nothing and answers version_conflict.
  describe("concurrent group PATCH", () => {
    const OTHER = "44444444-4444-4444-8444-444444444444";
    const THIRD = "55555555-5555-4555-8555-555555555555";
    const database = () => {
      const state = { version: 1, displayName: "Stewards", members: [] };
      let reads = 0;
      let release;
      const barrier = new Promise((resolve) => { release = resolve; });
      const rpcResults = {
        scim_get_group: async () => {
          const snapshot = groupRow({ version: state.version, displayName: state.displayName, members: state.members.map((value) => ({ value })) });
          reads += 1;
          if (reads === 2) release();
          if (reads <= 2) await barrier;
          return snapshot;
        },
        scim_upsert_group: (body) => {
          if (body.p_expected_version !== undefined && body.p_expected_version !== state.version) {
            return { outcome: "version_conflict", version: state.version };
          }
          Object.assign(state, { version: state.version + 1, displayName: body.p_display_name, members: [...body.p_members] });
          return { outcome: "updated", group: groupRow({ version: state.version, displayName: state.displayName, members: state.members.map((value) => ({ value })) }) };
        },
      };
      return { state, rpcResults };
    };
    const patch = (handler, operations) => request(handler, { method: "PATCH", path: `Groups/${GROUP_ID}`, body: { Operations: operations } });

    it("keeps both members when two additions read the same group", async () => {
      const { state, rpcResults } = database();
      const { handler, calls } = setup(rpcResults);
      const [first, second] = await Promise.all([
        patch(handler, [{ op: "add", path: "members", value: [{ value: USER_ID }] }]),
        patch(handler, [{ op: "add", path: "members", value: [{ value: OTHER }] }]),
      ]);
      expect([first.statusCode, second.statusCode]).toEqual([200, 200]);
      expect([...state.members].sort()).toEqual([USER_ID, OTHER].sort());
      // Every write named the version it read; one of them was refused and reapplied.
      const writes = calls.filter((call) => call.name === "scim_upsert_group");
      expect(writes.every((call) => Number.isInteger(call.body.p_expected_version))).toBe(true);
      expect(writes).toHaveLength(3);
    });

    it("keeps a concurrent rename and a member addition", async () => {
      const { state, rpcResults } = database();
      const { handler } = setup(rpcResults);
      await Promise.all([
        patch(handler, [{ op: "replace", path: "displayName", value: "Chapter stewards" }]),
        patch(handler, [{ op: "add", path: "members", value: [{ value: THIRD }] }]),
      ]);
      expect(state).toMatchObject({ displayName: "Chapter stewards", members: [THIRD] });
    });

    it("answers an honest 409 when the group keeps changing", async () => {
      const { handler, calls } = setup({
        scim_get_group: groupRow({ version: 1 }),
        scim_upsert_group: { outcome: "version_conflict", version: 9 },
      });
      const out = await patch(handler, [{ op: "add", path: "members", value: [{ value: OTHER }] }]);
      expect(out.statusCode).toBe(409);
      expect(out.body.detail).toMatch(/changed while this request was applied/u);
      expect(calls.filter((call) => call.name === "scim_upsert_group")).toHaveLength(3);
    });

    it("writes as before when the database has no version guard yet", async () => {
      const missing = Object.assign(new Error("scim_upsert_group-failed"), { status: 404, code: "PGRST202" });
      const { handler, calls } = setup({
        scim_get_group: groupRow({ version: 1 }),
        scim_upsert_group: (body) => {
          if (body.p_expected_version !== undefined) throw missing;
          return { outcome: "updated", group: groupRow({ version: 2 }) };
        },
      });
      const out = await patch(handler, [{ op: "add", path: "members", value: [{ value: OTHER }] }]);
      expect(out.statusCode).toBe(200);
      const writes = calls.filter((call) => call.name === "scim_upsert_group");
      expect(writes.map((call) => "p_expected_version" in call.body)).toEqual([true, false]);
    });

    it("never sends a version on POST or PUT", async () => {
      const { handler, calls } = setup({ scim_upsert_group: { outcome: "created", group: groupRow() } });
      await request(handler, { method: "POST", path: "Groups", body: { displayName: "Stewards" } });
      await request(handler, { method: "PUT", path: `Groups/${GROUP_ID}`, body: { displayName: "Stewards" } });
      expect(calls.filter((call) => call.name === "scim_upsert_group").every((call) => !("p_expected_version" in call.body))).toBe(true);
    });
  });

  it("maps conflicts, missing users, invalid bodies and the invitation budget to SCIM errors", async () => {
    const conflict = await request(setup({ scim_upsert_user: { outcome: "conflict" } }).handler, { method: "POST", path: "Users", body: { userName: "ana@example.org" } });
    expect(conflict.statusCode).toBe(409);
    expect(conflict.body.scimType).toBe("uniqueness");
    const missing = await request(setup({ scim_get_user: null }).handler, { path: `Users/${USER_ID}` });
    expect(missing.statusCode).toBe(404);
    const invalid = await request(setup().handler, { method: "POST", path: "Users", body: { userName: "not an address" } });
    expect(invalid.statusCode).toBe(400);
    const notJson = await request(setup().handler, { method: "POST", path: "Users", body: "{" });
    expect(notJson.body.scimType).toBe("invalidSyntax");
    const budget = Object.assign(new Error("scim_upsert_user-failed"), { status: 400, code: "P0001" });
    const limited = await request(setup({ scim_upsert_user: budget }).handler, { method: "POST", path: "Users", body: { userName: "ana@example.org" } });
    expect(limited.statusCode).toBe(429);
    expect(limited.headers["retry-after"]).toBe("3600");
  });

  // BUG-UG-SCIM-CONFLICT-LABELS-AND-EMAIL-SELECTOR-TRIM-20261021: the database
  // names the constraint that refused the write (20261022061913), so a binding
  // collision is not reported as a duplicate userName, and a concurrent group
  // create is a displayName conflict rather than an account-binding one.
  it("reports each SCIM conflict by the constraint that refused it", async () => {
    const user = async (result) => (await request(setup({ scim_upsert_user: result }).handler,
      { method: "POST", path: "Users", body: { userName: "ana@example.org" } })).body;
    expect(await user({ outcome: "conflict", conflict: "binding" })).toMatchObject({ status: "409", scimType: "uniqueness",
      detail: "the account already has a SCIM identity in this organization" });
    expect(await user({ outcome: "conflict", conflict: "userName" })).toMatchObject({ status: "409", detail: "a User with this userName already exists" });
    expect(await user({ outcome: "conflict", conflict: "other" })).toMatchObject({ status: "409", detail: "the User conflicts with an existing directory record" });
    // A database without the label still answers as a userName conflict.
    expect(await user({ outcome: "conflict" })).toMatchObject({ status: "409", detail: "a User with this userName already exists" });
    const group = await request(setup({ scim_upsert_group: { outcome: "conflict" } }).handler,
      { method: "POST", path: "Groups", body: { displayName: "Stewards" } });
    expect(group.body).toMatchObject({ status: "409", scimType: "uniqueness", detail: "a Group with this displayName already exists" });
  });

  it("matches an email value selector against the trimmed userName a padded PATCH just set", () => {
    const current = { userName: "old@example.org", emails: [{ value: "old@example.org", primary: true, type: "work" }], name: {}, active: true };
    for (const selector of ['emails[value eq "new@example.org"].value', 'emails[value eq "  new@example.org  "].value']) {
      const next = applyUserPatch(current, { Operations: [{ op: "replace", path: "userName", value: "  new@example.org  " },
        { op: "replace", path: selector, value: "work@example.org" }] });
      expect(next.emails).toEqual([{ value: "work@example.org", type: "work", primary: true }]);
    }
  });

  it.each(["POST", "PUT", "PATCH", "DELETE"])("reports a database identity uniqueness refusal as SCIM 409 on %s", async (method) => {
    const duplicate = Object.assign(new Error("bound account already has a SCIM identity"), { status: 409, code: "23505" });
    const { handler, sendInvitation } = setup({ scim_get_user: userRow(), scim_upsert_user: duplicate, scim_delete_user: duplicate });
    const response = await request(handler, {
      method, path: method === "POST" ? "Users" : `Users/${USER_ID}`,
      body: method === "PATCH" ? { Operations: [{ op: "replace", path: "active", value: false }] } : { userName: "ana@example.org" },
    });
    expect(response.statusCode).toBe(409);
    expect(response.body).toMatchObject({ schemas: [SCHEMA_ERROR], status: "409", scimType: "uniqueness" });
    expect(sendInvitation).not.toHaveBeenCalled();
  });

  // REQ-UG-BLOCK-GOVERNMENT-AND-EMPLOYER-EMAIL-DOMAINS-20261102.
  it("refuses to provision a government address and calls no write", async () => {
    const { handler, calls, sendInvitation } = setup({ open_signup_email_available: true, scim_upsert_user: { outcome: "created", user: userRow() } });
    const created = await request(handler, { method: "POST", path: "Users", body: { userName: "ana@agency.gov" } });
    expect(created.statusCode).toBe(400);
    expect(created.body).toMatchObject({ scimType: "invalidValue", detail: expect.stringContaining("personal email address") });
    expect(calls.some((call) => call.name === "scim_upsert_user")).toBe(false);
    expect(sendInvitation).not.toHaveBeenCalled();
  });

  it("refuses a PATCH that moves a User to a government address", async () => {
    const { handler, calls } = setup({ open_signup_email_available: true, scim_get_user: userRow(), scim_upsert_user: ({ p_user }) => ({ outcome: "updated", user: userRow(p_user) }) });
    const patched = await request(handler, {
      method: "PATCH", path: `Users/${USER_ID}`,
      body: { Operations: [{ op: "replace", path: "emails", value: [{ value: "ana@army.mil", type: "work", primary: true }] }] },
    });
    expect(patched.statusCode).toBe(400);
    expect(calls.some((call) => call.name === "scim_upsert_user")).toBe(false);
  });

  it("links an existing account on a blocked address that has no SCIM record yet", async () => {
    const { handler, calls } = setup({
      open_signup_email_available: false,
      scim_upsert_user: { outcome: "created", user: userRow({ userName: "former.member@agency.gov" }), invitation: { send: false } },
    });
    const created = await request(handler, { method: "POST", path: "Users", body: { userName: "former.member@agency.gov", active: true } });
    expect(created.statusCode).toBe(201);
    expect(calls.find((call) => call.name === "open_signup_email_available").body)
      .toEqual({ p_email_hash: createHash("sha256").update("former.member@agency.gov").digest("hex") });
    expect(calls.some((call) => call.name === "scim_upsert_user")).toBe(true);
  });

  it("deprovisions a User even when the same write moves it to a blocked address", async () => {
    const results = {
      scim_get_user: userRow({ state: "active" }),
      scim_upsert_user: (body) => ({ outcome: "updated", user: userRow({ userName: body.p_user.userName, active: body.p_user.active, state: "deprovisioned" }), invitation: { send: false } }),
    };
    const { handler, calls } = setup(results);
    const replaced = await request(handler, { method: "PUT", path: `Users/${USER_ID}`, body: { userName: "ana@agency.gov", active: false } });
    expect(replaced.statusCode).toBe(200);
    expect(calls.find((call) => call.name === "scim_upsert_user").body.p_user).toMatchObject({ active: false });
    const patched = await request(setup(results).handler, {
      method: "PATCH", path: `Users/${USER_ID}`,
      body: { Operations: [{ op: "replace", value: { active: false, emails: [{ value: "ana@army.mil", type: "work", primary: true }] } }] },
    });
    expect(patched.statusCode).toBe(200);
  });

  it("still updates and deprovisions a User whose existing address is on a blocked domain", async () => {
    const results = {
      scim_get_user: userRow({ userName: "ana@agency.gov", state: "active" }),
      scim_upsert_user: (body) => ({ outcome: "updated", user: userRow({ userName: body.p_user.userName, active: body.p_user.active, state: "deprovisioned" }), invitation: { send: false } }),
    };
    const { handler, calls } = setup(results);
    const patched = await request(handler, {
      method: "PATCH", path: `Users/${USER_ID}`,
      body: { Operations: [{ op: "replace", value: { active: false } }] },
    });
    expect(patched.statusCode).toBe(200);
    expect(calls.find((call) => call.name === "scim_upsert_user").body.p_user).toMatchObject({ active: false, userName: "ana@agency.gov" });
    const replaced = await request(setup(results).handler, { method: "PUT", path: `Users/${USER_ID}`, body: { userName: "ana@agency.gov", active: false } });
    expect(replaced.statusCode).toBe(200);
  });

  it("applies an Okta deactivation PATCH and an Entra string boolean", async () => {
    const results = { scim_get_user: userRow({ state: "active" }), scim_upsert_user: (body) => ({ outcome: "updated", user: userRow({ active: body.p_user.active, state: "deprovisioned" }), invitation: { send: false } }) };
    const okta = setup(results);
    const patched = await request(okta.handler, {
      method: "PATCH", path: `Users/${USER_ID}`,
      body: { schemas: ["urn:ietf:params:scim:api:messages:2.0:PatchOp"], Operations: [{ op: "replace", value: { active: false } }] },
    });
    expect(patched.statusCode).toBe(200);
    expect(okta.calls.find((call) => call.name === "scim_upsert_user").body.p_user).toMatchObject({ active: false, userName: "ana@example.org" });
    const entra = setup(results);
    await request(entra.handler, {
      method: "PATCH", path: `Users/${USER_ID}`,
      body: { Operations: [{ op: "Replace", path: "active", value: "False" }, { op: "Add", path: "urn:ietf:params:scim:schemas:extension:enterprise:2.0:User:department", value: "Ops" }] },
    });
    expect(entra.calls.find((call) => call.name === "scim_upsert_user").body.p_user.active).toBe(false);
  });

  it.each([
    { op: "replace", path: "emails", value: [{ value: "New@Example.org", type: "work", primary: true }] },
    { op: "replace", path: 'emails[type eq "work"].value', value: "New@Example.org" },
    { op: "replace", path: 'emails[type eq "work"]', value: { value: "New@Example.org" } },
    { op: "replace", path: "emails[primary eq true]", value: { value: "New@Example.org" } },
    { op: "replace", path: "emails[primary eq true].value", value: "New@Example.org" },
    { op: "replace", path: 'emails[value eq "ana@example.org"].value', value: "New@Example.org" },
    { op: "add", path: "emails", value: [{ value: "New@Example.org", primary: true }] },
    { op: "replace", value: { emails: [{ value: "New@Example.org", primary: true }] } },
  ])("persists a work-email PATCH through canonical normalization: $path / $op", async (operation) => {
    const { handler, calls } = setup({
      scim_get_user: userRow(),
      scim_upsert_user: ({ p_user }) => ({ outcome: "updated", user: userRow(p_user), invitation: { send: false } }),
    });
    const patched = await request(handler, {
      method: "PATCH", path: `Users/${USER_ID}`, body: { Operations: [operation] },
    });
    expect(patched.statusCode).toBe(200);
    expect(calls.find((call) => call.name === "scim_upsert_user").body).toMatchObject({
      p_organization_id: ORG, p_user_id: USER_ID, p_user: { userName: "new@example.org", active: true, externalId: "00u1" },
    });
    expect(patched.body.userName).toBe("ana@example.org");
    expect(patched.body.emails).toEqual([{ value: "new@example.org", type: "work", primary: true }]);
  });

  it.each(["invited", "active"])("keeps a divergent directory userName from undoing an email correction (%s)", async (state) => {
    let stored = userRow({ state });
    const { handler, calls } = setup({
      scim_get_user: () => stored,
      scim_upsert_user: ({ p_user }) => {
        stored = userRow({ ...p_user, state });
        return { outcome: "updated", user: stored, invitation: { send: false } };
      },
    });
    for (const operation of [
      { op: "replace", path: 'emails[type eq "work"].value', value: "ana.smith@example.org" },
      { op: "replace", path: "userName", value: "ana@example.org" },
      { op: "replace", path: 'emails[type eq "work"].value', value: "ana.smith@example.org" },
      { op: "replace", path: "userName", value: "ana@example.org" },
    ]) {
      const patched = await request(handler, { method: "PATCH", path: `Users/${USER_ID}`, body: { Operations: [operation] } });
      expect(patched.statusCode).toBe(200);
      expect(patched.body.userName).toBe("ana@example.org");
      expect(patched.body.emails[0].value).toBe("ana.smith@example.org");
    }
    expect(calls.filter((call) => call.name === "scim_upsert_user").map((call) => call.body.p_user.userName))
      .toEqual(Array(4).fill("ana.smith@example.org"));
    const renamed = await request(handler, { method: "PATCH", path: `Users/${USER_ID}`, body: {
      Operations: [{ op: "replace", path: "userName", value: "new-directory@example.org" }],
    } });
    expect(renamed.body).toMatchObject({ userName: "new-directory@example.org", emails: [{ value: "ana.smith@example.org" }] });
  });

  it.each(["invited", "needs_admin"])("round-trips a corrected User through JSON PUT without changing either identity (%s)", async (state) => {
    let stored = userRow();
    const { handler, calls, sendInvitation } = setup({
      scim_get_user: () => stored,
      scim_upsert_user: ({ p_user }) => {
        stored = userRow({ ...p_user, state });
        return { outcome: "updated", user: stored, invitation: { send: false } };
      },
    });
    const patched = await request(handler, { method: "PATCH", path: `Users/${USER_ID}`, body: {
      Operations: [{ op: "replace", path: 'emails[type eq "work"].value', value: "ana.smith@example.org" }],
    } });
    expect(patched.statusCode).toBe(200);
    const read = await request(handler, { path: `Users/${USER_ID}` });
    const replaced = await request(handler, { method: "PUT", path: `Users/${USER_ID}`, body: JSON.stringify(read.body) });
    expect(replaced.statusCode).toBe(200);
    expect(replaced.body).toEqual(patched.body);
    expect(calls.filter((call) => call.name === "scim_upsert_user").map((call) => call.body.p_user))
      .toEqual([expect.objectContaining({ userName: "ana.smith@example.org", directoryUserName: "ana@example.org" }),
        expect.objectContaining({ userName: "ana.smith@example.org", directoryUserName: "ana@example.org" })]);
    expect(sendInvitation).not.toHaveBeenCalled();
  });

  it.each([
    [undefined, "directory@example.org"],
    [[], "directory@example.org"],
    [[{ value: "work@example.org", type: "work" }], "work@example.org"],
    [[{ value: "other@example.org" }, { value: "primary@example.org", primary: true }], "primary@example.org"],
  ])("uses the explicit PUT work email with the legacy userName fallback: %j", async (emails, email) => {
    const { handler, calls } = setup({ scim_upsert_user: ({ p_user }) => ({ user: userRow(p_user) }) });
    const response = await request(handler, { method: "PUT", path: `Users/${USER_ID}`, body: { userName: "directory@example.org", emails } });
    expect(response.statusCode).toBe(200);
    expect(calls.find((call) => call.name === "scim_upsert_user").body.p_user.userName).toBe(email);
  });

  it("rejects an invalid explicit PUT email before writing", async () => {
    const { handler, calls } = setup();
    const response = await request(handler, { method: "PUT", path: `Users/${USER_ID}`, body: {
      userName: "directory@example.org", emails: [{ value: "invalid", primary: true }],
    } });
    expect(response.statusCode).toBe(400);
    expect(calls.map((call) => call.name)).toEqual(["scim_authenticate"]);
  });

  it.each(["", null, undefined])("rejects an empty directory userName after the work address has diverged: %j", async (value) => {
    const { handler, calls } = setup({ scim_get_user: userRow({ userName: "work@example.org", directoryUserName: "directory@example.org" }) });
    const patched = await request(handler, { method: "PATCH", path: `Users/${USER_ID}`, body: {
      Operations: [{ op: "replace", path: "userName", value }],
    } });
    expect(patched.statusCode).toBe(400);
    expect(patched.body.scimType).toBe("invalidValue");
    expect(calls.map((call) => call.name)).toEqual(["scim_authenticate", "scim_get_user"]);
  });

  it("ignores client-forged directory metadata on a User body", () => {
    expect(normalizeUser({ userName: "ana@example.org", directoryUserName: "other@example.org" })).not.toHaveProperty("directoryUserName");
    expect(normalizeUser({ userName: "ana@example.org", emails: [{ value: "other@example.org", primary: true }] }).userName).toBe("ana@example.org");
  });

  it.each([false, true])("applies email and userName PATCH operations in order (email last: %s)", async (emailLast) => {
    const email = { op: "replace", path: "emails", value: [{ value: "mail@example.org" }] };
    const userName = { op: "replace", path: "userName", value: "login@example.org" };
    const { handler, calls } = setup({
      scim_get_user: userRow(),
      scim_upsert_user: ({ p_user }) => ({ outcome: "updated", user: userRow(p_user) }),
    });
    const patched = await request(handler, {
      method: "PATCH", path: `Users/${USER_ID}`, body: { Operations: emailLast ? [userName, email] : [email, userName] },
    });
    const expected = "mail@example.org";
    expect(patched.statusCode).toBe(200);
    expect(calls.find((call) => call.name === "scim_upsert_user").body.p_user.userName).toBe(expected);
    expect(patched.body.emails[0].value).toBe(expected);
    expect(patched.body.userName).toBe("login@example.org");
  });

  it.each([false, true])("keeps pathless address precedence independent of JSON member order (email last: %s)", async (emailLast) => {
    const attributes = [["userName", "login@example.org"], ["emails", [{ value: "mail@example.org" }]]];
    const value = Object.fromEntries(emailLast ? attributes : [...attributes].reverse());
    const { handler, calls } = setup({
      scim_get_user: userRow(),
      scim_upsert_user: ({ p_user }) => ({ outcome: "updated", user: userRow(p_user) }),
    });
    const patched = await request(handler, {
      method: "PATCH", path: `Users/${USER_ID}`, body: { Operations: [{ op: "replace", value }] },
    });
    expect(patched.statusCode).toBe(200);
    expect(calls.find((call) => call.name === "scim_upsert_user").body.p_user.userName).toBe("mail@example.org");
    expect(patched.body.userName).toBe("login@example.org");
    expect(patched.body.emails[0].value).toBe("mail@example.org");
  });

  it.each(["not-an-address", "bad\n@example.org"])("refuses invalid email replacements without writing: %j", async (value) => {
    const { handler, calls } = setup({ scim_get_user: userRow() });
    const patched = await request(handler, {
      method: "PATCH", path: `Users/${USER_ID}`, body: { Operations: [{ op: "replace", path: "emails", value }] },
    });
    expect(patched.statusCode).toBe(400);
    expect(patched.body.scimType).toBe("invalidValue");
    expect(calls.map((call) => call.name)).toEqual(["scim_authenticate", "scim_get_user"]);
  });

  it.each([
    { op: "remove", path: "emails" },
    { op: "add", path: "emails", value: null },
    { op: "add", path: "emails", value: 12 },
    { op: "replace", path: "emails", value: [] },
  ])("preserves the existing no-op for removal or an unusable email: $op / $value", async (operation) => {
    const { handler, calls } = setup({
      scim_get_user: userRow(),
      scim_upsert_user: ({ p_user }) => ({ outcome: "updated", user: userRow(p_user) }),
    });
    const patched = await request(handler, {
      method: "PATCH", path: `Users/${USER_ID}`, body: { Operations: [operation] },
    });
    expect(patched.statusCode).toBe(200);
    expect(calls.find((call) => call.name === "scim_upsert_user").body.p_user.userName).toBe("ana@example.org");
    expect(patched.body.emails[0].value).toBe("ana@example.org");
  });

  it("refuses a nonmatching email filter instead of changing the work address", async () => {
    const { handler, calls } = setup({
      scim_get_user: userRow(),
      scim_upsert_user: ({ p_user }) => ({ outcome: "updated", user: userRow(p_user) }),
    });
    const patched = await request(handler, {
      method: "PATCH", path: `Users/${USER_ID}`,
      body: { Operations: [{ op: "replace", path: 'emails[type eq "home"].value', value: "home@example.org" }] },
    });
    expect(patched.statusCode).toBe(400);
    expect(patched.body.scimType).toBe("noTarget");
    expect(calls.map((call) => call.name)).toEqual(["scim_authenticate", "scim_get_user"]);
  });

  it.each([
    ["a padded address rename", " new@example.org ", "new@example.org"],
    ["a legacy rename to a non-address userName", "ana-login", "ana@example.org"],
    ["a padded rename named by a padded selector", " new@example.org ", " new@example.org "],
  ])("matches a later email value selector against the normalized address after %s", async (_name, userName, selected) => {
    const { handler, calls } = setup({
      scim_get_user: userRow(),
      scim_upsert_user: ({ p_user }) => ({ outcome: "updated", user: userRow(p_user) }),
    });
    const patched = await request(handler, {
      method: "PATCH", path: `Users/${USER_ID}`,
      body: { Operations: [
        { op: "replace", path: "userName", value: userName },
        { op: "replace", path: `emails[value eq "${selected}"].value`, value: "final@example.org" },
      ] },
    });
    expect(patched.statusCode).toBe(200);
    expect(calls.find((call) => call.name === "scim_upsert_user").body.p_user.userName).toBe("final@example.org");
    expect(patched.body.emails[0].value).toBe("final@example.org");
  });

  it("still refuses a value selector naming the replaced address after a padded rename", async () => {
    const { handler, calls } = setup({ scim_get_user: userRow() });
    const patched = await request(handler, {
      method: "PATCH", path: `Users/${USER_ID}`,
      body: { Operations: [
        { op: "replace", path: "userName", value: " new@example.org " },
        { op: "replace", path: 'emails[value eq "ana@example.org"].value', value: "final@example.org" },
      ] },
    });
    expect(patched.statusCode).toBe(400);
    expect(patched.body.scimType).toBe("noTarget");
    expect(calls.map((call) => call.name)).toEqual(["scim_authenticate", "scim_get_user"]);
  });

  it("refuses unsupported email filter syntax before writing", async () => {
    const { handler, calls } = setup({ scim_get_user: userRow() });
    const patched = await request(handler, {
      method: "PATCH", path: `Users/${USER_ID}`,
      body: { Operations: [{ op: "replace", path: 'emails[type co "work"].value', value: "new@example.org" }] },
    });
    expect(patched.statusCode).toBe(400);
    expect(patched.body.scimType).toBe("invalidPath");
    expect(calls.map((call) => call.name)).toEqual(["scim_authenticate", "scim_get_user"]);
  });

  it("leaves a renamed bound account's invitation decision to the database", async () => {
    const { handler, calls, sendInvitation } = setup({
      scim_get_user: userRow({ state: "active" }),
      scim_upsert_user: ({ p_user }) => ({
        outcome: "updated", user: userRow({ ...p_user, state: "needs_admin", stateReason: "user_name_changed" }),
        invitation: { send: false },
      }),
    });
    const patched = await request(handler, {
      method: "PATCH", path: `Users/${USER_ID}`,
      body: { Operations: [{ op: "replace", path: 'emails[type eq "work"].value', value: "new@example.org" }] },
    });
    expect(patched.statusCode).toBe(200);
    expect(calls.find((call) => call.name === "scim_upsert_user").body).toMatchObject({ p_user_id: USER_ID, p_user: { userName: "new@example.org" } });
    expect(sendInvitation).not.toHaveBeenCalled();
    expect(calls.map((call) => call.name)).toEqual(["scim_authenticate", "scim_get_user", "scim_upsert_user"]);
  });

  it("deletes with 204 and refuses to deprovision the last admin", async () => {
    expect((await request(setup({ scim_delete_user: { deleted: true } }).handler, { method: "DELETE", path: `Users/${USER_ID}` })).statusCode).toBe(204);
    const kept = await request(setup({ scim_delete_user: { deleted: false, reason: "last_organization_admin" } }).handler, { method: "DELETE", path: `Users/${USER_ID}` });
    expect(kept.statusCode).toBe(409);
    expect((await request(setup({ scim_delete_user: { deleted: false } }).handler, { method: "DELETE", path: `Users/${USER_ID}` })).statusCode).toBe(404);
    expect((await request(setup().handler, { path: "Users/not-a-uuid" })).statusCode).toBe(404);
  });
});

describe("SCIM Groups", () => {
  it("creates and patches group membership with Okta and Entra operations", async () => {
    const results = {
      scim_get_group: groupRow(),
      scim_upsert_group: (body) => ({ outcome: "updated", group: groupRow({ members: body.p_members.map((value) => ({ value })) }) }),
    };
    const okta = setup(results);
    const second = "55555555-5555-4555-8555-555555555555";
    await request(okta.handler, { method: "PATCH", path: `Groups/${GROUP_ID}`, body: { Operations: [{ op: "add", path: "members", value: [{ value: second, display: "B" }] }] } });
    expect(okta.calls.find((call) => call.name === "scim_upsert_group").body).toMatchObject({ p_organization_id: ORG, p_group_id: GROUP_ID, p_members: [USER_ID, second] });
    const remove = setup(results);
    await request(remove.handler, { method: "PATCH", path: `Groups/${GROUP_ID}`, body: { Operations: [{ op: "remove", path: `members[value eq "${USER_ID}"]` }] } });
    expect(remove.calls.find((call) => call.name === "scim_upsert_group").body.p_members).toEqual([]);
    const entra = setup(results);
    await request(entra.handler, { method: "PATCH", path: `Groups/${GROUP_ID}`, body: { Operations: [{ op: "Remove", path: "members", value: [{ value: USER_ID }] }, { op: "Replace", path: "displayName", value: "Chapter stewards" }] } });
    expect(entra.calls.find((call) => call.name === "scim_upsert_group").body).toMatchObject({ p_members: [], p_display_name: "Chapter stewards" });
  });

  it("honours excludedAttributes=members and rejects a member from another directory", async () => {
    const { handler, calls } = setup({ scim_list_groups: { totalResults: 1, items: [groupRow({ members: null })] } });
    const listed = await request(handler, { path: "Groups", query: { excludedAttributes: "members", filter: 'displayName eq "Stewards"' } });
    expect(calls[1].body).toMatchObject({ p_field: "displayName", p_value: "Stewards", p_include_members: false });
    expect(listed.body.Resources[0].members).toBeUndefined();
    const foreign = await request(setup({ scim_upsert_group: { outcome: "unknown_member" } }).handler, { method: "POST", path: "Groups", body: { displayName: "X", members: [{ value: USER_ID }] } });
    expect(foreign.statusCode).toBe(400);
    expect((await request(setup({ scim_delete_group: { deleted: true } }).handler, { method: "DELETE", path: `Groups/${GROUP_ID}` })).statusCode).toBe(204);
  });
});

describe("SCIM protocol helpers", () => {
  it("routes, filters and normalizes deterministically", () => {
    expect(routeOf("Users/abc")).toEqual({ resource: "Users", id: "abc" });
    expect(routeOf("users")).toEqual({ resource: "Users", id: null });
    expect(routeOf("Users/a/b")).toBeNull();
    expect(parseFilter('emails.value eq "A@B.org"', "Users")).toEqual({ field: "emails.value", value: "a@b.org" });
    expect(parseFilter('id eq "nope"', "Users")).toEqual({ field: "id", value: null });
    expect(() => parseFilter('displayName eq "x"', "Users")).toThrow();
    expect(normalizeUser({ userName: "00u1", emails: [{ value: "Ana@Example.org", primary: true }] }).userName).toBe("ana@example.org");
    expect(() => normalizeUser({ userName: "x", emails: [] })).toThrow();
    expect(normalizeUser({ userName: "a@b.org", active: "False" }).active).toBe(false);
  });

  it("keeps unknown PATCH attributes out of the stored user and refuses removing displayName from a group", () => {
    const next = applyUserPatch({ userName: "a@b.org", name: {}, active: true, emails: [] }, { Operations: [{ op: "add", path: "title", value: "x" }, { op: "replace", path: "name.givenName", value: "Ana" }] });
    expect(next.name.givenName).toBe("Ana");
    expect(next.title).toBeUndefined();
    expect(() => applyGroupPatch(groupRow(), { Operations: [{ op: "remove", path: "displayName" }] })).toThrow();
    expect(() => applyUserPatch({ userName: "a@b.org" }, { Operations: [{ op: "move", path: "active" }] })).toThrow();
  });
});

describe('SCIM deprovisioning API failures',()=>{
  it.each(['PUT','PATCH'])('does not report success for unresolved inactive %s',async(method)=>{
    const {handler}=setup({scim_get_user:userRow(),scim_upsert_user:{outcome:'updated',user:userRow({active:false,state:'needs_admin',stateReason:'user_name_changed'})}});
    const body=method==='PUT'?{schemas:[SCHEMA_USER],userName:'renamed@example.org',active:false}:{schemas:['urn:ietf:params:scim:api:messages:2.0:PatchOp'],Operations:[{op:'replace',path:'active',value:false}]};
    expect((await request(handler,{method,path:'Users/'+USER_ID,body})).statusCode).toBe(409);
  });
  it('does not return 204 for a failed account binding',async()=>{
    const {handler}=setup({scim_delete_user:{deleted:false,reason:'account_binding_unresolved'}});
    expect((await request(handler,{method:'DELETE',path:'Users/'+USER_ID})).statusCode).toBe(409);
  });
});
