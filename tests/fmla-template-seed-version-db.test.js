// @vitest-environment node
//
// FIX-UG-FMLA-FORMS-GINA-NOTICE-AND-NO-DIAGNOSIS-HINT-20261022
//
// The FMLA field changes ship as a new platform seed version, never an edit of
// version 1. A newer platform seed must not replace an organization's own copy,
// and an organization's first copy is minted from the latest seed only.
import pg from "pg";
import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { assertDisposableProofUrl } from "../scripts/run-required-db-proofs.mjs";
import { fnBody, loadMigrationSql, stripComments } from "./helpers/migration.js";
import { catalogue } from "../src/lib/i18n.js";

const SLUG = "fmla_templates_gina_notice_seed_version";
const sql = stripComments(loadMigrationSql(SLUG));
const squash = (text) => text.replace(/\s+/g, " ").trim();

describe("FMLA seed version migration", () => {
  it("guards the installed bodies and the two version-1 seeds, and adds a version without editing version 1", () => {
    expect(sql).toMatch(/if installed is distinct from '\{(?:[a-f0-9]{32},){6}[a-f0-9]{32}\}' then/u);
    expect(sql).toContain("expected exactly the version-1 platform seeds of fmla_self and fmla_family");
    for (const key of ["fmla_self", "fmla_family"]) {
      expect(sql).toContain(`where s.key = '${key}' and s.version = 1 and s.is_platform_seed;`);
    }
    expect(squash(sql)).toContain("select s.key, (select pg_catalog.max(m.version) + 1 from public.form_templates m where m.key = s.key)");
    // No statement outside the replaced functions updates or deletes a template row.
    const outsideFunctions = sql.split(/create or replace function/iu)[0];
    expect(outsideFunctions).not.toMatch(/update public\.form_templates|delete from public\.form_templates/u);
  });

  it("refreshes only the form_points lifecycle fingerprints and requires a clean inventory (Sol r1 on #5837)", () => {
    const flat = squash(sql);
    expect(flat).toContain("insert into private.account_lifecycle_trigger_review(kind,schema_name,table_name,object_name,definition_hash)");
    expect(flat).toContain("and pg_catalog.split_part(object_name,'(',1) = 'form_points'");
    expect(flat).toContain("raise exception 'account lifecycle trigger inventory differs from review'");
  });

  it("ranks an organization's own row above a platform seed and copies only the latest seed", () => {
    for (const name of ["private.form_points", "private.form_template_label_localized", "public.save_form_draft"]) {
      expect(squash(fnBody(sql, name)), name).toContain("order by (organization_id is not null) desc, version desc limit 1");
    }
    expect(squash(fnBody(sql, "public.get_admin_reward_economy"))).toContain("order by key, (organization_id is not null) desc, version desc) f");
    for (const name of ["public.deactivate_form_template", "public.reactivate_form_template"]) {
      expect(squash(fnBody(sql, name)), name).toContain("from public.form_templates t where t.key=p_key and t.is_platform_seed order by t.version desc limit 1;");
    }
  });
});

const ids = Object.fromEntries(["a", "b", "orgA", "orgB", "sessionA", "sessionB"].map((k) => [k, randomUUID()]));
const prefix = `fmla${randomUUID().replaceAll("-", "").slice(0, 10)}`;
const ownFields = { steps: [{ title: { en: "Leave", es: "Licencia" }, fields: [{ key: "answer", type: "text", label: { en: "Answer", es: "Respuesta" }, required: true }] }] };

