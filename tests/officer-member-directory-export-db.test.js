// @vitest-environment node
//
// REQ-UG-OFFICER-MEMBER-ROSTER-AND-EXPORT-20261030 (#6563), owner
// ruling of October 30, 2026: the CSV
// export holds exactly the member directory's fields for the rows the
// requester sees, and a chapter President or Secretary-Treasurer reads the
// directory and the export of their own chapter through the office. Fictional
// tenants; every refusal has an allowed control; every row is rolled back.
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { assertDisposableProofUrl } from "../scripts/run-required-db-proofs.mjs";
import { currentLegalVersions } from "../src/lib/legalInstruments.js";
import { fnBody, latestFnBody, loadMigrationSql, stripComments } from "./helpers/migration.js";

const MIGRATION = "20261031020000_officer_member_directory_and_export";
const contract = JSON.parse(readFileSync(new URL("../scripts/db-contract.json", import.meta.url), "utf8"));
const lower = (text) => stripComments(text).toLowerCase();

describe("officer member directory and export (static)", () => {
  const sql = loadMigrationSql(MIGRATION);

  it("runs in one transaction behind the reviewed directory and privacy 1.3.1 predecessors", () => {
    const code = stripComments(sql);
    expect(code.trimStart().startsWith("begin;")).toBe(true);
    expect(code.trimEnd().endsWith("commit;")).toBe(true);
    expect(code).toContain("pg_catalog.md5(p.prosrc) = 'deb9eafe32245334c7924c5346f387b7'");
    expect(code).toContain("pg_catalog.md5(p.prosrc) = '4d8b1855d88b0d512dea05152b13528b'");
  });

  it("grants the office only to the vp role or the secretary_treasurer budget office, never a title", () => {
    const officer = lower(fnBody(sql, "private.member_directory_officer("));
    expect(officer).toContain("private.member_has_chapter_role(p_chapter_id, array['vp'])");
    expect(officer).toContain("m.budget_office = 'secretary_treasurer'");
    expect(officer).toContain("(select private.mfa_satisfied())");
    expect(officer).toContain("private.has_second_factor((select auth.uid()))");
    expect(officer).toContain("and not private.member_pin_session_restricted()");
    expect(officer).not.toContain("display_title");
    expect(officer).not.toMatch(/'treasurer'|'secretary'(?!_)/);
    expect(stripComments(sql)).toContain("revoke all on function private.member_directory_officer(uuid, text)\n  from public, anon, authenticated, service_role;");
  });

  it("admits officers to the directory without widening its chapter scope", () => {
    const directory = lower(latestFnBody("get_admin_member_directory"));
    expect(directory).toContain("or private.member_directory_officer(caller_org, caller_chapter)) then");
    expect(directory).toContain("case when org_admin then null else caller_chapter end");
    expect(directory).toContain("and (org_admin or c.id = caller_chapter)");
    expect(directory).toContain("private.member_invitation_chapter_administrable(s.chapter_id)");
    expect(directory).toContain("'context', pg_catalog.jsonb_build_object('organizationid', caller_org, 'chapterid', caller_chapter)");
  });

  it("exports exactly the directory's fields, behind a full session, a cap and an audit row", () => {
    const exporter = lower(fnBody(sql, "public.export_member_directory_csv("));
    const directory = lower(latestFnBody("get_admin_member_directory"));
    for (const field of ["pronouns", "job_title", "worksite", "shift", "classification"]) {
      const shared = `case when d.details_visibility = 'admins' then d.${field} end as shared_${field}`;
      expect(directory).toContain(shared);
      expect(exporter).toContain(shared);
    }
    expect(exporter).toContain("case when d.phone_visibility = 'admins' then d.phone end as shared_phone");
    for (const banned of ["email", "address", "member_cases", "ballot", "member_messages", "member_forms"]) expect(exporter).not.toContain(banned);
    expect(exporter).toContain("perform private.member_pin_require_full_session();");
    expect(exporter).toContain("if caller_org is distinct from p_expected_org or caller_chapter is distinct from p_expected_chapter then");
    expect(exporter).toContain("raise exception 'directory context changed' using errcode = '40001';");
    // The internal platform organization stays outside union exports.
    expect(exporter).toContain("if not private.organization_is_union(caller_org) then\n    raise exception 'platform organization is private' using errcode = '42501';");
    expect(exporter).toContain("if total > 5000 then");
    expect(exporter).toContain("perform private.lock_case_graph(array[(select auth.uid())], array[]::uuid[]);");
    expect(exporter).toContain("raise exception 'export too large' using errcode = '54000';");
    expect(exporter).toContain("insert into public.organization_audit_ledger");
    expect(exporter).toContain("'exports', 'member_directory_export', 'export', caller");
    expect(stripComments(sql)).toContain("grant execute on function public.export_member_directory_csv(uuid, text, text)\n  to authenticated;");
    const cell = lower(fnBody(sql, "private.member_directory_csv_cell("));
    expect(cell).toContain("'^[=+@\\t\\r\\n-]'");
  });

  it("pins this migration's privacy pack and its new functions in the database contract", () => {
    const pin = stripComments(sql).match(/if p_versions <> '([^']+)'::jsonb/);
    expect(JSON.parse(pin[1])).toEqual({ 'privacy-policy': '1.3.2', 'terms-of-use': '1.1.0', 'accessibility-statement': '1.0.0', 'ai-disclosure': '1.1.0', 'retention-schedule': '1.1.0' });
    for (const sig of ["public.export_member_directory_csv(p_expected_org uuid, p_expected_chapter text, p_locale text)", "public.get_member_directory_access()"]) {
      expect(contract.functions.find((row) => row.sig === sig)).toMatchObject({ secdef: true, exec: "authenticated" });
    }
    expect(contract.functions.find((row) => row.sig.startsWith("private.member_directory_officer("))).toMatchObject({ exec: "" });
  });
});

