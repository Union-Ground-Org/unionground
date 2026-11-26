// @vitest-environment node
// The 14 RPCs the 09-24 hosted window
// installed kept the hosted default service_role EXECUTE grant, while their
// contract entries are authenticated-only. 20260925270000 revokes exactly that
// grant. The offline half pins the migration to the contract; the live half
// (disposable loopback only) reproduces the hosted grant inside a rolled-back
// transaction, applies the revokes and proves only those 14 ACLs changed.
import { readFileSync } from "node:fs";
import pg from "pg";
import { describe, expect, it } from "vitest";
import { assertDisposableProofUrl } from "../scripts/run-required-db-proofs.mjs";
import { findMigrationName, loadMigrationSql, stripComments } from "./helpers/migration.js";

const contract = JSON.parse(readFileSync(new URL("../scripts/db-contract.json", import.meta.url), "utf8"));
const MIGRATION = "window_rpc_service_role_execute_revoke";
const sql = stripComments(loadMigrationSql(MIGRATION));

// Contract signature -> the identity argument types the REVOKE names.
const SIGNATURES = {
  "public.list_case_note_mention_candidates(p_case_id uuid)": "public.list_case_note_mention_candidates(uuid)",
  "public.casework_add_case_note(p_case_id uuid, p_body text, p_mention_ids uuid[])": "public.casework_add_case_note(uuid, text, uuid[])",
  "public.casework_save_macro(p_macro_id uuid, p_chapter_id text, p_name text, p_actions jsonb, p_active boolean)": "public.casework_save_macro(uuid, text, text, jsonb, boolean)",
  "public.casework_list_macros()": "public.casework_list_macros()",
  "public.casework_apply_macro(p_macro_id uuid, p_case_ids uuid[], p_idempotency_key uuid)": "public.casework_apply_macro(uuid, uuid[], uuid)",
  "public.casework_record_case_export(p_case_ids uuid[], p_scope text, p_filter_keys text[])": "public.casework_record_case_export(uuid[], text, text[])",
  "public.list_member_saved_views(p_plane text)": "public.list_member_saved_views(text)",
  "public.save_member_saved_view(p_id uuid, p_plane text, p_name text, p_definition jsonb, p_is_default boolean)": "public.save_member_saved_view(uuid, text, text, jsonb, boolean)",
  "public.delete_member_saved_view(p_id uuid)": "public.delete_member_saved_view(uuid)",
  "public.get_member_organization_structure()": "public.get_member_organization_structure()",
  "public.get_member_chapter_stewards()": "public.get_member_chapter_stewards()",
  "public.get_my_steward_contact_visibility()": "public.get_my_steward_contact_visibility()",
  "public.set_my_steward_contact_visibility(p_share_email boolean, p_share_phone boolean, p_contact_email text, p_contact_phone text)": "public.set_my_steward_contact_visibility(boolean, boolean, text, text)",
  "public.start_member_steward_conversation(p_steward_user_id uuid, p_body text)": "public.start_member_steward_conversation(uuid, text)",
};
const TARGETS = Object.values(SIGNATURES);
const statements = sql.split(";").map((statement) => statement.trim().replace(/\s+/g, " ")).filter(Boolean);
const revokes = statements.filter((statement) => statement.startsWith("revoke "));

describe("window RPC service_role revoke migration", () => {
  it("sorts after the migrations that define the 14 RPCs", () => {
    expect(findMigrationName(MIGRATION) > "20260924170300_member_organization_structure.sql").toBe(true);
  });

  it("revokes only service_role EXECUTE, once per contract signature, and nothing else", () => {
    expect(revokes).toEqual(TARGETS.map((target) => `revoke execute on function ${target} from service_role`));
    expect(statements.filter((statement) => !statement.startsWith("revoke "))).toEqual([
      "begin",
      "notify pgrst, 'reload schema'",
      "commit",
    ]);
  });

  it("keeps the 14 contract entries authenticated-only", () => {
    for (const sig of Object.keys(SIGNATURES)) {
      const entries = contract.functions.filter((entry) => entry.sig === sig);
      expect(entries, sig).toHaveLength(1);
      expect(entries[0].exec, sig).toBe("authenticated");
    }
  });
});

const live = process.env.SUPABASE_DB_URL ? describe : describe.skip;

live("window RPC service_role revoke on a disposable database", () => {
  it("removes the hosted default service_role grant from exactly the 14 RPCs and keeps authenticated", async () => {
    const client = new pg.Client({ connectionString: assertDisposableProofUrl(process.env.SUPABASE_DB_URL) });
    const snapshot = async () => (await client.query(`
      select p.oid::text as oid, md5(pg_get_functiondef(p.oid)) as definition_md5,
        pg_get_userbyid(p.proowner) as owner,
        coalesce(p.proacl, acldefault('f', p.proowner))::text as acl
      from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      where n.nspname in ('public', 'private') and p.prokind = 'f'
      order by p.oid`)).rows;
    const permissions = async () => (await client.query(`
      select p.oid::regprocedure::text as sig,
        has_function_privilege('authenticated', p.oid, 'EXECUTE') as authenticated,
        has_function_privilege('anon', p.oid, 'EXECUTE') as anon,
        has_function_privilege('service_role', p.oid, 'EXECUTE') as service_role,
        exists (select 1 from aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a
          where a.grantee = 0 and a.privilege_type = 'EXECUTE') as public
      from pg_proc p where p.oid = any($1::regprocedure[]) order by p.oid`, [TARGETS])).rows;
    await client.connect();
    try {
      await client.query("begin");
      await client.query("set local lock_timeout = '5s'");
      // Restore the hosted defect on the real definitions, inside this
      // rolled-back transaction only.
      await client.query(`grant execute on function ${TARGETS.join(", ")} to service_role`);
      const hosted = await permissions();
      expect(hosted).toHaveLength(14);
      for (const row of hosted) {
        expect(row, row.sig).toMatchObject({ authenticated: true, anon: false, service_role: true, public: false });
      }
      const targetOids = new Set((await client.query(
        "select unnest($1::regprocedure[])::oid::text as oid", [TARGETS])).rows.map((row) => row.oid));
      const before = await snapshot();

      for (const statement of revokes) await client.query(statement);

      const after = await snapshot();
      // Bodies and owners are untouched everywhere; ACLs change only on the 14.
      expect(after.map(({ acl: _acl, ...row }) => row)).toEqual(before.map(({ acl: _acl, ...row }) => row));
      expect(after.filter((row, index) => row.acl !== before[index].acl).map((row) => row.oid).sort())
        .toEqual([...targetOids].sort());
      for (const row of await permissions()) {
        expect(row, row.sig).toMatchObject({ authenticated: true, anon: false, service_role: false, public: false });
      }

      // service_role is refused at EXECUTE, before any body runs.
      for (const target of TARGETS) {
        const [, name, args] = target.match(/^public\.(\w+)\((.*)\)$/);
        const nulls = args ? args.split(", ").map((type) => `null::${type}`).join(", ") : "";
        await client.query("savepoint denied_rpc");
        await client.query("set local role service_role");
        await expect(client.query(`select public.${name}(${nulls})`), name).rejects.toMatchObject({
          code: "42501", message: expect.stringContaining(`permission denied for function ${name}`),
        });
        await client.query("rollback to savepoint denied_rpc");
      }
    } finally {
      await client.query("rollback").catch(() => {});
      await client.end();
    }
  });
});
