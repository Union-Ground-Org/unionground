// @vitest-environment node
//
// SEC-UG-ADMIN-RANK-GUARD-ON-ACCOUNT-TAKEOVER-20261114
//
// One administrator must not take over another. 20261125120100 adds an admin
// rank check (organization-wide admin 2, chapter admin 1, everyone else 0) to
// the sign-in address recovery, the password reissue and the MFA reset: an
// administrator may act on another account only when that account has no
// admin rank, or the actor's rank is strictly higher. The API endpoints refuse
// to continue unless the database confirms the check ran.
//
// Three layers: the migration text (offline), the endpoints (mocked fetch),
// and the rule itself on a disposable database (skipped without
// SUPABASE_DB_URL, like every *-db test). The live cases use the fictional
// organization Example Workers Local 1.
import { createHash, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import pg from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { assertDisposableProofUrl } from "../scripts/run-required-db-proofs.mjs";
import { fnBody, findMigrationName, latestFnBody, loadMigrationSql, stripComments } from "./helpers/migration.js";
import { adminRankChecked } from "../api/_lib/adminRank.js";

vi.mock("../src/lib/trustedBackends.js", async () => (await import("./helpers/fictional-provider.js")).trustedBackendsModule("https://project.supabase.co"));

const MIGRATION = "admin_rank_guard_on_account_takeover";
const contract = JSON.parse(readFileSync(new URL("../scripts/db-contract.json", import.meta.url), "utf8"));

const GUARDED = {
  "public.begin_member_signin_recovery(p_target_user uuid, p_new_email_hash text, p_reason text)": {
    previous: "member_recovery_and_chapter_grant_tenant_check",
    beforeWrite: "consume_member_signin_recovery_limit",
  },
  "public.begin_member_password_reissue(p_target_user uuid)": {
    previous: "member_recovery_and_chapter_grant_tenant_check",
    beforeWrite: "consume_member_signin_recovery_limit",
  },
  "public.authorize_mfa_reset(p_user_id uuid)": {
    previous: "mfa_reset_chapter_scope_boundary",
    beforeWrite: "return pg_catalog.jsonb_build_object",
  },
  "public.begin_mfa_reset(p_user_id uuid)": {
    previous: "mfa_reset_chapter_scope_boundary",
    beforeWrite: "insert into private.member_mfa_reset_boundaries",
  },
};

// The new body with the added rank block and marker taken out must equal the
// installed body it replaces, so nothing else changed in the copy.
function withoutRankGuard(body) {
  return body
    .replace(/[ ]*-- Admin rank \(20261125120100\)[\s\S]*?end if;\n\n?/g, "")
    .replace(/,\s*'adminRank', 'checked'/g, "");
}

describe("admin rank guard migration (static)", () => {
  it("sorts after every earlier migration and is one transaction", () => {
    const name = findMigrationName(MIGRATION);
    expect(name).toBe("20261125120100_admin_rank_guard_on_account_takeover.sql");
    expect(name > "20261019174000_password_signin_success_refunds.sql").toBe(true);
    const sql = stripComments(loadMigrationSql(MIGRATION));
    expect(sql.trimStart().startsWith("begin;")).toBe(true);
    expect(sql.trimEnd().endsWith("commit;")).toBe(true);
  });

  it("ranks organization admins over chapter admins and refuses equal or higher targets", () => {
    const sql = loadMigrationSql(MIGRATION);
    const rank = stripComments(fnBody(sql, "private.admin_rank_in_organization("));
    expect(rank).toContain("security definer");
    expect(rank).toContain("set search_path = ''");
    expect(rank).toContain("om.status = 'active'");
    expect(rank).toMatch(/g\.role = 'admin'\s*\)\s*then 2/);
    expect(rank).toMatch(/rc\.role = 'admin'\s*and c\.organization_id = p_organization_id\s*\)\s*then 1/);
    expect(rank).toContain("m.status = 'active'");
    const permits = stripComments(fnBody(sql, "private.admin_rank_permits("));
    expect(permits).toContain("private.admin_rank_in_organization(p_target, p_organization_id) = 0");
    expect(permits).toMatch(/admin_rank_in_organization\(p_actor, p_organization_id\)\s*>\s*private\.admin_rank_in_organization\(p_target, p_organization_id\)/);
    expect(permits).not.toContain(">=");
    // Both helpers are owner-only: the definer routines call them, no client does.
    const code = stripComments(sql);
    expect(code).toContain("revoke all on function private.admin_rank_in_organization(uuid, uuid)\n  from public, anon, authenticated, service_role;");
    expect(code).toContain("revoke all on function private.admin_rank_permits(uuid, uuid, uuid)\n  from public, anon, authenticated, service_role;");
    expect(code).not.toMatch(/grant execute on function private\.admin_rank/);
  });

  it.each(Object.entries(GUARDED))("%s is the installed body plus the rank check, before any write", (sig, { previous, beforeWrite }) => {
    const declared = fnBody(loadMigrationSql(MIGRATION), sig);
    // The live definition after every migration is this one.
    expect(latestFnBody(sig)).toBe(fnBody(stripComments(loadMigrationSql(MIGRATION)), sig));
    const code = stripComments(declared);
    expect(code).toContain("private.admin_rank_permits(caller, ");
    expect(code).toContain("'adminRank', 'checked'");
    expect(code.indexOf("private.admin_rank_permits(")).toBeLessThan(code.indexOf(beforeWrite));
    expect(withoutRankGuard(declared)).toBe(fnBody(loadMigrationSql(previous), sig));
  });

  it("leaves the self-service recovery routines alone", () => {
    for (const sig of [
      "public.claim_mfa_recovery_code(",
      "public.finalize_mfa_recovery_code(",
      "public.consume_password_reset_attempt(",
      "public.record_self_service_password_reset(",
    ]) {
      expect(latestFnBody(sig), sig).not.toContain("admin_rank");
    }
  });

  it("pins the rank check in the database contract", () => {
    for (const sig of Object.keys(GUARDED)) {
      const entry = contract.functions.find((row) => row.sig === sig);
      expect(entry, sig).toBeDefined();
      expect(entry.bodyContains, sig).toContain("private.admin_rank_permits(caller, ");
    }
    for (const sig of [
      "private.admin_rank_in_organization(p_user_id uuid, p_organization_id uuid)",
      "private.admin_rank_permits(p_actor uuid, p_target uuid, p_organization_id uuid)",
    ]) {
      const entry = contract.functions.find((row) => row.sig === sig);
      expect(entry, sig).toMatchObject({ secdef: true, exec: "" });
    }
  });
});