describe.skipIf(!process.env.SUPABASE_DB_URL)("FMLA seed version on the complete schema", () => {
  let db;
  const query = async (text, args = []) => (await db.query(text, args)).rows;
  async function actor(name) {
    await query("reset role");
    await query("select set_config('request.jwt.claims',$1,true)", [JSON.stringify({ sub: ids[name], role: "authenticated", aal: "aal2", session_id: ids[name === "a" ? "sessionA" : "sessionB"] })]);
    await query("set local role authenticated");
  }
  // As the definer would run: owner role, the caller's claims kept.
  const asOwner = async (text, args = []) => { await query("reset role"); return query(text, args); };
  const draftVersion = async (key) => {
    // FMLA drafts start through prepare_sealed_form; save_form_draft refuses
    // sealed templates (#6329) and both apply the same template precedence.
    const id = (await query("select (public.prepare_sealed_form($1)->>'formId')::uuid id", [key]))[0].id;
    return Number((await asOwner("select template_version from public.member_forms where id=$1", [id]))[0].template_version);
  };
  const seeds = (key) => asOwner("select version, active, field_schema from public.form_templates where key=$1 and is_platform_seed order by version", [key]);

  beforeAll(async () => {
    db = new pg.Client({ connectionString: assertDisposableProofUrl(process.env.SUPABASE_DB_URL), application_name: "fmla-template-seed-version-proof" });
    await db.connect(); await query("begin");
    await query("set local statement_timeout='30s'");
    for (const name of ["a", "b"]) await query("insert into auth.users(id,email,raw_user_meta_data) values($1,$2,$3)", [ids[name], `${prefix}-${name}@example.invalid`, { full_name: `FMLA proof ${name}` }]);
    await query("insert into public.organizations(id,slug,name,created_by) values($1,$3,$3,$5),($2,$4,$4,$5)", [ids.orgA, ids.orgB, `${prefix}-a`, `${prefix}-b`, ids.a]);
    for (const name of ["a", "b"]) {
      const org = ids[name === "a" ? "orgA" : "orgB"], chapter = `${prefix}-${name}`;
      await query("insert into public.chapters(id,name,slug,region,is_default,order_index,organization_id) values($1,$1,$1,'proof',false,9981,$2)", [chapter, org]);
      await query("insert into public.organization_memberships(organization_id,user_id,status) values($1,$2,'active')", [org, ids[name]]);
      await query("insert into public.member_chapter_memberships(user_id,chapter_id,status) values($1,$2,'active')", [ids[name], chapter]);
      await query("update public.member_profiles set chapter_id=$2 where id=$1", [ids[name], chapter]);
      await query("insert into public.organization_role_grants(organization_id,user_id,role) values($1,$2,'admin')", [org, ids[name]]);
      await query("insert into public.member_roles(user_id,role,chapter_id) values($1,'admin',$2) on conflict do nothing", [ids[name], chapter]);
      await query("insert into public.member_role_chapters(user_id,role,chapter_id) values($1,'admin',$2) on conflict do nothing", [ids[name], chapter]);
      await query("insert into auth.sessions(id,user_id,created_at,updated_at,aal) values($1,$2,now(),now(),'aal2')", [ids[name === "a" ? "sessionA" : "sessionB"], ids[name]]);
      await query("insert into auth.mfa_factors(id,user_id,friendly_name,factor_type,status,created_at,updated_at) values($1,$2,'FMLA proof','totp','verified',now(),now())", [randomUUID(), ids[name]]);
    }
  }, 60000);
  afterAll(async () => { if (db) { await db.query("rollback"); await db.end(); } });
  beforeEach(async () => { await query("savepoint test_case"); });
  afterEach(async () => { await query("rollback to savepoint test_case"); });

  it("adds an active platform seed above version 1 with the new fields and leaves version 1 as it was", async () => {
    for (const key of ["fmla_self", "fmla_family"]) {
      const rows = await seeds(key);
      expect(rows.map((row) => [row.version, row.active])).toEqual([[1, true], [rows[1].version, true]]);
      expect(rows[1].version).toBeGreaterThan(1);
      const reason = (schema) => schema.steps.flatMap((step) => step.fields).find((field) => field.key === "reason").label.en;
      expect(reason(rows[0].field_schema)).toBe("Reason for leave");
      expect(reason(rows[1].field_schema)).toBe(catalogue.en["forms.f.leaveNeed"]);
    }
    const member = (await seeds("fmla_family"))[1].field_schema.steps[0].fields.find((field) => field.key === "family_member");
    expect(member).toMatchObject({ maxLength: 40, label: { en: catalogue.en["forms.f.familyMemberInitials"] } });
  });

  it("leaves the account-lifecycle trigger inventory clean", async () => {
    // The catalog-wide scan takes about 10 s and more on a loaded runner, past this
    // file's 30 s statement cap; the case savepoint restores the cap afterwards.
    await query("set local statement_timeout='80s'");
    expect(await asOwner("select * from private.account_lifecycle_referential_action_trigger_issues()")).toEqual([]);
  }, 90000);

  it("starts a new FMLA draft on the newest platform seed when the organization has no copy", async () => {
    const latest = (await seeds("fmla_self")).at(-1).version;
    await actor("b");
    expect(await draftVersion("fmla_self")).toBe(latest);
  });

  it("keeps an organization's own copy over an even newer platform seed in drafts, points, labels and the reward economy", async () => {
    await actor("a");
    // This edition retired points (form_templates_points_retired_check: points = 0),
    // so the organization's copy is told apart by its version and labels.
    const own = (await query("select public.upsert_form_template('fmla_self','Local FMLA','FMLA local',null,null,null,0,1::smallint,true,$1) result", [ownFields]))[0].result;
    // A later platform seed lands after the organization edited its copy.
    await asOwner(`insert into public.form_templates(key,version,label_en,label_es,blurb_en,blurb_es,icon,points,active,sort,field_schema,is_platform_seed,organization_id)
      select key,(select max(version)+1 from public.form_templates where key='fmla_self'),label_en,label_es,blurb_en,blurb_es,icon,points,true,sort,field_schema,true,null
      from public.form_templates where key='fmla_self' and is_platform_seed order by version desc limit 1`);
    const newest = (await seeds("fmla_self")).at(-1).version;
    expect(newest).toBeGreaterThan(own.version);

    await actor("a");
    expect(await draftVersion("fmla_self")).toBe(own.version);
    const economy = (await query("select public.get_admin_reward_economy() result"))[0].result;
    expect(economy.formTemplatePoints.find((row) => row.key === "fmla_self")).toMatchObject({ version: own.version, labelEn: "Local FMLA", points: 0 });
    expect((await asOwner("select private.form_points('fmla_self') p, private.form_points('fmla_self', 1) q, private.form_template_label_localized('fmla_self','es') l"))[0])
      .toEqual({ p: 0, q: 0, l: "FMLA local" });

    // Another organization, with no copy, gets the newest platform seed.
    await actor("b");
    expect(await draftVersion("fmla_self")).toBe(newest);
    expect((await asOwner("select private.form_points('fmla_self') p"))[0].p).toBe(0);
  });

  it("mints an organization's first copy from the latest platform seed only when it turns a template off or on", async () => {
    for (const [fn, key, active] of [["deactivate_form_template", "fmla_family", false], ["reactivate_form_template", "fmla_self", true]]) {
      const latest = (await seeds(key)).at(-1);
      await actor("b");
      await query(`select public.${fn}($1)`, [key]);
      const copies = await asOwner("select version, active, field_schema from public.form_templates where key=$1 and organization_id=$2", [key, ids.orgB]);
      expect(copies, fn).toHaveLength(1);
      expect(copies[0].active).toBe(active);
      expect(copies[0].field_schema).toEqual(latest.field_schema);
    }
  });
});
