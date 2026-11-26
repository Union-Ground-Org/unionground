// @vitest-environment node
//
// REQ-UG-PROFILE-WORKPLACE-JOB-PHONE-AND-PRONOUNS-20261006
//
// A member keeps their own pronouns, job, worksite and phone and decides who
// sees them. 20261008100000 stores them in their own RPC-only table (stewards
// and coordinators read whole member_profiles rows, so a column there would
// reach them whatever the member chose). Nothing is shared by default; the
// admin member directory shows only the fields the member shared with
// administrators. Two fictional tenants; every refusal has an allowed control;
// every row is rolled back.
import { proveWorkplaceRoster, proveWorkplaceReleasePrivacy } from "./helpers/workplace-roster-proof.js";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { assertDisposableProofUrl } from "../scripts/run-required-db-proofs.mjs";
import { fnBody, latestFnBody, loadMigrationSql, migrationFiles, stripComments } from "./helpers/migration.js";

const MIGRATION = "20261008100000_member_profile_details";
const contract = JSON.parse(readFileSync(new URL("../scripts/db-contract.json", import.meta.url), "utf8"));

describe("member profile details (static)", () => {
  const sql = stripComments(loadMigrationSql(MIGRATION));

  it("keeps the release digest private and declares its writes outside passive read probes", () => {
    const releaseSql = stripComments(loadMigrationSql("20261008232000_member_workplace_roster"));
    const report = latestFnBody("get_organization_survey_worksites");
    expect(report).toContain("language plpgsql volatile security definer");
    expect(report).toContain("pg_catalog.pg_advisory_xact_lock");
    expect(releaseSql).toContain("alter table private.organization_survey_worksite_releases enable row level security;");
    expect(releaseSql).toContain("revoke all on private.organization_survey_worksite_releases from public, anon, authenticated, service_role;");
  });

  it("creates one RPC-only table with the MFA floor, a self-only read policy and no client grant", () => {
    expect(sql.trimStart().startsWith("begin;")).toBe(true);
    expect(sql.trimEnd().endsWith("commit;")).toBe(true);
    expect(sql).toContain("create table public.member_profile_details (");
    expect(sql).toContain("details_visibility text not null default 'only_me'");
    expect(sql).toContain("phone_visibility text not null default 'only_me'");
    expect(sql).toContain("alter table public.member_profile_details enable row level security;");
    expect(sql).toMatch(/create policy mfa_assurance on public\.member_profile_details\s+as restrictive for all to authenticated/);
    expect(sql).toContain("revoke all on public.member_profile_details from public, anon, authenticated, service_role;");
    expect(sql).not.toMatch(/grant\s+[^;]*\bon\s+(table\s+)?public\.member_profile_details\b/i);
    // The only policies on the table: the MFA floor and the owner's own row.
    const policies = [...sql.matchAll(/create policy (\w+) on public\.member_profile_details/g)].map((match) => match[1]);
    expect(policies.sort()).toEqual(["member_profile_details_select_own", "mfa_assurance"]);
    expect(sql).toMatch(/member_profile_details_select_own on public\.member_profile_details\s+for select to authenticated\s+using \(\(select auth\.uid\(\)\) = user_id\);/);
  });

  it("keeps the details off member_profiles, which stewards and coordinators read", () => {
    for (const { sql: text } of migrationFiles()) {
      expect(stripComments(text)).not.toMatch(/alter table public\.member_profiles[^;]*add column (if not exists )?(pronouns|job_title|worksite|phone)\b/i);
    }
  });

  it("reads and writes only the caller's own row, behind MFA and a full session", () => {
    const reader = stripComments(fnBody(sql, "public.get_my_profile_details()"));
    const writer = stripComments(fnBody(sql, "public.set_my_profile_details("));
    for (const body of [reader, writer]) {
      expect(body).toContain("security definer");
      expect(body).toContain("set search_path = ''");
      expect(body).toContain("perform private.member_pin_require_full_session();");
      expect(body).toContain("if caller is null or not private.mfa_satisfied() then");
      expect(body).not.toMatch(/p_user_id|p_member/);
    }
    expect(reader).toContain("where d.user_id = caller");
    expect(writer).toMatch(/^create function public\.set_my_profile_details\([\s\S]*?begin\s+perform private\.lock_case_graph\(array\[auth\.uid\(\)\], array\[\]::uuid\[\]\);/);
    expect(writer).toContain("caller, clean_pronouns, clean_job_title, clean_worksite, clean_phone, details_choice, phone_choice");
    expect(writer).toContain("on conflict (user_id) do update set");
  });

  it("lets the admin directory read only what the member shared with administrators", () => {
    const directory = stripComments(latestFnBody("get_admin_member_directory")).toLowerCase();
    expect(directory).toContain("left join public.member_profile_details d on d.user_id = p.id");
    expect(directory).toContain("case when d.details_visibility = 'admins' then d.pronouns end as shared_pronouns");
    expect(directory).toContain("case when d.phone_visibility = 'admins' then d.phone end as shared_phone");
    // Every function that reads the table: its own reader and writer, the
    // directory, and the account export.
    const readers = new Set();
    for (const { sql: text } of migrationFiles()) {
      const code = stripComments(text);
      if (!code.includes("member_profile_details")) continue;
      for (const match of code.matchAll(/create\s+(?:or\s+replace\s+)?function\s+([\w.]+)\s*\(/g)) {
        const body = fnBody(text, match[1]);
        if (body && /from public\.member_profile_details|join public\.member_profile_details|into public\.member_profile_details|update public\.member_profile_details|public\.member_profile_details%rowtype/.test(stripComments(body))) readers.add(match[1]);
      }
    }
    // private.apply_member_invitation_unit (20261030201200) only writes the
    // accepted member's own empty worksite from the unit their invitation
    // named; it reads nothing back and shares nothing
    // (REQ-UG-CHAPTER-UNITS-WORKSITES-AND-LOCAL-PROFILE-20261030).
    // public.get_my_form_autofill and public.set_my_form_autofill_preference
    // (20261031130301) read and write only the caller's own row, and the read
    // returns the work details only while they are shared with administrators
    // (REQ-UG-FORMS-OFFER-WORKPLACE-AUTOFILL-20261030).
    expect([...readers].sort()).toEqual([
      "private.account_lifecycle_export_member_profile_details",
      "private.apply_member_invitation_unit",
      // The member's own learning-period undo state and its reversal (#6946).
      "private.learning_membership_state",
      "private.learning_undo_own_profile_details",
      // Pulse only counts worksite cells from details shared with admins,
      // under the admin hat. It returns anonymous groups after a whole-cube
      // distinct-person floor, never profiles or private worksite values.
      "private.pulse_chart_values",
      "public.export_member_directory_csv",
      "public.get_admin_member_directory",
      // REQ-UG-ADMIN-OVERVIEW-GOALS-AND-ACTIVITY-LOG-20261030: an
      // organization administrator's count of one collective action's
      // participants by shift and classification. It reads those two fields
      // only, only where the member shared details with administrators and is
      // still an active member, and returns counts, never names or rows.
      "public.get_digital_action_goal_breakdown",
      "public.get_my_form_autofill",
      "public.get_my_profile_details",
      "public.get_organization_survey_worksites",
      "public.set_my_form_autofill_preference",
      "public.set_my_profile_details",
      "public.set_my_profile_details_v2",
    ]);
    const autofill = stripComments(latestFnBody("get_my_form_autofill")).toLowerCase();
    expect(autofill).toContain("where d.user_id = caller");
    expect(autofill).toContain("shared := coalesce(details.details_visibility, 'only_me') = 'admins'");
    for (const field of ["job_title", "worksite", "shift", "classification"]) expect(autofill).toContain(`case when shared then details.${field} end`);
  });

  it("lets the goal breakdown count only the shift and classification a member shared with administrators", () => {
    const breakdown = stripComments(latestFnBody("get_digital_action_goal_breakdown")).toLowerCase();
    const fields = [...breakdown.matchAll(/\bdetail\.(\w+)/g)].map((match) => match[1]);
    expect([...new Set(fields)].sort()).toEqual(["classification", "details_visibility", "shift", "user_id"]);
    expect(breakdown).toContain("case when detail.details_visibility = 'admins' then nullif(pg_catalog.btrim(detail.shift), '') end");
    expect(breakdown).toContain("case when detail.details_visibility = 'admins' then nullif(pg_catalog.btrim(detail.classification), '') end");
    expect(breakdown).toContain("membership.status = 'active'");
    expect(breakdown).toContain("private.has_organization_role(org, array['admin'])");
    expect(breakdown).not.toMatch(/full_name|pronouns|job_title|worksite|phone/);
  });

  it("is exported to the member and deleted with the account", () => {
    expect(sql).toMatch(/\('public', 'member_profile_details', 'user_id', 'cascade', 'included',/);
    expect(sql).toContain("user_id uuid primary key references auth.users(id) on delete cascade");
    expect(sql).toContain("'member_profile_details', private.account_lifecycle_export_member_profile_details(p_caller)");
  });

  it("pins the reader and writer in the database contract", () => {
    for (const sig of [
      "public.get_my_profile_details()",
      "public.set_my_profile_details(p_pronouns text, p_job_title text, p_worksite text, p_phone text, p_details_visibility text, p_phone_visibility text)",
    ]) {
      expect(contract.functions.find((row) => row.sig === sig)).toMatchObject({ secdef: true, exec: "authenticated" });
    }
    const directory = contract.functions.find((row) => row.sig.startsWith("public.get_admin_member_directory("));
    expect(directory.bodyContains).toContain("case when d.phone_visibility = 'admins' then d.phone end as shared_phone");
    expect(directory.bodyForbids).toEqual(expect.arrayContaining(["email", "address", "member_cases"]));
  });
});

const live = process.env.SUPABASE_DB_URL ? describe : describe.skip;

live("member profile details on a disposable database", () => {
  let client;

  beforeAll(async () => {
    assertDisposableProofUrl(process.env.SUPABASE_DB_URL);
    client = new pg.Client({ connectionString: process.env.SUPABASE_DB_URL, application_name: "member-profile-details-rollback-proof" });
    await client.connect();
    await client.query("set statement_timeout = '10s'");
  });

  afterAll(async () => {
    await client?.end();
  });

  async function tenants() {
    const orgA = randomUUID();
    const orgB = randomUUID();
    const library = `cpl-main-${orgA}`;
    const branch = `cpl-east-${orgA}`;
    const other = `pkt-${orgB}`;
    await client.query("insert into public.organizations(id,slug,name) values ($1,$2,$3), ($4,$5,$6)",
      [orgA, `cpl-${orgA}`, `Copperline Library Workers ${orgA}`, orgB, `pkt-${orgB}`, `Port Kinsey Transit ${orgB}`]);
    await client.query(
      `insert into public.chapters(id,name,slug,region,organization_id,order_index)
       values ($1,'Main Branch',$1,'proof',$4,9971), ($2,'Eastside Branch',$2,'proof',$4,9972), ($3,'Depot',$3,'proof',$5,9973)`,
      [library, branch, other, orgA, orgB]);
    return { orgA, orgB, library, branch, other };
  }

  async function person(t, chapter, { organization = t.orgA, role = null } = {}) {
    const id = randomUUID();
    await client.query("insert into auth.users(id,email) values ($1,$2)", [id, `${id}@example.invalid`]);
    await client.query("update public.member_profiles set chapter_id=$2, full_name=$3 where id=$1", [id, chapter, `Proof ${id.slice(0, 8)}`]);
    await client.query("insert into public.organization_memberships(organization_id,user_id,status) values ($1,$2,'active') on conflict do nothing", [organization, id]);
    await client.query("insert into public.member_chapter_memberships(user_id,chapter_id,status) values ($1,$2,'active') on conflict do nothing", [id, chapter]);
    await client.query("insert into auth.mfa_factors(id,user_id,factor_type,status,created_at,updated_at) values ($1,$2,'totp','verified',now(),now())", [randomUUID(), id]);
    if (role) {
      await client.query("insert into public.member_roles(user_id,role,chapter_id) values ($1,$2,$3)", [id, role, chapter]);
      await client.query("insert into public.member_role_chapters(user_id,role,chapter_id) values ($1,$2,$3)", [id, role, chapter]);
    }
    return id;
  }

  async function actAs(userId) {
    const session = randomUUID();
    await client.query("insert into auth.sessions(id,user_id,aal,created_at,updated_at) values ($1,$2,'aal2',now(),now())", [session, userId]);
    await client.query("select set_config('request.jwt.claims',$1,true)", [JSON.stringify({ sub: userId, role: "authenticated", aal: "aal2", session_id: session })]);
    await client.query("set local role authenticated");
  }

  async function asOwner() {
    await client.query("reset role");
    await client.query("select set_config('request.jwt.claims','',true)");
  }

  async function capture(statement, args = []) {
    await client.query("savepoint cell");
    try {
      const result = await client.query(statement, args);
      await client.query("release savepoint cell");
      return { ok: true, value: result.rows[0]?.v ?? null, rows: result.rowCount, code: "", message: "" };
    } catch (error) {
      await client.query("rollback to savepoint cell");
      return { ok: false, value: null, rows: 0, code: error.code || "", message: error.message || "" };
    }
  }

  const save = (fields) => capture("select public.set_my_profile_details($1,$2,$3,$4,$5,$6) as v",
    [fields.pronouns ?? null, fields.jobTitle ?? null, fields.worksite ?? null, fields.phone ?? null, fields.detailsVisibility ?? null, fields.phoneVisibility ?? null]);
  const directoryRow = async (admin, member) => {
    await actAs(admin);
    const directory = await capture("select public.get_admin_member_directory('', null, null, 50) as v");
    await asOwner();
    expect(directory.ok, directory.message).toBe(true);
    return directory.value.items.find((item) => item.userId === member) ?? null;
  };

  it("saves and reads the member's own details, private by default, and exports them to the member", async () => {
    await client.query("begin");
    try {
      const t = await tenants();
      const member = await person(t, t.library);

      await actAs(member);
      const before = await capture("select public.get_my_profile_details() as v");
      const saved = await save({ pronouns: "  he/him ", jobTitle: "Circulation Clerk", worksite: "Main Branch", phone: "+1 (555) 010-0142" });
      const after = await capture("select public.get_my_profile_details() as v");
      await asOwner();

      expect(before.value).toMatchObject({ pronouns: null, jobTitle: null, worksite: null, phone: null, detailsVisibility: "only_me", phoneVisibility: "only_me" });
      expect(saved.ok, saved.message).toBe(true);
      expect(after.value).toMatchObject({ pronouns: "he/him", jobTitle: "Circulation Clerk", worksite: "Main Branch", phone: "+1 (555) 010-0142", detailsVisibility: "only_me", phoneVisibility: "only_me" });
      // The settings card shows what the setter returns, so the setter's own
      // answer must already carry the write (insert and update paths alike).
      expect(saved.value).toEqual(after.value);

      const exported = (await client.query("select private.account_lifecycle_export_member_profile_details($1) as v", [member])).rows[0].v;
      const columns = (await client.query("select export_columns from private.account_lifecycle_manifest where table_name='member_profile_details'")).rows[0].export_columns;
      expect(exported).toEqual([expect.objectContaining({ user_id: member, pronouns: "he/him", phone: "+1 (555) 010-0142" })]);
      expect(Object.keys(exported[0]).sort()).toEqual([...columns].sort());
      const domains = (await client.query("select private.account_lifecycle_export_additional_domains($1) as v", [member])).rows[0].v;
      expect(domains.member_profile_details).toEqual(exported);

      await actAs(member);
      const updated = await save({ pronouns: "he/him", jobTitle: "Branch Supervisor", worksite: "Main Branch", detailsVisibility: "admins" });
      await asOwner();
      expect(updated.ok, updated.message).toBe(true);
      expect(updated.value).toMatchObject({ pronouns: "he/him", jobTitle: "Branch Supervisor", worksite: "Main Branch", phone: null, detailsVisibility: "admins", phoneVisibility: "only_me" });
    } finally {
      await client.query("rollback");
    }
  });

  it("gives no other person a read: not the member's steward, coordinator or another member", async () => {
    await client.query("begin");
    try {
      const t = await tenants();
      const member = await person(t, t.library);
      const steward = await person(t, t.library, { role: "steward" });
      const coordinator = await person(t, t.library, { role: "coordinator" });
      const peer = await person(t, t.library);
      await actAs(member);
      expect((await save({ pronouns: "she/her", phone: "555-0100", detailsVisibility: "admins", phoneVisibility: "admins" })).ok).toBe(true);
      await asOwner();

      for (const reader of [steward, coordinator, peer, member]) {
        await actAs(reader);
        // No client grant at all: even the owner reads only through the RPC.
        const direct = await capture("select pronouns as v from public.member_profile_details where user_id=$1", [member]);
        const write = await capture("update public.member_profile_details set phone='555-0199' where user_id=$1", [member]);
        await asOwner();
        expect(direct).toMatchObject({ ok: false, code: "42501" });
        expect(write).toMatchObject({ ok: false, code: "42501" });
      }

      // Each caller's reader returns their own (empty) row, never the member's.
      await actAs(steward);
      const stewardOwn = await capture("select public.get_my_profile_details() as v");
      const stewardDirectory = await capture("select public.get_admin_member_directory('', null, null, 50) as v");
      await asOwner();
      expect(stewardOwn.value).toMatchObject({ pronouns: null, phone: null });
      expect(stewardDirectory).toMatchObject({ ok: false, code: "42501" });

      // A steward's name lookup on member_profiles carries none of the details.
      await actAs(steward);
      const profileRow = await capture("select to_jsonb(p) as v from public.member_profiles p where p.id=$1", [member]);
      await asOwner();
      if (profileRow.ok && profileRow.value) {
        for (const key of ["pronouns", "job_title", "worksite", "phone"]) expect(profileRow.value).not.toHaveProperty(key);
      }

      await client.query("select set_config('request.jwt.claims','',true)");
      await client.query("set local role anon");
      const anonymous = await capture("select public.get_my_profile_details() as v");
      await asOwner();
      expect(anonymous).toMatchObject({ ok: false, code: "42501" });
    } finally {
      await client.query("rollback");
    }
  });

  it("shows administrators only the fields the member shared, and nothing across organizations", async () => {
    await client.query("begin");
    try {
      const t = await tenants();
      const chapterAdmin = await person(t, t.library, { role: "admin" });
      const otherChapterAdmin = await person(t, t.branch, { role: "admin" });
      const foreignAdmin = await person(t, t.other, { organization: t.orgB, role: "admin" });
      const member = await person(t, t.library);
      const privateMember = await person(t, t.library);

      await actAs(privateMember);
      expect((await save({ pronouns: "they/them", jobTitle: "Page", phone: "555-0111" })).ok).toBe(true);
      await asOwner();
      await actAs(member);
      expect((await save({ pronouns: "he/him", jobTitle: "Circulation Clerk", worksite: "Main Branch", phone: "555-0142", detailsVisibility: "admins", phoneVisibility: "only_me" })).ok).toBe(true);
      await asOwner();

      expect((await directoryRow(chapterAdmin, member)).profileDetails).toEqual({ pronouns: "he/him", jobTitle: "Circulation Clerk", worksite: "Main Branch" });
      expect((await directoryRow(chapterAdmin, privateMember)).profileDetails).toEqual({});

      await actAs(member);
      expect((await save({ phone: "555-0142", detailsVisibility: "only_me", phoneVisibility: "admins" })).ok).toBe(true);
      await asOwner();
      expect((await directoryRow(chapterAdmin, member)).profileDetails).toEqual({ phone: "555-0142" });

      // An admin of another chapter does not list this chapter's member, and
      // an admin of another organization never sees them.
      expect(await directoryRow(otherChapterAdmin, member)).toBeNull();
      expect(await directoryRow(foreignAdmin, member)).toBeNull();
    } finally {
      await client.query("rollback");
    }
  });

  it("refuses invalid values and visibility choices and stores nothing", async () => {
    await client.query("begin");
    try {
      const t = await tenants();
      const member = await person(t, t.library);
      await actAs(member);
      const refusals = [
        await save({ detailsVisibility: "everyone" }),
        await save({ phoneVisibility: "stewards" }),
        await save({ phone: "call me" }),
        await save({ phone: "12" }),
        await save({ pronouns: "x".repeat(41) }),
        await save({ jobTitle: "Clerk\u0007" }),
        await save({ worksite: "y".repeat(161) }),
      ];
      const allowed = await save({ pronouns: "she/they", worksite: "Depot 4" });
      await asOwner();
      for (const refused of refusals) expect(refused).toMatchObject({ ok: false, code: "22023" });
      expect(allowed.ok, allowed.message).toBe(true);
      const rows = (await client.query("select pronouns, worksite, phone, details_visibility from public.member_profile_details where user_id=$1", [member])).rows;
      expect(rows).toEqual([{ pronouns: "she/they", worksite: "Depot 4", phone: null, details_visibility: "only_me" }]);
      await proveWorkplaceRoster({ client, tenants, person, actAs, asOwner, capture, expect });
      await proveWorkplaceReleasePrivacy({ client, tenants, person, actAs, asOwner, capture, expect });
    } finally {
      await client.query("rollback");
    }
  });
});
