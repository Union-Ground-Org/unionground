// @vitest-environment node
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import pg from "pg";
import { describe, expect, it } from "vitest";
import { assertDisposableProofUrl } from "../scripts/run-required-db-proofs.mjs";

const signature = "public.get_calendar_feed_status()";
const database = process.env.SUPABASE_DB_URL ? describe : describe.skip;

database("calendar feed status on the migrated database", () => {
  it("returns a boolean for only the caller and follows mint and revoke", async () => {
    const db = new pg.Client({ connectionString: assertDisposableProofUrl(process.env.SUPABASE_DB_URL), ssl: false });
    await db.connect();
    await db.query("begin");
    try {
      for (const [role, allowed] of [["authenticated", true], ["anon", false], ["service_role", false]]) {
        const { rows: [acl] } = await db.query("select has_function_privilege($1, $2, 'execute') as allowed", [role, signature]);
        expect(acl.allowed).toBe(allowed);
      }
      const contract = JSON.parse(readFileSync(new URL("../scripts/db-contract.json", import.meta.url), "utf8"));
      const { rows: [definition] } = await db.query(`
        select prosecdef, provolatile, proconfig, format_type(prorettype, null) as return_type, md5(prosrc) as digest
        from pg_proc where oid = $1::regprocedure
      `, [signature]);
      expect(definition).toMatchObject({ prosecdef: false, provolatile: "s", return_type: "boolean", proconfig: ['search_path=""'] });
      expect(definition.digest).toBe(contract.functions.find(({ sig }) => sig === signature).sourceMd5);
      const { rows: [column] } = await db.query(`
        select has_column_privilege('authenticated', 'public.member_calendar_feed_tokens', 'token_hash', 'select') as readable
      `);
      expect(column.readable).toBe(false);

      const members = [];
      for (let index = 0; index < 2; index += 1) {
        const user = randomUUID();
        const session = randomUUID();
        await db.query("insert into auth.users (id, email, raw_user_meta_data) values ($1, $2, '{}')", [user, `${user}@calendar-status.invalid`]);
        await db.query("insert into auth.sessions (id, user_id, created_at, updated_at, aal) values ($1, $2, now(), now(), 'aal2')", [session, user]);
        members.push({ role: "authenticated", sub: user, session_id: session, aal: "aal2" });
      }

      const signIn = async (claims) => {
        await db.query("reset role");
        await db.query("select set_config('request.jwt.claims', $1, true)", [JSON.stringify(claims)]);
        await db.query("set local role authenticated");
      };
      const status = async () => (await db.query(`select ${signature} as active`)).rows[0].active;

      await signIn(members[0]);
      expect(await status()).toBe(false);
      expect((await db.query("select public.rotate_calendar_feed_token() as feed")).rows[0].feed.token).toMatch(/^[0-9a-f]{48}$/);
      expect(await status()).toBe(true);

      await signIn(members[1]);
      expect(await status()).toBe(false);
      await signIn(members[0]);
      expect(await status()).toBe(true);
      expect((await db.query("select public.revoke_calendar_feed_token() as feed")).rows[0].feed).toEqual({ revoked: true });
      expect(await status()).toBe(false);

      await db.query("reset role");
      const enrolled = members[1];
      await db.query("insert into auth.mfa_factors (id, user_id, factor_type, status, created_at, updated_at) values ($1, $2, 'totp', 'verified', now(), now())", [randomUUID(), enrolled.sub]);
      await db.query("update auth.sessions set aal = 'aal1' where id = $1", [enrolled.session_id]);
      await db.query("savepoint insufficient_assurance");
      await signIn({ ...enrolled, aal: "aal1" });
      await expect(status()).rejects.toMatchObject({ code: "42501", message: "full member session required" });
      await db.query("rollback to savepoint insufficient_assurance");

      await db.query("savepoint missing_session");
      await signIn({ ...members[0], session_id: randomUUID() });
      await expect(status()).rejects.toMatchObject({ code: "42501" });
      await db.query("rollback to savepoint missing_session");
      await db.query("reset role");
      await db.query("insert into private.member_pin_sessions (session_id, user_id) values ($1, $2)", [members[0].session_id, members[0].sub]);
      await signIn(members[0]);
      await expect(status()).rejects.toMatchObject({ code: "42501", message: "full member session required" });
    } finally {
      await db.query("rollback");
      await db.end();
    }
  });
});