// ---------------------------------------------------------------------------
// Endpoints, with fetch mocked. A same- or higher-rank refusal arrives from the
// database as 42501 (HTTP 403); a database that does not answer the marker is
// treated as one without the guard.
// ---------------------------------------------------------------------------
const SUPABASE = "https://project.supabase.co";
const TARGET = "10000000-0000-4000-8000-000000000001";
const OPERATION = "20000000-0000-4000-8000-000000000002";

function upstream(payload, status = 200) {
  const body = payload === null ? "" : JSON.stringify(payload);
  return { ok: status >= 200 && status < 300, status, text: async () => body, json: async () => JSON.parse(body) };
}

function recorder() {
  const out = { status: 0, body: null };
  return {
    out,
    status(code) { out.status = code; return this; },
    setHeader() {},
    end(body) { out.body = body ? JSON.parse(body) : null; },
  };
}

async function call(handler, body, token = "admin-token") {
  const res = recorder();
  await handler({ method: "POST", headers: { authorization: `Bearer ${token}` }, body }, res);
  return res.out;
}

const ENDPOINTS = {
  "sign-in address recovery": {
    load: () => import("../api/admin-signin-recovery.js"),
    body: { userId: TARGET, newEmail: "new.inbox@example.com", reason: "lost_inbox", identityVerified: true },
    rpc: "begin_member_signin_recovery",
    accepted: { accepted: true, operationId: OPERATION, retry: false },
    failRpc: "fail_member_signin_recovery",
  },
  "password reissue": {
    load: () => import("../api/admin-password-reissue.js"),
    body: { userId: TARGET, identityVerified: true },
    rpc: "begin_member_password_reissue",
    accepted: { accepted: true, operationId: OPERATION, retry: false },
    failRpc: "fail_member_password_reissue",
  },
};

