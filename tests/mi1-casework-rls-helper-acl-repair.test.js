import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import pg from "pg";
import { describe, expect, it } from "vitest";

const migrationPath = resolve(
  process.cwd(),
  "supabase/migrations/20260830062000_casework_rls_helper_acl_repair.sql",
);

const policyHelpers = [
  "casework_staff_can_access(uuid)",
  "casework_can_read(uuid)",
  "casework_scope_matches(uuid, uuid, text)",
];

describe("casework RLS helper ACL repair", () => {
  it("ships an append-only repair for every private helper called directly by authenticated RLS", () => {
    expect(existsSync(migrationPath)).toBe(true);

    const sql = readFileSync(migrationPath, "utf8");
    for (const helper of policyHelpers) {
      expect(sql).toContain(`grant execute on function private.${helper} to authenticated`);
      expect(sql).toContain(`revoke all on function private.${helper} from public, anon, service_role`);
    }
    expect(sql).not.toMatch(/grant execute on function private\.casework_member_owns\(uuid\)/i);
    expect(sql).not.toMatch(/grant execute on function private\.casework_require_mfa\(\)/i);

    const contract = JSON.parse(readFileSync(resolve(process.cwd(), "scripts/db-contract.json"), "utf8"));
    const functions = new Map(contract.functions.map((entry) => [entry.sig, entry]));
    for (const signature of [
      "private.casework_staff_can_access(p_case_id uuid)",
      "private.casework_can_read(p_case_id uuid)",
      "private.casework_scope_matches(p_case_id uuid, p_organization_id uuid, p_chapter_id text)",
    ]) expect(functions.get(signature)?.exec).toBe("authenticated");
    expect(functions.get("private.casework_member_owns(p_case_id uuid)")?.exec).toBe("");
    expect(functions.get("private.casework_require_mfa()")?.exec).toBe("");
  });

  const databaseIt = process.env.RUN_CASEWORK_RLS_ACL_DB_TESTS === "1" ? it : it.skip;

  databaseIt("lets authenticated policies execute only their direct helpers", async () => {
    const client = new pg.Client({
      connectionString: process.env.CASEWORK_RLS_ACL_DB_URL
        || "postgresql://postgres:postgres@127.0.0.1:54422/postgres",
    });
    await client.connect();

    try {
      await client.query("begin");
      for (const helper of policyHelpers) {
        await client.query(`revoke all on function private.${helper} from authenticated`);
      }
      await client.query(readFileSync(migrationPath, "utf8"));

      const metadata = await client.query(`
        select
          p.proname,
          pg_get_function_identity_arguments(p.oid) as arguments,
          p.prosecdef,
          p.proconfig,
          coalesce(has_function_privilege('public', p.oid, 'execute'), false) as public_execute,
          coalesce(has_function_privilege('anon', p.oid, 'execute'), false) as anon_execute,
          coalesce(has_function_privilege('authenticated', p.oid, 'execute'), false) as authenticated_execute,
          coalesce(has_function_privilege('service_role', p.oid, 'execute'), false) as service_role_execute
        from pg_proc p
        join pg_namespace n on n.oid = p.pronamespace
        where n.nspname = 'private'
          and p.proname = any(array[
            'casework_member_owns',
            'casework_staff_can_access',
            'casework_can_read',
            'casework_scope_matches',
            'casework_require_mfa'
          ])
        order by p.proname
      `);

      expect(metadata.rows).toEqual([
        {
          proname: "casework_can_read",
          arguments: "p_case_id uuid",
          prosecdef: true,
          proconfig: ["search_path=\"\""],
          public_execute: false,
          anon_execute: false,
          authenticated_execute: true,
          service_role_execute: false,
        },
        {
          proname: "casework_member_owns",
          arguments: "p_case_id uuid",
          prosecdef: true,
          proconfig: ["search_path=\"\""],
          public_execute: false,
          anon_execute: false,
          authenticated_execute: false,
          service_role_execute: false,
        },
        {
          proname: "casework_require_mfa",
          arguments: "",
          prosecdef: true,
          proconfig: ["search_path=\"\""],
          public_execute: false,
          anon_execute: false,
          authenticated_execute: false,
          service_role_execute: false,
        },
        {
          proname: "casework_scope_matches",
          arguments: "p_case_id uuid, p_organization_id uuid, p_chapter_id text",
          prosecdef: true,
          proconfig: ["search_path=\"\""],
          public_execute: false,
          anon_execute: false,
          authenticated_execute: true,
          service_role_execute: false,
        },
        {
          proname: "casework_staff_can_access",
          arguments: "p_case_id uuid",
          prosecdef: true,
          proconfig: ["search_path=\"\""],
          public_execute: false,
          anon_execute: false,
          authenticated_execute: true,
          service_role_execute: false,
        },
      ]);

      await client.query("set local role authenticated");
      const executable = await client.query(`
        select
          private.casework_can_read('00000000-0000-0000-0000-000000000000'::uuid) as can_read,
          private.casework_staff_can_access('00000000-0000-0000-0000-000000000000'::uuid) as staff_can_access,
          private.casework_scope_matches(
            '00000000-0000-0000-0000-000000000000'::uuid,
            '00000000-0000-0000-0000-000000000000'::uuid,
            'missing'
          ) as scope_matches
      `);
      expect(executable.rows).toEqual([{
        can_read: false,
        staff_can_access: false,
        scope_matches: false,
      }]);
    } finally {
      await client.query("rollback");
      await client.end();
    }
  });
});
