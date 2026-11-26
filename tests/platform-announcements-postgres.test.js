// @vitest-environment node
import { beforeAll, beforeEach, afterAll, describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { offlinePostgres } from "./tamarack-postgres-helper.mjs";
import { loadMigrationSql, fnBody } from "./helpers/migration.js";
import { createAnnouncementApi } from "../src/features/platformAnnouncements/api.js";

const migration = loadMigrationSql("20261029141540_");
const scope = loadMigrationSql("20260822010000_");
const boundary = loadMigrationSql("20261028080000_");
const platform = "10000000-0000-4000-8000-000000000000";
const a = "20000000-0000-4000-8000-000000000000";
const b = "30000000-0000-4000-8000-000000000000";
const c = "40000000-0000-4000-8000-000000000000";
const publisher = "50000000-0000-4000-8000-000000000000";
const admin = "60000000-0000-4000-8000-000000000000";
const member = "70000000-0000-4000-8000-000000000000";
const tables = ["platform_announcement_publishers", "platform_organization_follows", "platform_announcements",
  "platform_announcement_delivery_jobs", "organization_platform_announcements", "platform_announcement_preferences", "platform_announcement_audit"];

describe("private opt-in platform announcements, real PostgreSQL", () => {
  let database, db;
  beforeAll(async () => {
    database = await offlinePostgres({ durable: false }); db = database.client;
    // Existing identity/MFA helpers are controlled inputs. The tenant resolver,
    // organization-role predicate, current boundary dispatch and the entire new
    // migration are real, unmodified declarations. No hosted fixture or URL.
    await db.query(`create schema auth; create schema private; create schema extensions;
      create extension pgcrypto with schema extensions;
      create role anon; create role authenticated; create role service_role;
      grant usage on schema public,private,auth to anon,authenticated,service_role;
      create table auth.users(id uuid primary key,deleted_at timestamptz,banned_until timestamptz);
      create table auth.sessions(id uuid primary key,user_id uuid references auth.users(id) on delete cascade,aal text,created_at timestamptz default now(),not_after timestamptz);
      create table private.member_mfa_reset_boundaries(user_id uuid,invalid_before timestamptz);
      create table private.member_mfa_recovery_locks(user_id uuid);
      create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('proof.user',true),'')::uuid $$;
      create function private.mfa_satisfied() returns boolean language sql stable as $$ select current_setting('proof.mfa',true)='true' $$;
      create function private.staff_mfa_required(uuid) returns boolean language sql stable as $$ select false $$;
      create function private.has_second_factor(uuid) returns boolean language sql stable as $$ select coalesce(current_setting('proof.factor',true),'true')<>'false' $$;
      create function private.verified_key_session(uuid,uuid) returns boolean language sql stable as $$ select false $$;
      create function auth.jwt() returns jsonb language sql stable as $$ select jsonb_build_object('aal',coalesce(nullif(current_setting('proof.aal',true),''),'aal2'),'session_id','90000000-0000-4000-8000-000000000000') $$;
      create table public.organizations(id uuid primary key,kind text,status text default 'active',name text default 'Fictional organization',verified boolean default true);
      create unique index one_platform on public.organizations(kind) where kind='platform';
      create table public.chapters(id text primary key,organization_id uuid references public.organizations(id));
      create table public.member_profiles(id uuid primary key,chapter_id text);
      create table public.organization_memberships(organization_id uuid,user_id uuid,status text default 'active',revoked_at timestamptz);
      create table public.organization_role_grants(organization_id uuid,user_id uuid,role text);
      create table public.member_chapter_memberships(chapter_id text,user_id uuid,status text default 'active');
      create function private.current_member_chapter() returns text language sql stable security definer as $$ select chapter_id from public.member_profiles where id=auth.uid() $$;
      create function private.organization_clears_signup_boundary(p uuid) returns boolean language sql stable security definer as $$ select exists(select 1 from public.organizations where id=p and kind='union' and verified) $$;
      create function private.lock_case_graph(uuid[],uuid[]) returns void language sql as $$ select pg_advisory_xact_lock(509,700) $$;
      create function private.lock_case_graph_statement() returns trigger language plpgsql as $$ begin perform private.lock_case_graph(array[]::uuid[],array[]::uuid[]);return null;end; $$;
      create function private.lock_case_graph_row_keys() returns trigger language plpgsql as $$ begin if tg_op='DELETE' then return old;end if;return new;end; $$;
      create table private.account_lifecycle_manifest(schema_name text,table_name text,user_column text,delete_disposition text,export_disposition text,export_inventory_basis text,exclusion_reason text,note text,primary key(schema_name,table_name,user_column));
      create table private.account_lifecycle_trigger_review(kind text,schema_name text,table_name text,object_name text,definition_hash text,primary key(kind,schema_name,table_name,object_name));
      create function private.account_lifecycle_trigger_surface() returns table(kind text,schema_name text,table_name text,object_name text,definition_hash text)
      language sql as $$ select 'trigger',n.nspname::text,c.relname::text,t.tgname::text,md5(pg_get_triggerdef(t.oid)) from pg_trigger t join pg_class c on c.oid=t.tgrelid join pg_namespace n on n.oid=c.relnamespace where not t.tgisinternal
      union all select 'function',n.nspname::text,''::text,p.proname||'()',md5(pg_get_functiondef(p.oid)) from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='private' and p.prokind='f' $$;
    `);
    await db.query(fnBody(scope, "private.current_member_organization"));
    await db.query(fnBody(loadMigrationSql("20260902050000_"), "private.current_mobile_staff_organization"));
    await db.query(fnBody(loadMigrationSql("20260903040000_"), "private.has_organization_role"));
    await db.query(fnBody(boundary, "private.enforce_unverified_organization_boundary"));
    await db.query(migration);
    await db.query(fnBody(loadMigrationSql("20261029230836_"), "private.legal_acceptance_versions"));
    await db.query(loadMigrationSql("20261029235622_"));
    // Privacy 1.3.2 re-pins the validator the contract now describes.
    await db.query(fnBody(loadMigrationSql("20261102001534_"), "private.legal_acceptance_versions"));
    // The first legal release (privacy 1.4.0, OPS-UG-FIRST-LEGAL-RELEASE-FOLDS-SIX-PENDING-DECLARATIONS-20261112)
    // re-pins the validator again; the contract describes that body.
    await db.query(fnBody(loadMigrationSql("20261113125500_"), "private.legal_acceptance_versions"));
    // The learning period journals the preference writer (20261105182000).
    // Its journal helpers are controlled inputs here: no period runs, so
    // nothing is journalled; the writer itself is the real re-emitted one.
    await db.query(`create function private.learning_preference_state(text,text) returns jsonb language sql stable as $$ select '{"present": false}'::jsonb $$;
      create function private.learning_preference_journal(text,text,text,jsonb) returns uuid language sql as $$ select null::uuid $$;`);
    await db.query(fnBody(loadMigrationSql("20261105182000_"), "public.set_my_platform_announcement_preference"));
    // 20261106220000 re-declares the stale-revision refusals on PT409, because
    // PostgREST 14 retries 40001 without limit.
    const conflicts = loadMigrationSql("20261106220000_");
    for (const name of ["public.save_platform_announcement_draft", "public.review_platform_announcement", "public.publish_platform_announcement",
      "public.withdraw_platform_announcement", "public.set_platform_announcement_follow"]) await db.query(fnBody(conflicts, name));
  }, 120_000);
  afterAll(async () => { await database?.close(); });
  beforeEach(async () => {
    await db.query(`rollback; begin;
      truncate private.platform_announcement_audit,private.platform_announcement_preferences,private.organization_platform_announcements,
      private.platform_announcement_delivery_jobs,private.platform_announcements,private.platform_organization_follows,
      private.platform_announcement_publishers,public.member_profiles,public.member_chapter_memberships,public.organization_role_grants,
      public.organization_memberships,public.chapters,public.organizations,auth.users cascade;
      insert into auth.users(id) values('${publisher}'),('${admin}'),('${member}');
      insert into auth.sessions(id,user_id,aal) values('90000000-0000-4000-8000-000000000000','${publisher}','aal2');
      insert into public.organizations(id,kind) values('${platform}','platform'),('${a}','union'),('${b}','union'),('${c}','union');
      insert into public.chapters values('platform','${platform}'),('a','${a}'),('b','${b}'),('c','${c}');
      insert into public.member_profiles values('${publisher}','platform'),('${admin}','a'),('${member}','a');
      insert into public.organization_memberships(organization_id,user_id) values('${platform}','${publisher}'),('${a}','${publisher}'),('${a}','${admin}'),('${b}','${admin}'),('${c}','${admin}'),('${a}','${member}'),('${b}','${member}');
      insert into public.member_chapter_memberships(chapter_id,user_id) values('platform','${publisher}'),('a','${publisher}'),('a','${admin}'),('b','${admin}'),('c','${admin}'),('a','${member}'),('b','${member}');
      insert into public.organization_role_grants values('${a}','${admin}','admin'),('${b}','${admin}','admin'),('${c}','${admin}','admin');
      insert into private.platform_announcement_publishers values('${platform}','${publisher}',null);
      select set_config('proof.mfa','true',true);
    `);
  }, 30_000);
  async function as(user, chapter, sql, values = [], { role = "authenticated", mfa = true, aal = "aal2", factor = true } = {}) {
    await db.query("savepoint probe");
    try {
      if (chapter) await db.query("update public.member_profiles set chapter_id=$1 where id=$2", [chapter,user]);
      await db.query("select set_config('proof.user',$1,true),set_config('proof.mfa',$2,true),set_config('proof.aal',$3,true),set_config('proof.factor',$4,true)", [user ?? "",String(mfa),aal,String(factor)]);
      await db.query(`set local role ${role}`);
      const rows = (await db.query(sql, values)).rows;
      await db.query("reset role;release savepoint probe"); return rows;
    } catch (e) { await db.query("rollback to savepoint probe;release savepoint probe"); throw e; }
  }
  const follow = (chapter = "a", enabled = true, generation = 0) => as(admin,chapter,"select public.set_platform_announcement_follow($1,$2,'platform-updates-v1') result",[enabled,generation]);
  async function publish() {
    const result = (await as(publisher,"platform",`select public.save_platform_announcement_draft(null,0,'Update','Aviso','Public product update','Aviso del producto',now()+interval '1 day') result`))[0].result;
    await as(publisher,"platform","select public.review_platform_announcement($1,1)",[result.id]);
    await as(publisher,"platform","select public.publish_platform_announcement($1,1)",[result.id]);
    return result.id;
  }
  const dispatch = () => as(null,null,"select public.dispatch_platform_announcements(100) result",[],{role:"service_role"});
  const feed = (user = member, chapter = "a", locale = "en") => as(user,chapter,"select public.list_my_platform_announcements($1) result",[locale]);
  const consumer = (user, selectedChapter, organizationId = a) => createAnnouncementApi({ rpc: async (name, args) => {
    expect(name).toBe("platform_announcement_request");
    try { return { data: (await as(user,selectedChapter(),"select public.platform_announcement_request($1,$2,$3::jsonb) result",[args.p_organization_id,args.p_action,JSON.stringify(args.p_args)]))[0].result, error: null }; }
    catch (error) { return { data: null, error: { code: error.code } }; }
  } }, organizationId);

  it("drives the shared web/native consumer through actual consent, mute, revoke and withdrawal", async () => {
    const adminApi = consumer(admin, () => "a");
    const memberApi = consumer(member, () => "a");
    expect((await adminApi.settings()).enabled).toBe(false);
    await adminApi.follow(true,0);
    const id = await publish(); await dispatch();
    expect((await memberApi.feed("en")).items[0]).toMatchObject({ title: "Update", sourceType: "platform-announcement" });
    expect((await memberApi.feed("es")).items[0].title).toBe("Aviso");
    await memberApi.preference(true); expect((await memberApi.feed()).hidden).toBe(true);
    await memberApi.preference(false); expect((await memberApi.feed()).items).toHaveLength(1);
    await as(publisher,"platform","select public.withdraw_platform_announcement($1,1)",[id]);
    expect((await memberApi.feed()).items).toEqual([]);
    await publish(); await dispatch(); await adminApi.follow(false,1);
    expect((await memberApi.feed()).items).toEqual([]);
    await expect(adminApi.follow(true,1)).rejects.toThrow("Platform updates unavailable");
    await adminApi.follow(true,2); expect((await memberApi.feed()).items).toEqual([]);
  });
  it("denies delayed consumer reads and writes after the server-selected workspace changes", async () => {
    let chapter = "a";
    const api = consumer(admin, () => chapter);
    await api.follow(true,0); chapter = "b";
    await expect(api.follow(true,0)).rejects.toMatchObject({denied:true});
    await expect(api.feed()).rejects.toMatchObject({denied:true});
    expect((await db.query("select organization_id from private.platform_organization_follows")).rows).toEqual([{organization_id:a}]);
  });
  it("keeps the consumer's containment revoke and personal hiding available after suspension", async () => {
    await follow(); await publish(); await dispatch();
    await db.query("update public.organizations set status='suspended' where id=$1",[a]);
    expect(await consumer(member,()=>"a").preference(true)).toEqual({hidden:true});
    expect((await consumer(admin,()=>"a").follow(false,1)).enabled).toBe(false);
    await expect(consumer(member,()=>"a").feed()).rejects.toMatchObject({denied:true});
  });

  it("allows a chapterless single-organization administrator to inspect, follow and revoke", async () => {
    await db.query(`update public.member_profiles set chapter_id=null where id='${admin}';delete from public.member_chapter_memberships where user_id='${admin}';delete from public.organization_memberships where user_id='${admin}' and organization_id<>'${a}'`);
    expect((await as(admin,null,"select public.get_platform_announcement_follow_settings() result"))[0].result).toMatchObject({enabled:false,generation:0});
    expect((await as(admin,null,"select public.set_platform_announcement_follow(true,0,'platform-updates-v1') result"))[0].result).toMatchObject({enabled:true,generation:1});
    await db.query("update public.organizations set status='suspended',verified=false where id=$1",[a]);
    expect((await as(admin,null,"select public.set_platform_announcement_follow(false,1,'platform-updates-v1') result"))[0].result).toMatchObject({enabled:false,generation:2});
    await expect(as(admin,null,"select public.get_platform_announcement_follow_settings()",[],{mfa:false})).rejects.toMatchObject({code:"42501"});
    await db.query("update public.organization_memberships set revoked_at=now() where user_id=$1",[admin]);
    await expect(as(admin,null,"select public.get_platform_announcement_follow_settings()")).rejects.toMatchObject({code:"42501"});
  });
  it("denies ambiguous chapterless organization selection and preserves selected-chapter precedence", async () => {
    await db.query("update public.member_profiles set chapter_id=null where id=$1",[admin]);
    await expect(as(admin,null,"select public.get_platform_announcement_follow_settings()")).rejects.toMatchObject({code:"42501"});
    await expect(as(admin,null,"select public.set_platform_announcement_follow(true,0,'platform-updates-v1')")).rejects.toMatchObject({code:"42501"});
    await as(admin,"b","select public.set_platform_announcement_follow(true,0,'platform-updates-v1')");
    expect((await db.query("select organization_id from private.platform_organization_follows")).rows).toEqual([{organization_id:b}]);
  });
  it("does not turn chapterless membership into an administrator grant", async () => {
    await db.query(`update public.member_profiles set chapter_id=null where id='${member}';delete from public.member_chapter_memberships where user_id='${member}';delete from public.organization_memberships where user_id='${member}' and organization_id<>'${a}'`);
    await expect(as(member,null,"select public.get_platform_announcement_follow_settings()")).rejects.toMatchObject({code:"42501"});
    await expect(as(member,null,"select public.set_platform_announcement_follow(true,0,'platform-updates-v1')")).rejects.toMatchObject({code:"42501"});
  });

  it("invalidates delayed enable requests when an administrator revokes consent", async () => {
    await follow();
    const revoked = (await follow("a", false, 1))[0].result;
    await expect(follow("a", true, 1)).rejects.toMatchObject({ code: "PT409" });
    expect((await follow("a", true, revoked.generation))[0].result.enabled).toBe(true);
  });
  it("revalidates a reviewed correction's predecessor at publication", async () => {
    const old = await publish();
    const corrections = [];
    for (let index = 0; index < 2; index += 1) {
      const next = (await as(publisher,"platform",`select public.save_platform_announcement_draft(null,0,'Correction','Cambio','New body','Texto nuevo',now()+interval '1 day',$1) result`,[old]))[0].result.id;
      await as(publisher,"platform","select public.review_platform_announcement($1,1)",[next]);
      corrections.push(next);
    }
    await as(publisher,"platform","select public.publish_platform_announcement($1,1)",[corrections[0]]);
    await expect(as(publisher,"platform","select public.publish_platform_announcement($1,1)",[corrections[1]])).rejects.toMatchObject({code:"PT409"});
    expect((await db.query("select state from private.platform_announcements where id=$1",[corrections[1]])).rows[0].state).toBe("reviewed");
  });
  it("bounds raw stored titles and bodies as well as trimmed nonempty content", async () => {
    for (const [title,body] of [[" ".repeat(120)+"Update","Body"],["Update"," ".repeat(4000)+"Body"]]) {
      await expect(as(publisher,"platform",`select public.save_platform_announcement_draft(null,0,$1,$1,$2,$2,now()+interval '1 day')`,[title,body])).rejects.toMatchObject({code:"23514"});
    }
  });
  it("starts without follows and never discloses the platform ID before consent", async () => {
    const result = (await as(admin,"a","select public.get_platform_announcement_follow_settings() result"))[0].result;
    expect(result).toMatchObject({enabled:false,generation:0,platformOrganizationId:null});
    expect((await feed())[0].result.items).toEqual([]);
  });
  it("admits only a selected organization admin with live membership and MFA", async () => {
    for (const [user,chapter,options] of [[member,"a",{}],[publisher,"a",{}],[admin,"a",{mfa:false}],[null,null,{role:"anon"}]]) {
      await expect(as(user,chapter,"select public.set_platform_announcement_follow(true,0,'platform-updates-v1')",[],options)).rejects.toMatchObject({code:"42501"});
    }
    await db.query("update public.organization_role_grants set role='vp' where user_id=$1",[admin]);
    await expect(follow()).rejects.toMatchObject({code:"42501"});
  });
  it("requires the approved notice and serializes expected generations; retries are idempotent", async () => {
    await expect(as(admin,"a","select public.set_platform_announcement_follow(true,0,'invented')")).rejects.toMatchObject({code:"22023"});
    expect((await follow())[0].result).toMatchObject({enabled:true,generation:1,platformOrganizationId:platform});
    await expect(follow()).rejects.toMatchObject({code:"PT409"});
    await follow("a",true,1);
    expect((await db.query("select count(*)::int n from private.platform_announcement_audit where action='follow'")).rows[0].n).toBe(1);
  });
  it("serializes two concurrent consent requests with one winner", async () => {
    await db.query("commit");
    const clients=[0,1].map(()=>new db.constructor({host:db.connectionParameters.host,port:db.connectionParameters.port,user:"postgres",database:"postgres",statement_timeout:3000}));
    try {
      for(const client of clients) {
        await client.connect();await client.query("begin");
        await client.query("select set_config('proof.user',$1,true),set_config('proof.mfa','true',true)",[admin]);
        await client.query("set local role authenticated");
      }
      await clients[0].query("select public.set_platform_announcement_follow(true,0,'platform-updates-v1')");
      const second=clients[1].query("select public.set_platform_announcement_follow(true,0,'platform-updates-v1')").then(()=>null,error=>error);
      await clients[0].query("commit");
      expect(await second).toMatchObject({code:"PT409"});
      expect((await db.query("select count(*)::int n from private.platform_organization_follows")).rows[0].n).toBe(1);
    } finally { for(const client of clients){await client.query("rollback");await client.end();} }
  });
  it("requires a dedicated publisher grant as well as MFA and platform membership", async () => {
    await db.query("update private.platform_announcement_publishers set revoked_at=now()");
    await expect(publish()).rejects.toMatchObject({code:"42501"});
    await db.query("update private.platform_announcement_publishers set revoked_at=null");
    await expect(as(publisher,"platform","select public.get_platform_announcement_publisher_workspace()",[],{mfa:false})).rejects.toMatchObject({code:"42501"});
    await expect(as(publisher,"a","select public.get_platform_announcement_publisher_workspace()")).rejects.toMatchObject({code:"42501"});
  });
  it("refuses AAL1, missing factors and revoked/expired/banned publisher sessions", async () => {
    for(const options of [{aal:"aal1"},{factor:false}]) await expect(as(publisher,"platform","select public.get_platform_announcement_publisher_workspace()",[],options)).rejects.toMatchObject({code:"42501"});
    await db.query("update auth.sessions set not_after=now()-interval '1 second'");
    await expect(publish()).rejects.toMatchObject({code:"42501"});
    await db.query("update auth.sessions set not_after=null;update auth.users set banned_until=now()+interval '1 day'");
    await expect(publish()).rejects.toMatchObject({code:"42501"});
    await db.query("update auth.users set banned_until=null;delete from auth.sessions");
    await expect(publish()).rejects.toMatchObject({code:"42501"});
  });
  it("requires review, records one MFA publisher's actions, and refuses stale revisions", async () => {
    const result=(await as(publisher,"platform",`select public.save_platform_announcement_draft(null,0,'One','Uno','Body','Texto',now()+interval '1 day') result`))[0].result;
    await expect(as(publisher,"platform","select public.publish_platform_announcement($1,1)",[result.id])).rejects.toMatchObject({code:"PT409"});
    await as(publisher,"platform","select public.review_platform_announcement($1,1)",[result.id]);
    await as(publisher,"platform","select public.publish_platform_announcement($1,1)",[result.id]);
    await expect(as(publisher,"platform","select public.review_platform_announcement($1,2)",[result.id])).rejects.toMatchObject({code:"PT409"});
    expect((await db.query("select action from private.platform_announcement_audit order by id")).rows.map(x=>x.action)).toEqual(["draft","review","publish"]);
  });
  it("delivers one organization copy only to prior consenting followers, never to a later follow", async () => {
    await follow(); await follow("b"); const id=await publish(); await follow("c"); await dispatch(); await dispatch();
    expect((await db.query("select count(*)::int n from private.organization_platform_announcements")).rows[0].n).toBe(2);
    expect((await feed())[0].result.items[0]).toMatchObject({announcementId:id,title:"Update"});
    expect((await feed(member,"b","es"))[0].result.items[0].title).toBe("Aviso");
    expect((await feed(admin,"c"))[0].result.items).toEqual([]);
  });
  it("revocation immediately hides copies; refollow never revives an old generation", async () => {
    await follow(); await publish(); await dispatch(); await follow("a",false,1);
    expect((await feed())[0].result.items).toEqual([]);
    await follow("a",true,2); expect((await feed())[0].result.items).toEqual([]);
    await publish(); await dispatch(); expect((await feed())[0].result.items).toHaveLength(1);
  });
  it("a queued job rechecks revocation and cannot deliver a revoked generation", async () => {
    await follow(); await publish(); await follow("a",false,1); await dispatch();
    expect((await db.query("select count(*)::int n from private.organization_platform_announcements")).rows[0].n).toBe(0);
  });
  it("a retried worker cannot duplicate organization copies or overstate inserted rows", async () => {
    await follow();await publish();await dispatch();
    await db.query("update private.platform_announcement_delivery_jobs set state='pending',cursor_organization_id=null");
    expect((await dispatch())[0].result.delivered).toBe(0);
    expect((await db.query("select count(*)::int n from private.organization_platform_announcements")).rows[0].n).toBe(1);
  });
  it("stops a failing job after five tries and exposes terminal failure only to the worker", async () => {
    await follow(); await publish();
    await db.query(`create function pg_temp.fail_announcement_copy() returns trigger language plpgsql as $$ begin raise exception 'injected failure';end $$;
      create trigger test_copy_failure before insert on private.organization_platform_announcements for each row execute function pg_temp.fail_announcement_copy()`);
    for (let attempt=1;attempt<=5;attempt+=1) expect((await dispatch())[0].result.state).toBe(attempt===5?"failed":"retry");
    expect((await dispatch())[0].result.state).toBe("idle");
    expect((await db.query("select state,failures from private.platform_announcement_delivery_jobs")).rows).toEqual([{state:"failed",failures:5}]);
    expect((await feed())[0].result.items).toEqual([]);
    await expect(as(member,"a","select public.platform_announcement_request($1,'dispatch_platform_announcements','{}')",[a])).rejects.toMatchObject({code:"42501"});
  });
  it("expires previously delivered content at the next transaction", async () => {
    await follow();
    const id=(await as(publisher,"platform",`select public.save_platform_announcement_draft(null,0,'Short','Breve','Body','Texto',clock_timestamp()+interval '2 seconds') result`))[0].result.id;
    await as(publisher,"platform","select public.review_platform_announcement($1,1)",[id]);
    await as(publisher,"platform","select public.publish_platform_announcement($1,1)",[id]);
    await dispatch();await db.query("commit");await db.query("select pg_sleep(2.1)");await db.query("begin");
    expect((await feed())[0].result.items).toEqual([]);
  });
  it("a reviewed correction withdraws its predecessor instead of editing a delivered body", async () => {
    await follow();const old=await publish();await dispatch();
    const next=(await as(publisher,"platform",`select public.save_platform_announcement_draft(null,0,'Correction','Cambio','New body','Texto nuevo',now()+interval '1 day',$1) result`,[old]))[0].result.id;
    await as(publisher,"platform","select public.review_platform_announcement($1,1)",[next]);
    await as(publisher,"platform","select public.publish_platform_announcement($1,1)",[next]);
    expect((await feed())[0].result.items).toEqual([]);
    await dispatch();expect((await feed())[0].result.items.map(x=>x.announcementId)).toEqual([next]);
    expect((await db.query("select body_en,state from private.platform_announcements where id=$1",[old])).rows[0]).toMatchObject({body_en:"Public product update",state:"withdrawn"});
  });
  it("withdrawal, expiry and membership loss each deny the next feed read", async () => {
    await follow(); const id=await publish(); await dispatch();
    await as(publisher,"platform","select public.withdraw_platform_announcement($1,1)",[id]);
    expect((await feed())[0].result.items).toEqual([]);
    await publish(); await dispatch(); await db.query("update public.organization_memberships set status='revoked',revoked_at=now() where user_id=$1 and organization_id=$2",[member,a]);
    await expect(feed()).rejects.toMatchObject({code:"42501"});
  });
  it("own mute survives organization refollow and is unreadable to its administrator or publisher", async () => {
    await follow(); await as(member,"a","select public.set_my_platform_announcement_preference(true)");
    await follow("a",false,1); await follow("a",true,2); await publish(); await dispatch();
    expect((await feed())[0].result).toMatchObject({items:[],hidden:true});
    expect((await feed(admin))[0].result.items).toHaveLength(1);
    await as(member,"a","select public.set_my_platform_announcement_preference(false)");
    expect((await feed())[0].result.items).toHaveLength(1);
    await expect(as(admin,"a","select * from private.platform_announcement_preferences")).rejects.toMatchObject({code:"42501"});
  });
  it("permits revoke and withdrawal as containment after verification is lost", async () => {
    await follow(); const id=await publish(); await dispatch();
    await db.query("update public.organizations set verified=false where id=$1",[a]);
    await expect(follow("a",true,1)).rejects.toMatchObject({code:"42501"});
    await follow("a",false,1);
    await db.query("update public.organizations set status='suspended' where id=$1",[platform]);
    await as(publisher,"platform","select public.withdraw_platform_announcement($1,1)",[id]);
  });
  it("allows a still-authorized administrator to revoke consent after organization suspension", async () => {
    await follow();await db.query("update public.organizations set status='suspended' where id=$1",[a]);
    expect((await follow("a",false,1))[0].result.enabled).toBe(false);
  });
  it("publishing context exposes only organization follow status and its own audit", async () => {
    await follow(); await publish(); await dispatch();
    const status=(await as(publisher,"platform","select public.list_platform_follow_status() result"))[0].result.items[0];
    expect(Object.keys(status).sort()).toEqual(["name","organizationId","status"]);
    const workspace=(await as(publisher,"platform","select public.get_platform_announcement_publisher_workspace() result"))[0].result;
    expect(workspace.audit.every(x=>!["follow","revoke"].includes(x.action))).toBe(true);
    expect(JSON.stringify(workspace)).not.toContain(admin);
    await expect(as(publisher,"platform","select public.list_my_platform_announcements('en')")).rejects.toMatchObject({code:"42501"});
  });
  it("paginates all publisher posts and audit so an older live post remains withdrawable", async () => {
    await db.query(`insert into private.platform_announcements(id,organization_id,title_en,title_es,body_en,body_es,state,reviewed_at,published_at,expires_at)
      select ('a0000000-0000-4000-8000-'||lpad(i::text,12,'0'))::uuid,$1,'Update','Aviso','Body','Texto','published',now()-interval '1 day',now()-i*interval '1 minute',now()+interval '1 day' from generate_series(1,51) i`,[platform]);
    await db.query(`insert into private.platform_announcement_audit(organization_id,actor_user_id,action,announcement_id,revision,publisher_assurance)
      select organization_id,$1,'publish',id,revision,'aal2' from private.platform_announcements`,[publisher]);
    const first=(await as(publisher,"platform","select public.get_platform_announcement_publisher_workspace(50) result"))[0].result;
    expect(first.posts).toHaveLength(50);expect(first.audit).toHaveLength(50);
    expect(first).toMatchObject({hasMorePosts:true,hasMoreAudit:true});
    const second=(await as(publisher,"platform","select public.get_platform_announcement_publisher_workspace(50,$1,$2) result",[first.nextPostId,first.nextAuditBefore]))[0].result;
    expect(second.posts).toHaveLength(1);expect(second.audit).toHaveLength(1);
    expect(second).toMatchObject({hasMorePosts:false,hasMoreAudit:false,nextPostId:null,nextAuditBefore:null});
    await as(publisher,"platform","select public.withdraw_platform_announcement($1,1)",[second.posts[0].id]);
    expect((await db.query("select state from private.platform_announcements where id=$1",[second.posts[0].id])).rows[0].state).toBe("withdrawn");
  });
  it("rejects forged source snapshots, cross-organization IDs and published edits", async () => {
    await follow(); const id=await publish(); await dispatch();
    await expect(as(admin,"b","select public.hide_organization_platform_announcement($1)",[(await db.query("select id from private.organization_platform_announcements")).rows[0].id])).rejects.toMatchObject({code:"42501"});
    await expect(as(publisher,"platform",`select public.save_platform_announcement_draft($1,1,'Altered','Otro','Body','Texto',now()+interval '1 day')`,[id])).rejects.toMatchObject({code:"PT409"});
    await db.query("savepoint bad_snapshot");
    await expect(db.query("update private.organization_platform_announcements set body_en='forged'")).rejects.toMatchObject({code:"42501"});
    await db.query("rollback to savepoint bad_snapshot;release savepoint bad_snapshot");
  });
  it("direct storage and the dispatcher are denied to every client context", async () => {
    for (const t of tables) for (const role of ["anon","authenticated","service_role"]) {
      await expect(as(publisher,"platform",`select * from private.${t}`,[],{role})).rejects.toMatchObject({code:"42501"});
    }
    await expect(as(publisher,"platform","select public.dispatch_platform_announcements(1)")).rejects.toMatchObject({code:"42501"});
  });
  it("installs every RLS/MFA/graph/boundary/lifecycle safeguard and maps account deletion", async () => {
    const objects=(await db.query("select relname,relrowsecurity,relforcerowsecurity from pg_class where relnamespace='private'::regnamespace and relname=any($1)",[tables])).rows;
    expect(objects).toHaveLength(7); expect(objects.every(x=>x.relrowsecurity&&x.relforcerowsecurity)).toBe(true);
    for (const t of tables) {
      expect((await db.query("select count(*)::int n from pg_trigger where tgrelid=$1::regclass and not tgisinternal",['private.'+t])).rows[0].n).toBe(3);
      expect((await db.query("select permissive,qual,with_check from pg_policies where schemaname='private' and tablename=$1",[t])).rows[0]).toMatchObject({permissive:"RESTRICTIVE"});
      expect((await db.query("select count(*)::int n from private.account_lifecycle_manifest where table_name=$1",[t])).rows[0].n).toBeGreaterThan(0);
    }
    await follow(); await publish();
    await db.query("delete from auth.users where id=$1",[publisher]);
    expect((await db.query("select count(*)::int n from private.platform_announcement_publishers")).rows[0].n).toBe(0);
    expect((await db.query("select count(*)::int n from private.platform_announcement_audit where action='publish' and actor_user_id is null")).rows[0].n).toBe(1);
  });
  it("matches the captured database contract's live function bodies and ACLs", async () => {
    const contract=JSON.parse(readFileSync(new URL("../scripts/db-contract.json",import.meta.url),"utf8"));
    const entries=contract.functions.filter(f=>f.sig.includes("platform_announcement")||f.sig.startsWith("public.list_platform_follow_status("));
    expect(entries).toHaveLength(16);
    const live=(await db.query(`select n.nspname||'.'||p.proname||'('||pg_get_function_identity_arguments(p.oid)||')' sig,
      md5(pg_get_functiondef(p.oid)) hash,
      concat_ws(',',case when has_function_privilege('anon',p.oid,'EXECUTE') then 'anon' end,
      case when has_function_privilege('authenticated',p.oid,'EXECUTE') then 'authenticated' end,
      case when has_function_privilege('service_role',p.oid,'EXECUTE') then 'service_role' end) acl
      from pg_proc p join pg_namespace n on n.oid=p.pronamespace where p.prokind='f'`)).rows;
    for(const entry of entries) expect(live.find(x=>x.sig===entry.sig),entry.sig).toMatchObject({hash:entry.bodyMd5,acl:entry.exec});
    const legal=contract.functions.find(entry=>entry.sig==="private.legal_acceptance_versions(p_versions jsonb)");
    expect((await db.query("select md5(prosrc) hash from pg_proc where oid='private.legal_acceptance_versions(jsonb)'::regprocedure")).rows[0].hash).toBe(legal.sourceMd5);
  });
  it("organization deletion removes its content graph without blocking on correction references", async () => {
    await follow();const old=await publish();
    const next=(await as(publisher,"platform",`select public.save_platform_announcement_draft(null,0,'Correction','Cambio','New body','Texto nuevo',now()+interval '1 day',$1) result`,[old]))[0].result.id;
    await as(publisher,"platform","select public.review_platform_announcement($1,1)",[next]);
    await as(publisher,"platform","select public.publish_platform_announcement($1,1)",[next]);
    await db.query("delete from public.chapters where organization_id=$1",[platform]);
    await db.query("delete from public.organizations where id=$1",[platform]);
    expect((await db.query("select count(*)::int n from private.platform_announcements")).rows[0].n).toBe(0);
  });
});
