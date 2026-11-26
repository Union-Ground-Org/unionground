// @vitest-environment node
// BUG-UG-TAMARACK-DEMO-MEMBER-DEADLINE-AGES-DAILY-AND-MEETING-WEEKDAY-WRONG-20261122 (#9610):
// private.demo_seed_case_deadline_writes is the demo seed's own proof of the
// deadline it last wrote to each history case. No client role can read or
// write it (no grant, row security with no policy), it goes with its case,
// and it joins the case-graph locking protocol.
import pg from "pg";
import { afterAll, beforeAll, expect, it } from "vitest";
import { assertDisposableProofUrl } from "../scripts/run-required-db-proofs.mjs";

const databaseIt = process.env.SUPABASE_DB_URL ? it : it.skip;
let client;
beforeAll(async () => {
  if (!process.env.SUPABASE_DB_URL) return;
  client = new pg.Client({ connectionString: assertDisposableProofUrl(process.env.SUPABASE_DB_URL) });
  await client.connect();
});
afterAll(async () => { await client?.end(); });

databaseIt("keeps the ledger closed to every client role, cascading with its case, inside the case-graph protocol", async () => {
  const { rows: [table] } = await client.query(`select c.relrowsecurity rls,
      (select count(*)::int from pg_policy p where p.polrelid = c.oid) policies,
      (select array_agg(pg_catalog.format('%s:%s', r, p) order by r, p) from unnest(array['anon','authenticated','service_role']) r,
         unnest(array['select','insert','update','delete','truncate','references','trigger']) p
         where pg_catalog.has_table_privilege(r, c.oid, p)) client_privileges,
      (select array_agg(pg_catalog.format('%s %s %s', con.conname, con.confrelid::regclass, con.confdeltype) order by con.conname)
         from pg_constraint con where con.conrelid = c.oid and con.contype = 'f') foreign_keys,
      (select array_agg(t.tgname || ' ' || t.tgfoid::regprocedure || ' ' || t.tgtype order by t.tgname)
         from pg_trigger t where t.tgrelid = c.oid and not t.tgisinternal) triggers,
      (select count(*)::int from private.account_lifecycle_transitive_fk_manifest m
         where m.schema_name = 'private' and m.table_name = 'demo_seed_case_deadline_writes'
           and m.parent_table_name = 'member_cases' and m.delete_disposition = 'cascade') lifecycle
    from pg_class c where c.oid = 'private.demo_seed_case_deadline_writes'::regclass`);
  expect(table).toEqual({
    rls: true, policies: 0, client_privileges: null, lifecycle: 1,
    foreign_keys: [
      "demo_seed_case_deadline_writes_case_id_fkey member_cases c",
      "demo_seed_case_deadline_writes_organization_id_fkey organizations c",
    ],
    triggers: [
      "a00_case_graph_lock private.lock_case_graph_statement() 30",
      "z99_case_graph_keys private.lock_case_graph_row_keys() 31",
    ],
  });
}, 60_000);