describe("account-recovery endpoints enforce the rank answer", () => {
  let calls;
  beforeEach(() => {
    calls = [];
    vi.stubEnv("VITE_SUPABASE_URL", SUPABASE);
    vi.stubEnv("UNIONGROUND_SUPABASE_PROJECT_REF", "project");
    vi.stubEnv("VITE_SUPABASE_PUBLISHABLE_KEY", "publishable-key");
    vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", "server-secret-key");
    vi.stubEnv("RESEND_API_KEY", "resend-key");
    vi.stubEnv("NOTIFY_FROM_ADDRESS", "Union Ground <alerts@example.invalid>");
  });
  afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); vi.restoreAllMocks(); });

  function network(routes) {
    vi.stubGlobal("fetch", vi.fn(async (url, init = {}) => {
      calls.push({ url: String(url), method: init.method || "GET" });
      for (const [needle, answer] of Object.entries(routes)) {
        if (String(url).includes(needle)) return answer();
      }
      return upstream({ message: "unexpected" }, 599);
    }));
  }

  it.each(Object.entries(ENDPOINTS))("%s: a same- or higher-rank refusal stops before any account change", async (_name, endpoint) => {
    const { default: handler } = await endpoint.load();
    network({ [`/rpc/${endpoint.rpc}`]: () => upstream({ code: "42501", message: "recovery unavailable" }, 403) });
    expect(await call(handler, endpoint.body)).toEqual({ status: 403, body: { error: "not-permitted" } });
    expect(calls.map((entry) => entry.url)).toEqual([`${SUPABASE}/rest/v1/rpc/${endpoint.rpc}`]);
  });

  it.each(Object.entries(ENDPOINTS))("%s: a database without the rank marker is refused and the operation released", async (_name, endpoint) => {
    const { default: handler } = await endpoint.load();
    network({
      [`/rpc/${endpoint.rpc}`]: () => upstream(endpoint.accepted),
      [`/rpc/${endpoint.failRpc}`]: () => upstream({ failed: true }),
    });
    expect(await call(handler, endpoint.body)).toEqual({ status: 503, body: { error: "service-unavailable" } });
    expect(calls.map((entry) => entry.url)).toEqual([
      `${SUPABASE}/rest/v1/rpc/${endpoint.rpc}`,
      `${SUPABASE}/rest/v1/rpc/${endpoint.failRpc}`,
    ]);
    // Never reached the provider's admin API.
    expect(calls.some((entry) => entry.url.includes("/auth/v1/admin/"))).toBe(false);
  });

  it.each(Object.entries(ENDPOINTS))("%s: a lower-rank target with the marker proceeds to the account", async (_name, endpoint) => {
    const { default: handler } = await endpoint.load();
    network({
      [`/rpc/${endpoint.rpc}`]: () => upstream({ ...endpoint.accepted, adminRank: "checked" }),
      "/auth/v1/admin/users/": () => upstream({ message: "stop here" }, 500),
      [`/rpc/${endpoint.failRpc}`]: () => upstream({ failed: true }),
    });
    await call(handler, endpoint.body);
    expect(calls.some((entry) => entry.url === `${SUPABASE}/auth/v1/admin/users/${TARGET}`)).toBe(true);
  });

  it("MFA reset refuses without the marker and never begins the reset", async () => {
    const { default: handler } = await import("../api/admin-mfa-reset.js");
    network({
      "/auth/v1/user": () => upstream({ id: "30000000-0000-4000-8000-000000000003" }),
      "/rpc/authorize_mfa_reset": () => upstream({ userId: TARGET, authorized: true }),
      "/rpc/begin_mfa_reset": () => upstream({ authorized: true }),
    });
    const out = await call(handler, { userId: TARGET });
    expect(out).toEqual({ status: 403, body: { error: "not-permitted" } });
    expect(calls.some((entry) => entry.url.endsWith("/rpc/begin_mfa_reset"))).toBe(false);
  });

  it("MFA reset passes a same- or higher-rank refusal through as the flat refusal", async () => {
    const { default: handler } = await import("../api/admin-mfa-reset.js");
    network({
      "/auth/v1/user": () => upstream({ id: "30000000-0000-4000-8000-000000000003" }),
      "/rpc/authorize_mfa_reset": () => upstream({ code: "42501", message: "admin rank insufficient" }, 403),
    });
    expect(await call(handler, { userId: TARGET })).toEqual({ status: 403, body: { error: "not-permitted" } });
    expect(calls.some((entry) => entry.url.endsWith("/rpc/begin_mfa_reset"))).toBe(false);
  });

  it("reads the marker strictly", () => {
    expect(adminRankChecked({ adminRank: "checked" })).toBe(true);
    for (const value of [undefined, null, {}, { adminRank: true }, { adminRank: "CHECKED" }]) {
      expect(adminRankChecked(value)).toBe(false);
    }
  });

  it("self-service recovery endpoints do not depend on the admin rank", () => {
    for (const path of ["../api/mfa-recovery.js", "../api/password-reset.js"]) {
      const source = readFileSync(new URL(path, import.meta.url), "utf8");
      expect(source, path).not.toContain("adminRank");
    }
  });
});

