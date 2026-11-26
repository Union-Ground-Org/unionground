// @vitest-environment node
import { readFileSync, writeFileSync } from "node:fs";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { offlinePostgres, postgresBin } from "./tamarack-postgres-helper.mjs";
import { fnBody, loadMigrationSql } from "./helpers/migration.js";
import { helperFirst } from "../scripts/account-case-graph-inventory.mjs";

const migration = readFileSync(new URL("../supabase/migrations/20261030201100_two_step_and_session_controls.sql", import.meta.url), "utf8");
const member = "00000000-0000-4000-8000-000000000001";
const administrator = "00000000-0000-4000-8000-000000000002";
const outsider = "00000000-0000-4000-8000-000000000003";
const org = "00000000-0000-4000-8000-000000000101";
const otherOrg = "00000000-0000-4000-8000-000000000102";
const session = "00000000-0000-4000-8000-000000000201";

describe.skipIf(!postgresBin)("organization two-step policy in PostgreSQL", () => {
  let db;
  beforeAll(async () => {
    db = await offlinePostgres({ durable: false });
    await db.client.query(`
      create schema auth; create schema private; create schema extensions;
      create table private.account_lifecycle_trigger_review(kind text, schema_name text, table_name text, object_name text, definition_hash text,
        primary key(kind, schema_name, table_name, object_name));
      create function private.account_lifecycle_trigger_surface() returns table(kind text, schema_name text, table_name text, object_name text, definition_hash text)
        language sql as $$ select 'function','private','','mfa_satisfied()',md5(pg_get_functiondef(p.oid))
          from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='private' and p.proname='mfa_satisfied' $$;
      create extension pgcrypto with schema extensions;
      create role anon; create role authenticated; create role service_role;
      grant usage on schema auth, private to authenticated;
      create function auth.jwt() returns jsonb language sql stable as
        $$ select coalesce(nullif(current_setting('request.jwt.claims',true),''),'{}')::jsonb $$;
      create function auth.uid() returns uuid language sql stable as
        $$ select (auth.jwt()->>'sub')::uuid $$;
      create table auth.sessions(id uuid primary key, user_id uuid, created_at timestamptz default now());
      create table auth.mfa_factors(user_id uuid, status text, factor_type text);
      create table private.member_mfa_recovery_locks(user_id uuid);
      create table private.member_mfa_reset_boundaries(user_id uuid, invalid_before timestamptz);
      create table public.organizations(id uuid primary key, status text default 'active');
      create table public.organization_memberships(organization_id uuid, user_id uuid, status text);
      create table public.organization_role_grants(organization_id uuid, user_id uuid, role text);
      create table public.member_role_chapters(user_id uuid, chapter_id text);
      create table public.chapters(id text, organization_id uuid);
      create table public.member_chapter_memberships(user_id uuid, chapter_id text, status text);
      create table public.org_security_policy(id boolean, organization_id uuid, require_staff_mfa boolean default true,
        updated_at timestamptz, updated_by uuid);
      create unique index org_security_policy_organization_key on public.org_security_policy(organization_id) where organization_id is not null;
      alter table public.org_security_policy enable row level security;
      create table public.organization_audit_events(organization_id uuid, event_type text, actor_user_id uuid, idempotency_key uuid, metadata jsonb);
      create function private.current_member_organization() returns uuid language plpgsql stable security definer as
        $$ declare result uuid; begin
          if current_setting('test.require_case_graph_gate',true) = 'on' and not exists (
            select 1 from pg_locks where pid=pg_backend_pid() and locktype='advisory'
              and classid=509 and objid=700 and granted
          ) then raise exception 'organization lookup preceded case graph gate' using errcode='55000'; end if;
          select organization_id into result from public.organization_memberships
            where user_id=auth.uid() and status='active' order by organization_id limit 1;
          return result;
        end $$;
      create function private.current_member_session_id() returns uuid language plpgsql stable security definer as
        $$ begin
          if not exists(select 1 from auth.sessions where id=(auth.jwt()->>'session_id')::uuid and user_id=auth.uid()) then
            raise exception 'session required' using errcode='42501';
          end if;
          return (auth.jwt()->>'session_id')::uuid;
        end $$;
      create function private.has_second_factor(uuid) returns boolean language sql stable security definer as
        $$ select exists(select 1 from auth.mfa_factors where user_id=$1 and status='verified' and factor_type='totp') $$;
      create function private.member_pin_require_full_session() returns void language plpgsql as $$ begin end $$;
      create function private.verified_key_session(uuid, uuid) returns boolean language sql stable as $$ select false $$;
      create function private.has_organization_role(uuid, text[]) returns boolean language sql stable security definer as
        $$ select exists(select 1 from public.organization_role_grants where organization_id=$1 and user_id=auth.uid() and role=any($2)) $$;
      create function private.staff_mfa_required(uuid) returns boolean language sql stable security definer as
        $$ select coalesce((select require_staff_mfa from public.org_security_policy where organization_id=$1),true) $$;
    `);
    // Run the actual lifecycle/graph lock functions, including their global
    // ordering and bounded lifecycle wait, rather than a permissive no-op.
    await db.client.query(fnBody(loadMigrationSql("20261008065201_message_lifecycle_bounded_wait"), "private.lock_message_lifecycle"));
    await db.client.query(fnBody(loadMigrationSql("20260907152000_sensitive_content_lock_order"), "private.lock_case_graph"));
    await db.client.query("revoke all on function private.lock_message_lifecycle(), private.lock_case_graph(uuid[],uuid[]) from public, anon, authenticated, service_role");
    // Carry the real prior audit constraint. A permissive fixture used to
    // conceal that the new metadata key rolled the entire policy change back.
    const taxonomy = readFileSync(new URL("../supabase/migrations/20260925120000_engagement_audit_event_taxonomy.sql", import.meta.url), "utf8");
    const constraintStart = taxonomy.indexOf("alter table public.organization_audit_events\n  add constraint organization_audit_events_metadata_keys");
    await db.client.query(taxonomy.slice(constraintStart, taxonomy.indexOf(";", constraintStart) + 1));
    await db.client.query(migration);
    // Isolated proof table exercises the real restrictive predicate as the
    // authenticated role; no table/RPC assertions run as the schema owner.
    await db.client.query(`
      revoke all on function private.mfa_satisfied() from public;
      grant execute on function private.mfa_satisfied() to authenticated;
      create table public.protected_data(value text); insert into public.protected_data values ('member data');
      alter table public.protected_data enable row level security;
      grant select on public.protected_data to authenticated;
      create policy access on public.protected_data to authenticated using (true);
      create policy mfa_assurance on public.protected_data as restrictive to authenticated using ((select private.mfa_satisfied()));
    `);
    if (process.env.TWO_STEP_MD5_OUTPUT) {
      const rows = await db.client.query("select oid::regprocedure::text sig, md5(pg_get_functiondef(oid)) md5 from pg_proc where pronamespace='private'::regnamespace and proname='mfa_satisfied'");
      writeFileSync(process.env.TWO_STEP_MD5_OUTPUT, JSON.stringify(rows.rows));
    }
  }, 120000);
  afterAll(async () => { await db?.close(); });
  beforeEach(async () => {
    await db.client.query(`reset role; truncate public.organizations, public.organization_memberships, public.organization_role_grants,
      public.org_security_policy, public.organization_audit_events, auth.sessions, auth.mfa_factors, private.member_mfa_recovery_locks;
      insert into public.organizations(id) values ('${org}'),('${otherOrg}');
      insert into public.organization_memberships values ('${org}','${member}','active'),('${org}','${administrator}','active'),('${otherOrg}','${outsider}','active');
      insert into public.organization_role_grants values ('${org}','${administrator}','admin');
      insert into auth.sessions(id,user_id) values ('${session}','${member}');
    `);
  });

  async function as(user, aal, sql, args = []) {
    await db.client.query("select set_config('request.jwt.claims',$1,false)", [JSON.stringify({ sub: user, session_id: session, aal })]);
    await db.client.query("set role authenticated");
    try { return await db.client.query(sql, args); }
    finally { await db.client.query("reset role"); }
  }
  const requireAll = () => db.client.query("insert into public.org_security_policy(organization_id,require_member_mfa) values ($1,true)", [org]);

  it("denies unenrolled members at RLS while leaving their self-only enrollment explanation reachable", async () => {
    await requireAll();
    expect((await as(member, "aal1", "select * from public.protected_data")).rows).toEqual([]);
    expect((await as(member, "aal1", "select public.get_my_mfa_requirement() r")).rows[0].r).toEqual({ required: true, enrolled: false });
    await db.client.query("insert into auth.mfa_factors values ($1,'verified','totp')", [member]);
    expect((await as(member, "aal1", "select * from public.protected_data")).rows).toEqual([]);
    expect((await as(member, "aal2", "select * from public.protected_data")).rows).toHaveLength(1);
  });

  it("explicitly exempts only the self-only pre-enrollment explanation from the verifier's MFA guard sweep", async () => {
    const contract = JSON.parse(readFileSync(new URL("../scripts/db-contract.json", import.meta.url), "utf8"));
    const rows = (await db.client.query(`select p.proname,pg_get_functiondef(p.oid) definition from pg_proc p
      join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.prosecdef
      and p.proname in ('get_my_mfa_requirement','set_member_mfa_policy')
      and has_function_privilege('authenticated',p.oid,'execute')`)).rows;
    expect(rows).toHaveLength(2);
    for (const row of rows) {
      expect(contract.mfaCoverage.termNeedles.some(term => row.definition.includes(term)) || Boolean(contract.mfaCoverage.exempt[row.proname])).toBe(true);
    }
    expect(contract.mfaCoverage.exempt.get_my_mfa_requirement).toContain("live Auth session");
    expect(contract.mfaCoverage.exempt.set_member_mfa_policy).toBeUndefined();
  });

  it("does not apply another tenant's member policy or count an inactive membership", async () => {
    await requireAll();
    await db.client.query("update auth.sessions set user_id=$1", [outsider]);
    expect((await as(outsider, "aal1", "select * from public.protected_data")).rows).toHaveLength(1);
    await db.client.query("update public.organization_memberships set status='inactive' where user_id=$1", [member]);
    await db.client.query("update auth.sessions set user_id=$1", [member]);
    expect((await as(member, "aal1", "select public.get_my_mfa_requirement() r")).rows[0].r.required).toBe(false);
  });

  it("cannot evade a required membership by selecting another organization", async () => {
    await db.client.query("insert into public.organization_memberships values ($1,$2,'active')", [otherOrg, member]);
    await db.client.query("insert into public.org_security_policy(organization_id,require_member_mfa) values ($1,true)", [otherOrg]);
    expect((await as(member, "aal1", "select * from public.protected_data")).rows).toEqual([]);
  });

  it("authorizes and audits admin changes, preserving staff enforcement when other members become optional", async () => {
    await db.client.query("update auth.sessions set user_id=$1;", [administrator]);
    await db.client.query("insert into auth.mfa_factors values ($1,'verified','totp')", [administrator]);
    for (const required of [true, false]) {
      const result = await as(administrator, "aal2", "select public.set_member_mfa_policy($1) r", [required]);
      expect(result.rows[0].r).toEqual({ requireMemberMfa: required, changed: true });
      expect((await db.client.query("select require_staff_mfa from public.org_security_policy")).rows[0].require_staff_mfa).toBe(true);
    }
    expect((await db.client.query("select * from public.organization_audit_events")).rows).toHaveLength(2);
    await expect(as(administrator, "aal2", "select public.set_staff_mfa_policy(false)")).rejects.toMatchObject({ code: "22023" });
  });

  it.each([
    ["public.set_member_mfa_policy", { requireMemberMfa: true, changed: true }],
    ["public.set_staff_mfa_policy", { requireStaffMfa: true, changed: false }],
  ])("%s locks the lifecycle and case graph before resolving the policy organization", async (setter, expected) => {
    await db.client.query("update auth.sessions set user_id=$1", [administrator]);
    await db.client.query("insert into auth.mfa_factors values ($1,'verified','totp')", [administrator]);
    await db.client.query("select set_config('test.require_case_graph_gate','on',false)");
    try {
      const result = await as(administrator, "aal2", `select ${setter}(true) r`);
      expect(result.rows[0].r).toEqual(expected);
      expect((await db.client.query("select require_staff_mfa from public.org_security_policy")).rows[0].require_staff_mfa).toBe(true);
      const installed = await db.client.query("select prosrc source from pg_proc where oid=$1::regprocedure", [`${setter}(boolean)`]);
      expect(helperFirst(installed.rows[0].source)).toBe(true);
      const contract = JSON.parse(readFileSync(new URL("../scripts/db-contract.json", import.meta.url), "utf8"));
      const policyContract = contract.functions.find(entry => entry.sig === `${setter}(p_required boolean)`);
      expect(policyContract).toBeDefined();
      for (const needle of policyContract.bodyContains || []) {
        expect(installed.rows[0].source, `${setter}: ${needle}`).toContain(needle);
      }
      for (const needle of policyContract.bodyForbids || []) {
        expect(installed.rows[0].source, `${setter}: ${needle}`).not.toContain(needle);
      }
    } finally {
      await db.client.query("select set_config('test.require_case_graph_gate','off',false)");
    }
  });

  it("keeps prior audit metadata keys while rejecting unreviewed keys", async () => {
    await db.client.query("insert into public.organization_audit_events(metadata) values ($1)", [{ requireMemberMfa: true, requireStaffMfa: true, pollId: "prior-key" }]);
    await expect(db.client.query("insert into public.organization_audit_events(metadata) values ($1)", [{ unreviewedKey: true }])).rejects.toMatchObject({ code: "23514" });
    const contract = JSON.parse(readFileSync(new URL("../scripts/db-contract.json", import.meta.url), "utf8"));
    const pin = contract.constraints.find(row => row.name === "organization_audit_events_metadata_keys");
    expect(pin.defContains).toContain("requireMemberMfa");
    expect((await db.client.query("select pg_get_constraintdef(oid) definition from pg_constraint where conname='organization_audit_events_metadata_keys'")).rows[0].definition).toContain("requireMemberMfa");
  });

  it("rejects non-admin and unenrolled admin writes and hides private helpers", async () => {
    await expect(as(member, "aal1", "select public.set_member_mfa_policy(true)")).rejects.toMatchObject({ code: "42501" });
    await db.client.query("update auth.sessions set user_id=$1", [administrator]);
    await expect(as(administrator, "aal1", "select public.set_member_mfa_policy(true)")).rejects.toMatchObject({ code: "42501" });
    await expect(as(member, "aal1", "select private.member_mfa_required($1)", [outsider])).rejects.toMatchObject({ code: "42501" });
    await expect(as(outsider, "aal1", "select public.get_my_mfa_requirement()")).rejects.toMatchObject({ code: "42501" });
  });

  it("still denies a stale or recovery-locked AAL2 session", async () => {
    await requireAll();
    await db.client.query("insert into private.member_mfa_recovery_locks values ($1)", [member]);
    expect((await as(member, "aal2", "select * from public.protected_data")).rows).toEqual([]);
    await db.client.query("truncate private.member_mfa_recovery_locks; delete from auth.sessions");
    expect((await as(member, "aal2", "select * from public.protected_data")).rows).toEqual([]);
  });
});
