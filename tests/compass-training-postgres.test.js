// @vitest-environment node
import { randomUUID } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { offlinePostgres, postgresBin } from "./tamarack-postgres-helper.mjs";
import { foreignKeyCatalogueSql, normalizeForeignKeyRow, reviewedForeignKeys } from "../scripts/account-case-graph-inventory.mjs";
import { readPolicyCatalogue } from "../scripts/verify-db-contract.mjs";

const read = name => readFileSync(new URL(`../supabase/migrations/${name}.sql`, import.meta.url), "utf8");
const migration = read("20261027060200_compass_training_retention");
const foundation = read("20260822010000_mi1_organization_scope_foundation");
const lifecycle = read("20260907150000_account_lifecycle_manifest");
const currentExport = read("20261009000500_steward_case_title_and_private_reminders");
// 20261030224501 re-emits the export with the chapter seniority domains; the
// database contract pins that generation, so it is applied over this one.
const seniorityExport = read("20261030224501_chapter_seniority_and_bids");
// The saved-chart delivery adds one export domain. Install its actual wrapper
// over the same domain-helper stubs so the isolated fixture matches the current
// contract without pulling the chart schema into this training-only database.
const savedChartExport = read("20261102001534_pulse_saved_charts");
const scopedAccessExport = read("20261102005607_unit_committee_scoped_access");
const financeExport = read("20261102014446_chapter_treasurer_financial_duties");
// #7663 re-emits the export with steward unit assignments and the carry-over flag.
const stewardUnitsExport = read(readdirSync(new URL("../supabase/migrations/", import.meta.url)).find((name) => name.endsWith("_stewards_require_unit_with_carry_over.sql")).replace(/\.sql$/, ""));
const pulseLayoutExport = read("20261113148000_pulse_layout_store");
const referralPayoutsExport = read('20261113134500_referral_over_weekly_cap_waits_for_a_later_week');
const triggerInventory = read("20260929034500_account_lifecycle_trigger_inventory_tokens");
const quotaScope = read("20261002135600_restore_review_hotfixes");
const providerScope = read("20260918071000_compass_inhouse_mesh_provider");
// The training migration refuses any predecessor but the privacy 1.0.2 validator.
const privacyPredecessor = read("20261027055000_privacy_1_0_2_pkce_storage_disclosure");
// The analytics and heatmaps privacy revisions re-pin the validator after it.
const privacyAnalytics = read("20261028214849_privacy_1_2_0_member_product_analytics");
const privacyHeatmaps = read("20261029230836_privacy_1_2_1_public_page_heatmaps");
const privacyAnnouncements = read("20261029235622_platform_announcements_consumers_and_controls");
// Privacy 1.3.1 (the device-only menu pin key) and 1.3.2 (the officer
// member-list export) re-pin it once more each.
const privacyNavigationPins = read("20261031000500_privacy_1_3_1_navigation_pins_storage");
const privacyOfficerExport = read("20261031020000_officer_member_directory_and_export");
// The first legal release re-pins the validator last (privacy 1.4.0).
const legalPackRelease = read("20261113125500_legal_pack_release");
// #8605 re-emits the purge so it picks its expired rows once.
const boundedCleanups = read("20261113123500_bounded_cleanups_pick_rows_once");
// The chart cache disclosure follows the same nonmaterial sequence at 1.3.3.
const privacyPulseCharts = savedChartExport.slice(savedChartExport.indexOf('do $pulse_disclosure_pack$'), savedChartExport.indexOf('notify pgrst'));
const body = (source, signature) => source.slice(source.indexOf(signature), source.indexOf("$function$;", source.indexOf(signature)) + 11);
const NOTICE = "compass-training-v1";
const contract = JSON.parse(readFileSync(new URL("../scripts/db-contract.json", import.meta.url), "utf8"));

