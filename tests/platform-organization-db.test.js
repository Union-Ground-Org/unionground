// @vitest-environment node
// Full migrated disposable database only. Every fixture rolls back; no hosted
// target, SAMPLE identity, or existing application account is accepted.
import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { assertDisposableProofUrl } from "../scripts/run-required-db-proofs.mjs";
import { releaseCalendarHolds } from "./helpers/release-calendar-holds.js";

// #8568: fixture dates are built on the Eastern day, the day the readers count;
// the session's current_date is the UTC day, tomorrow from 7 PM Eastern.

const live = process.env.SUPABASE_DB_URL ? describe : describe.skip;
live("internal platform organization", () => {
  let db;
  const platform = randomUUID();
  const union = randomUUID();
  const user = randomUUID();
  const session = randomUUID();
  const tag = platform.slice(0, 8);
  const pc = `platform-${tag}`;
  const uc = `union-${tag}`;
  const claims = JSON.stringify({ sub: user, session_id: session, role: "authenticated", aal: "aal2" });

  async function as(role, sql, values = [], jwt = role === "authenticated" ? claims : JSON.stringify({ role })) {
    await db.query("savepoint platform_probe");
    try {
      await db.query("select set_config('request.jwt.claims',$1,true)", [jwt]);
      await db.query(`set local role ${role}`);
      const result = await db.query(sql, values);
      await db.query("reset role");
      await db.query("select set_config('request.jwt.claims','',true)");
      await db.query("release savepoint platform_probe");
      return result.rows;
    } catch (error) {
      await db.query("rollback to savepoint platform_probe");
      await db.query("release savepoint platform_probe");
      throw error;
    }
  }
  const refuses = async (sql, values, role = "postgres", message = "platform organization is private") => {
    await expect(as(role, sql, values)).rejects.toMatchObject({ code: "42501", message });
  };

  async function exportFixture(run) {
    await db.query("savepoint export_fixture");
    try {
      await db.query("set local session_replication_role=replica");
      await db.query("update public.member_profiles set full_name='Export Proof User' where id=$1", [user]);
      await db.query("insert into public.member_roles(user_id,role,chapter_id) values($1,'admin',null) on conflict do nothing", [user]);
      await db.query("insert into public.member_role_chapters(user_id,role,chapter_id) values($1,'admin',$2),($1,'admin',$3) on conflict do nothing", [user, pc, uc]);
      await db.query("set local session_replication_role=origin");
      await run();
    } finally {
      await db.query("rollback to savepoint export_fixture");
      await db.query("release savepoint export_fixture");
    }
  }

  async function seedExportData(kind) {
    const fixtures = new Map();
    await db.query("set local session_replication_role=replica");
    for (const [org, chapter] of [[platform, pc], [union, uc]]) {
      const item = { org, chapter, id: randomUUID() };
      if (kind === "survey" || kind === "bargaining") {
        // Every survey reader holds 25 whatever the survey floor (3 here for a
        // plain survey; REQ-UG-SURVEY-RESPONSE-FLOOR-25-SERVER-SIDE-20261104).
        const count = 25, floor = kind === "bargaining" ? 25 : 3;
        item.question = randomUUID(); item.responses = [];
        await db.query(`insert into public.organization_surveys
          (id,organization_id,title,status,cadence,owner_user_id,privacy_min_responses,created_by,operations_state)
          values($1,$2,'Export proof','open','one_off',$3,$4,$3,'distributing')`, [item.id, org, user, floor]);
        await db.query(`insert into public.organization_survey_questions
          (id,organization_id,survey_id,sort_index,question_type,label,options,section_key)
          values($1,$2,$3,0,'radio','Priority','["Pay"]',$4)`, [item.question, org, item.id, kind === "bargaining" ? "bargaining-v1:priorities" : "general"]);
        for (let i = 0; i < count; i += 1) {
          const person = randomUUID(), response = randomUUID();
          await db.query("insert into auth.users(id,email) values($1,$2)", [person, `${person}@export-proof.invalid`]);
          await db.query("insert into public.member_profiles(id,chapter_id,full_name) values($1,$2,'Survey respondent')", [person, chapter]);
          await db.query("insert into public.organization_memberships(organization_id,user_id) values($1,$2)", [org, person]);
          await db.query("insert into public.member_chapter_memberships(chapter_id,user_id) values($1,$2)", [chapter, person]);
          await db.query("insert into public.member_profile_details(user_id,worksite,details_visibility) values($1,'Proof workplace','admins')", [person]);
          await db.query("insert into public.organization_survey_sessions(id,organization_id,survey_id,respondent_user_id,status,submitted_at) values($1,$2,$3,$4,'submitted',now())", [response, org, item.id, person]);
          await db.query("insert into public.organization_survey_answers(organization_id,session_id,question_id,value) values($1,$2,$3,'\"Pay\"')", [org, response, item.question]);
          item.responses.push(response);
        }
      } else if (kind === "digital") {
        await db.query("insert into public.digital_actions(id,organization_id,chapter_id,action_kind,title,summary,status,published_at,created_by,updated_by) values($1,$2,$3,'petition','Export proof','Proof petition','published',now(),$4,$4)", [item.id, org, chapter, user]);
        await db.query("insert into public.digital_action_participants(organization_id,action_id,user_id,participation_kind) values($1,$2,$3,'signature')", [org, item.id, user]);
      } else if (kind === "ballot" || kind === "officer") {
        item.id = `export-${item.id}`;
        item.option = `${item.id}-option`;
        item.code = org === platform ? "SG-AAAA-BBBB" : "SG-CCCC-DDDD";
        const officer = kind === "officer";
        await db.query(`insert into public.member_ballots
          (id,title,organization_id,chapter_id,closes_at,active,campaign_state,published_at,order_index,created_by,
           ballot_type,target_officer_id,target_officer_name,target_officer_role,removal_reason)
          values($1,$2,$3,$4,now()-$5::interval,false,'closed',now()-interval '2 days',$12,$6,$7,$8,$9,$10,$11)`,
        [item.id, org === platform ? "Platform ballot" : "Union ballot", org, chapter, org === platform ? "1 minute" : "1 hour", user,
          officer ? "officer_removal" : "standard", officer ? user : null, officer ? "Proof officer" : null, officer ? "steward" : null, officer ? "Documented proof removal reason" : null, org === platform ? 90001 : 90002]);
        await db.query("insert into public.member_ballot_options(id,ballot_id,label,order_index) values($1,$2,'Yes',1)", [item.option, item.id]);
        await db.query("insert into public.member_ballot_choices(ballot_id,option_id) values($1,$2)", [item.id, item.option]);
        await db.query("insert into public.member_ballot_receipts(ballot_id,user_id,receipt_code,counted) values($1,$2,$3,true)", [item.id, user, item.code]);
      } else if (kind === "case") {
        await db.query("insert into public.member_cases(id,organization_id,chapter_id,user_id,reference,title,case_type) values($1,$2,$3,$4,$5,'Export case','grievance')", [item.id, org, chapter, user, `EXP-${item.id}`]);
      } else if (kind === "poll") {
        const space = randomUUID(), option = randomUUID();
        await db.query("insert into public.chapter_spaces(id,chapter_id,name,visibility) values($1,$2,'Export proof','chapter')", [space, chapter]);
        await db.query("insert into public.chapter_channel_polls(id,space_id,chapter_id,question,created_by) values($1,$2,$3,'Priority?',$4)", [item.id, space, chapter, user]);
        await db.query("insert into public.chapter_channel_poll_options(id,poll_id,label,position) values($1,$2,'Pay',0)", [option, item.id]);
        await db.query("insert into public.chapter_channel_poll_votes(poll_id,option_id,user_id) values($1,$2,$3)", [item.id, option, user]);
      } else if (kind === "task") {
        await db.query("insert into public.chapter_tasks(chapter_id,title,status,created_by,task_number) values($1,'Report proof','to_do',$2,$3)", [chapter, user, org === platform ? 50001 : 50002]);
      } else if (kind === "coordination") {
        item.run = randomUUID();
        const config = JSON.stringify({ dataset: "members_directory", cadence: "daily", format: "json", deliveryMode: "email_unset", nextRunAt: "2020-01-01T00:00:00Z" });
        await db.query("insert into public.organization_coordination_records(id,organization_id,kind,title,status,config,idempotency_key,created_by) values($1,$2,'network_export_schedule','Export schedule','active',$3::jsonb,$4,$5)", [item.id, org, config, randomUUID(), user]);
        await db.query("insert into public.organization_coordination_export_runs(id,schedule_id,organization_id,requested_by,format,delivery_mode,status,row_count,idempotency_key,dataset,expires_at) values($1,$2,$3,$4,'json','internal_download','ready',1,$5,'members_directory',now()+interval '1 day')", [item.run, item.id, org, user, randomUUID()]);
      }
      fixtures.set(org, item);
    }
    await db.query("set local session_replication_role=origin");
    for (const key of ["features.engagement_voice.bargaining_survey_template", "features.engagement_voice.survey_report_exports", "features.automation.scheduled_dataset_exports", "features.governance.officer_removal_ballots"]) {
      for (const org of [platform, union]) await db.query("insert into public.organization_setting_values(organization_id,setting_key,value,updated_by) values($1,$2,'true',$3) on conflict(organization_id,setting_key) do update set value='true'", [org, key, user]);
    }
    return fixtures;
  }

  beforeAll(async () => {
    db = new pg.Client({ connectionString: assertDisposableProofUrl(process.env.SUPABASE_DB_URL) });
    await db.connect();
    await db.query("begin");
    await releaseCalendarHolds(db);
    await db.query("set local statement_timeout='30s'");
    // The migration replay withholds direct organization-table grants from
    // service_role. Give the fixture only the column rights needed to reach
    // the kind guard; the transaction rolls them back with its synthetic rows.
    await db.query("grant select(id,kind), update(kind) on public.organizations to service_role");
    // Schema-only local restores need the same reviewed defaults as migrated CI.
    await db.query(`insert into public.platform_setting_definitions
      (key,value_kind,label,description,default_value,minimum,maximum,sort_order,category,member_visible)
      values ('limits.analytics.anonymity_floor','integer','Analytics anonymity floor','Reviewed default','25',10,200,2640,'analytics',false),
        ('limits.analytics.chapter_health_cohort_floor','integer','Chapter health cohort floor','Reviewed default','10',5,100,2660,'analytics',false)
      on conflict (key) do nothing`);
    // Historical published rows are deliberately installed before designation.
    // This proves reads do not rely on a new-write guard or unpublished defaults.
    await db.query("set local session_replication_role=replica");
    await db.query("insert into public.organizations(id,slug,name) values($1,$2,$2),($3,$4,$4)", [platform, pc, union, uc]);
    await db.query("insert into public.chapters(id,slug,name,organization_id,order_index) values($1,$1,$1,$2,1),($3,$3,$3,$4,2)", [pc, platform, uc, union]);
    // Replica-mode fixture must supply the default units its disabled chapter trigger would create.
    await db.query("insert into private.chapter_units(organization_id,chapter_id,name,is_default) values($1,$2,$2,true),($3,$4,$4,true)", [platform,pc,union,uc]);
    await db.query("insert into auth.users(id,email) values($1,$2)", [user, `${tag}@platform-proof.invalid`]);
    await db.query("insert into auth.sessions(id,user_id,aal,created_at,updated_at) values($1,$2,'aal2',now(),now())", [session, user]);
    await db.query("insert into auth.mfa_factors(id,user_id,factor_type,status,created_at,updated_at) values($1,$2,'totp','verified',now(),now())", [randomUUID(), user]);
    await db.query("insert into public.member_profiles(id,chapter_id) values($1,$2)", [user, uc]);
    await db.query("insert into public.organization_memberships(organization_id,user_id) values($1,$3),($2,$3)", [platform, union, user]);
    await db.query("insert into public.member_chapter_memberships(chapter_id,user_id) values($1,$3),($2,$3)", [pc, uc, user]);
    await db.query("insert into public.organization_role_grants(organization_id,user_id,role) values($1,$3,'admin'),($2,$3,'admin')", [platform, union, user]);
    for (const [org, chapter] of [[platform, pc], [union, uc]]) {
      await db.query(`insert into public.public_site_records(id,kind,title_en,title_es,body_en,body_es,organization_id,is_published,published_at)
        values($1,'chapter','Proof','Prueba','Proof','Prueba',$2,true,now())`, [chapter, org]);
      await db.query(`insert into public.public_site_records(id,kind,title_en,title_es,body_en,body_es,organization_id,is_published,published_at,starts_at,ends_at,location_en,location_es,chapter_code)
        values($1,'meeting','Proof','Prueba','Proof','Prueba',$2,true,now(),now(),now()+interval '1 day','Hall','Sala',$3)`, [`event-${chapter}`, org, chapter]);
      await db.query("insert into public.organization_network_directory_profiles(organization_id,display_name,visibility) values($1,'Proof','directory')", [org]);
    }
    await db.query(`insert into public.member_kb_articles
      (slug,kind,title,article_ref,body,chapter_id,status,content_origin,created_by,updated_by,verified_by,verified_at,
       compass_organization_id,compass_scope_path,compass_classification)
      values($1,'contract','Platform proof','Article 12','The employer shall pay wages within 14 days.',
        $2,'published','authored',$3,$3,$3,now(),$4,
        private.compass_scope_path_for_chapter($2),
        private.classify_compass_document('Platform proof','Article 12','The employer shall pay wages within 14 days.'))`,
    [`article-${pc}`, pc, user, platform]);
    await db.query(`insert into private.chapter_connection_profiles
      (chapter_id,organization_id,location_country,publication_status,publication_version,published_at,expires_at,consent_version,consent_recorded_at,consent_hat)
      values($1,$2,'US','published',1,now(),now()+interval '180 days',1,now(),'admin')`, [pc, platform]);
    await db.query("set local session_replication_role=origin");
    await as("service_role", "update public.organizations set kind='platform' where id=$1", [platform]);
    await db.query("create function pg_temp.network_discover(p_id uuid) returns boolean language sql security definer as $$ select private.organization_network_can_discover(p_id) $$");
  }, 120_000);

  afterAll(async () => {
    if (!db) return;
    await db.query("rollback").catch(() => {});
    await db.end();
  });

  it("defaults tenants to union and permits only one platform", async () => {
    expect((await db.query("select kind from public.organizations where id=$1", [union])).rows[0].kind).toBe("union");
    await expect(as("service_role", "update public.organizations set kind='platform' where id=$1", [union])).rejects.toMatchObject({ code: "23505" });
  });

  it("refuses client classification, including a definer running as postgres", async () => {
    // A test-only definer models an otherwise privileged RPC invoked by a client.
    await db.query("create function pg_temp.classify_fixture(p_id uuid) returns void language sql security definer as $$ update public.organizations set kind='union' where id=p_id $$");
    await refuses("select pg_temp.classify_fixture($1)", [platform], "authenticated", "service role required to classify an organization");
    expect((await db.query("select kind from public.organizations where id=$1", [platform])).rows[0].kind).toBe("platform");
  });

  it("refuses designation over existing catalog or handshake history", async () => {
    await db.query("savepoint old_binding");
    await as("service_role", "update public.organizations set kind='union' where id=$1", [platform]);
    await db.query("set local session_replication_role=replica");
    await db.query("insert into private.organization_catalog_placements(organization_id,unlisted_parent_name) values($1,'Example parent')", [platform]);
    await db.query("set local session_replication_role=origin");
    await expect(as("service_role", "update public.organizations set kind='platform' where id=$1", [platform])).rejects.toMatchObject({ code: "23514" });
    await db.query("rollback to savepoint old_binding");
  });

  it("makes anonymous platform verification indistinguishable from an unknown slug", async () => {
    const call = async (slug) => (await as("anon", "select public.get_organization_public_verification($1) value", [slug]))[0].value;
    expect(await call(pc)).toEqual(await call(`unknown-${tag}`));
    expect((await call(uc)).found).toBe(true);
  });

  it("excludes platform content from both public locales and preserves ordinary tenants", async () => {
    for (const locale of ["en", "es"]) {
      for (const rpc of ["get_public_site_content", "get_public_directory"]) {
        const value = (await as("anon", `select public.${rpc}($1) value`, [locale]))[0].value;
        expect(JSON.stringify(value)).not.toContain(pc);
        expect(JSON.stringify(value)).toContain(uc);
      }
      expect((await as("anon", "select public.get_public_chapter_microsite($1,$2) value", [pc, locale]))[0].value).toBeNull();
      expect((await as("anon", "select public.get_public_chapter_microsite($1,$2) value", [uc, locale]))[0].value).not.toBeNull();
      expect((await as("anon", "select public.get_public_event_detail($1,$2) value", [`event-${pc}`, locale]))[0].value).toBeNull();
      expect((await as("anon", "select public.get_public_event_detail($1,$2) value", [`event-${uc}`, locale]))[0].value).not.toBeNull();
    }
  });

  it("refuses platform publishing even through privileged table writes", async () => {
    await refuses("update public.public_site_records set title_en='Changed' where id=$1", [pc]);
    await refuses("update public.organization_network_directory_profiles set display_name='Changed' where organization_id=$1", [platform]);
    await refuses("insert into private.chapter_connection_profiles(chapter_id,organization_id,location_country,publication_status) values($1,$2,'US','published')", [pc, platform]);
    await refuses("insert into public.public_chapter_sections(organization_id,chapter_code,slug,title_en,title_es,body_en,body_es,is_published) values($1,$2,'proof','Proof','Prueba','Proof','Prueba',true)", [platform, pc]);
  });

  it("withholds platform reward cards from an entitled member of another union", async () => {
    const member = randomUUID();
    const memberSession = randomUUID();
    const memberClaims = JSON.stringify({ sub: member, session_id: memberSession, role: "authenticated", aal: "aal2" });
    await db.query("savepoint reward_cards");
    try {
      await db.query("set local session_replication_role=replica");
      await db.query("insert into auth.users(id,email) values($1,$2)", [member, `${member}@platform-proof.invalid`]);
      await db.query("insert into auth.sessions(id,user_id,aal,created_at,updated_at) values($1,$2,'aal2',now(),now())", [memberSession, member]);
      await db.query("insert into auth.mfa_factors(id,user_id,factor_type,status,created_at,updated_at) values($1,$2,'totp','verified',now(),now())", [randomUUID(), member]);
      await db.query("insert into public.member_profiles(id,chapter_id) values($1,$2)", [member, uc]);
      await db.query("insert into public.organization_memberships(organization_id,user_id) values($1,$2)", [union, member]);
      await db.query("insert into public.member_chapter_memberships(chapter_id,user_id) values($1,$2)", [uc, member]);
      await db.query("insert into public.member_reward_grants(organization_id,user_id,item_key,status,source) values($1,$2,'cross-chapter-cards','granted','admin_grant')", [union, member]);
      await db.query("set local session_replication_role=origin");
      for (const locale of [null, "en", "es"]) {
        const cards = (await as("authenticated", "select public.get_reward_cross_chapter_cards($1) value", [locale], memberClaims))[0].value;
        expect(cards.map((card) => card.id)).toContain(uc);
        expect(cards.map((card) => card.id)).not.toContain(pc);
      }
    } finally {
      await db.query("rollback to savepoint reward_cards");
    }
  });

  it("refuses catalog placement, catalog claim, union binding and both handshake ends", async () => {
    await refuses("insert into private.organization_catalog_placements(organization_id,unlisted_parent_name) values($1,'Example parent')", [platform]);
    await refuses("insert into private.organization_claims(organization_id) values($1)", [platform]);
    await refuses("insert into public.chapter_union_org_bindings(chapter_id,union_org_id) values($1,'example')", [pc]);
    for (const [from, to] of [[pc, uc], [uc, pc]]) {
      await refuses("insert into public.chapter_handshakes(chapter_id,receiving_chapter_id,partner_org_id,title,purpose) values($1,$2,'example','Proof','Proof')", [from, to]);
    }
  });

  it("hides platform directory rows and refuses discovery in both directions", async () => {
    const value = (await as("authenticated", "select pg_temp.network_discover($1) visible", [platform]))[0].visible;
    expect(value).toBe(false);
    const directory = (await as("authenticated", "select public.get_organization_coordination_extensions() value"))[0].value.directory;
    expect(directory.map((r) => r.organizationId)).not.toContain(platform);
    expect(directory.map((r) => r.organizationId)).toContain(union);
    expect((await as("authenticated", "select pg_temp.network_discover($1) visible", [union]))[0].visible).toBe(true);
  });

  it("keeps the selected union's Compass scope free of a dual member's platform organization", async () => {
    const scope = async () => (await as("authenticated", "select private.compass_retrieval_scope_summary('platform proof', '[]') value"))[0].value;
    // Positive control: the same verified authored article is a matching
    // alternative when its organization is a union; only kind changes.
    await db.query("savepoint ordinary_article");
    await as("service_role", "update public.organizations set kind='union' where id=$1", [platform]);
    expect((await scope()).matching_organization_ids).toContain(platform);
    await db.query("rollback to savepoint ordinary_article");
    const value = await scope();
    expect(value.organization_id).toBe(union);
    expect(value.matching_organization_ids).not.toContain(platform);
  });

  it("excludes a previously published platform connection profile and keeps the union control visible", async () => {
    const profiles = async () => (await as("authenticated", "select public.list_chapter_connection_profiles('admin') value"))[0].value.rows;
    expect((await profiles()).map((row) => row.id)).not.toContain(pc);
    await db.query("savepoint union_profile");
    await as("service_role", "update public.organizations set kind='union' where id=$1", [platform]);
    expect((await profiles()).map((row) => row.id)).toContain(pc);
    await db.query("rollback to savepoint union_profile");
  });

  it("does not record platform analytics or allow platform analytics exports", async () => {
    await db.query("update public.member_profiles set chapter_id=$1 where id=$2", [pc, user]);
    try {
      expect((await as("authenticated", "select public.record_workspace_page_view('/m/home','member',$1) value", [platform]))[0].value).toEqual({ recorded: false });
      await refuses("select public.get_organization_analytics_snapshot()", [], "authenticated");
      await refuses("select public.get_organization_analytics_workspace()", [], "authenticated");
      await refuses("select public.request_organization_analytics_export('json',$1)", [randomUUID()], "authenticated");
      expect((await db.query("select count(*)::int n from public.organization_page_views where organization_id=$1", [platform])).rows[0].n).toBe(0);
    } finally {
      await db.query("update public.member_profiles set chapter_id=$1 where id=$2", [uc, user]);
    }
  });

  it("refuses every filtered export domain to a platform admin and keeps the union admin's export", async () => {
    await db.query("update public.member_profiles set chapter_id=$1 where id=$2", [pc, user]);
    try {
      for (const domains of [["members"], ["members", "cases", "tasks", "minutes", "timeline", "contacts"]]) {
        await refuses("select public.request_filtered_organization_export($1::text[],'json')", [domains], "authenticated");
      }
      expect((await db.query("select count(*)::int n from public.organization_data_export_runs where organization_id=$1", [platform])).rows[0].n).toBe(0);
    } finally {
      await db.query("update public.member_profiles set chapter_id=$1 where id=$2", [uc, user]);
    }
    const value = (await as("authenticated", "select public.request_filtered_organization_export(array['members'],'json') value"))[0].value;
    expect(value.rows).toContainEqual(expect.objectContaining({ domain: "members", values: expect.objectContaining({ memberId: user, chapterId: uc }) }));
    expect(JSON.stringify(value)).not.toContain(pc);
  });

  it.each(["results", "window"])("refuses platform survey %s exports and keeps union responses available", async kind => {
    await db.query("savepoint survey_exports");
    try {
      await db.query(`insert into public.platform_setting_definitions
        (key,value_kind,label,description,default_value,sort_order,category,member_visible)
        values ('features.engagement_voice.survey_report_exports','boolean','Survey exports','Proof setting','true',1,'engagement_voice',false)
        on conflict (key) do update set default_value='true'::jsonb`);
      const fixtures = new Map();
      // Retained responses predate designation. They must stay stored while
      // the platform's export entry points refuse to disclose them.
      await db.query("set local session_replication_role=replica");
      for (const org of [platform, union]) {
        const survey = randomUUID(), question = randomUUID();
        const responses = [];
        await db.query(`insert into public.organization_surveys
          (id,organization_id,title,status,cadence,owner_user_id,privacy_min_responses,created_by,operations_state)
          values($1,$2,'Retained survey','open','one_off',$3,3,$3,'distributing')`, [survey, org, user]);
        await db.query(`insert into public.organization_survey_questions
          (id,organization_id,survey_id,sort_index,question_type,label)
          values($1,$2,$3,0,'paragraph','Feedback')`, [question, org, survey]);
        // 25 responses: the survey floor is 3, but exports never go below 25
        // (REQ-UG-SURVEY-RESPONSE-FLOOR-25-SERVER-SIDE-20261104).
        for (let index = 0; index < 25; index += 1) {
          const respondent = randomUUID(), response = randomUUID();
          await db.query("insert into auth.users(id,email) values($1,$2)", [respondent, `${respondent}@platform-proof.invalid`]);
          await db.query(`insert into public.organization_survey_sessions
            (id,organization_id,survey_id,respondent_user_id,status,submitted_at)
            values($1,$2,$3,$4,'submitted',now())`, [response, org, survey, respondent]);
          await db.query(`insert into public.organization_survey_answers
            (organization_id,session_id,question_id,value) values($1,$2,$3,$4::jsonb)`, [org, response, question, JSON.stringify(`answer-${index}`)]);
          responses.push(response);
        }
        fixtures.set(org, { survey, question, responses });
      }
      await db.query("set local session_replication_role=origin");
      const sql = kind === "window"
        ? "select public.export_organization_survey_window($1,null,null,'json') value"
        : "select public.export_organization_survey_results($1) value";
      await db.query("update public.member_profiles set chapter_id=$1 where id=$2", [pc, user]);
      await refuses(sql, [fixtures.get(platform).survey], "authenticated");
      expect((await db.query("select count(*)::int n from public.organization_survey_sessions where survey_id=$1", [fixtures.get(platform).survey])).rows[0].n).toBe(25);
      expect((await db.query("select count(*)::int n from public.organization_audit_events where organization_id=$1 and event_type='organization_export_completed'", [platform])).rows[0].n).toBe(0);
      await db.query("update public.member_profiles set chapter_id=$1 where id=$2", [uc, user]);
      const value = (await as("authenticated", sql, [fixtures.get(union).survey]))[0].value;
      expect(value).toMatchObject({ available: true, responseCount: 25, privacyMinResponses: 25 });
      expect(value.responses.map(response => response.responseId).sort()).toEqual(fixtures.get(union).responses.sort());
      expect(value.responses.map(response => response.answers[fixtures.get(union).question]).sort()).toEqual(Array.from({ length: 25 }, (_, index) => `answer-${index}`).sort());
      expect(JSON.stringify(value)).not.toContain(fixtures.get(platform).survey);
    } finally {
      await db.query("rollback to savepoint survey_exports");
      await db.query("release savepoint survey_exports");
    }
  });

  it.each([
    ["get_bargaining_survey_results", "bargaining"],
    ["get_organization_survey_report", "survey"],
    ["get_organization_survey_report_window", "survey"],
    ["get_organization_survey_review_detail", "survey"],
    ["get_organization_survey_worksites", "survey"],
    ["request_digital_action_participant_export", "digital"],
    ["casework_record_case_export", "case"],
    ["get_ballot_tally", "ballot"],
    ["get_channel_poll_tally", "poll"],
    ["chapter_task_report", "task"],
    ["get_vp_overview", "ballot"],
    ["get_advisor_overview", "ballot"],
    ["get_officer_removal_ballot_details", "officer"],
    ["organization_export_dataset", "coordination"],
    ["run_organization_coordination_export", "coordination"],
    ["get_organization_coordination_export_payload", "coordination"],
    ["complete_organization_export_delivery", "coordination"],
  ])("%s withholds platform data and preserves the union result", async (name, kind) => {
    await exportFixture(async () => {
      const fixtures = await seedExportData(kind);
      const query = item => {
        switch (name) {
          case "request_digital_action_participant_export": return ["select public.request_digital_action_participant_export('admin',$1,'signature') value", [item.id]];
          case "casework_record_case_export": return ["select public.casework_record_case_export($1::uuid[],'selection','{}') value", [[item.id]]];
          case "get_organization_survey_report_window": return ["select public.get_organization_survey_report_window($1,null,null) value", [item.id]];
          case "get_organization_survey_review_detail": return ["select public.get_organization_survey_review_detail($1) value", [item.responses[0]]];
          case "get_vp_overview": return ["select public.get_vp_overview() value", []];
          case "get_advisor_overview": return ["select public.get_advisor_overview() value", []];
          case "chapter_task_report": return ["select public.chapter_task_report(null,null) value", []];
          case "get_officer_removal_ballot_details": return ["select public.get_officer_removal_ballot_details($1::text[]) value", [[fixtures.get(platform).id, fixtures.get(union).id]]];
          case "organization_export_dataset": return ["select private.organization_export_dataset($1,'members_directory') value", [item.org]];
          case "run_organization_coordination_export": return ["select public.run_organization_coordination_export($1,'json',$2) value", [item.id, randomUUID()]];
          case "get_organization_coordination_export_payload": return ["select public.get_organization_coordination_export_payload($1) value", [item.run]];
          case "complete_organization_export_delivery": return ["select public.complete_organization_export_delivery($1,'delivered',null) value", [item.run]];
          default: return [`select public.${name}($1) value`, [item.id]];
        }
      };
      if (name === "complete_organization_export_delivery") {
        await db.query("update public.organization_coordination_export_runs set status='running',delivery_mode='email_unset' where id=any($1::uuid[])", [[fixtures.get(platform).run, fixtures.get(union).run]]);
      }
      const role = name === "organization_export_dataset" ? "postgres" : name === "complete_organization_export_delivery" ? "service_role" : "authenticated";
      await db.query("update public.member_profiles set chapter_id=$1 where id=$2", [pc, user]);
      if (name === "get_channel_poll_tally") {
        const [sql, params] = query(fixtures.get(platform));
        expect((await as(role, sql, params))[0].value).toMatchObject({ total: null, options: [expect.objectContaining({ votes: null })] });
      } else await refuses(...query(fixtures.get(platform)), role);
      expect((await db.query("select count(*)::int n from public.digital_action_exports where organization_id=$1", [platform])).rows[0].n).toBe(0);
      expect((await db.query("select count(*)::int n from public.casework_audit_events where organization_id=$1 and event_type='cases_exported'", [platform])).rows[0].n).toBe(0);
      expect((await db.query("select count(*)::int n from private.organization_survey_worksite_releases r join public.organization_surveys s on s.id=r.survey_id where s.organization_id=$1", [platform])).rows[0].n).toBe(0);
      await db.query("update public.member_profiles set chapter_id=$1 where id=$2", [uc, user]);
      const [sql, params] = query(fixtures.get(union));
      const value = (await as(role, sql, params))[0].value;
      if (name === "get_bargaining_survey_results") expect(value).toMatchObject({ available: true, responseCount: 25 });
      else if (["get_organization_survey_report", "get_organization_survey_report_window"].includes(name)) expect(value).toMatchObject({ available: true, responseCount: 25, privacyMinResponses: 25 });
      else if (name === "get_organization_survey_review_detail") expect(value).toMatchObject({ available: true, answers: [expect.objectContaining({ value: "Pay" })] });
      else if (name === "get_organization_survey_worksites") expect(value).toMatchObject({ withheld: false, groups: [expect.any(Object)] });
      else if (name === "request_digital_action_participant_export") expect(value).toMatchObject({ rowCount: 1, rows: [expect.objectContaining({ memberName: "Export Proof User", email: `${tag}@platform-proof.invalid` })] });
      else if (name === "casework_record_case_export") expect(value).toMatchObject({ rowCount: 1, scope: "selection" });
      else if (name === "get_ballot_tally") expect(value).toMatchObject({ totalVotes: 1, options: [expect.objectContaining({ votes: 1 })] });
      else if (name === "get_channel_poll_tally") expect(value).toMatchObject({ total: 1, options: [expect.objectContaining({ votes: 1 })] });
      else if (name === "chapter_task_report") expect(value.totals.total).toBe(1);
      else if (["get_vp_overview", "get_advisor_overview"].includes(name)) expect(value.turnout).toMatchObject({ title: "Union ballot", totalVotes: 1 });
      else if (name === "get_officer_removal_ballot_details") expect(value.items.map(item => item.ballotId)).toEqual([fixtures.get(union).id]);
      else if (name === "organization_export_dataset") expect(JSON.stringify(value.rows)).toContain("Export Proof User");
      else if (name === "run_organization_coordination_export") expect(value).toMatchObject({ status: "ready", rowCount: 1 });
      else if (name === "get_organization_coordination_export_payload") expect(value.content).toContain("Export Proof User");
      else if (name === "complete_organization_export_delivery") expect(value).toMatchObject({ status: "delivered" });
    });
  });

  it("verify_ballot_receipt hides platform receipts and verifies a union receipt", async () => {
    await exportFixture(async () => {
      const fixtures = await seedExportData("ballot");
      const lookup = async code => (await as("anon", "select public.verify_ballot_receipt($1) value", [code]))[0].value;
      expect(await lookup(fixtures.get(platform).code)).toEqual(await lookup("SG-ZZZZ-ZZZZ"));
      expect(await lookup(fixtures.get(union).code)).toMatchObject({ found: true, ballotTitle: "Union ballot", counted: true });
    });
  });

  it("run_due_organization_coordination_exports skips platform schedules and runs the union schedule", async () => {
    await exportFixture(async () => {
      const fixtures = await seedExportData("coordination");
      const value = (await as("service_role", "select public.run_due_organization_coordination_exports(now(),50) value"))[0].value;
      expect(value.processed).toBe(1);
      expect((await db.query("select count(*)::int n from public.organization_coordination_export_runs where schedule_id=$1", [fixtures.get(platform).id])).rows[0].n).toBe(1);
      expect((await db.query("select count(*)::int n from public.organization_coordination_export_runs where schedule_id=$1", [fixtures.get(union).id])).rows[0].n).toBe(2);
    });
  });

  it("claim_organization_export_deliveries skips platform receipts and claims the union receipt", async () => {
    await exportFixture(async () => {
      const fixtures = await seedExportData("coordination");
      await db.query("update public.organization_coordination_export_runs set status='queued',delivery_mode='email_unset' where id=any($1::uuid[])", [[fixtures.get(platform).run, fixtures.get(union).run]]);
      const rows = (await as("service_role", "select public.claim_organization_export_deliveries(25) value"))[0].value;
      expect(rows.map(row => row.runId)).toEqual([fixtures.get(union).run]);
      expect((await db.query("select status from public.organization_coordination_export_runs where id=$1", [fixtures.get(platform).run])).rows[0].status).toBe("queued");
    });
  });

  it("refuses platform report reads while keeping union coordinator and coordination reads", async () => {
    await exportFixture(async () => {
      const records = await seedExportData("coordination");
      await seedExportData("case");
      await db.query("set local session_replication_role=replica");
      await db.query("insert into public.organization_role_grants(organization_id,user_id,role) values($1,$3,'coordinator'),($2,$3,'coordinator') on conflict do nothing", [platform, union, user]);
      await db.query("set local session_replication_role=origin");
      const reads = ["get_coordinator_kpis()", "get_organization_coordination_snapshot()", "list_organization_coordination_records(null,null,50)", "list_organization_coordination_messages(null,null,30)"];
      await db.query("update public.member_profiles set chapter_id=$1 where id=$2", [pc, user]);
      for (const call of reads) await refuses(`select public.${call} value`, [], "authenticated");
      await db.query("update public.member_profiles set chapter_id=$1 where id=$2", [uc, user]);
      const values = [];
      for (const call of reads) values.push((await as("authenticated", `select public.${call} value`))[0].value);
      expect(values[0]).toMatchObject({ openCases: 1 });
      expect(values[1]).toMatchObject({ state: "ready", organizationId: union });
      expect(values[2].records).toEqual(expect.arrayContaining([expect.objectContaining({ id: records.get(union).id })]));
      expect(values[3].messages).toEqual([]);
    });
  });
  it("keeps a steward revoked from a union chapter uncounted when only a platform chapter role remains (#6369)", async () => {
    // The real grant and revoke helpers: steward role in the union chapter,
    // then in the platform chapter, then the union chapter membership is
    // revoked. member_roles keeps chapter_id on the union chapter while the
    // platform mapping remains, so only the membership test keeps it out.
    const steward = randomUUID();
    await db.query("savepoint revoked_steward");
    try {
      await db.query("set local session_replication_role=replica");
      await db.query("insert into auth.users(id,email) values($1,$2)", [steward, `${steward}@platform-proof.invalid`]);
      await db.query("insert into public.member_profiles(id,chapter_id) values($1,$2)", [steward, uc]);
      await db.query("insert into public.organization_memberships(organization_id,user_id) values($1,$3),($2,$3)", [platform, union, steward]);
      await db.query("insert into public.member_chapter_memberships(chapter_id,user_id) values($1,$3),($2,$3)", [pc, uc, steward]);
      await db.query("insert into public.member_roles(user_id,role,chapter_id) values($1,'advisor',$2)", [user, uc]);
      await db.query("set local session_replication_role=origin");
      const overview = async () => (await as("authenticated", "select public.get_advisor_overview() value"))[0].value;
      const baseline = (await overview()).stewardCount;
    // This new steward grant explicitly chooses a real unit.
      await as("authenticated", "select public.set_member_access_role($1,$2,'steward',true,((public.get_chapter_access_workspace($2)->'units')->0->>'id')::uuid,null)", [steward, uc]);
      expect((await overview()).stewardCount).toBe(baseline + 1);
      await db.query("update public.member_profiles set chapter_id=$1 where id=$2", [pc, user]);
    // This new steward grant explicitly chooses a real unit.
      await as("authenticated", "select public.set_member_access_role($1,$2,'steward',true,((public.get_chapter_access_workspace($2)->'units')->0->>'id')::uuid,null)", [steward, pc]);
      await db.query("update public.member_profiles set chapter_id=$1 where id=$2", [uc, user]);
      await as("authenticated", "select public.revoke_member_chapter_membership($1,$2)", [steward, uc]);
      expect((await db.query(`select r.chapter_id, array(select om.organization_id from public.organization_memberships om
        where om.user_id=r.user_id and om.status='active') orgs from public.member_roles r where r.user_id=$1 and r.role='steward'`, [steward])).rows)
        // #8311: the legacy row no longer keeps naming the revoked union
        // chapter; it moves to the platform chapter that still holds the role.
        .toEqual([{ chapter_id: pc, orgs: [platform] }]);
      expect(await overview()).toMatchObject({ stewardCount: baseline, atRisk: { unstaffed: baseline === 0 } });
    } finally {
      await db.query("rollback to savepoint revoked_steward");
      await db.query("release savepoint revoked_steward");
    }
  });
  it("withholds platform live polls from direct and realtime reads while union polls stay readable", async () => {
    const polls = new Map();
    await db.query("savepoint live_poll_boundary");
    await db.query("set local session_replication_role=replica");
    for (const org of [platform, union]) {
      const id = randomUUID();
      await db.query(`insert into public.organization_live_polls(id,organization_id,title,state,eligibility,results_visibility,vote_count,result_cache,created_by)
        values($1,$2,'Boundary poll','open','organization','live',3,'[{"optionId":"a","votes":3}]'::jsonb,$3)`, [id, org, user]);
      polls.set(org, id);
    }
    await db.query("set local session_replication_role=origin");
    for (const [org, chapter, visible] of [[platform, pc, 0], [union, uc, 1]]) {
      await db.query("update public.member_profiles set chapter_id=$1 where id=$2", [chapter, user]);
      const rows = await as("authenticated", "select vote_count, result_cache from public.organization_live_polls where id=$1", [polls.get(org)]);
      expect(rows.length, org === platform ? "platform" : "union").toBe(visible);
    }
    await db.query("rollback to savepoint live_poll_boundary");
    await db.query("release savepoint live_poll_boundary");
    await db.query("update public.member_profiles set chapter_id=$1 where id=$2", [uc, user]);
  });

  it("withholds the platform participant total in the participation RPC and keeps the union total", async () => {
    await exportFixture(async () => {
      const actions = await seedExportData("digital");
      for (const [org, chapter] of [[platform, pc], [union, uc]]) {
        await db.query("update public.member_profiles set chapter_id=$1 where id=$2", [chapter, user]);
        const [{ value }] = await as("authenticated", "select public.toggle_digital_action_participation($1,'signature',false) value", [actions.get(org).id]);
        expect(value.joined).toBe(false);
        if (org === platform) expect(value.participantCount).toBeNull();
        else expect(value.participantCount).toBe(0);
      }
    });
  });

  it.each([
    ["live issue signals", "select public.get_issue_intelligence_signals('admin') value", { enabled: true, viewer: "staff" }],
    ["steward workload intelligence", "select public.get_steward_workload_intelligence(12) value", { available: false }],
    ["derived topic readiness", "select public.get_organization_derived_graph('admin') value", { topicReadiness: [] }],
    ["civic campaign statistics", "select coalesce(jsonb_agg(stats),'[]'::jsonb) value from public.civic_campaign_stats_for_org($1) stats", [expect.objectContaining({ messages_sent: 1, members_participating: 1 })]],
  ])("refuses platform %s and preserves the authenticated union read", async (_name, sql, expected) => {
    await exportFixture(async () => {
      await db.query("set local session_replication_role=replica");
      for (const org of [platform, union]) {
        for (const key of ["features.intelligence.issue_signals", "features.intelligence.neuro_map_derived_graph", "features.intelligence.neuro_map_auto_progress"]) {
          await db.query(`insert into public.organization_setting_values(organization_id,setting_key,value)
            values($1,$2,'true'::jsonb) on conflict(organization_id,setting_key) do update set value=excluded.value`, [org, key]);
        }
      }
      if (sql.includes("civic_campaign_stats_for_org")) {
        for (const chapter of [pc, uc]) {
          const campaign = randomUUID();
          await db.query("insert into public.civic_campaigns(id,org_id,title,topic,status,created_by) values($1,$2,'Proof campaign','Workplace proof','active',$3)", [campaign, chapter, user]);
          await db.query(`insert into public.civic_member_messages(campaign_id,user_id,official_key,official_name,office,channel,status)
            values($1,$2,'proof-official','Proof official','Proof office','letter','sent')`, [campaign, user]);
        }
      }
      await db.query("set local session_replication_role=origin");
      const call = chapter => as("authenticated", sql, sql.includes("$1") ? [chapter] : []);
      await db.query("update public.member_profiles set chapter_id=$1 where id=$2", [uc, user]);
      expect((await call(uc))[0].value).toMatchObject(expected);
      await db.query("update public.member_profiles set chapter_id=$1 where id=$2", [pc, user]);
      await expect(call(pc)).rejects.toMatchObject({ code: "42501", message: "platform organization is private" });
    });
  });

  // Round 8: each reader shares private.organization_is_platform.
  const selectChapter = chapter => db.query("update public.member_profiles set chapter_id=$1 where id=$2", [chapter, user]);

  it("refuses platform case-dashboard aggregates and keeps the union dashboard", async () => {
    await exportFixture(async () => {
      const cases = await seedExportData("case");
      await db.query("set local session_replication_role=replica");
      await db.query("update public.member_cases set step='Step 2' where id = any($1::uuid[])", [[cases.get(platform).id, cases.get(union).id]]);
      await db.query("set local session_replication_role=origin");
      await selectChapter(pc);
      for (const call of ["open_cases_by_step", "open_cases_by_assignee", "overdue_deadlines", "deadlines_due_soon", "median_days_per_step"]) {
        await refuses(`select * from public.casework_dashboard_${call}()`, [], "authenticated");
      }
      await selectChapter(uc);
      expect(await as("authenticated", "select step, case_count::int from public.casework_dashboard_open_cases_by_step()"))
        .toEqual([{ step: "Step 2", case_count: 1 }]);
    });
  });

  it("refuses platform Compass staff-data aggregates and keeps the union bargaining counts", async () => {
    await exportFixture(async () => {
      await db.query("set local session_replication_role=replica");
      for (const [org, chapter] of [[platform, pc], [union, uc]]) {
        for (const key of ["features.ai_assistant.enabled", "features.ai_assistant.staff_data_answers"]) {
          await db.query(`insert into public.organization_setting_values(organization_id,setting_key,value)
            values($1,$2,'true'::jsonb) on conflict(organization_id,setting_key) do update set value=excluded.value`, [org, key]);
        }
        await db.query("insert into public.casework_bargaining_workspaces(id,organization_id,chapter_id,title,status,created_by) values($1,$2,$3,'Proof table','live',$4)", [randomUUID(), org, chapter, user]);
      }
      await db.query("set local session_replication_role=origin");
      const sql = "select public.get_compass_staff_data_context(array['bargaining']) value";
      await selectChapter(pc);
      await refuses(sql, [], "authenticated");
      await selectChapter(uc);
      const [{ value }] = await as("authenticated", sql);
      expect(value).toMatchObject({ organization_id: union, data: { bargaining: { workspacesByStatus: { live: 1 } } } });
    });
  });

  it("keeps retained platform cases out of union workload rebalancing after profiles move", async () => {
    await exportFixture(async () => {
      await db.query("set local session_replication_role=replica");
      await db.query("insert into public.organization_role_grants(organization_id,user_id,role) values($1,$2,'steward') on conflict do nothing", [union, user]);
      await db.query("insert into public.member_role_chapters(user_id,role,chapter_id) values($1,'steward',$2) on conflict do nothing", [user, uc]);
      for (const [org, chapter] of [[platform, pc], [union, uc]]) {
        const id = randomUUID();
        await db.query("insert into public.member_cases(id,organization_id,chapter_id,user_id,steward_user_id,reference,title,case_type) values($1,$2,$3,$4,$4,$5,'Workload case','grievance')", [id, org, chapter, user, `WL-${id}`]);
      }
      await db.query("set local session_replication_role=origin");
      // The member and the steward now both sit in the union chapter; the
      // platform case keeps its platform ownership.
      await selectChapter(uc);
      const [{ value }] = await as("authenticated", "select public.get_steward_workload_intelligence(12) value");
      expect(value.rebalancing.stewards.find(steward => steward.userId === user)).toMatchObject({ activeCases: 1 });
    });
  });

  it("refuses platform Constant Contact analytics and keeps the union rows", async () => {
    await exportFixture(async () => {
      await db.query("set local session_replication_role=replica");
      for (const org of [platform, union]) {
        await db.query("insert into public.constant_contact_member_analytics(organization_id,member_id,contact_status,sends_count,opens_count,clicks_count) values($1,$2,'active',3,2,1)", [org, user]);
      }
      await db.query("set local session_replication_role=origin");
      const sql = "select public.list_constant_contact_analytics(25) value";
      await selectChapter(pc);
      await refuses(sql, [], "authenticated");
      await selectChapter(uc);
      const [{ value }] = await as("authenticated", sql);
      expect(value).toEqual([expect.objectContaining({ memberId: user, sendsCount: 3, opensCount: 2, clicksCount: 1 })]);
    });
  });

  // Round 9.
  it("keeps a granted platform case out of a union caller's Compass byOutcome", async () => {
    await exportFixture(async () => {
      await db.query("set local session_replication_role=replica");
      await db.query("insert into public.organization_role_grants(organization_id,user_id,role) values($1,$3,'coordinator'),($2,$3,'coordinator') on conflict do nothing", [platform, union, user]);
      for (const org of [platform, union]) {
        for (const key of ["features.ai_assistant.enabled", "features.ai_assistant.staff_data_answers"]) {
          await db.query(`insert into public.organization_setting_values(organization_id,setting_key,value)
            values($1,$2,'true'::jsonb) on conflict(organization_id,setting_key) do update set value=excluded.value`, [org, key]);
        }
      }
      for (const [org, chapter, outcome] of [[platform, pc, "settled"], [union, uc, "upheld"]]) {
        const id = randomUUID();
        await db.query("insert into public.member_cases(id,organization_id,chapter_id,user_id,reference,title,case_type) values($1,$2,$3,$4,$5,'Outcome case','grievance')", [id, org, chapter, user, `OUT-${id}`]);
        await db.query("insert into public.member_case_outcomes(case_id,user_id,outcome,summary,recorded_by) values($1,$2,$3,'Proof outcome',$2)", [id, user, outcome]);
        // The union coordinator holds an active grant to the platform-owned case.
        if (org === platform) {
          await db.query("insert into public.casework_access_grants(case_id,organization_id,chapter_id,grantee_user_id,granted_by,reason) values($1,$2,$3,$4,$4,'Proof cross-organization grant')", [id, org, chapter, user]);
        }
      }
      await db.query("set local session_replication_role=origin");
      await selectChapter(uc);
      const [{ value }] = await as("authenticated", "select public.get_compass_staff_data_context(array['outcomes']) value");
      expect(value.data.outcomes.byOutcome).toEqual({ upheld: 1 });
    });
  });

  it("withholds platform Constant Contact totals from the control read and keeps the union totals", async () => {
    await exportFixture(async () => {
      await db.query("set local session_replication_role=replica");
      for (const org of [platform, union]) {
        await db.query("insert into public.constant_contact_member_analytics(organization_id,member_id,contact_status,sends_count,opens_count,clicks_count) values($1,$2,'active',3,2,1)", [org, user]);
      }
      await db.query("set local session_replication_role=origin");
      const sql = "select public.list_constant_contact_control() value";
      const totals = ["memberCount", "activeContactCount", "sendCount", "openCount", "clickCount"];
      await selectChapter(pc);
      await refuses("select public.list_constant_contact_analytics(25) value", [], "authenticated");
      const [{ value: withheld }] = await as("authenticated", sql);
      for (const key of totals) expect(withheld[key], key).toBeNull();
      expect(withheld).toMatchObject({ status: "unset", connected: false });
      await selectChapter(uc);
      const [{ value }] = await as("authenticated", sql);
      expect(value).toMatchObject({ memberCount: 1, activeContactCount: 1, sendCount: 3, openCount: 2, clickCount: 1 });
    });
  });

  it("refuses platform workload statistics before aggregation and keeps the union read", async () => {
    await db.query("update public.member_profiles set chapter_id=$1 where id=$2", [pc, user]);
    try {
      await refuses("select public.get_workload_stats()", [], "authenticated");
    } finally {
      await db.query("update public.member_profiles set chapter_id=$1 where id=$2", [uc, user]);
    }
    const [{ value }] = await as("authenticated", "select public.get_workload_stats() value");
    expect(value).toMatchObject({ enoughData: false });
  });

  it("keeps platform chapter health out of the portfolio and the snapshot policy", async () => {
    await db.query("savepoint chapter_health_boundary");
    await db.query("set local session_replication_role=replica");
    for (const chapter of [pc, uc]) {
      await db.query(`insert into public.chapter_health_snapshots(chapter_id,measured_on,member_count,participation,case_timeliness,steward_capacity,training_coverage,communication_reach,governance_readiness,score,created_by)
        values($1,(now() at time zone 'America/New_York')::date,500,60,60,60,60,60,60,60,$2)`, [chapter, user]);
    }
    await db.query("set local session_replication_role=origin");
    await exportFixture(async () => {
      for (const [chapter, visible] of [[pc, 0], [uc, 1]]) {
        await db.query("update public.member_profiles set chapter_id=$1 where id=$2", [chapter, user]);
        expect((await as("authenticated", "select count(*)::int n from public.chapter_health_snapshots where chapter_id=$1", [chapter]))[0].n).toBe(visible);
        const [{ value }] = await as("authenticated", "select public.get_chapter_health_portfolio() value");
        const ids = (Array.isArray(value) ? value : value?.chapters ?? []).map((row) => row.chapterId);
        expect(ids.includes(pc)).toBe(false);
        if (visible) expect(ids).toContain(uc);
      }
      await db.query("update public.member_profiles set chapter_id=$1 where id=$2", [uc, user]);
    });
    await db.query("rollback to savepoint chapter_health_boundary");
    await db.query("release savepoint chapter_health_boundary");
  });

  it("excludes the platform organization from issue-intelligence digests and refuses platform digest reads", async () => {
    const flag = (org) => db.query(
      "insert into public.organization_setting_values(organization_id,setting_key,value) values($1,'features.intelligence.weekly_digest','true'::jsonb) on conflict (organization_id, setting_key) do update set value=excluded.value",
      [org],
    );
    await db.query("savepoint issue_digest_boundary");
    try {
      // The boundary trigger refuses platform setting rows; install the switch as a privileged write so the generator sees both flags on.
      await db.query("set local session_replication_role=replica");
      await flag(platform);
      await flag(union);
      await db.query("set local session_replication_role=origin");
      expect((await db.query("select count(*)::int n from public.organizations where id in ($1,$2) and status='active'", [platform, union])).rows[0].n).toBe(2);
      await db.query("select private.generate_issue_intelligence_weekly_digests('2026-10-26T13:30:00Z'::timestamptz, 200, true)");
      const visits = await db.query("select organization_id from private.issue_intelligence_digest_visits where organization_id in ($1,$2)", [platform, union]);
      expect(visits.rows.map((row) => row.organization_id)).toEqual([union]);
      expect((await db.query("select count(*)::int n from private.issue_intelligence_weekly_digests where organization_id=$1", [platform])).rows[0].n).toBe(0);
      // A retained platform digest, installed through a privileged write, stays unreadable; the union read is ordinary.
      await db.query("set local session_replication_role=replica");
      for (const org of [platform, union]) {
        await db.query(`insert into private.issue_intelligence_weekly_digests
          (organization_id,window_start,window_end,thread_family,confidence_label,trend,evidence,recommendations,ai_status)
          values($1,'2026-10-12','2026-10-18','contract_rights_confusion','low','stable','{}'::jsonb,'{}'::text[],'not_requested')`, [org]);
      }
      await db.query("set local session_replication_role=origin");
      await db.query("update public.member_profiles set chapter_id=$1 where id=$2", [pc, user]);
      await refuses("select public.get_issue_intelligence_weekly_digests('admin')", [], "authenticated");
      await db.query("update public.member_profiles set chapter_id=$1 where id=$2", [uc, user]);
      const read = (await as("authenticated", "select public.get_issue_intelligence_weekly_digests('admin') data"))[0].data;
      expect(read.enabled).toBe(true);
      expect(read.digests).toHaveLength(1);
    } finally {
      await db.query("rollback to savepoint issue_digest_boundary");
      await db.query("release savepoint issue_digest_boundary");
    }
  });

  it("keeps the platform member own-data export and memberships available", async () => {
    await exportFixture(async () => {
      await db.query("update public.member_profiles set chapter_id=$1 where id=$2", [pc, user]);
      const value = (await as("authenticated", "select public.get_member_data_export() value"))[0].value;
      expect(value.account.userId).toBe(user);
      expect(value.additionalDomains.organization_memberships).toEqual(expect.arrayContaining([
        expect.objectContaining({ organization_id: platform, user_id: user }),
        expect.objectContaining({ organization_id: union, user_id: user }),
      ]));
    });
  });

  it("advisor results follow immutable case ownership after member placement changes", async () => {
    await exportFixture(async () => {
      await seedExportData("case");
      await db.query("update public.member_profiles set chapter_id=$1 where id=$2", [uc, user]);
      await db.query("update public.member_cases set status='active', deadline=(now() at time zone 'America/New_York')::date-1 where user_id=$1", [user]);
      // The export fixture's NULL chapter grants global scope. Keep this
      // chapter proof independent of cases committed by earlier suites.
      await db.query("set local session_replication_role=replica");
      await db.query("update public.member_roles set chapter_id=$2 where user_id=$1 and role='admin'", [user, uc]);
      await db.query("set local session_replication_role=origin");
      const value = (await as("authenticated", "select public.get_advisor_overview() value"))[0].value;
      expect(value).toMatchObject({ openGrievances: 1, atRisk: { overdueCases: 1 } });
    });
  });

  it("collective action listing hides platform totals and retains personal participation", async () => {
    await exportFixture(async () => {
      const fixtures = await seedExportData("digital");
      for (const [org, chapter] of [[platform, pc], [union, uc]]) {
        await db.query("update public.member_profiles set chapter_id=$1 where id=$2", [chapter, user]);
        const value = (await as("authenticated", "select public.get_collective_actions('member',25,0) value"))[0].value;
        expect(value.actions).toEqual([expect.objectContaining({ id: fixtures.get(org).id, participantCount: org === union ? 1 : null, viewerParticipation: "signature" })]);
      }
    });
  });

  it.each(["get_staff_engagement_snapshot", "get_member_engagement_snapshot", "engagement_member_snapshot_scoped"])("%s hides platform poll results and preserves the union and personal fields", async name => {
    await exportFixture(async () => {
      await db.query("set local session_replication_role=replica");
      for (const [org, chapter] of [[platform, pc], [union, uc]]) {
        const poll = randomUUID(), option = randomUUID();
        await db.query("insert into public.organization_live_polls(id,organization_id,chapter_id,title,state,results_visibility,result_cache,vote_count,created_by) values($1,$2,$3,'Result proof','open','live','[{\"votes\":1}]',1,$4)", [poll, org, chapter, user]);
        await db.query("insert into public.organization_live_poll_options(id,organization_id,poll_id,label,sort_index) values($1,$2,$3,'Yes',0)", [option, org, poll]);
        await db.query("insert into public.organization_live_poll_attendance(organization_id,poll_id,user_id,eligible,rsvp) values($1,$2,$3,true,'yes')", [org, poll, user]);
        await db.query("insert into public.organization_live_poll_votes(organization_id,poll_id,option_id,voter_user_id) values($1,$2,$3,$4)", [org, poll, option, user]);
      }
      await db.query("set local session_replication_role=origin");
      for (const [org, chapter] of [[platform, pc], [union, uc]]) {
        await db.query("update public.member_profiles set chapter_id=$1 where id=$2", [chapter, user]);
        const schema = name === "engagement_member_snapshot_scoped" ? "private" : "public";
        const value = (await as(schema === "private" ? "postgres" : "authenticated", `select ${schema}.${name}() value`, [], claims))[0].value;
        expect(value.livePolls).toHaveLength(1);
        const poll = value.livePolls[0];
        expect(poll).toMatchObject({ title: "Result proof", voteCount: org === union ? 1 : null, results: org === union ? [{ votes: 1 }] : [] });
        if (name === "get_staff_engagement_snapshot") expect(poll.attendance).toEqual(org === union ? { roster: 1, rsvpYes: 1, checkedIn: 0 } : null);
        else expect(poll.attendance).toMatchObject({ eligible: true, rsvp: "yes" });
      }
    });
  });

  it.each(["get_staff_engagement_surveys", "staff_engagement_survey_page"])("%s hides platform survey response counts and preserves union results", async name => {
    await exportFixture(async () => {
      await seedExportData("survey");
      for (const [org, chapter] of [[platform, pc], [union, uc]]) {
        await db.query("update public.member_profiles set chapter_id=$1 where id=$2", [chapter, user]);
        const value = name === "get_staff_engagement_surveys"
          ? (await as("authenticated", "select public.get_staff_engagement_surveys(null,null,20) value"))[0].value
          : (await as("postgres", "select private.staff_engagement_survey_page($1,null,null,20) value", [org]))[0].value;
        expect(value.surveys).toHaveLength(1);
        expect(value.surveys[0].reviewLane.responseCount).toBe(org === union ? 25 : null);
        if (org === platform) expect(value.surveys[0]).toMatchObject({ coverage: null, reviews: [], reviewCounts: {} });
      }
    });
  });

  it("keeps platform-owned shared records out of a union coordination export", async () => {
    await exportFixture(async () => {
      const fixtures = await seedExportData("coordination");
      const hidden = randomUUID(), visible = randomUUID();
      await db.query("set local session_replication_role=replica");
      await db.query("insert into public.organization_coordination_records(id,organization_id,kind,title,status,idempotency_key,created_by) values($1,$2,'mission','Hidden platform record','active',$3,$4),($5,$6,'mission','Visible union record','active',$7,$4)", [hidden, platform, randomUUID(), user, visible, union, randomUUID()]);
      await db.query("insert into public.organization_coordination_organization_participants(record_id,organization_id,role,status) values($1,$2,'partner','active')", [hidden, union]);
      await db.query("update public.organization_coordination_records set config=config||'{\"dataset\":\"coordination_records\"}'::jsonb where id=$1", [fixtures.get(union).id]);
      await db.query("set local session_replication_role=origin");
      await db.query("update public.member_profiles set chapter_id=$1 where id=$2", [uc, user]);
      const dataset = (await as("postgres", "select private.organization_export_dataset($1,'coordination_records') value", [union]))[0].value;
      expect(JSON.stringify(dataset)).toContain("Visible union record");
      expect(JSON.stringify(dataset)).not.toContain("Hidden platform record");
      const run = (await as("authenticated", "select public.run_organization_coordination_export($1,'json',$2) value", [fixtures.get(union).id, randomUUID()]))[0].value;
      expect(run.rowCount).toBe(2);
      const payload = (await as("authenticated", "select public.get_organization_coordination_export_payload($1) value", [run.runId]))[0].value;
      expect(payload.content).toContain("Visible union record");
      expect(payload.content).not.toContain("Hidden platform record");
      const batch = (await as("service_role", "select public.run_due_organization_coordination_exports(now(),50) value"))[0].value;
      expect(batch.processed).toBe(1);
      const scheduled = (await db.query("select row_count from public.organization_coordination_export_runs where schedule_id=$1 and delivery_mode='email_unset'", [fixtures.get(union).id])).rows;
      expect(scheduled).toEqual([{ row_count: 2 }]);
    });
  });

  it("keeps verified cross-organization union bindings visible without exposing platform bindings", async () => {
    await db.query("savepoint cross_union_binding");
    try {
      await db.query("set local session_replication_role=replica");
      await db.query(`insert into public.chapter_union_org_bindings
        (chapter_id,union_org_id,status,requested_by,verified_by,verified_at)
        values($1,$2,'verified',$3,$3,now())`, [pc, `registry-${tag}`, user]);
      await db.query("set local session_replication_role=origin");
      expect(await as("authenticated", "select id from public.chapters where id=$1", [pc])).toEqual([]);
      const bindings = () => as("authenticated", "select chapter_id from public.chapter_union_org_bindings where chapter_id=$1", [pc]);
      expect(await bindings()).toEqual([]);
      await db.query("set local session_replication_role=replica");
      await db.query("update public.organizations set kind='union' where id=$1", [platform]);
      await db.query("set local session_replication_role=origin");
      expect(await bindings()).toEqual([{ chapter_id: pc }]);
    } finally {
      await db.query("rollback to savepoint cross_union_binding");
    }
  });

  // #6277 (#5813 round 10, finding 1): the binding boundary hides only
  // platform-owned chapters. An ownerless legacy chapter with a verified
  // binding to a visible registry identity stays a native handshake target,
  // read exactly as loadMobileHandshakeTargets reads it.
  it("keeps an ownerless legacy chapter in the native handshake targets and hides the platform chapter", async () => {
    await exportFixture(async () => {
      const legacy = `legacy-${tag}`, registry = `registry-legacy-${tag}`, platformRegistry = `registry-platform-${tag}`;
      await db.query("set local session_replication_role=replica");
      await db.query("insert into public.chapters(id,slug,name,organization_id,order_index) values($1,$1,$1,null,3)", [legacy]);
      await db.query(`insert into public.union_orgs(id,name,atlas_manifest_sha,state,level,olms_file_number,enrichment_status)
        values($1,'Legacy Local','source','MA','local',$3,'no_web_presence'),($2,'Platform Local','source','MA','local',$3 + 1,'no_web_presence')`,
      [registry, platformRegistry, 900000 + Number.parseInt(tag.slice(0, 4), 16)]);
      await db.query(`insert into public.chapter_union_org_bindings(chapter_id,union_org_id,status,requested_by,verified_by,verified_at)
        values($1,$2,'verified',$5,$5,now()),($3,$4,'verified',$5,$5,now())`, [legacy, registry, pc, platformRegistry, user]);
      await db.query("set local session_replication_role=origin");
      await selectChapter(uc);
      const targets = () => as("authenticated", `select b.chapter_id, u.id union_org_id from public.chapter_union_org_bindings b
        join public.union_orgs u on u.id = b.union_org_id where b.status = 'verified' and b.chapter_id = any($1) order by 1`, [[legacy, pc]]);
      expect(await targets()).toEqual([{ chapter_id: legacy, union_org_id: registry }]);
      // The same platform chapter becomes visible once its owner is a union.
      await db.query("set local session_replication_role=replica");
      await db.query("update public.organizations set kind='union' where id=$1", [platform]);
      await db.query("set local session_replication_role=origin");
      expect(await targets()).toEqual([{ chapter_id: legacy, union_org_id: registry }, { chapter_id: pc, union_org_id: platformRegistry }]);
    });
  });

  // #6277 (#5813 round 10, finding 2): per-article grievance counts are
  // platform results; the refusal comes before any aggregation.
  it("refuses platform clause grievance counts before aggregation and keeps the union counts", async () => {
    await exportFixture(async () => {
      await db.query("set local session_replication_role=replica");
      for (const [org, chapter] of [[platform, pc], [union, uc]]) {
        await db.query("insert into public.contract_clauses(organization_id,article,category,title,summary,status) values($1,'12','Proof','Proof clause','Proof clause summary','published')", [org]);
        for (let i = 0; i < 2; i += 1) {
          await db.query("insert into public.member_cases(id,organization_id,chapter_id,user_id,reference,title,case_type,articles) values($1,$2,$3,$4,$5,'Clause case','grievance','12')",
            [randomUUID(), org, chapter, user, `CLS-${chapter}-${i}`]);
        }
      }
      await db.query("set local session_replication_role=origin");
      const counts = "select public.list_contract_clause_grievance_counts() value";
      await selectChapter(pc);
      await refuses(counts, [], "authenticated");
      await selectChapter(uc);
      const [{ value }] = await as("authenticated", counts);
      expect(value).toEqual([{ article: "12", count: 2 }]);
    });
  });

  it("allows real author deletion to detach retained platform content but rejects direct edits", async () => {
    const author = randomUUID();
    await db.query("savepoint platform_author");
    try {
      await db.query("set local session_replication_role=replica");
      await db.query("insert into auth.users(id,email) values($1,$2)", [author, `${author}@platform-proof.invalid`]);
      await db.query(`insert into public.public_chapter_sections
        (organization_id,chapter_code,slug,title_en,title_es,body_en,body_es,is_published,published_at,created_by)
        values($1,$2,'retained-author','Proof','Prueba','Proof','Prueba',true,now(),$3)`, [platform, pc, author]);
      await db.query("update public.public_site_records set created_by=$1 where id=$2", [author, pc]);
      await db.query("update public.organization_network_directory_profiles set updated_by=$1 where organization_id=$2", [author, platform]);
      await db.query("set local session_replication_role=origin");
      await refuses("update public.public_chapter_sections set created_by=null where organization_id=$1 and slug='retained-author'", [platform]);
      await refuses("update public.public_site_records set created_by=null where id=$1", [pc]);
      await refuses("update public.organization_network_directory_profiles set updated_by=null where organization_id=$1", [platform]);
      await db.query("delete from auth.users where id=$1", [author]);
      expect((await db.query("select created_by,body_en,is_published from public.public_chapter_sections where organization_id=$1 and slug='retained-author'", [platform])).rows)
        .toEqual([{ created_by: null, body_en: "Proof", is_published: true }]);
      expect((await db.query("select created_by,body_en,is_published from public.public_site_records where id=$1", [pc])).rows)
        .toEqual([{ created_by: null, body_en: "Proof", is_published: true }]);
      expect((await db.query("select updated_by,display_name,visibility from public.organization_network_directory_profiles where organization_id=$1", [platform])).rows)
        .toEqual([{ updated_by: null, display_name: "Proof", visibility: "directory" }]);
      await refuses("update public.public_chapter_sections set body_en='Changed' where organization_id=$1 and slug='retained-author'", [platform]);
      await refuses("update public.public_site_records set body_en='Changed' where id=$1", [pc]);
      await refuses("update public.organization_network_directory_profiles set display_name='Changed' where organization_id=$1", [platform]);
    } finally {
      await db.query("rollback to savepoint platform_author");
    }
  });

  it("retains the platform's own authorized Compass content", async () => {
    await db.query("update public.member_profiles set chapter_id=$1 where id=$2", [pc, user]);
    const results = await as("authenticated", "select * from public.search_member_kb('platform proof',4)");
    expect(results.map((row) => row.source_id)).toContain(`kb:article-${pc}`);
    await db.query("update public.member_profiles set chapter_id=$1 where id=$2", [uc, user]);
  });

  it("preserves membership isolation instead of exposing the platform to unrelated members", async () => {
    const outsider = randomUUID();
    const outsiderClaims = JSON.stringify({ sub: outsider, role: "authenticated", aal: "aal2" });
    expect(await as("authenticated", "select id from public.organizations where id=$1", [platform], outsiderClaims)).toEqual([]);
    // A dual membership alone does not widen the currently selected tenant.
    expect(await as("authenticated", "select id from public.organizations where id=$1", [platform])).toEqual([]);
    await db.query("update public.member_profiles set chapter_id=$1 where id=$2", [pc, user]);
    expect((await as("authenticated", "select id from public.organizations where id=$1", [platform]))[0].id).toBe(platform);
  });
});