// ---------------------------------------------------------------------------
// The rule on a disposable database. Every row is rolled back.
// ---------------------------------------------------------------------------
const live = process.env.SUPABASE_DB_URL ? describe : describe.skip;

live("admin rank guard on a disposable database", () => {
  let client;

  beforeAll(async () => {
    assertDisposableProofUrl(process.env.SUPABASE_DB_URL);
    client = new pg.Client({ connectionString: process.env.SUPABASE_DB_URL, application_name: "admin-rank-guard-rollback-proof" });
    await client.connect();
    await client.query("set statement_timeout = '10s'");
  });

  afterAll(async () => { await client?.end(); });

  async function organization() {
    const org = randomUUID();
    const chapter = `ewl1-a-${org}`;
    const chapter2 = `ewl1-b-${org}`;
    await client.query("insert into public.organizations(id,slug,name) values ($1,$2,$3)", [org, `ewl1-${org}`, `Example Workers Local 1 ${org}`]);
    await client.query(
      `insert into public.chapters(id,name,slug,region,organization_id,order_index)
       values ($1,$1,$1,'proof',$3,9931), ($2,$2,$2,'proof',$3,9932)`,
      [chapter, chapter2, org],
    );
    return { org, chapter, chapter2 };
  }

  async function person(t, chapter = t.chapter) {
    const id = randomUUID();
    await client.query("insert into auth.users(id,email) values ($1,$2)", [id, `${id}@example.invalid`]);
    await client.query("update public.member_profiles set chapter_id=$2 where id=$1", [id, chapter]);
    await client.query("insert into public.organization_memberships(organization_id,user_id,status) values ($1,$2,'active') on conflict do nothing", [t.org, id]);
    await client.query("insert into public.member_chapter_memberships(user_id,chapter_id,status) values ($1,$2,'active') on conflict do nothing", [id, chapter]);
    return id;
  }

  async function secondFactor(id) {
    await client.query(
      "insert into auth.mfa_factors(id,user_id,factor_type,status,created_at,updated_at) values ($1,$2,'totp','verified',now(),now())",
      [randomUUID(), id],
    );
  }

  async function chapterAdmin(t, chapter = t.chapter) {
    const id = await person(t, chapter);
    await client.query("insert into public.member_roles(user_id,role,chapter_id) values ($1,'admin',$2)", [id, chapter]);
    await client.query("insert into public.member_role_chapters(user_id,role,chapter_id) values ($1,'admin',$2)", [id, chapter]);
    await secondFactor(id);
    return id;
  }

  async function organizationAdmin(t) {
    const id = await chapterAdmin(t);
    await client.query("insert into public.organization_role_grants(organization_id,user_id,role) values ($1,$2,'admin')", [t.org, id]);
    return id;
  }

  async function actAs(userId) {
    const session = randomUUID();
    await client.query("insert into auth.sessions(id,user_id,aal,created_at,updated_at) values ($1,$2,'aal2',now(),now())", [session, userId]);
    await client.query("select set_config('request.jwt.claims',$1,true)", [
      JSON.stringify({ sub: userId, role: "authenticated", aal: "aal2", session_id: session }),
    ]);
    await client.query("set local role authenticated");
  }

  async function asOwner() {
    await client.query("reset role");
    await client.query("select set_config('request.jwt.claims','',true)");
  }

  async function capture(statement, args) {
    await client.query("savepoint cell");
    try {
      const result = await client.query(statement, args);
      await client.query("release savepoint cell");
      return { ok: true, row: result.rows[0], code: "", message: "" };
    } catch (error) {
      await client.query("rollback to savepoint cell");
      return { ok: false, row: null, code: error.code || "", message: error.message || "" };
    }
  }

  const hash = (email) => createHash("sha256").update(email).digest("hex");

  async function attempts(actor, target) {
    await actAs(actor);
    const signin = await capture("select public.begin_member_signin_recovery($1,$2,'lost_inbox') as v", [target, hash(`${randomUUID()}@example.invalid`)]);
    const reissue = await capture("select public.begin_member_password_reissue($1) as v", [target]);
    const mfa = await capture("select public.authorize_mfa_reset($1) as v", [target]);
    const mfaBegin = await capture("select public.begin_mfa_reset($1) as v", [target]);
    await asOwner();
    return { signin, reissue, mfa, mfaBegin };
  }

  it("ranks organization admins, chapter admins and members", async () => {
    await client.query("begin");
    try {
      const t = await organization();
      const owner = await organizationAdmin(t);
      const admin = await chapterAdmin(t);
      const member = await person(t);
      const rank = async (id) => (await client.query("select private.admin_rank_in_organization($1,$2) as r", [id, t.org])).rows[0].r;
      expect(await rank(owner)).toBe(2);
      expect(await rank(admin)).toBe(1);
      expect(await rank(member)).toBe(0);
      expect(await rank(randomUUID())).toBe(0);
      const other = await organization();
      expect((await client.query("select private.admin_rank_in_organization($1,$2) as r", [owner, other.org])).rows[0].r).toBe(0);
      // Owner-only: an authenticated session cannot call the helpers.
      await actAs(member);
      const direct = await capture("select private.admin_rank_permits($1,$2,$3) as v", [member, owner, t.org]);
      await asOwner();
      expect(direct).toMatchObject({ ok: false, code: "42501" });
    } finally {
      await client.query("rollback");
    }
  });

  it("refuses a same-rank target on every path", async () => {
    await client.query("begin");
    try {
      const t = await organization();
      const actor = await chapterAdmin(t);
      const peer = await chapterAdmin(t);
      const out = await attempts(actor, peer);
      expect(out.signin).toMatchObject({ ok: false, code: "42501", message: "recovery unavailable" });
      expect(out.reissue).toMatchObject({ ok: false, code: "42501", message: "password reissue unavailable" });
      expect(out.mfa).toMatchObject({ ok: false, code: "42501", message: "admin rank insufficient" });
      expect(out.mfaBegin).toMatchObject({ ok: false, code: "42501", message: "admin rank insufficient" });
      const owners = [await organizationAdmin(t), await organizationAdmin(t)];
      const top = await attempts(owners[0], owners[1]);
      for (const cell of Object.values(top)) expect(cell).toMatchObject({ ok: false, code: "42501" });
    } finally {
      await client.query("rollback");
    }
  });

  it("refuses a higher-rank target on every path", async () => {
    await client.query("begin");
    try {
      const t = await organization();
      const actor = await chapterAdmin(t);
      const owner = await organizationAdmin(t);
      const out = await attempts(actor, owner);
      for (const cell of Object.values(out)) expect(cell).toMatchObject({ ok: false, code: "42501" });
      const state = await client.query(
        `select (select count(*)::int from private.member_signin_recoveries where target_user = $1) as recoveries,
                (select count(*)::int from private.member_password_reissues where target_user = $1) as reissues,
                (select count(*)::int from private.member_mfa_reset_boundaries where user_id = $1) as boundaries`,
        [owner],
      );
      expect(state.rows[0]).toEqual({ recoveries: 0, reissues: 0, boundaries: 0 });
    } finally {
      await client.query("rollback");
    }
  });

  it("allows a lower-rank target and marks the answer as rank-checked", async () => {
    await client.query("begin");
    try {
      const t = await organization();
      const actor = await chapterAdmin(t);
      const member = await person(t);
      const out = await attempts(actor, member);
      expect(out.signin.ok).toBe(true);
      expect(out.signin.row.v).toMatchObject({ accepted: true, adminRank: "checked" });
      expect(out.reissue.ok).toBe(true);
      expect(out.reissue.row.v).toMatchObject({ accepted: true, adminRank: "checked" });
      expect(out.mfa.row.v).toMatchObject({ authorized: true, adminRank: "checked" });
      expect(out.mfaBegin.ok).toBe(true);
      const owner = await organizationAdmin(t);
      const lowerAdmin = await chapterAdmin(t);
      const down = await attempts(owner, lowerAdmin);
      expect(down.signin.ok).toBe(true);
      expect(down.reissue.ok).toBe(true);
      expect(down.mfa.ok).toBe(true);
      expect(down.mfaBegin.ok).toBe(true);
    } finally {
      await client.query("rollback");
    }
  });

  it("leaves the self-target refusals exactly as they were", async () => {
    await client.query("begin");
    try {
      const t = await organization();
      const owner = await organizationAdmin(t);
      const out = await attempts(owner, owner);
      expect(out.signin).toMatchObject({ ok: false, code: "42501", message: "recovery unavailable" });
      expect(out.reissue).toMatchObject({ ok: false, code: "42501", message: "password reissue unavailable" });
      expect(out.mfa).toMatchObject({ ok: false, code: "42501", message: "an admin cannot reset their own second factor" });
    } finally {
      await client.query("rollback");
    }
  });
});
