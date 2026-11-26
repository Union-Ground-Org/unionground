// @vitest-environment node
//
// PERF-UG-COLD-HOME-BOOTSTRAP-ONE-CALL-20261028
//
// public.get_member_home_bootstrap returns the eighteen plain cold-Home table
// reads of the member App in one call. It is SECURITY INVOKER, so it adds no
// visibility: every array must hold exactly the rows the PostgREST read it
// replaces returns for the same caller. The query shapes come from
// src/lib/memberHomeBootstrap.js, the same registry the session loader
// matches against, so a drift in any of the three (memberApi.js, the registry,
// this function) shows up here or in tests/member-boot-budget.test.js.
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { createClient } from "@supabase/supabase-js";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PROOF_FILES, assertDisposableProofUrl, assertDisposableStorageStatus } from "../scripts/run-required-db-proofs.mjs";
import {
  MEMBER_HOME_BOOTSTRAP_RESOURCES,
  MEMBER_HOME_BOOTSTRAP_RPC,
  memberHomeBootstrapArguments,
  memberHomeBootstrapQueries,
} from "../src/lib/memberHomeBootstrap.js";

const migration = readFileSync(new URL("../supabase/migrations/20261028150000_member_home_bootstrap.sql", import.meta.url), "utf8");
const contract = JSON.parse(readFileSync(new URL("../scripts/db-contract.json", import.meta.url), "utf8"));
const SIGNATURE = "public.get_member_home_bootstrap(p_action_log_since timestamp with time zone, p_resources text[])";
const ALL = MEMBER_HOME_BOOTSTRAP_RESOURCES;
// Served by get_member_home_bootstrap but not in the client registry.
const UNREQUESTED_SERVED = ["member_case_updates"];

describe("member Home bootstrap (static)", () => {
  it("is a stable security-invoker function reachable by the member role only, pinned in the contract and the proof lane", () => {
    const code = migration.replace(/--[^\n]*/g, "");
    expect(code).toMatch(/create function public\.get_member_home_bootstrap\(p_action_log_since timestamptz, p_resources text\[\]\)\s+returns jsonb\s+language plpgsql\s+stable\s+security invoker\s+set search_path = ''/u);
    expect(code).toContain("revoke all on function public.get_member_home_bootstrap(timestamptz, text[]) from public, anon, authenticated, service_role;");
    expect(code).toContain("grant execute on function public.get_member_home_bootstrap(timestamptz, text[]) to authenticated;");
    expect(code).not.toMatch(/security definer/iu);
    expect(contract.functions).toContainEqual(expect.objectContaining({ sig: SIGNATURE, secdef: false, exec: "authenticated" }));
    expect(PROOF_FILES).toContain("tests/member-home-bootstrap-db.test.js");
  });

  it("names every registered resource as a payload array and echoes the caller", () => {
    expect(migration).toContain("'user_id', caller");
    for (const resource of MEMBER_HOME_BOOTSTRAP_RESOURCES) {
      expect(migration, resource).toContain(`'${resource.slice("table:".length)}', case when '${resource.slice("table:".length)}' = any(p_resources) then (`);
    }
  });
});

// Unordered reads compare as sets; embedded option arrays compare as sets too,
// because PostgREST gives no order inside an embed.
const ORDERED = new Set([
  "table:member_notifications", "table:chapters", "table:member_cases", "table:member_case_updates", "table:member_broadcasts",
  "table:member_ballots", "table:member_surveys", "table:member_rights_lessons", "table:member_action_log",
  "table:member_point_rules", "table:member_reward_tiers",
]);
const sortRows = rows => [...rows].sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)));
const canonical = (resource, rows) => {
  const embedded = rows.map(row => {
    const copy = { ...row };
    for (const key of ["member_ballot_options", "member_survey_options"]) if (Array.isArray(copy[key])) copy[key] = sortRows(copy[key]);
    return copy;
  });
  return ORDERED.has(resource) ? embedded : sortRows(embedded);
};

const RETIRED_POINTS_RESOURCES = ["table:member_point_rules", "table:member_reward_tiers"];

