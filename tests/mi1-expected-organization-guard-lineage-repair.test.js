import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import pg from "pg";
import { describe, expect, it } from "vitest";

const migrationPath = resolve(
  process.cwd(),
  "supabase/migrations/20260830061000_expected_organization_guard_lineage_repair.sql",
);

describe("expected-organization guard lineage repair", () => {
  it("ships an append-only repair after the browser reproduced the missing guard", () => {
    expect(existsSync(migrationPath)).toBe(true);
  });

  const databaseIt = process.env.RUN_EXPECTED_ORG_GUARD_DB_TESTS === "1" ? it : it.skip;

  databaseIt("restores the guard's scope check and private ACL when the historical migration is absent", async () => {
    const client = new pg.Client({
      connectionString: process.env.EXPECTED_ORG_GUARD_DB_URL
        || "postgresql://postgres:postgres@127.0.0.1:54422/postgres",
    });
    await client.connect();

    try {
      await client.query("begin");
      await client.query("drop function if exists private.mi1_require_expected_selected_organization(uuid)");
      await client.query(`
        create or replace function private.mi1_require_selected_organization()
        returns uuid
        language sql
        stable
        security definer
        set search_path = ''
        as $function$
          select '11111111-1111-4111-8111-111111111111'::uuid
        $function$
      `);
      await client.query(readFileSync(migrationPath, "utf8"));

      const accepted = await client.query(
        "select private.mi1_require_expected_selected_organization($1::uuid) as organization_id",
        ["11111111-1111-4111-8111-111111111111"],
      );
      expect(accepted.rows).toEqual([
        { organization_id: "11111111-1111-4111-8111-111111111111" },
      ]);

      await client.query("savepoint wrong_organization");
      await expect(client.query(
        "select private.mi1_require_expected_selected_organization($1::uuid)",
        ["22222222-2222-4222-8222-222222222222"],
      )).rejects.toMatchObject({ code: "42501" });
      await client.query("rollback to savepoint wrong_organization");

      const metadata = await client.query(`
        select
          p.prosecdef,
          p.proconfig,
          coalesce(has_function_privilege('public', p.oid, 'execute'), false) as public_execute,
          coalesce(has_function_privilege('anon', p.oid, 'execute'), false) as anon_execute,
          coalesce(has_function_privilege('authenticated', p.oid, 'execute'), false) as authenticated_execute,
          coalesce(has_function_privilege('service_role', p.oid, 'execute'), false) as service_role_execute
        from pg_proc p
        join pg_namespace n on n.oid = p.pronamespace
        where n.nspname = 'private'
          and p.proname = 'mi1_require_expected_selected_organization'
          and pg_get_function_identity_arguments(p.oid) = 'p_expected_organization_id uuid'
      `);
      expect(metadata.rows).toEqual([{
        prosecdef: true,
        proconfig: ["search_path=\"\""],
        public_execute: false,
        anon_execute: false,
        authenticated_execute: false,
        service_role_execute: false,
      }]);
    } finally {
      await client.query("rollback");
      await client.end();
    }
  });
});