describe.skipIf(!postgresBin)("Compass training retention in isolated PostgreSQL", () => {
  let db;
  let f;
  let definitions;
  let trainingForeignKeys;
  beforeAll(async () => {
    db = await offlinePostgres({ durable: false });
    await db.client.query(`
      create schema private; create schema auth; create schema extensions; create schema cron;
      create extension pgcrypto with schema extensions;
      create role anon; create role authenticated; create role service_role;
      grant usage on schema public, private, auth to anon, authenticated, service_role;
      create table auth.users(id uuid primary key);
      create table public.organizations(id uuid primary key, status text not null default 'active');
      create table public.chapters(id text primary key, organization_id uuid references public.organizations(id));
      create table public.member_profiles(id uuid primary key, chapter_id text);
      create table public.member_chapter_memberships(user_id uuid, chapter_id text, status text);
      create table public.organization_memberships(organization_id uuid, user_id uuid, status text);
      create table public.organization_role_grants(organization_id uuid, user_id uuid, role text);
      create table public.member_ai_requests(id uuid primary key, user_id uuid, created_at timestamptz default now(),
        compass_organization_id uuid, dispatch_authorized_at timestamptz);
      create function auth.jwt() returns jsonb language sql stable as $$ select coalesce(nullif(current_setting('request.jwt.claims',true),''),'{}')::jsonb $$;
      create function auth.uid() returns uuid language sql stable as $$ select (auth.jwt()->>'sub')::uuid $$;
      create function private.mfa_satisfied() returns boolean language sql stable as $$ select coalesce(auth.jwt()->>'aal'='aal2',false) $$;
      create function private.staff_mfa_required(uuid) returns boolean language sql stable as $$ select true $$;
      create function private.has_second_factor(uuid) returns boolean language sql stable as $$ select private.mfa_satisfied() $$;
      create function private.member_pin_require_full_session() returns void language plpgsql as $$ begin
        if auth.jwt()->>'restricted'='true' then raise exception 'step up' using errcode='42501'; end if;
      end $$;
      create function private.lock_message_lifecycle() returns void language sql as $$ select pg_advisory_xact_lock(509,699) $$;
      create table cron.job(jobid bigint,jobname text,command text);
      insert into cron.job values (1,'union-ground-organization-retention','select private.run_due_organization_retention_jobs(25);');
      create function cron.alter_job(job_id bigint, command text) returns void language sql as $$ update cron.job set command=$2 where jobid=$1 $$;
      create table private.account_lifecycle_trigger_review(kind text,schema_name text,table_name text,object_name text,definition_hash text,
        primary key(kind,schema_name,table_name,object_name));
    `);
    await db.client.query(lifecycle.slice(lifecycle.indexOf("create function private.lock_case_graph("), lifecycle.indexOf("-- BUG-UG-ACCOUNT-LIFECYCLE-REGRESSION")));
    await db.client.query(lifecycle.match(/create table private.account_lifecycle_manifest \([\s\S]*?\n\);/)[0]);
    await db.client.query(lifecycle.match(/alter table private.account_lifecycle_manifest\s+add constraint account_lifecycle_manifest_export_projection_shape check \([\s\S]*?\n {2}\);/)[0]);
    await db.client.query(lifecycle.match(/create function private.account_lifecycle_unmanaged_export_fks\(\)[\s\S]*?\n\$\$;/)[0]);
    await db.client.query(body(foundation, "create function private.current_member_organization()"));
    await db.client.query(body(foundation, "create function private.has_organization_role("));
    const memberOrganization = providerScope.slice(providerScope.indexOf("create function private.member_organization_for("), providerScope.indexOf("revoke all on function private.member_organization_for("));
    await db.client.query(memberOrganization);
    await db.client.query(body(quotaScope, "create function private.compass_quota_organization("));
    const contextStart = quotaScope.indexOf("create or replace function private.compass_context_organization()");
    await db.client.query(quotaScope.slice(contextStart, quotaScope.indexOf("revoke all on function private.compass_context_organization()", contextStart)));
    await db.client.query(body(triggerInventory, "create or replace function private.account_lifecycle_trigger_surface()"));
    await db.client.query(body(lifecycle, "create function private.account_lifecycle_referential_action_trigger_issues()"));
    // Existing lifecycle trigger functions are already reviewed on Main.
    // Seed that baseline using the real installed inventory, not a stub that
    // makes every new trigger appear reviewed automatically.
    await db.client.query(`
      create trigger fixture_existing_statement before update on public.organizations
        for each statement execute function private.lock_case_graph_statement();
      create trigger fixture_existing_row before update on public.organizations
        for each row execute function private.lock_case_graph_row_keys('', '');
      insert into private.account_lifecycle_trigger_review select * from private.account_lifecycle_trigger_surface();
    `);
    const helpers = [...currentExport.match(/create or replace function private.account_lifecycle_export_additional_domains[\s\S]*?\n\$\$;/)[0]
      .matchAll(/private\.(account_lifecycle_export_\w+)\(p_caller\)/g)].map(match => match[1]);
    // This edition's training migration also calls its own export domains
    // (member capacity commitments); stub every helper the migration names.
    const definedHere = new Set([...migration.matchAll(/create (?:or replace )?function private\.(\w+)\(/g)].map(match => match[1]));
    helpers.push(...[...migration.matchAll(/private\.(account_lifecycle_export_\w+)\(p_caller\)/g)].map(match => match[1]).filter(name => !definedHere.has(name)));
    for (const name of new Set(helpers)) await db.client.query(`create function private.${name}(uuid) returns jsonb language sql as $$ select '[]'::jsonb $$`);
    await db.client.query(body(privacyPredecessor, "create or replace function private.legal_acceptance_versions("));
    await db.client.query(migration);
    for (const name of ["account_lifecycle_export_chapter_seniority_entries", "account_lifecycle_export_chapter_bid_entries", "account_lifecycle_export_pulse_saved_charts"]) {
      await db.client.query(`create function private.${name}(uuid) returns jsonb language sql as $$ select '[]'::jsonb $$`);
    }
    await db.client.query(seniorityExport.match(/create or replace function private\.account_lifecycle_export_additional_domains[\s\S]*?\n\$\$;/)[0]);
    await db.client.query(body(savedChartExport, "create or replace function private.account_lifecycle_export_additional_domains("));
    // #6682 (20261102005607) re-emits it once more with the caller's own unit,
    // committee and role-scope rows; the contract pins that generation.
    await db.client.query(`
      create table private.chapter_unit_members(user_id uuid, chapter_id text, unit_id uuid);
      create table private.chapter_committee_members(user_id uuid, chapter_id text, committee_id uuid);
      create table private.chapter_role_scopes(user_id uuid, chapter_id text, role text, unit_id uuid, committee_id uuid);
    `);
    await db.client.query(scopedAccessExport.match(/CREATE OR REPLACE FUNCTION private\.account_lifecycle_export_additional_domains[\s\S]*?\n\$function\$/)[0]);
    // #6688 re-emits it with the caller's own financial requests; the
    // contract pins that generation.
    await db.client.query(`create table private.chapter_financial_requests(id uuid, organization_id uuid, chapter_id text, subject_id uuid, kind text, title text, description text, amount numeric, currency text, status text, decision_note text, revision integer, created_at timestamptz, decided_at timestamptz)`);
    await db.client.query(financeExport.match(/CREATE OR REPLACE FUNCTION private\.account_lifecycle_export_additional_domains[\s\S]*?\n\$function\$/)[0]);
    // #7663 adds the caller's organization steward unit assignments and the
    // carry-over flag on role scopes; the contract pins that generation.
    await db.client.query(`alter table private.chapter_role_scopes add column legacy_chapter_coverage boolean not null default false;
      create table private.organization_steward_unit_assignments(organization_id uuid, user_id uuid, role text, chapter_id text, unit_id uuid, legacy_chapter_coverage boolean);`);
    await db.client.query(stewardUnitsExport.match(/CREATE OR REPLACE FUNCTION private\.account_lifecycle_export_additional_domains[\s\S]*?\n\$function\$/)[0]);
    // #8772 appends the caller's own waiting referral payouts before #8927.
    await db.client.query("create function private.account_lifecycle_export_member_referral_payouts_waiting(uuid) returns jsonb language sql as $$ select '[]'::jsonb $$");
    await db.client.query(referralPayoutsExport.match(/CREATE OR REPLACE FUNCTION private\.account_lifecycle_export_additional_domains[\s\S]*?\n\$function\$/)[0]);
    // #8927 adds only owner layout metadata to this same current exporter.
    await db.client.query('create table private.pulse_layouts(owner_id uuid, organization_id uuid, chapter_id text, entries jsonb)');
    await db.client.query(pulseLayoutExport.match(/CREATE OR REPLACE FUNCTION private\.account_lifecycle_export_additional_domains[\s\S]*?\n\$function\$/)[0]);
    await db.client.query(privacyAnalytics);
    await db.client.query(privacyHeatmaps);
    await db.client.query(body(privacyAnnouncements, "create or replace function private.legal_acceptance_versions("));
    await db.client.query(body(privacyNavigationPins, "create or replace function private.legal_acceptance_versions("));
    await db.client.query(body(privacyOfficerExport, "create or replace function private.legal_acceptance_versions("));
    await db.client.query(privacyPulseCharts);
    await db.client.query(body(legalPackRelease, "create or replace function private.legal_acceptance_versions("));
    const purgeStart = boundedCleanups.indexOf("create or replace function private.purge_expired_compass_training_samples(");
    await db.client.query(boundedCleanups.slice(purgeStart, boundedCleanups.indexOf("\n$$;", purgeStart) + 4));
    trainingForeignKeys = (await db.client.query(foreignKeyCatalogueSql)).rows.map(normalizeForeignKeyRow)
      .filter(row => row.child.startsWith("private.compass_training_"));
    {
      const functions = (await db.client.query(`select n.nspname||'.'||p.proname||'('||pg_get_function_identity_arguments(p.oid)||')' sig,
        p.prosecdef secdef, p.prosrc source, md5(p.prosrc) source_md5, array(select r from unnest(array['anon','authenticated','service_role']) r where has_function_privilege(r,p.oid,'EXECUTE')) grantees
        from pg_proc p join pg_namespace n on n.oid=p.pronamespace where p.proname like '%compass_training%' or p.proname in ('legal_acceptance_versions','account_lifecycle_export_additional_domains') order by 1`)).rows;
      const policies = (await db.client.query(`select n.nspname||'.'||c.relname "table",p.polname name,p.polcmd cmd,p.polpermissive permissive,
        pg_get_expr(p.polqual,p.polrelid) qual, array(select rolname from pg_roles where oid=any(p.polroles)) roles
        from pg_policy p join pg_class c on c.oid=p.polrelid join pg_namespace n on n.oid=c.relnamespace where c.relname like 'compass_training_%' order by 1,2`)).rows;
      definitions = { functions, policies };
    }
  }, 120000);
  afterAll(async () => { await db?.close(); });
  beforeEach(async () => {
    f = Object.fromEntries(["org1", "org2", "member1", "member2", "admin1", "admin2"].map(key => [key, randomUUID()]));
    await db.client.query("begin");
    for (const user of [f.member1, f.member2, f.admin1, f.admin2]) await db.client.query("insert into auth.users values ($1)", [user]);
    for (const [org, users, admin] of [[f.org1, [f.member1, f.admin1], f.admin1], [f.org2, [f.member2, f.admin2], f.admin2]]) {
      await db.client.query("insert into public.organizations(id) values($1)", [org]);
      await db.client.query("insert into public.chapters values($1,$2)", [org, org]);
      for (const user of users) {
        await db.client.query("insert into public.member_profiles values($1,$2)", [user, org]);
        await db.client.query("insert into public.member_chapter_memberships values($1,$2,'active')", [user, org]);
        await db.client.query("insert into public.organization_memberships values($1,$2,'active')", [org, user]);
      }
      await db.client.query("insert into public.organization_role_grants values($1,$2,'admin')", [org, admin]);
    }
  });
  afterEach(async () => { await db.client.query("rollback"); });

  it("includes contracted private policies without widening the exposed-schema sweep", async () => {
    await db.client.query(`
      create table private.unlisted_policy_probe(id integer);
      create policy unlisted_read on private.unlisted_policy_probe for select to authenticated using (true);
      create table public.catalogue_policy_probe(id integer);
      create policy public_read on public.catalogue_policy_probe for select to authenticated using (true);
      create schema storage;
      create table storage.catalogue_policy_probe(id integer);
      create policy storage_read on storage.catalogue_policy_probe for select to authenticated using (true);
    `);
    const rows = await readPolicyCatalogue(
      (sql, parameters) => db.client.query(sql, parameters).then(result => result.rows),
      contract.policies,
    );
    for (const [table, name] of [
      ["private.compass_training_member_consents", "training_member_read"],
      ["private.compass_training_organization_consents", "training_organization_read"],
      ["private.compass_training_samples", "training_sample_read"],
      ["catalogue_policy_probe", "public_read"],
      ["storage.catalogue_policy_probe", "storage_read"],
    ]) {
      expect(rows).toContainEqual(expect.objectContaining({ tbl: table, name, cmd: "r", roles: ["authenticated"] }));
    }
    expect(rows.some(row => row.tbl === "private.unlisted_policy_probe")).toBe(false);
  });

  async function asUser(user, extra = {}) {
    await db.client.query("reset role");
    await db.client.query("select set_config('request.jwt.claims',$1,true)", [JSON.stringify({ sub: user, role: "authenticated", aal: "aal2", ...extra })]);
    await db.client.query("set local role authenticated");
  }
  async function service() {
    await db.client.query("reset role");
    await db.client.query("select set_config('request.jwt.claims','{\"role\":\"service_role\"}',true)");
    await db.client.query("set local role service_role");
  }
  async function consent(org = 1) {
    await asUser(org === 1 ? f.admin1 : f.admin2);
    await db.client.query("select public.compass_training_preferences('organization',true,$1)", [NOTICE]);
    await asUser(org === 1 ? f.member1 : f.member2);
    await db.client.query("select public.compass_training_preferences('member',true,$1)", [NOTICE]);
  }
  async function request(org = f.org1, user = f.member1, age = "0 seconds") {
    await db.client.query("reset role");
    const id = randomUUID();
    await db.client.query("insert into public.member_ai_requests values($1,$2,now()-$4::interval,$3,now())", [id, user, org, age]);
    return id;
  }
  async function retain(id, user = f.member1) {
    await service();
    return (await db.client.query("select public.retain_compass_training_pair($1,$2,'question','Where is the contract?','The contract is in the library.',$3) saved", [id, user, NOTICE])).rows[0].saved;
  }
  async function count(org = null) {
    await db.client.query("reset role");
    return Number((await db.client.query("select count(*) n from private.compass_training_samples where $1::uuid is null or organization_id=$1", [org])).rows[0].n);
  }
  async function denied(sql, params = []) {
    await db.client.query("savepoint deny");
    try { await expect(db.client.query(sql, params)).rejects.toMatchObject({ code: "42501" }); }
    finally { await db.client.query("rollback to savepoint deny"); }
  }

  it("starts off and needs both explicit current-version consents before the request", async () => {
    await asUser(f.member1);
    expect((await db.client.query("select public.compass_training_preferences() pref")).rows[0].pref).toMatchObject({ memberEnabled: false, organizationEnabled: false });
    expect(await retain(await request())).toBe(false);
    await consent();
    expect(await retain(await request(f.org1, f.member1, "1 minute"))).toBe(false);
    expect(await retain(await request())).toBe(true);
    expect(await count()).toBe(1);
  });
  it("matches the database contract's exact helper bodies, permissions and RLS predicates", () => {
    for (const definition of definitions.functions) {
      const entry = contract.functions.find(candidate => candidate.sig === definition.sig);
      expect(entry, definition.sig).toBeDefined();
      expect(definition.secdef).toBe(entry.secdef);
      expect(definition.grantees.join(",")).toBe(entry.exec);
      expect(definition.source_md5).toBe(entry.sourceMd5);
      for (const required of entry.bodyContains ?? []) expect(definition.source).toContain(required);
    }
    for (const definition of definitions.policies) {
      if (definition.name === "mfa_assurance") {
        expect(definition.permissive).toBe(false);
        expect(definition.qual).toBe(contract.policyCoverage.restrictiveOnEveryRlsTable.qual);
      } else {
        const entry = contract.policies.find(candidate => candidate.table === definition.table && candidate.name === definition.name);
        expect(entry, `${definition.table}.${definition.name}`).toBeDefined();
        expect(definition.qual).toBe(entry.qual);
        expect(definition.cmd).toBe(entry.cmd);
      }
    }
  });
  it("pins the installed training foreign keys in the lifecycle catalogue", () => {
    expect(trainingForeignKeys).toHaveLength(7);
    expect(trainingForeignKeys).toEqual(reviewedForeignKeys.foreign_keys.filter(row => row.child.startsWith("private.compass_training_")));
  });
  it("binds the writer to a dispatched request, its user and its active organization", async () => {
    await consent();
    const id = await request();
    expect(await retain(id, f.member2)).toBe(false);
    expect(await retain(randomUUID())).toBe(false);
    expect(await retain(id)).toBe(true);
    expect(await retain(id)).toBe(false);
    expect(await count()).toBe(1);
  });
  it("requires each consent independently and refuses stale or missing notice versions", async () => {
    await asUser(f.member1);
    await db.client.query("savepoint notice");
    await expect(db.client.query("select public.compass_training_preferences('member',true,'older-notice')")).rejects.toMatchObject({ code: "22023" });
    await db.client.query("rollback to savepoint notice");
    await db.client.query("select public.compass_training_preferences('member',true,$1)", [NOTICE]);
    expect(await retain(await request())).toBe(false);
    await asUser(f.member1);
    await db.client.query("select public.compass_training_preferences('member',false)");
    await asUser(f.admin1);
    await db.client.query("select public.compass_training_preferences('organization',true,$1)", [NOTICE]);
    expect(await retain(await request())).toBe(false);
  });
  it("uses Compass's single-organization fallback for chapterless members and administrators", async () => {
    await db.client.query("update public.member_profiles set chapter_id=null where id=any($1::uuid[])", [[f.admin1, f.member1]]);
    await db.client.query("delete from public.member_chapter_memberships where user_id=any($1::uuid[])", [[f.admin1, f.member1]]);
    await consent();
    await asUser(f.member1);
    expect((await db.client.query("select public.compass_training_preferences() pref")).rows[0].pref).toMatchObject({ organizationId: f.org1, memberEnabled: true, organizationEnabled: true });
    expect(await retain(await request())).toBe(true);
    await db.client.query("reset role");
    await db.client.query("grant select on private.compass_training_samples to authenticated");
    await asUser(f.member1);
    expect((await db.client.query("select user_id from private.compass_training_samples")).rows).toEqual([{ user_id: f.member1 }]);
    await asUser(f.admin1);
    expect((await db.client.query("select public.compass_training_preferences() pref")).rows[0].pref.canManageOrganization).toBe(true);
  });
  it("refuses ambiguous or unresolved organization context for reads and opt-ins", async () => {
    await db.client.query("update public.member_profiles set chapter_id=null where id=$1", [f.member1]);
    await db.client.query("insert into public.organization_memberships values($1,$2,'active')", [f.org2, f.member1]);
    await asUser(f.member1);
    await denied("select public.compass_training_preferences()");
    await denied("select public.compass_training_preferences('member',true,$1)", [NOTICE]);
    await db.client.query("reset role");
    await db.client.query("update public.member_profiles set chapter_id=$1 where id=$2", [f.org1, f.member1]);
    await db.client.query("delete from public.member_chapter_memberships where user_id=$1", [f.member1]);
    await asUser(f.member1);
    await denied("select public.compass_training_preferences('member',true,$1)", [NOTICE]);
  });
  it("allows own-data withdrawal after the last organization membership is revoked", async () => {
    await consent(1); await consent(2);
    await retain(await request()); await retain(await request(f.org2, f.member2), f.member2);
    await db.client.query("reset role");
    await db.client.query("update public.organization_memberships set status='revoked' where user_id=$1", [f.member1]);
    await db.client.query("delete from public.member_chapter_memberships where user_id=$1", [f.member1]);
    await db.client.query("update public.member_profiles set chapter_id=null where id=$1", [f.member1]);
    await asUser(f.member1, { aal: "aal1" });
    await denied("select public.compass_training_preferences('member',false)");
    await asUser(f.member1, { restricted: true });
    await denied("select public.compass_training_preferences('member',false)");
    await asUser(f.member1);
    expect((await db.client.query("select public.get_my_compass_training_export() data")).rows[0].data.samples).toHaveLength(1);
    await db.client.query("select public.compass_training_preferences('member',false)");
    const after = (await db.client.query("select public.get_my_compass_training_export() data")).rows[0].data;
    expect(after.samples).toEqual([]);
    expect(after.consents.every(row => row.enabled === false)).toBe(true);
    expect(await count(f.org2)).toBe(1);
  });
  it("does not retain an undispatched, expired, or no-longer-authorized request", async () => {
    await consent();
    const id = await request();
    await db.client.query("update public.member_ai_requests set dispatch_authorized_at=null where id=$1", [id]);
    expect(await retain(id)).toBe(false);
    await db.client.query("reset role");
    await db.client.query("update public.member_ai_requests set dispatch_authorized_at=now()-interval '11 minutes' where id=$1", [id]);
    expect(await retain(id)).toBe(false);
    const current = await request();
    await db.client.query("update public.organization_memberships set status='inactive' where user_id=$1", [f.member1]);
    expect(await retain(current)).toBe(false);
  });
  it("restricts preference management and exports to the actual caller", async () => {
    await asUser(f.member1);
    await denied("select public.compass_training_preferences('organization',true,$1)", [NOTICE]);
    await consent(1); await consent(2);
    await retain(await request()); await retain(await request(f.org2, f.member2), f.member2);
    await asUser(f.member1);
    const own = (await db.client.query("select public.get_my_compass_training_export() data")).rows[0].data;
    expect(own.samples).toHaveLength(1);
    expect(own.samples[0].user_id).toBe(f.member1);
    await asUser(f.member1, { restricted: true });
    await denied("select public.get_my_compass_training_export()");
    await asUser(f.member1, { aal: "aal1" });
    await denied("select public.compass_training_preferences()");
  });
  it("keeps tables inaccessible directly and RLS self-scoped if a future select grant appears", async () => {
    await consent(1); await consent(2);
    await retain(await request()); await retain(await request(f.org2, f.member2), f.member2);
    await asUser(f.member1);
    await denied("select * from private.compass_training_samples");
    await denied("select public.retain_compass_training_pair($1,$2,'question','a','b',$3)", [randomUUID(), f.member1, NOTICE]);
    await db.client.query("reset role");
    await db.client.query("grant select, insert on private.compass_training_samples to authenticated");
    await asUser(f.member1);
    const rows = (await db.client.query("select user_id from private.compass_training_samples")).rows;
    expect(rows).toEqual([{ user_id: f.member1 }]);
    await denied("insert into private.compass_training_samples(organization_id,user_id,request_id,kind,prompt,response,notice_version) values($1,$2,$3,'question','a','b',$4)", [f.org1, f.member1, randomUUID(), NOTICE]);
  });
  it("withdraws and erases only the caller's organization data", async () => {
    await consent(1); await consent(2);
    const pending = await request();
    await retain(pending); await retain(await request(f.org2, f.member2), f.member2);
    await asUser(f.member1);
    await db.client.query("select public.compass_training_preferences('member',false)");
    expect(await count(f.org1)).toBe(0);
    expect(await count(f.org2)).toBe(1);
    expect(await retain(pending)).toBe(false);
  });
  it("deletes the corpus and resets consent on organization archive", async () => {
    await consent(1); await consent(2);
    await retain(await request()); await retain(await request(f.org2, f.member2), f.member2);
    await db.client.query("reset role");
    await db.client.query("update public.organizations set status='archived' where id=$1", [f.org1]);
    expect(await count(f.org1)).toBe(0);
    expect(await count(f.org2)).toBe(1);
    await asUser(f.admin1);
    await denied("select public.compass_training_preferences('organization',true,$1)", [NOTICE]);
    await db.client.query("reset role");
    await db.client.query("update public.organizations set status='active' where id=$1", [f.org1]);
    await asUser(f.member1);
    expect((await db.client.query("select public.compass_training_preferences() pref")).rows[0].pref).toMatchObject({ memberEnabled: false, organizationEnabled: false });
  });
  it("organization withdrawal erases its samples and requires new member consent", async () => {
    await consent(1); await consent(2);
    await retain(await request()); await retain(await request(f.org2, f.member2), f.member2);
    await asUser(f.admin1);
    await db.client.query("select public.compass_training_preferences('organization',false)");
    expect(await count(f.org1)).toBe(0);
    expect(await count(f.org2)).toBe(1);
    await asUser(f.admin1);
    await db.client.query("select public.compass_training_preferences('organization',true,$1)", [NOTICE]);
    expect(await retain(await request())).toBe(false);
  });
  it("enforces a 180-day maximum and a bounded corpus without extending old samples", async () => {
    await consent();
    for (let index = 0; index < 102; index += 1) await retain(await request());
    expect(await count()).toBe(100);
    await db.client.query("reset role");
    const bounds = (await db.client.query("select bool_and(expires_at = created_at + interval '180 days') ok from private.compass_training_samples")).rows[0];
    expect(bounds.ok).toBe(true);
  });
  it("removes data with the account and exposes no expired samples", async () => {
    await consent(); await retain(await request());
    await db.client.query("reset role");
    await db.client.query("update private.compass_training_samples set expires_at=now()-interval '1 second'");
    await asUser(f.member1);
    expect((await db.client.query("select public.get_my_compass_training_export() data")).rows[0].data.samples).toEqual([]);
    await db.client.query("reset role");
    expect((await db.client.query("select private.purge_expired_compass_training_samples() n")).rows[0].n).toBe(1);
    await retain(await request());
    await db.client.query("reset role");
    await db.client.query("delete from auth.users where id=$1", [f.member1]);
    expect(await count()).toBe(0);
  });
  it("classifies every training identity foreign key in the bidirectional export inventory", async () => {
    const issues = await db.client.query("select * from private.account_lifecycle_unmanaged_export_fks()");
    expect(issues.rows).toEqual([]);
    await db.client.query(`update private.account_lifecycle_manifest set export_inventory_basis = null
      where table_name = 'compass_training_organization_consents' and user_column = 'enabled_by'`);
    const drift = await db.client.query("select * from private.account_lifecycle_unmanaged_export_fks()");
    expect(drift.rows).toEqual([expect.objectContaining({
      table_name: "compass_training_organization_consents", user_column: "enabled_by", inventory_issue: "missing-review",
    })]);
  });

  it("preserves existing account export domains and the monitored retention job", async () => {
    await consent(); await retain(await request());
    await db.client.query("reset role");
    const data = (await db.client.query("select private.account_lifecycle_export_additional_domains($1) data", [f.member1])).rows[0].data;
    expect(data.member_profile_details).toEqual([]);
    expect(data.steward_private_reminders).toEqual([]);
    expect(data.compass_training_samples).toHaveLength(1);
    expect(data.compass_training_member_consents).toHaveLength(1);
    expect((await db.client.query("select command from cron.job")).rows[0].command).toBe("select private.run_due_organization_retention_jobs(25); select private.purge_expired_compass_training_samples();");
    expect((await db.client.query("select * from private.account_lifecycle_referential_action_trigger_issues()")).rows).toEqual([]);
    expect((await db.client.query("select count(*)::int n from private.account_lifecycle_trigger_review where object_name='compass_training_archive_cleanup()'")).rows[0].n).toBe(1);
  });
});