const live = process.env.SUPABASE_DB_URL ? describe : describe.skip;

live("officer member directory and export on a disposable database", () => {
  let client;

  beforeAll(async () => {
    assertDisposableProofUrl(process.env.SUPABASE_DB_URL);
    client = new pg.Client({ connectionString: process.env.SUPABASE_DB_URL, application_name: "officer-member-directory-rollback-proof" });
    await client.connect();
    await client.query("set statement_timeout = '10s'");
  });

  afterAll(async () => {
    await client?.end();
  });

  async function tenants() {
    const orgA = randomUUID();
    const orgB = randomUUID();
    const main = `hbr-main-${orgA}`;
    const east = `hbr-east-${orgA}`;
    const other = `pkt-${orgB}`;
    await client.query("insert into public.organizations(id,slug,name) values ($1,$2,$3), ($4,$5,$6)",
      [orgA, `hbr-${orgA}`, `Harrow Bay Library Workers ${orgA}`, orgB, `pkt-${orgB}`, `Port Kinsey Transit ${orgB}`]);
    await client.query(
      `insert into public.chapters(id,name,slug,region,organization_id,order_index)
       values ($1,'Main Branch',$1,'proof',$4,9981), ($2,'Eastside Branch',$2,'proof',$4,9982), ($3,'Depot',$3,'proof',$5,9983)`,
      [main, east, other, orgA, orgB]);
    return { orgA, orgB, main, east, other };
  }

  async function person(t, chapter, { organization = t.orgA, role = null, office = null, title = null, name = null } = {}) {
    const id = randomUUID();
    await client.query("insert into auth.users(id,email) values ($1,$2)", [id, `${id}@example.invalid`]);
    await client.query("update public.member_profiles set chapter_id=$2, full_name=$3 where id=$1", [id, chapter, name ?? `Proof ${id.slice(0, 8)}`]);
    await client.query("insert into public.organization_memberships(organization_id,user_id,status) values ($1,$2,'active') on conflict do nothing", [organization, id]);
    await client.query("insert into public.member_chapter_memberships(user_id,chapter_id,status) values ($1,$2,'active') on conflict do nothing", [id, chapter]);
    if (office || title) {
      await client.query("update public.member_chapter_memberships set budget_office=$3, display_title=$4 where user_id=$1 and chapter_id=$2", [id, chapter, office, title]);
    }
    await client.query("insert into auth.mfa_factors(id,user_id,factor_type,status,created_at,updated_at) values ($1,$2,'totp','verified',now(),now())", [randomUUID(), id]);
    if (role) {
      await client.query("insert into public.member_roles(user_id,role,chapter_id) values ($1,$2,$3)", [id, role, chapter]);
      await client.query("insert into public.member_role_chapters(user_id,role,chapter_id) values ($1,$2,$3)", [id, role, chapter]);
    }
    return id;
  }

  async function actAs(userId, { pin = false } = {}) {
    const session = randomUUID();
    await client.query("insert into auth.sessions(id,user_id,aal,created_at,updated_at) values ($1,$2,'aal2',now(),now())", [session, userId]);
    if (pin) await client.query("insert into private.member_pin_sessions(session_id,user_id) values ($1,$2)", [session, userId]);
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
      return { ok: true, value: result.rows[0]?.v ?? null, code: "", message: "" };
    } catch (error) {
      await client.query("rollback to savepoint cell");
      return { ok: false, value: null, code: error.code || "", message: error.message || "" };
    }
  }

  async function as(userId, statement, args = [], options = {}) {
    await actAs(userId, options);
    const result = await capture(statement, args);
    await asOwner();
    return result;
  }

  const directory = (userId, options) => as(userId, "select public.get_admin_member_directory('', null, null, 50) as v", [], options);
  const exportedIn = (userId, org, chapter, locale = "en") => as(userId, "select public.export_member_directory_csv($1, $2, $3) as v", [org, chapter, locale]);
  const access = (userId, options) => as(userId, "select public.get_member_directory_access() as v", [], options);
  const shareDetails = (userId, fields) => as(userId, "select public.set_my_profile_details($1,$2,$3,$4,$5,$6) as v",
    [fields.pronouns ?? null, fields.jobTitle ?? null, fields.worksite ?? null, fields.phone ?? null, fields.detailsVisibility ?? null, fields.phoneVisibility ?? null]);

  it("lets the chapter President and Secretary-Treasurer read their own chapter, and no title or other office", async () => {
    await client.query("begin");
    try {
      const t = await tenants();
      const exported = (userId) => exportedIn(userId, t.orgA, t.main);
      const president = await person(t, t.main, { role: "vp" });
      const secretaryTreasurer = await person(t, t.main, { office: "secretary_treasurer" });
      const treasurer = await person(t, t.main, { office: "treasurer" });
      const titled = await person(t, t.main, { title: "Secretary-Treasurer" });
      const member = await person(t, t.main);
      const eastMember = await person(t, t.east);
      const foreignPresident = await person(t, t.other, { organization: t.orgB, role: "vp" });

      for (const officer of [president, secretaryTreasurer]) {
        const read = await directory(officer);
        expect(read.ok, read.message).toBe(true);
        const ids = read.value.items.map((item) => item.userId);
        expect(ids).toEqual(expect.arrayContaining([president, secretaryTreasurer, member]));
        expect(ids).not.toContain(eastMember);
        expect(ids).not.toContain(foreignPresident);
        expect(read.value.items.every((item) => item.displayTitleEditable === false)).toBe(true);
        expect(read.value.context).toEqual({ organizationId: t.orgA, chapterId: t.main });
        expect((await access(officer)).value).toEqual({ canRead: true, scope: "chapter", chapterId: t.main });
        // A restricted PIN session holds no office read.
        expect(await directory(officer, { pin: true })).toMatchObject({ ok: false, code: "42501" });
        expect((await access(officer, { pin: true })).value).toEqual({ canRead: false });
      }
      for (const refused of [treasurer, titled, member]) {
        expect(await directory(refused)).toMatchObject({ ok: false, code: "42501" });
        expect(await exported(refused)).toMatchObject({ ok: false, code: "42501" });
        expect((await access(refused)).value).toEqual({ canRead: false });
      }
      // The foreign President reads only their own organization's chapter.
      const foreign = await directory(foreignPresident);
      expect(foreign.ok, foreign.message).toBe(true);
      expect(foreign.value.items.map((item) => item.userId)).toEqual([foreignPresident]);
    } finally {
      await client.query("rollback");
    }
  });

  it("exports the directory's rows and shared fields only, neutralizes formulas, and logs each export", async () => {
    await client.query("begin");
    try {
      const t = await tenants();
      const exported = (userId, locale) => exportedIn(userId, t.orgA, t.main, locale);
      const president = await person(t, t.main, { role: "vp", name: "Avery Hale" });
      const sharing = await person(t, t.main, { name: "=HYPERLINK(\"x\")" });
      const privatePhone = await person(t, t.main, { name: "Rosa Quill" });
      const lineFeed = await person(t, t.main, { name: "\n=1+1" });
      const eastMember = await person(t, t.east, { name: "Eli East" });

      expect((await shareDetails(sharing, { pronouns: "she/her", jobTitle: "Page", worksite: "Main Branch", phone: "555-0142", detailsVisibility: "admins", phoneVisibility: "admins" })).ok).toBe(true);
      expect((await shareDetails(privatePhone, { jobTitle: "Clerk", phone: "555-0199", detailsVisibility: "admins", phoneVisibility: "only_me" })).ok).toBe(true);

      const before = (await client.query("select count(*)::int as n from public.organization_audit_ledger where organization_id = $1", [t.orgA])).rows[0].n;
      const result = await exported(president);
      expect(result.ok, result.message).toBe(true);
      expect(result.value).toMatchObject({ rowCount: 4, scope: "chapter", chapterId: t.main });
      const lines = result.value.csv.split("\r\n");
      expect(lines[0]).toBe("Full name,Member since,Chapter,Officer title,Staff roles,Pronouns,Job title,Worksite,Shift,Job classification,Phone");
      expect(lines).toHaveLength(6);
      // A leading line feed is neutralized like =.
      expect(result.value.csv).toContain("\"'\n=1+1\"");
      expect(lines.at(-1)).toBe("");
      expect(result.value.csv).toContain("\"Main Branch\",,\"President\"");
      expect(result.value.csv).toContain("\"'=HYPERLINK(\"\"x\"\")\"");
      expect(result.value.csv).toContain("\"she/her\",\"Page\",\"Main Branch\",,,\"555-0142\"");
      expect(result.value.csv).toContain("\"Clerk\"");
      expect(result.value.csv).not.toContain("555-0199");
      expect(result.value.csv).not.toContain("Eli East");
      expect(result.value.csv).not.toContain("example.invalid");

      const rows = (await directory(president)).value.items;
      expect(rows).toHaveLength(result.value.rowCount);

      const audit = (await client.query(
        `select domain, event_type, action, actor_user_id, entity_type, entity_id, metadata
           from public.organization_audit_ledger where organization_id = $1 order by occurred_at desc limit 1`, [t.orgA])).rows[0];
      expect((await client.query("select count(*)::int as n from public.organization_audit_ledger where organization_id = $1", [t.orgA])).rows[0].n).toBe(before + 1);
      expect(audit).toEqual({
        domain: "exports", event_type: "member_directory_export", action: "export", actor_user_id: president,
        entity_type: "chapter", entity_id: t.main,
        metadata: { chapterId: t.main, count: 4, exportType: "member_directory_csv", role: "president" },
      });
      void lineFeed;

      // The export binds to the context the page displayed:
      // another chapter or organization than the caller's current one refuses
      // and writes no audit row.
      const audited = (await client.query("select count(*)::int as n from public.organization_audit_ledger where organization_id = $1", [t.orgA])).rows[0].n;
      expect(await exportedIn(president, t.orgA, t.east)).toMatchObject({ ok: false, code: "PT409" });
      expect(await exportedIn(president, t.orgB, t.main)).toMatchObject({ ok: false, code: "PT409" });
      expect(await exportedIn(president, null, null)).toMatchObject({ ok: false, code: "PT409" });
      expect((await client.query("select count(*)::int as n from public.organization_audit_ledger where organization_id = $1", [t.orgA])).rows[0].n).toBe(audited);
      // The internal platform organization stays outside union exports
      // (codex review, P1): its President exports nothing and no row is audited.
      await client.query("update public.organizations set kind = 'platform' where id = $1", [t.orgA]);
      expect(await exportedIn(president, t.orgA, t.main)).toMatchObject({ ok: false, code: "42501", message: "platform organization is private" });
      expect((await client.query("select count(*)::int as n from public.organization_audit_ledger where organization_id = $1 and event_type = 'member_directory_export'", [t.orgA])).rows[0].n).toBe(1);
      await client.query("update public.organizations set kind = 'union' where id = $1", [t.orgA]);
      // A restricted PIN session never exports.
      expect(await as(president, "select public.export_member_directory_csv($1, $2, 'en') as v", [t.orgA, t.main], { pin: true })).toMatchObject({ ok: false, code: "42501" });

      const spanish = await exported(president, "es");
      expect(spanish.value.csv.split("\r\n")[0]).toBe("Nombre completo,Miembro desde,Capítulo,Título de cargo,Funciones del personal,Pronombres,Puesto,Lugar de trabajo,Turno,Clasificación del puesto,Teléfono");
      expect(spanish.value.csv).toContain("\"Presidente\"");
      expect(await exported(president, "fr")).toMatchObject({ ok: false, code: "22023" });
    } finally {
      await client.query("rollback");
    }
  });

  it("accepts privacy 1.3.2 as the only current pack", async () => {
    await client.query("begin");
    try {
      const pack = currentLegalVersions();
      expect((await client.query("select private.legal_acceptance_versions($1::jsonb) as v", [JSON.stringify(pack)])).rows[0].v).toEqual(pack);
      await expect(client.query("select private.legal_acceptance_versions($1::jsonb)", [JSON.stringify({ ...pack, "privacy-policy": "1.3.1" })]))
        .rejects.toMatchObject({ code: "22023" });
    } finally {
      await client.query("rollback");
    }
  });
});
