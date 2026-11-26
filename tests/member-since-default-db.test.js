// @vitest-environment node
// BUG-UG-MEMBER-SINCE-WRONG-FOR-NEW-ACCOUNTS-20261003: creating an
// account does not tell us the year its member joined their union, so the new
// profile's member_since is null (shown blank) rather than the year the
// account was created, and the member can enter or clear their year on their
// own card. Synthetic accounts only; every transaction is rolled back.
// 20261004030000 replaced the current-year default of 20261003066000.
import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { assertDisposableProofUrl } from "../scripts/run-required-db-proofs.mjs";

const live = process.env.RUN_MEMBER_SINCE_DEFAULT_DB_TESTS === "1" ? describe : describe.skip;

live("member_since for new accounts on a disposable database", () => {
  let c;

  beforeAll(async () => {
    c = new pg.Client({ connectionString: assertDisposableProofUrl(process.env.SUPABASE_DB_URL), application_name: "member-since-default-rollback-proof" });
    await c.connect();
  });

  afterAll(async () => {
    await c?.end();
  });

  it("leaves a new account's join year blank and out of the new-this-year count", async () => {
    await c.query("begin");
    try {
      const user = randomUUID();
      // The invitation and sign-up paths create the auth user; the profile row
      // comes from the auth trigger with the column default.
      await c.query("insert into auth.users(id,email) values ($1,$2)", [user, `${user}@example.invalid`]);
      // get_vp_overview's predicate, evaluated in the same session.
      const row = (await c.query(
        `select p.member_since,
                p.member_since = pg_catalog.date_part('year', pg_catalog.now())::int as new_this_year
           from public.member_profiles p where p.id = $1`, [user],
      )).rows[0];
      expect(row.member_since).toBeNull();
      expect(row.new_this_year).toBeNull();
      const column = (await c.query(
        `select a.attnotnull, pg_catalog.pg_get_expr(d.adbin, d.adrelid) as default_expr
           from pg_catalog.pg_attribute a
           left join pg_catalog.pg_attrdef d on d.adrelid = a.attrelid and d.adnum = a.attnum
          where a.attrelid = 'public.member_profiles'::regclass and a.attname = 'member_since'`,
      )).rows[0];
      expect(column).toEqual({ attnotnull: false, default_expr: null });
    } finally {
      await c.query("rollback");
    }
  });

  it("lets the member enter and clear their own join year, within the existing range check", async () => {
    await c.query("begin");
    try {
      const user = randomUUID();
      await c.query("insert into auth.users(id,email) values ($1,$2)", [user, `${user}@example.invalid`]);
      const session = randomUUID();
      await c.query("insert into auth.sessions(id,user_id,aal,created_at,updated_at) values ($1,$2,'aal1',now(),now())", [session, user]);
      await c.query("select set_config('request.jwt.claims',$1,true)", [
        JSON.stringify({ sub: user, role: "authenticated", aal: "aal1", session_id: session }),
      ]);
      await c.query("set local role authenticated");
      const entered = (await c.query(
        "update public.member_profiles set member_since = 2015 where id = $1 returning member_since", [user],
      )).rows;
      const cleared = (await c.query(
        "update public.member_profiles set member_since = null where id = $1 returning member_since", [user],
      )).rows;
      await c.query("savepoint out_of_range");
      const outOfRange = await c.query("update public.member_profiles set member_since = 1800 where id = $1", [user])
        .then(() => "accepted", (error) => error.code);
      await c.query("rollback to savepoint out_of_range");
      await c.query("reset role");
      expect(entered).toEqual([{ member_since: 2015 }]);
      expect(cleared).toEqual([{ member_since: null }]);
      expect(outOfRange).toBe("23514");
    } finally {
      await c.query("rollback");
    }
  });
});
