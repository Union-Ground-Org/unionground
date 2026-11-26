// @vitest-environment node
//
// SEC-UG-PG-NET-PUBLIC-WRITE-TRIGGER-ESCALATION-20261110 (#8015): on a
// disposable database after 20261111031500, a login with no grants of its own
// (the drift reader's shape) still connects and reads, but can no longer create
// a temporary function or table, while postgres keeps enqueueing pg_net
// requests and the API roles keep TEMP. The trigger hole that only
// supabase_admin can close is pinned as still open, so the day it closes this
// proof says so.
import { randomBytes } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { assertDisposableProofUrl } from "../scripts/run-required-db-proofs.mjs";

const databaseDescribe = process.env.SUPABASE_DB_URL ? describe : describe.skip;
const LOGIN = "c74_temp_probe_login";
const password = randomBytes(18).toString("hex");

const refusal = async (client, sql) => {
  try {
    await client.query(sql);
    return null;
  } catch (error) {
    return error.code;
  }
};

databaseDescribe("PUBLIC TEMP revoked on database postgres", () => {
  let admin;
  let login;

  beforeAll(async () => {
    const url = assertDisposableProofUrl(process.env.SUPABASE_DB_URL);
    admin = new pg.Client({ connectionString: url, ssl: false });
    await admin.connect();
    await admin.query(`drop role if exists ${LOGIN}`);
    await admin.query(`create role ${LOGIN} login password '${password}'`);
    const loginUrl = new URL(url);
    loginUrl.username = LOGIN;
    loginUrl.password = password;
    login = new pg.Client({ connectionString: loginUrl.toString(), ssl: false });
    await login.connect();
  });

  afterAll(async () => {
    await login?.end();
    if (admin) {
      await admin.query(`drop role if exists ${LOGIN}`);
      await admin.end();
    }
  });

  it("leaves no TEMPORARY grant to PUBLIC on the database", async () => {
    const { rows } = await admin.query(`
      select count(*)::int as n
        from pg_catalog.pg_database d, pg_catalog.aclexplode(d.datacl) a
       where d.datname = 'postgres' and a.grantee = 0 and a.privilege_type = 'TEMPORARY'`);
    expect(rows[0].n).toBe(0);
  });

  it("lets a plain login connect and read, and refuses its temporary function and table", async () => {
    expect((await login.query("select current_user as who, 1 as one")).rows[0]).toEqual({ who: LOGIN, one: 1 });
    expect(await refusal(login, "create function pg_temp.c74_probe() returns trigger language plpgsql as $$ begin return new; end $$")).toBe("42501");
    expect(await refusal(login, "create temporary table c74_probe (id int)")).toBe("42501");
  });

  it("keeps TEMP for postgres and the API roles", async () => {
    const { rows } = await admin.query(`
      select r.rolname, pg_catalog.has_database_privilege(r.oid, 'postgres', 'TEMPORARY') as temp
        from pg_catalog.pg_roles r
       where r.rolname in ('postgres', 'anon', 'authenticated', 'service_role', 'authenticator')
       order by r.rolname`);
    expect(rows).toEqual([
      { rolname: "anon", temp: true },
      { rolname: "authenticated", temp: true },
      { rolname: "authenticator", temp: true },
      { rolname: "postgres", temp: true },
      { rolname: "service_role", temp: true },
    ]);
    await admin.query("begin");
    try {
      await admin.query("set local role authenticated");
      await admin.query("create temporary table c74_api_temp (id int) on commit drop");
    } finally {
      await admin.query("rollback");
    }
  });

  it("still lets postgres enqueue a pg_net request (the intended caller)", async () => {
    await admin.query("begin");
    try {
      const { rows } = await admin.query("select net.http_post(url := 'http://127.0.0.1:9/c74-temp-probe', body := '{}'::jsonb) as id");
      expect(Number(rows[0].id)).toBeGreaterThan(0);
      const queued = await admin.query("select count(*)::int as n from net.http_request_queue where id = $1", [rows[0].id]);
      expect(queued.rows[0].n).toBe(1);
    } finally {
      await admin.query("rollback");
    }
  });

  it("pins the residual: the login can still attach a built-in trigger function to the pg_net queue", async () => {
    // Only supabase_admin can revoke PUBLIC TRIGGER on net tables (#8015 support
    // request). When it does, this assertion flips and the record can close.
    await login.query("begin");
    try {
      const code = await refusal(login,
        "create trigger c74_residual_probe before update on net.http_request_queue for each row when (false) execute function pg_catalog.suppress_redundant_updates_trigger()");
      expect(code).toBeNull();
    } finally {
      await login.query("rollback");
    }
  });
});