describe.skipIf(!process.env.SUPABASE_DB_URL)("member Home bootstrap on the complete schema", () => {
  const org = randomUUID();
  const chapter = `home-boot-${org}`;
  const lesson = `home-boot-lesson-${org}`;
  const cases = [randomUUID(), randomUUID()];
  const ballot = `home-boot-ballot-${org}`;
  const survey = `home-boot-survey-${org}`;
  const event = randomUUID();
  const broadcasts = [`home-boot-live-${org}`, `home-boot-retracted-${org}`];
  const receipts = ["SG-PR0F-A1B2", "SG-PR0F-A1B3"];
  const users = {};
  const clients = {};
  const options = { auth: { persistSession: false, autoRefreshToken: false } };
  const nowMs = Date.now();
  let db, admin, status, anon;

  beforeAll(async () => {
    const connectionString = assertDisposableProofUrl(process.env.SUPABASE_DB_URL);
    status = assertDisposableStorageStatus(
      JSON.parse(readFileSync(process.env.PRIVATE_FILE_STORAGE_STATUS_FILE, "utf8")), connectionString,
    );
    db = new pg.Client({ connectionString, application_name: "member-home-bootstrap-proof" });
    await db.connect();
    await db.query("set lock_timeout='5s'; set statement_timeout='30s'");
    admin = createClient(status.API_URL, status.SERVICE_ROLE_KEY, options);
    anon = createClient(status.API_URL, status.ANON_KEY, options);
    for (const name of ["alpha", "beta"]) {
      const email = `${chapter}-${name}@example.invalid`;
      const password = `Local-proof!${randomUUID()}`;
      const created = await admin.auth.admin.createUser({ email, password, email_confirm: true });
      if (created.error) throw created.error;
      users[name] = { id: created.data.user.id, email };
      // Isolate the seeded notices from this edition's account welcome.
      await db.query("delete from public.member_notifications where user_id=$1 and kind='general' and title='Welcome to your private organizing workspace'", [created.data.user.id]);
      const client = createClient(status.API_URL, status.ANON_KEY, options);
      const signedIn = await client.auth.signInWithPassword({ email, password });
      if (signedIn.error) throw signedIn.error;
      clients[name] = client;
    }
    await db.query("insert into public.organizations(id,slug,name,created_by) values($1,$2,$2,$3)", [org, chapter, users.alpha.id]);
    await db.query("insert into public.org_security_policy(id,organization_id,require_staff_mfa) values(true,$1,false)", [org]);
    await db.query("insert into public.chapters(id,name,slug,organization_id,is_default,order_index) values($1,$1,$1,$2,false,9960)", [chapter, org]);
    for (const user of Object.values(users)) {
      await db.query("insert into public.organization_memberships(organization_id,user_id,status) values($1,$2,'active')", [org, user.id]);
      await db.query("insert into public.member_chapter_memberships(user_id,chapter_id,status) values($1,$2,'active')", [user.id, chapter]);
      await db.query("update public.member_profiles set chapter_id=$2 where id=$1", [user.id, chapter]);
    }
    await db.query("insert into public.member_roles(user_id,role,chapter_id) values($1,'steward',$2) on conflict do nothing", [users.beta.id, chapter]);
    await db.query(`insert into public.member_rights_lessons(id,label,title,description,steps,script,order_index,title_es,description_es,steps_es,script_es)
      values($1,$1,'Proof lesson','Proof description','["One","Two"]','Proof script',9960,'Leccion de prueba','Descripcion de prueba','["Uno","Dos"]','Guion de prueba')`, [lesson]);
    // Chapter rows every member sees: a ballot and a pulse with two options
    // each, a live and a retracted broadcast, and one event.
    await db.query(`insert into public.member_ballots(id,title,body,closes_at,active,order_index,chapter_id,organization_id,campaign_state,published_at)
      values($1,'Proof ballot','Vote',now()+interval '7 days',true,996001,$2,$3,'open',now()-interval '1 day')`, [ballot, chapter, org]);
    await db.query("insert into public.member_ballot_options(id,ballot_id,label,label_es,order_index) values($1||'-b',$1,'B option','Opcion B',2),($1||'-a',$1,'A option','Opcion A',1)", [ballot]);
    await db.query(`insert into public.member_surveys(id,title,body,closes_at,active,order_index,chapter_id,organization_id,campaign_state,published_at)
      values($1,'Proof pulse','Pulse',now()+interval '7 days',true,996001,$2,$3,'open',now()-interval '1 day')`, [survey, chapter, org]);
    await db.query("insert into public.member_survey_options(id,survey_id,label,label_es,order_index) values($1||'-a',$1,'Yes','Si',1),($1||'-b',$1,'No','No',2)", [survey]);
    await db.query(`insert into public.member_broadcasts(id,sender,title,body,published_at,order_index,organization_id,chapter_id,audience_scope,retracted_at)
      values($1,'Chapter office','Live notice','live',now()-interval '1 day',996001,$3,$4,'chapter',null),($2,'Chapter office','Retracted notice','gone',now()-interval '2 days',996002,$3,$4,'chapter',now())`, [broadcasts[0], broadcasts[1], org, chapter]);
    await db.query("insert into public.member_events(id,title,starts_at,location,summary,check_in_code,order_index,chapter_id) values($1,'Proof meeting',now()+interval '3 days','Hall','Proof',$2,996001,$3)", [event, `SG-HB${org.slice(0, 6).toUpperCase().replace(/[^0-9A-Z]/g, "0")}`, chapter]);
    for (const [index, name] of ["alpha", "beta"].entries()) {
      const user = users[name];
      await db.query("insert into public.member_ballot_receipts(ballot_id,user_id,receipt_code) values($1,$2,$3)", [ballot, user.id, receipts[index]]);
      await db.query("insert into public.member_survey_responses(survey_id,option_id,user_id) values($1,$1||'-a',$2)", [survey, user.id]);
      await db.query("insert into public.member_broadcast_receipts(broadcast_id,user_id) values($1,$2)", [broadcasts[0], user.id]);
      await db.query("insert into public.member_event_rsvps(event_id,user_id,status) values($1,$2,'going')", [event, user.id]);
      await db.query("insert into public.member_event_checkins(event_id,user_id) values($1,$2)", [event, user.id]);
      await db.query(`insert into public.member_notifications(user_id,title,body,created_at)
        values($1,'First notice','first',now()-interval '2 hours'),($1,'Second notice','second',now()-interval '1 hour')`, [user.id]);
      await db.query(`insert into public.member_cases(id,user_id,reference,title,case_type,step,status)
        values($1,$2,$3,'Proof case','other','Intake','active')`, [cases[index], user.id, `HB-${index}-${org.slice(0, 8)}`]);
      await db.query("insert into public.member_case_updates(case_id,user_id,body) values($1,$2,'Proof update')", [cases[index], user.id]);
      await db.query("insert into public.member_rights_progress(lesson_id,user_id,completed_steps) values($1,$2,'{0}')", [lesson, user.id]);
      await db.query(`insert into public.member_action_log(user_id,action_key,action_kind,occurred_at)
        values($1,$2,'rights',now()-interval '2 days'),($1,$3,'rights',now()-interval '30 days')`,
      [user.id, `home-boot-recent-${org}-${index}`, `home-boot-old-${org}-${index}`]);
    }
  }, 90000);

  afterAll(async () => {
    const failures = [];
    const clean = async operation => { try { await operation(); } catch (error) { failures.push(error); } };
    if (db) {
      const userIds = Object.values(users).map(user => user.id);
      await clean(() => db.query("delete from public.member_action_log where user_id=any($1::uuid[])", [userIds]));
      for (const table of ["member_event_checkins", "member_event_rsvps", "member_broadcast_receipts", "member_ballot_receipts", "member_survey_responses"]) {
        await clean(() => db.query(`delete from public.${table} where user_id=any($1::uuid[])`, [userIds]));
      }
      await clean(() => db.query("delete from public.member_events where id=$1", [event]));
      await clean(() => db.query("delete from public.member_broadcasts where id=any($1::text[])", [broadcasts]));
      await clean(() => db.query("delete from public.member_ballots where id=$1", [ballot]));
      await clean(() => db.query("delete from public.member_surveys where id=$1", [survey]));
      await clean(() => db.query("delete from public.member_rights_progress where user_id=any($1::uuid[])", [userIds]));
      await clean(() => db.query("delete from public.member_rights_lessons where id=$1", [lesson]));
      await clean(() => db.query("delete from public.member_cases where id=any($1::uuid[])", [cases]));
      await clean(() => db.query("delete from public.member_notifications where user_id=any($1::uuid[])", [userIds]));
      await clean(() => db.query("delete from public.member_roles where user_id=any($1::uuid[])", [userIds]));
      await clean(() => db.query("delete from public.member_role_chapters where user_id=any($1::uuid[])", [userIds]));
      await clean(() => db.query("update public.member_profiles set chapter_id=null where id=any($1::uuid[])", [userIds]));
      await clean(() => db.query("delete from public.member_chapter_memberships where user_id=any($1::uuid[])", [userIds]));
      await clean(() => db.query("delete from public.chapters where id=$1", [chapter]));
      // Publishing the ballot and broadcast queued engagement deliveries for the tenant.
      for (const table of ["engagement_delivery_outbox", "organization_role_grants", "organization_memberships", "dues_member_subjects", "org_security_policy"]) {
        await clean(() => db.query(`delete from public.${table} where organization_id=$1`, [org]));
      }
      await clean(() => db.query("delete from public.organizations where id=$1", [org]));
      for (const user of Object.values(users)) {
        await clean(async () => { const result = await admin.auth.admin.deleteUser(user.id); if (result.error) throw result.error; });
      }
      await clean(() => db.end());
    }
    if (failures.length) throw new AggregateError(failures, "Member Home bootstrap fixture cleanup failed");
  }, 90000);

  async function bootstrap(name, args = memberHomeBootstrapArguments(nowMs, ALL)) {
    return clients[name].rpc(MEMBER_HOME_BOOTSTRAP_RPC, args);
  }

  async function directRead(name, resource, calls) {
    let query = clients[name].from(resource.slice("table:".length));
    for (const [method, args] of calls) query = query[method](...args);
    const result = await query;
    expect(result.error, `${resource} direct read`).toBeNull();
    return result.data;
  }

  it("returns, for every covered resource, exactly the rows PostgREST returns to the same member", async () => {
    for (const name of ["alpha", "beta"]) {
      const result = await bootstrap(name);
      expect(result.error).toBeNull();
      expect(result.data.user_id).toBe(users[name].id);
      // The function names every resource it serves and fills only the ones
      // asked for. This edition's loader reads case notes itself, newest
      // first, so the registry does not ask for member_case_updates and the
      // call reads none (null, not an empty list).
      expect(Object.keys(result.data).toSorted()).toEqual(["user_id", ...MEMBER_HOME_BOOTSTRAP_RESOURCES.map(resource => resource.slice("table:".length)), ...UNREQUESTED_SERVED].toSorted());
      for (const key of UNREQUESTED_SERVED) expect(result.data[key], `${key} for ${name}`).toBeNull();
      const queries = memberHomeBootstrapQueries(users[name].id, nowMs);
      for (const resource of MEMBER_HOME_BOOTSTRAP_RESOURCES) {
        // This edition retired the points economy and closed its two tables to
        // clients: the bootstrap answers them empty instead of reading them.
        if (RETIRED_POINTS_RESOURCES.includes(resource)) {
          expect(result.data[resource.slice("table:".length)], `${resource} for ${name}`).toEqual([]);
          continue;
        }
        const direct = await directRead(name, resource, queries[resource]);
        expect(canonical(resource, result.data[resource.slice("table:".length)]), `${resource} for ${name}`).toEqual(canonical(resource, direct));
      }
      expect(result.data.member_notifications.map(row => row.title)).toEqual(["Second notice", "First notice"]);
      expect(result.data.member_cases.map(row => row.id)).toEqual([cases[name === "alpha" ? 0 : 1]]);
      expect(result.data.member_rights_progress).toEqual([{ lesson_id: lesson, completed_steps: [0] }]);
      // The populated branches, not only empty-array equality: embedded options
      // in order_index order, the retraction filter, receipts and attendance.
      const [ballotRow] = result.data.member_ballots.filter(row => row.id === ballot);
      expect(ballotRow.member_ballot_options.map(row => row.id)).toEqual([`${ballot}-a`, `${ballot}-b`]);
      expect(ballotRow.quorum_target).toBeNull();
      const [surveyRow] = result.data.member_surveys.filter(row => row.id === survey);
      expect(surveyRow.member_survey_options.map(row => row.label)).toEqual(["Yes", "No"]);
      expect(result.data.member_broadcasts.map(row => row.id).filter(id => broadcasts.includes(id))).toEqual([broadcasts[0]]);
      expect(result.data.member_broadcast_receipts.map(row => row.broadcast_id)).toEqual([broadcasts[0]]);
      expect(result.data.member_ballot_receipts.map(row => row.receipt_code)).toEqual([receipts[name === "alpha" ? 0 : 1]]);
      expect(result.data.member_survey_responses).toEqual([{ survey_id: survey, option_id: `${survey}-a` }]);
      expect(result.data.member_event_rsvps).toEqual([{ event_id: event, status: "going" }]);
      expect(result.data.member_event_checkins).toEqual([{ event_id: event }]);
    }
  }, 60000);

  it("scopes self rows to the caller: a steward's call never carries another member's rows", async () => {
    // Ask for the case notes too, so their branch is proven self-scoped even
    // though the registry leaves them to the loader.
    const beta = await bootstrap("beta", memberHomeBootstrapArguments(nowMs, [...ALL, ...UNREQUESTED_SERVED.map(key => `table:${key}`)]));
    expect(beta.error).toBeNull();
    expect(beta.data.user_id).toBe(users.beta.id);
    expect(beta.data.member_roles).toEqual([{ role: "steward" }]);
    expect(Array.isArray(beta.data.member_case_updates)).toBe(true);
    for (const key of ["member_notifications", "member_cases", "member_case_updates", "member_rights_progress", "member_action_log"]) {
      expect(beta.data[key].every(row => row.user_id === undefined || row.user_id === users.beta.id), key).toBe(true);
    }
    expect(beta.data.member_cases.map(row => row.id)).not.toContain(cases[0]);
    expect(beta.data.member_notifications.map(row => row.user_id)).toEqual([users.beta.id, users.beta.id]);
  });

  it("applies the action-log window argument exactly as the direct read's filter", async () => {
    const recent = await bootstrap("alpha");
    expect(recent.data.member_action_log.map(row => row.action_key)).toEqual([`home-boot-recent-${org}-0`]);
    // A clock 30 days back opens a 37-day window that admits the 30-day-old row.
    const wide = await bootstrap("alpha", memberHomeBootstrapArguments(nowMs - 30 * 86400000, ALL));
    expect(wide.data.member_action_log.map(row => row.action_key)).toEqual([`home-boot-old-${org}-0`, `home-boot-recent-${org}-0`]);
    const none = await bootstrap("alpha", { ...memberHomeBootstrapArguments(nowMs, ALL), p_action_log_since: null });
    expect(none.error?.code).toBe("22023");
  });

  it("returns only the requested arrays, ignores an unknown name and refuses an empty list", async () => {
    const subset = await bootstrap("alpha", memberHomeBootstrapArguments(nowMs, ["table:member_roles", "table:member_reward_tiers", "table:not_a_table"]));
    expect(subset.error).toBeNull();
    expect(subset.data.user_id).toBe(users.alpha.id);
    expect(Array.isArray(subset.data.member_roles) && Array.isArray(subset.data.member_reward_tiers)).toBe(true);
    for (const resource of ALL) {
      if (["table:member_roles", "table:member_reward_tiers"].includes(resource)) continue;
      expect(subset.data[resource.slice("table:".length)], resource).toBeNull();
    }
    expect(subset.data.not_a_table).toBeUndefined();
    const empty = await bootstrap("alpha", memberHomeBootstrapArguments(nowMs, []));
    expect(empty.error?.code).toBe("22023");
  });

  it("refuses anon callers", async () => {
    const result = await anon.rpc(MEMBER_HOME_BOOTSTRAP_RPC, memberHomeBootstrapArguments(nowMs, ALL));
    expect(result.error).not.toBeNull();
    expect(["42501", "PGRST202", "PGRST301"]).toContain(result.error.code);
  });

  it("is live as a stable invoker function with a pinned search_path and the member role as its only grantee", async () => {
    const { rows } = await db.query(`
      select p.prosecdef, p.provolatile, p.proconfig,
        pg_catalog.has_function_privilege('anon', p.oid, 'execute') as anon_exec,
        pg_catalog.has_function_privilege('authenticated', p.oid, 'execute') as member_exec,
        pg_catalog.has_function_privilege('service_role', p.oid, 'execute') as service_exec
      from pg_catalog.pg_proc p join pg_catalog.pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'public' and p.proname = 'get_member_home_bootstrap'`);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ prosecdef: false, provolatile: "s", anon_exec: false, member_exec: true, service_exec: false });
    expect(rows[0].proconfig.some((setting) => /^search_path=("")?$/u.test(setting))).toBe(true);
  });
});
