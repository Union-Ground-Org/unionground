// @vitest-environment node
import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadMigrationSql } from "./helpers/migration.js";
import { sourceTransactionProblem } from "../scripts/hosted-migration-apply-runner.mjs";
import { assertDisposableProofUrl } from "../scripts/run-required-db-proofs.mjs";

describe("unit settings migration", () => {
  it("uses the real transaction guard", () => { expect(sourceTransactionProblem(loadMigrationSql("per_unit_settings"))).toBeNull(); });
});

const live = process.env.SUPABASE_DB_URL ? describe : describe.skip;
live("unit defaults, delegated overrides and live boundaries", () => {
  let db, f;
  const one = async (sql, args = []) => (await db.query(sql, args)).rows[0]?.v;
  const owner = async () => { await db.query("reset role"); await db.query("select set_config('request.jwt.claims','',true)"); };
  const as = async (name, aal = "aal2") => {
    await owner(); const actor = f.people[name];
    await db.query("select set_config('request.jwt.claims',$1,true)", [JSON.stringify({ sub: actor.id, session_id: actor.session, role: "authenticated", aal })]);
    await db.query("set local role authenticated");
  };
  const denied = async (sql, args = [], codes = ["42501"]) => {
    await db.query("savepoint unit_setting_refusal"); let failure;
    try { await db.query(sql, args); } catch (error) { failure = error; }
    await db.query("rollback to savepoint unit_setting_refusal"); await db.query("release savepoint unit_setting_refusal");
    expect(failure, "operation unexpectedly succeeded").toBeTruthy(); expect(codes).toContain(failure.code);
  };
  const workspace = (unit = null) => one("select public.get_unit_settings_workspace($1,$2) v", [f.chapter, unit]);
  const my = (unit = null) => one("select public.get_my_unit_settings($1) v", [unit]);
  const policy = async (name = "admin", allowed = { workload: true, forms: true, templates: true, capabilities: true }, defaults = {}) => {
    await as(name); const current = await workspace();
    return one("select public.save_chapter_unit_settings($1,$2,$3,$4,$5) v", [f.chapter, defaults, allowed, current.chapterVersion, f.people[name].id]);
  };
  const save = async (value, unit = f.a, version = null, actor = f.people.steward.id) => {
    const current = version === null ? await workspace(unit) : { unitVersion: version };
    return one("select public.save_unit_settings($1,$2,$3,$4,$5) v", [f.chapter, unit, value, current.unitVersion, actor]);
  };
  // A fictional person with an active organization and chapter membership and
  // a verified second factor; roles and units are the caller's to add.
  const enrol = async (name, chapter = f.chapter) => {
    const id = randomUUID(), session = randomUUID();
    f.people[name] = { id, session };
    await db.query("insert into auth.users(id,email) values($1,$2)", [id, id + "@example.invalid"]);
    await db.query("update public.member_profiles set chapter_id=$2,full_name=$3 where id=$1", [id, chapter, "Fictional " + name]);
    await db.query("insert into auth.sessions(id,user_id,aal,created_at,updated_at) values($1,$2,'aal2',now(),now())", [session, id]);
    await db.query("insert into auth.mfa_factors(id,user_id,factor_type,status,created_at,updated_at) values($1,$2,'totp','verified',now(),now())", [randomUUID(), id]);
    await db.query("insert into public.organization_memberships(organization_id,user_id,status) values($1,$2,'active')", [f.org, id]);
    await db.query("insert into public.member_chapter_memberships(user_id,chapter_id,status) values($1,$2,'active')", [id, chapter]);
    return f.people[name];
  };
  // A staff-only chapter document, written as the admin so the product-identity
  // trigger stamps the chapter from that session; unit null is chapter-wide.
  const staffDocument = async (status, unit) => {
    await owner(); const admin = f.people.admin, doc = randomUUID();
    await db.query("select set_config('request.jwt.claims',$1,true)", [JSON.stringify({ sub: admin.id, session_id: admin.session, role: "authenticated", aal: "aal2" })]);
    await db.query("insert into public.chapter_documents(id,chapter_id,title,document_type,visibility,status,published_at,created_by,access_unit_id) values($1,$2,'Fictional staff playbook','training','staff',$3,$4,$5,$6)",
      [doc, f.chapter, status, status === "published" ? new Date().toISOString() : null, admin.id, unit]);
    return doc;
  };
  const sees = async (name, doc) => { await as(name); return one("select count(*)::int v from public.chapter_documents where id=$1", [doc]); };
  beforeEach(async () => {
    db = new pg.Client({ connectionString: assertDisposableProofUrl(process.env.SUPABASE_DB_URL), application_name: "unit-settings-owned-rollback-proof" });
    await db.connect(); await db.query("begin"); await db.query("set constraints all deferred");
    // The switch is held on Main; this proof releases it inside its own rolled-back transaction.
    await db.query("update public.platform_setting_definitions set release_at=null where key='features.governance.per_unit_settings'");
    f = { org: randomUUID(), a: randomUUID(), b: randomUUID(), foreignUnit: randomUUID(), people: {} };
    f.chapter = "unit-settings-" + f.org; f.other = "unit-other-" + f.org; f.empty = "unit-empty-" + f.org;
    await db.query("insert into public.organizations(id,slug,name) values($1::uuid,$1::text,'Fictional Harbor Units')", [f.org]);
    await db.query("insert into public.chapters(id,name,slug,organization_id,order_index) values($1,'Harbor chapter',$1,$3,9982),($2,'Ridge chapter',$2,$3,9983)", [f.chapter, f.other, f.org]);
    // Exercise the documented no-unit compatibility state, without weakening
    // the foundation's runtime default-unit constraint or committing a row.
    await db.query("alter table public.chapters disable trigger chapter_gets_default_unit");
    await db.query("insert into public.chapters(id,name,slug,organization_id,order_index) values($1,'Legacy no-unit chapter',$1,$2,9984)", [f.empty, f.org]);
    await db.query("alter table public.chapters enable trigger chapter_gets_default_unit");
    await db.query("insert into private.chapter_units(id,organization_id,chapter_id,name) values($1,$4,$5,'Team A'),($2,$4,$5,'Team B'),($3,$4,$6,'Ridge team')", [f.a, f.b, f.foreignUnit, f.org, f.chapter, f.other]);
    for (const name of ["admin", "lead", "chapterAdmin", "steward", "member", "single", "empty", "secretary"]) {
      const chapter = name === "empty" ? f.empty : f.chapter;
      const { id } = await enrol(name, chapter);
      if (["admin", "lead", "chapterAdmin"].includes(name)) {
        const role = name === "lead" ? "vp" : "admin";
        await db.query("insert into public.member_roles(user_id,role,chapter_id) values($1,$2,$3)", [id, role, chapter]);
        await db.query("insert into public.member_role_chapters(user_id,role,chapter_id) values($1,$2,$3)", [id, role, chapter]);
      }
    }
    await db.query("insert into public.organization_role_grants(organization_id,user_id,role) values($1,$2,'admin')", [f.org, f.people.admin.id]);
    for (const name of ["steward", "member", "single", "secretary"]) {
      await db.query("insert into private.chapter_unit_members(unit_id,chapter_id,user_id) values($1,$2,$3)", [f.a, f.chapter, f.people[name].id]);
      if (["member", "secretary"].includes(name)) await db.query("insert into private.chapter_unit_members(unit_id,chapter_id,user_id) values($1,$2,$3)", [f.b, f.chapter, f.people[name].id]);
    }
    await as("admin");
    await one("select public.set_member_access_role($1,$2,'steward',true,$3,null) v", [f.people.steward.id, f.chapter, f.a]);
    await one("select public.set_member_access_role($1,$2,'secretary',true,$3,null) v", [f.people.secretary.id, f.chapter, f.a]);
  }, 60000);
  afterEach(async () => { if (db) { await db.query("rollback"); await db.end(); } });

  it("uses chapter defaults without a unit, and the only unit without a prompt", async () => {
    await as("empty"); const empty = await my();
    expect(empty).toMatchObject({ units: [], unitId: null, needsChoice: false }); expect(empty.effective.configuration.chapterId).toBe(f.empty);
    await as("single"); const single = await my();
    expect(single.unitId).toBe(f.a); expect(single.needsChoice).toBe(false); expect(single.units).toHaveLength(1);
    expect(single.effective.configuration.unitName).toBe("Team A");
  });
  it("inherits chapter workload labels and follows later chapter changes until overridden", async () => {
    await as("admin"); const base = (await workspace()).organizationDefaults;
    const first = base.workload.map((field, index) => index ? field : { ...field, label: "Harbor cases" });
    await policy("lead", { workload: true }, { workload: first });
    await as("single"); expect((await my()).effective.configuration.definition.fields.find((field) => field.key === first[0].key).label).toBe("Harbor cases");
    await as("steward"); await save({ workload: first.map((field, index) => index ? field : { ...field, label: "Team A cases" }) });
    await as("single"); expect((await my()).effective.configuration.definition.fields.find((field) => field.key === first[0].key).label).toBe("Team A cases");
    await policy("lead", { workload: false }, { workload: first });
    await as("single"); expect((await my()).effective.configuration.definition.fields.find((field) => field.key === first[0].key).label).toBe("Harbor cases");
  });
  it("stores the workload snapshot the member was shown for their unit", async () => {
    await policy("lead", { workload: true }); await as("steward");
    const categories = (await workspace(f.a)).effective.workload;
    await save({ workload: categories.map((field, index) => index ? field : { ...field, label: "Team A cases" }) });
    await as("single"); const shown = (await my()).effective.configuration;
    expect(shown.definition.fields.find((field) => field.key === categories[0].key).label).toBe("Team A cases");
    await one("select public.save_unit_workload_log(null,$1,$2,'logged',$3,$4,$5,$6,$7) v",
      [shown.version, { [categories[0].key]: 1 }, f.org, f.a, shown.settingsRevision, f.people.single.id, f.chapter]);
    await owner();
    const stored = await one("select jsonb_build_object('snapshot',workload_configuration,'scope',settings_scope) v from public.member_workload_logs where user_id=$1 order by created_at desc limit 1", [f.people.single.id]);
    expect(stored.snapshot.definition).toEqual(shown.definition);
    expect(stored.snapshot.settingsRevision).toBe(shown.settingsRevision);
    expect(stored.scope).toEqual({ chapterId: f.chapter, unitId: f.a, unitName: "Team A" });
  });
  it("refuses undelegated changes and audits every accepted change with its actual unit", async () => {
    await as("steward"); await denied("select public.save_unit_settings($1,$2,$3,0,$4)", [f.chapter, f.a, { forms: [] }, f.people.steward.id]);
    await policy(); await as("steward"); const saved = await save({ forms: [] });
    expect(saved.effective.forms).toEqual([]);
    await owner(); const audit = await one("select jsonb_build_object('actor',actor_id,'unit',unit_id,'name',unit_name,'after',after_value) v from private.unit_setting_audit where chapter_id=$1 and unit_id=$2", [f.chapter, f.a]);
    expect(audit).toEqual({ actor: f.people.steward.id, unit: f.a, name: "Team A", after: { forms: [] } });
  });
  it("refuses another unit even if its steward also joins that unit, and refuses another chapter", async () => {
    await policy(); await owner();
    await db.query("insert into private.chapter_unit_members(unit_id,chapter_id,user_id) values($1,$2,$3)", [f.b, f.chapter, f.people.steward.id]);
    await as("steward");
    await denied("select public.save_unit_settings($1,$2,$3,0,$4)", [f.chapter, f.b, { forms: [] }, f.people.steward.id]);
    await denied("select public.save_unit_settings($1,$2,$3,0,$4)", [f.other, f.foreignUnit, { forms: [] }, f.people.steward.id]);
    await denied("select public.get_unit_settings_workspace($1,$2)", [f.chapter, f.b]);
  });
  it("lets the unit's assigned steward edit it without being one of its members", async () => {
    await policy(); await owner();
    await db.query("delete from private.chapter_unit_members where unit_id=$1 and user_id=$2", [f.a, f.people.steward.id]);
    await as("steward");
    expect((await save({ forms: [] })).effective.forms).toEqual([]);
    expect((await my()).canManage).toBe(true);
    await denied("select public.save_unit_settings($1,$2,$3,0,$4)", [f.chapter, f.b, { forms: [] }, f.people.steward.id]);
  });
  it("reserves delegation to a chapter lead or organization admin, and binds the actor and version", async () => {
    await as("steward"); await denied("select public.save_chapter_unit_settings($1,'{}','{}',0,$2)", [f.chapter, f.people.steward.id]);
    await as("chapterAdmin"); await denied("select public.save_chapter_unit_settings($1,'{}','{}',0,$2)", [f.chapter, f.people.chapterAdmin.id]);
    await policy(); await as("steward");
    await denied("select public.save_unit_settings($1,$2,$3,0,$4)", [f.chapter, f.a, { forms: [] }, f.people.admin.id]);
    await save({ forms: [] });
    await denied("select public.save_unit_settings($1,$2,$3,0,$4)", [f.chapter, f.a, { templates: [] }, f.people.steward.id], ["PT409"]);
  });
  it("asks for an explicit choice for several memberships and never merges their choices", async () => {
    await policy(); await as("steward"); await save({ forms: [] });
    await as("member"); const choices = await my();
    expect(choices.needsChoice).toBe(true); expect(choices.unitId).toBeNull(); expect(choices.effective).toBeNull();
    expect((await my(f.a)).effective.forms).toEqual([]);
    expect((await my(f.b)).effective.forms).toContain("grievance");
  });
  it("rechecks live membership for unit reads and refuses stale actors or chapters on writes", async () => {
    await as("member"); const context = await my(f.a);
    await owner(); await db.query("delete from private.chapter_unit_members where unit_id=$1 and user_id=$2", [f.a, f.people.member.id]);
    await as("member"); await denied("select public.get_my_unit_settings($1)", [f.a]);
    await denied("select public.save_unit_workload_log(null,$1,$2,'logged',$3,$4,$5,$6,$7)", [context.effective.configuration.version, { priority: 1 }, f.org, f.a, context.effective.configuration.settingsRevision, f.people.member.id, f.chapter]);
    await denied("select public.save_unit_form_draft('grievance','{}',0,$1,$2,$3,$4)", [f.b, f.people.admin.id, f.chapter, f.org]);
    await denied("select public.prepare_unit_sealed_form('fmla_self',$1,$2,$3,$4)", [f.b, f.people.member.id, f.other, f.org]);
  });
  it("checks a capability against the actual unit and never creates a new role grant", async () => {
    await policy(); await as("secretary");
    expect(await one("select private.chapter_officer_can_for_scope($1,'records',$2,null) v", [f.chapter, f.a])).toBe(true);
    expect(await one("select private.chapter_officer_can_for_scope($1,'records',$2,null) v", [f.chapter, f.b])).toBe(false);
    await as("steward"); await save({ capabilities: { "secretary:records": false } });
    await as("secretary"); expect(await one("select private.chapter_officer_can_for_scope($1,'records',$2,null) v", [f.chapter, f.a])).toBe(false);
    await as("admin"); await one("select public.set_chapter_role_capability($1,'secretary','records',false) v", [f.chapter]);
    await as("steward"); const current = await workspace(f.a);
    await denied("select public.save_unit_settings($1,$2,$3,$4,$5)", [f.chapter, f.a, { capabilities: { "secretary:records": true } }, current.unitVersion, f.people.steward.id]);
  });
  it("enforces form visibility on both ordinary and sealed creation, including cached clients", async () => {
    await policy(); await as("steward"); await save({ forms: [] });
    await as("member");
    await denied("select public.save_unit_form_draft('grievance','{}',0,$1,$2,$3,$4)", [f.a, f.people.member.id, f.chapter, f.org]);
    await denied("select public.prepare_unit_sealed_form('fmla_self',$1,$2,$3,$4)", [f.a, f.people.member.id, f.chapter, f.org]);
    await denied("select public.save_form_draft('grievance','{}',0)", [], ["22023"]);
    const id = await one("select public.save_unit_form_draft('grievance','{}',0,$1,$2,$3,$4) v", [f.b, f.people.member.id, f.chapter, f.org]);
    expect(await one("select settings_scope->>'unitName' v from public.member_forms where id=$1", [id])).toBe("Team B");
  });
  it("stamps a template task with its unit and refuses a template that unit hides", async () => {
    await owner(); await db.query("insert into public.chapter_workstreams(chapter_id,name) values ($1,'General') on conflict do nothing", [f.chapter]);
    await policy(); await as("steward"); await save({ templates: [] });
    const create = (unit, actor) => one("select public.create_unit_task_from_template('review_approval','Unit review','General',$1::jsonb,$2,$3,$4,$5) v",
      [JSON.stringify({ review_kind: "document" }), unit, actor, f.chapter, f.org]);
    await denied("select public.create_unit_task_from_template('review_approval','Unit review','General',$1::jsonb,$2,$3,$4,$5)",
      [JSON.stringify({ review_kind: "document" }), f.a, f.people.steward.id, f.chapter, f.org]);
    await save({});
    const made = await create(f.a, f.people.steward.id);
    expect(made.task.settings_scope).toEqual({ chapterId: f.chapter, unitId: f.a, unitName: "Team A" });
    await owner();
    expect(await one("select settings_scope v from public.chapter_tasks where id=$1", [made.task.id])).toEqual({ chapterId: f.chapter, unitId: f.a, unitName: "Team A" });
  });
  it("lets a unit's records switch narrow its assigned steward's scoped records (gate stage 153 r1s1)", async () => {
    await as("steward");
    expect(await one("select private.chapter_record_manageable($1,$2,null) v", [f.chapter, f.a])).toBe(true);
    await policy(); await as("steward"); await save({ capabilities: { "steward:records": false } });
    expect(await one("select private.chapter_record_manageable($1,$2,null) v", [f.chapter, f.a])).toBe(false);
    await denied("select public.save_scoped_institutional_record(null,'minutes','Fictional unit minutes','Fictional body',now(),'staff','save',false,null,null,'[]'::jsonb,$1,null)", [f.a]);
    await as("admin"); expect(await one("select private.chapter_record_manageable($1,$2,null) v", [f.chapter, f.a])).toBe(true);
  });
  it("lets a unit's documents switch narrow its steward's document writes there (gate stage 184 r3s1)", async () => {
    // The product-identity trigger stamps chapter_id from the author's session.
    await owner(); const admin = f.people.admin, doc = randomUUID();
    await db.query("select set_config('request.jwt.claims',$1,true)", [JSON.stringify({ sub: admin.id, session_id: admin.session, role: "authenticated", aal: "aal2" })]);
    await db.query("insert into public.chapter_documents(id,chapter_id,title,document_type,visibility,status,created_by,access_unit_id) values($1,$2,'Fictional unit playbook','training','staff','draft',$3,$4)", [doc, f.chapter, admin.id, f.a]);
    const edit = "select public.update_chapter_document_content($1,$2,'training','','Fictional body','staff','save') v";
    const seen = () => one("select count(*)::int v from public.chapter_documents where id=$1", [doc]);
    await as("steward"); expect((await one(edit, [doc, "Fictional edit one"])).title).toBe("Fictional edit one");
    expect(await seen()).toBe(1);
    await policy(); await as("steward"); await save({ capabilities: { "steward:documents": false } });
    await denied(edit, [doc, "Fictional edit two"]);
    // The staff arm of the read policy is narrowed too; a draft is no member's.
    expect(await seen()).toBe(0);
    await as("admin"); expect((await one(edit, [doc, "Fictional edit three"])).title).toBe("Fictional edit three");
  });
  it("lets a unit's records switch remove its steward's staff route to members it covers (gate stage 184 r3s2)", async () => {
    await as("steward");
    expect(await one("select private.chapter_records_member_allowed($1,$2) v", [f.chapter, f.people.single.id])).toBe(true);
    await policy(); await as("steward"); await save({ capabilities: { "steward:records": false } });
    expect(await one("select private.chapter_records_member_allowed($1,$2) v", [f.chapter, f.people.single.id])).toBe(false);
    await as("lead"); expect(await one("select private.chapter_records_member_allowed($1,$2) v", [f.chapter, f.people.single.id])).toBe(true);
  });
  it("lets a unit's notices switch narrow its steward's notices to that unit (gate stage 153 ruling)", async () => {
    // No API role may run the private notice-scope helper: read it as the
    // owner with the person's claims, as the publish functions do.
    const notices = async (name) => {
      await owner(); const actor = f.people[name];
      await db.query("select set_config('request.jwt.claims',$1,true)", [JSON.stringify({ sub: actor.id, session_id: actor.session, role: "authenticated", aal: "aal2" })]);
      return one("select private.chapter_notice_scope_allowed($1,$2,null) v", [f.chapter, f.a]);
    };
    expect(await notices("steward")).toBe(true);
    await policy(); await as("steward"); await save({ capabilities: { "steward:notices": false } });
    expect(await notices("steward")).toBe(false);
    expect(await notices("lead")).toBe(true);
  });
  it("lets a unit's records switch narrow a unit officer's member records", async () => {
    await as("secretary");
    expect(await one("select private.chapter_records_member_allowed($1,$2) v", [f.chapter, f.people.single.id])).toBe(true);
    await policy(); await as("steward"); await save({ capabilities: { "secretary:records": false } });
    await as("secretary");
    expect(await one("select private.chapter_records_member_allowed($1,$2) v", [f.chapter, f.people.single.id])).toBe(false);
  });
  // A second role assigned to the same unit restores nothing its own role does
  // not hold there: the role must carry the capability, the chapter must leave
  // it on and the unit must leave it on (gate stage 188 r5s1, r6s1).
  for (const second of ["secretary", "records"]) {
    it(`counts a ${second} assignment beside a narrowed unit steward only where ${second} holds the capability (gate stage 188 r5s1, r6s1)`, async () => {
      await owner(); const dual = await enrol("dual");
      await db.query("insert into private.chapter_unit_members(unit_id,chapter_id,user_id) values($1,$2,$3)", [f.a, f.chapter, dual.id]);
      await as("admin");
      await one("select public.set_member_access_role($1,$2,'steward',true,$3,null) v", [dual.id, f.chapter, f.a]);
      await one("select public.set_member_access_role($1,$2,$4,true,$3,null) v", [dual.id, f.chapter, f.a, second]);
      const doc = await staffDocument("draft", f.a);
      const edits = async () => {
        await as("dual"); await db.query("savepoint mixed_role_edit");
        try { await db.query("select public.update_chapter_document_content($1,'Fictional mixed edit','training','','Fictional body','staff','save') v", [doc]); return true; }
        catch (error) { if (error.code !== "42501") throw error; return false; }
        finally { await db.query("rollback to savepoint mixed_role_edit"); await db.query("release savepoint mixed_role_edit"); }
      };
      const records = async () => { await as("dual"); return one("select private.chapter_records_member_allowed($1,$2) v", [f.chapter, f.people.single.id]); };
      await policy();
      const seen = [];
      for (const chapterOn of [true, false]) for (const unitOn of [true, false]) {
        // The unit narrows the steward first; the chapter decides afterwards.
        const capabilities = { "steward:documents": false, "steward:records": false };
        if (!unitOn) Object.assign(capabilities, { [second + ":documents"]: false, [second + ":records"]: false });
        await as("steward"); await save({ capabilities });
        await as("admin");
        for (const capability of ["documents", "records"]) await one("select public.set_chapter_role_capability($1,$2,$3,$4) v", [f.chapter, second, capability, chapterOn]);
        seen.push({ chapterOn, unitOn, edit: await edits(), read: (await sees("dual", doc)) === 1, records: await records() });
      }
      expect(seen).toEqual([
        { chapterOn: true, unitOn: true, edit: true, read: true, records: true },
        { chapterOn: true, unitOn: false, edit: false, read: false, records: false },
        { chapterOn: false, unitOn: true, edit: false, read: false, records: false },
        { chapterOn: false, unitOn: false, edit: false, read: false, records: false },
      ]);
    });
  }
  it("keeps a shared unit document behind its unit's documents switch for its own chapter's staff (gate stage 188 r5s2)", async () => {
    await owner(); const ridge = await enrol("ridge", f.other);
    await db.query("insert into public.member_roles(user_id,role,chapter_id) values($1,'coordinator',$2)", [ridge.id, f.other]);
    await db.query("insert into public.member_role_chapters(user_id,role,chapter_id) values($1,'coordinator',$2)", [ridge.id, f.other]);
    const unitDoc = await staffDocument("published", f.a), chapterDoc = await staffDocument("published", null);
    // Fixture only: an active document exchange with the Ridge chapter,
    // written past the verification boundary trigger.
    await owner(); await db.query("set local session_replication_role = replica");
    const handshake = await one("insert into public.chapter_handshakes(chapter_id,receiving_chapter_id,partner_org_id,title,purpose,data_scope,status,requested_by) values($1,$2,'fictional-partner','Fictional exchange','Fictional purpose','docs_only','active',$3) returning id v", [f.chapter, f.other, f.people.admin.id]);
    await db.query("insert into public.chapter_handshake_documents(handshake_id,document_id,shared_by) values($1,$2,$4),($1,$3,$4)", [handshake, unitDoc, chapterDoc, f.people.admin.id]);
    await db.query("set local session_replication_role = origin");
    expect(await sees("steward", unitDoc)).toBe(1);
    await policy(); await as("steward"); await save({ capabilities: { "steward:documents": false } });
    expect(await sees("steward", unitDoc)).toBe(0);
    expect(await sees("admin", unitDoc)).toBe(1);
    // The receiving chapter keeps its read of what was shared with it.
    expect(await sees("ridge", chapterDoc)).toBe(1);
  });
  it("binds a draft from before units to the unit chosen when it is prepared, so the separate sealed write succeeds (r1s4)", async () => {
    await owner();
    const draft = await one("insert into public.member_forms(user_id,template_key,template_version,answers,step,organization_id) values($1,'fmla_self',1,'{}',0,$2) returning id v", [f.people.member.id, f.org]);
    await db.query("update public.member_forms set settings_scope='{}'::jsonb where id=$1", [draft]);
    await as("member");
    expect((await one("select public.prepare_unit_sealed_form('fmla_self',$1,$2,$3,$4) v", [f.a, f.people.member.id, f.chapter, f.org])).formId).toBe(draft);
    await owner();
    expect(await one("select settings_scope v from public.member_forms where id=$1", [draft])).toEqual({ chapterId: f.chapter, unitId: f.a, unitName: "Team A" });
    // The sealed write updates the row in its own call, with no unit chosen in it.
    await db.query("select set_config('request.jwt.claims',$1,true)", [JSON.stringify({ sub: f.people.member.id, session_id: f.people.member.session, role: "authenticated", aal: "aal2" })]);
    await db.query("update public.member_forms set step=1 where id=$1", [draft]);
    await owner(); expect(await one("select step v from public.member_forms where id=$1", [draft])).toBe(1);
  });
  it("validates a new unit workload entry against what the unit shows, not the organization's required fields (r2s3)", async () => {
    await owner(); const current = await one("select private.workload_configuration_payload($1) v", [f.org]);
    const categories = current.definition.fields.filter((field) => field.kind === "category");
    const hidden = categories[0].key, kept = categories[1].key;
    const definition = { ...current.definition, fields: current.definition.fields.map((field) => field.key === hidden ? { ...field, required: true, visible: true } : field) };
    await as("admin");
    await one("select public.save_organization_workload_configuration($1,$2,$3) v", [definition, current.version, f.org]);
    await policy("lead", { workload: true }); await as("steward");
    const base = (await workspace(f.a)).effective.workload;
    await save({ workload: base.map((field) => field.key === hidden ? { ...field, visible: false } : { ...field, visible: field.key === kept ? true : field.visible }) });
    await as("single"); const shown = (await my()).effective.configuration;
    expect(shown.definition.fields.find((field) => field.key === hidden).required).toBe(false);
    const saved = await one("select public.save_unit_workload_log(null,$1,$2,'logged',$3,$4,$5,$6,$7) v",
      [shown.version, { [kept]: 1 }, f.org, f.a, shown.settingsRevision, f.people.single.id, f.chapter]);
    expect(saved).toBeTruthy();
  });
  // Ledger 238: an entry bound to the chapter itself (saved in a chapter with
  // no unit yet) and edited after the chapter gains a unit its author is in.
  // The unit save reads a null unit as the author's current unit, so the row's
  // stamp refuses it; the ordinary save, which the web edit now takes, keeps
  // the chapter binding.
  it("edits a chapter-bound entry after its author joins a unit only through the ordinary save (ledger 238)", async () => {
    await as("empty"); const shown = (await my()).effective.configuration;
    expect(shown.chapterId).toBe(f.empty);
    const key = shown.definition.fields.find((field) => field.kind === "category").key;
    const saved = await one("select public.save_unit_workload_log(null,$1,$2,'logged',$3,null,$4,$5,$6) v",
      [shown.version, { [key]: 1 }, f.org, shown.settingsRevision, f.people.empty.id, f.empty]);
    await owner();
    const row = () => one("select jsonb_build_object('scope',settings_scope,'values',workload_values) v from public.member_workload_logs where id=$1", [saved.id]);
    expect((await row()).scope).toMatchObject({ chapterId: f.empty, unitId: null });
    const later = randomUUID();
    await db.query("insert into private.chapter_units(id,organization_id,chapter_id,name) values($1,$2,$3,'Later team')", [later, f.org, f.empty]);
    await db.query("insert into private.chapter_unit_members(unit_id,chapter_id,user_id) values($1,$2,$3)", [later, f.empty, f.people.empty.id]);
    await as("empty");
    expect((await my()).unitId).toBe(later);
    await denied("select public.save_unit_workload_log($1,$2,$3,'logged',$4,null,null,$5,$6)",
      [saved.id, shown.version, { [key]: 2 }, f.org, f.people.empty.id, f.empty], ["PT409"]);
    const edited = await one("select public.save_configured_workload_log($1,$2,$3,'logged',$4) v", [saved.id, shown.version, { [key]: 3 }, f.org]);
    expect(edited).toMatchObject({ id: saved.id, updated: true });
    await owner();
    const after = await row();
    expect(after.scope).toMatchObject({ chapterId: f.empty, unitId: null });
    expect(after.values).toEqual({ [key]: 3 });
  });
  it("keeps a unit's overrides with the unit when it moves to another chapter (r2s5)", async () => {
    const moved = randomUUID();
    await owner(); await db.query("insert into private.chapter_units(id,organization_id,chapter_id,name) values($1,$2,$3,'Team C')", [moved, f.org, f.chapter]);
    await policy(); await as("admin");
    await one("select public.save_unit_settings($1,$2,$3,0,$4) v", [f.chapter, moved, { forms: [] }, f.people.admin.id]);
    await owner(); await db.query("update private.chapter_units set chapter_id=$2 where id=$1", [moved, f.other]);
    expect(await one("select chapter_id v from private.unit_setting_overrides where unit_id=$1", [moved])).toBe(f.other);
    await as("admin"); const there = await one("select public.get_unit_settings_workspace($1,$2) v", [f.other, moved]);
    expect(there.overrides).toEqual({ forms: [] }); expect(there.unitVersion).toBe(1);
  });
  it("shows and saves nothing about units while the switch is held, and keeps what is stored", async () => {
    await policy(); await as("steward"); await save({ forms: [], capabilities: { "secretary:records": false } });
    await owner(); await db.query("update public.platform_setting_definitions set release_at='infinity' where key='features.governance.per_unit_settings'");
    await as("member"); expect(await my()).toEqual({ released: false });
    const id = await one("select public.save_unit_form_draft('grievance','{}',0,null,$1,$2,$3) v", [f.people.member.id, f.chapter, f.org]);
    expect(await one("select settings_scope v from public.member_forms where id=$1", [id])).toEqual({});
    await denied("select public.save_unit_form_draft('grievance','{}',0,$1,$2,$3,$4)", [f.a, f.people.member.id, f.chapter, f.org]);
    await as("steward"); await denied("select public.get_unit_settings_workspace($1,$2)", [f.chapter, f.a]);
    await denied("select public.save_unit_settings($1,$2,'{}',1,$3)", [f.chapter, f.a, f.people.steward.id]);
    await as("lead"); await denied("select public.save_chapter_unit_settings($1,'{}','{}',1,$2)", [f.chapter, f.people.lead.id]);
    await as("secretary"); expect(await one("select private.chapter_officer_can_for_scope($1,'records',$2,null) v", [f.chapter, f.a])).toBe(true);
    await owner(); expect(await one("select overrides v from private.unit_setting_overrides where unit_id=$1", [f.a])).toEqual({ forms: [], capabilities: { "secretary:records": false } });
  });
  it("keeps direct settings tables private and requires two-step assurance", async () => {
    await as("member"); await denied("select * from private.unit_setting_overrides");
    await denied("select public.get_unit_settings_workspace($1,null)", [f.chapter]);
    await as("steward", "aal1"); await denied("select public.get_my_unit_settings(null)");
    await denied("select public.save_unit_settings($1,$2,'{}',0,$3)", [f.chapter, f.a, f.people.steward.id]);
  });
});
