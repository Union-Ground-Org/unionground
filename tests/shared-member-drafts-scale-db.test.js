// @vitest-environment node
//
// BUG-UG-STEWARD-DESK-SHARED-DRAFTS-CASE-UPDATES-KB-READS-SLOW-AT-SCALE-20261106
// public.list_shared_member_drafts (the steward desk's shared-access panel)
// took 5.1 s on SAMPLE at 1,002 accounts and returned an empty list: the body
// is security invoker, so every row of public.member_forms went through the
// table's row policies and private.member_draft_shared_to_caller although only
// drafts explicitly shared with the caller can qualify. 20261106224000 reads
// public.member_forms by primary key for the caller's own shares only.
//
// 1. On a small fixture each caller sees exactly the drafts it should, and the
//    installed body returns exactly what the 20261102005607 body returns.
// 2. At 1,000 accounts plus 200 in another organization, with 3,600 forms, a
//    steward's read answers in under 1 s (runner-scaled) with and without
//    shares, and runs the form row policy only for shared drafts; the old body
//    runs it for every form.
// Everything runs in one transaction that is rolled back.
import { migrateLegacyStewardFixtures } from "./helpers/steward-unit-fixtures.js";
import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { assertDisposableProofUrl } from "../scripts/run-required-db-proofs.mjs";
import { runnerTimeout } from "../scripts/lib/runner-timeout.mjs";
import { loadScaledBudget, pairedFastest, reportPaired } from "./helpers/db-load-budget.mjs";

const live = process.env.SUPABASE_DB_URL ? describe : describe.skip;
const PREDECESSOR = new URL("../supabase/migrations/20261102005607_unit_committee_scoped_access.sql", import.meta.url);
const LOOKUP_PREDECESSOR = new URL("../supabase/migrations/20261106224000_shared_member_drafts_drive_from_shares.sql", import.meta.url);
const DRAFTS = "select public.list_shared_member_drafts() value";
const SCALE_MEMBERS = 1000;
const OTHER_MEMBERS = 200;
const FORMS_PER_MEMBER = 3;

// The predecessor definition exactly as 20261102005607 installed it.
function predecessor() {
  const sql = readFileSync(PREDECESSOR, "utf8");
  const start = sql.indexOf("create function public.list_shared_member_drafts()");
  const end = sql.indexOf("\n$function$;\n", start);
  if (start < 0 || end < 0) throw new Error("predecessor list_shared_member_drafts not found");
  return sql.slice(start, end + "\n$function$;\n".length).replace("create function", "create or replace function");
}

const id = (prefix, n) => `${prefix}-0000-4000-8000-${String(n).padStart(12, "0")}`;

// Preserve passing plans and work counts too: some reporters show test
// console output only on failure. The DB runner owns this artifact directory.
function evidence(value) {
  const line = `${JSON.stringify(value)}\n`;
  console.info(line.trim());
  if (process.env.DB_ASSURANCE_ARTIFACT_DIR) {
    mkdirSync(process.env.DB_ASSURANCE_ARTIFACT_DIR, { recursive: true });
    appendFileSync(join(process.env.DB_ASSURANCE_ARTIFACT_DIR, "shared-draft-lookup.jsonl"), line);
  }
}

function predecessorLookup() {
  const sql = readFileSync(LOOKUP_PREDECESSOR, "utf8");
  const start = sql.indexOf("create function private.caller_shared_draft_form_ids()");
  const end = sql.indexOf("\n$function$;", start);
  if (start < 0 || end < 0) throw new Error("predecessor shared draft lookup not found");
  return sql.slice(start, end + "\n$function$;".length).replace("create function", "create or replace function");
}

live("shared member drafts at organization scale (#7353)", () => {
  let db;

  async function call(caller, { aal = "aal2", sql = DRAFTS, role = "authenticated" } = {}) {
    await db.query("savepoint call");
    try {
      await db.query("select set_config('request.jwt.claims',$1,true)", [JSON.stringify({ sub: caller.id, role: "authenticated", aal, session_id: caller.session })]);
      await db.query(`set local role ${role}`);
      // The hosted authenticated role's limit.
      await db.query("set local statement_timeout = '30s'");
      const started = performance.now();
      const { rows } = await db.query(sql);
      return { ms: performance.now() - started, value: rows[0].value };
    } catch (error) {
      return { error: error.code, message: error.message };
    } finally {
      await db.query("rollback to savepoint call");
      await db.query("reset role");
    }
  }

  async function policyCalls(run) {
    const read = async () => (await db.query(
      `select coalesce(sum(calls),0)::integer calls from pg_stat_xact_user_functions
        where schemaname = 'private' and funcname = 'member_form_scope_and_identity_allowed'`,
    )).rows[0].calls;
    const before = await read();
    const result = await run();
    return { result, policy: (await read()) - before };
  }

  async function shareCheckCalls(run) {
    const read = async () => (await db.query(`select coalesce(sum(calls),0)::integer calls
      from pg_stat_xact_user_functions where schemaname = 'private' and funcname = 'member_draft_shared_to_caller'`)).rows[0].calls;
    const before = await read();
    const result = await run();
    return { result, checks: (await read()) - before };
  }

  // Explain the SQL body in the same role as its function executes. A plain
  // EXPLAIN of a definer call hides the join inside the function.
  async function lookupPlans(caller, label) {
    await db.query("savepoint plans");
    try {
      await db.query("select set_config('request.jwt.claims',$1,true)", [JSON.stringify({ sub: caller.id, role: "authenticated", aal: "aal2", session_id: caller.session })]);
      const body = async (sig) => (await db.query("select prosrc from pg_proc where oid=$1::regprocedure", [sig])).rows[0].prosrc;
      const helper = await db.query(`explain (analyze, buffers, format json) ${await body("private.caller_shared_draft_form_ids()")}`);
      const rpcBody = await body("public.list_shared_member_drafts()");
      await db.query("set local role authenticated");
      const rpc = await db.query(`explain (analyze, buffers, format json) ${rpcBody}`);
      evidence({ label, helperPlan: helper.rows[0]["QUERY PLAN"], rpcPlan: rpc.rows[0]["QUERY PLAN"] });
    } finally {
      await db.query("rollback to savepoint plans");
    }
  }

  // n members in five chapters of one organization (chapter = n mod 5), plus
  // `other` members in a sixth chapter of a second organization.
  async function seedOrganization(prefix, organization, members, { other = 0, staff = [] } = {}) {
    const user = (n) => `'${prefix}-0000-4000-8000-'||lpad((${n})::text,12,'0')`;
    const otherOrganization = id(`${prefix.slice(0, 7)}f`, 9);
    await db.query(`insert into public.organizations(id,slug,name,status) values ($1,$2,$2,'active'),($3,$4,$4,'active')`,
      [organization, `scale-${prefix}`, otherOrganization, `scale-${prefix}-other`]);
    await db.query(`insert into public.chapters(id,name,region,is_default,order_index,organization_id,slug)
      select '${prefix}-ch-'||n,'Scale chapter '||n,'scale',false,9900+n,
        case when n <= 5 then $1::uuid else $2::uuid end,'${prefix}-ch-'||n
      from generate_series(1, 6) n`, [organization, otherOrganization]);
    const chapter = `case when n > ${members} then 6 else ((n - 1) % 5) + 1 end`;
    await db.query(`insert into auth.users(id,aud,role,email,raw_app_meta_data,raw_user_meta_data,created_at,updated_at,is_sso_user,is_anonymous)
      select (${user("n")})::uuid,'authenticated','authenticated','${prefix}-'||n||chr(64)||'example.invalid',
        '{"provider":"email","providers":["email"]}','{}',now(),now(),false,false
      from generate_series(1, $1::integer) n`, [members + other]);
    await db.query(`insert into public.member_profiles(id,first_name,full_name,initials,chapter_id,role_line,member_since,language,
        notification_prefs,dnd_enabled,quiet_hours_timezone,urgent_notifications_enabled,shortcut_keys,work_widget_order,created_at,updated_at)
      select (${user("n")})::uuid,'Scale','Scale member '||lpad(n::text,5,'0'),'SM','${prefix}-ch-'||(${chapter}),'Member',2020,'en',
        '{}',false,'UTC',true,'{}','{}',now(),now()
      from generate_series(1, $1::integer) n`, [members + other]);
    await db.query(`insert into public.member_chapter_memberships(user_id,chapter_id,status,pinned,joined_at)
      select (${user("n")})::uuid,'${prefix}-ch-'||(${chapter}),'active',true,now() from generate_series(1, $1::integer) n`, [members + other]);
    await db.query(`insert into public.organization_memberships(organization_id,user_id,status)
      select case when n > $2::integer then $3::uuid else $1::uuid end,(${user("n")})::uuid,'active'
      from generate_series(1, $4::integer) n`, [organization, members, otherOrganization, members + other]);
    for (const grant of staff) {
      const userId = id(prefix, grant.n);
      if (grant.organizationRole) {
        await db.query("insert into public.organization_role_grants(organization_id,user_id,role,granted_by) values ($1,$2,$3,$2)", [organization, userId, grant.organizationRole]);
      }
      if (grant.chapterRole) {
        for (const table of ["member_roles", "member_role_chapters"]) {
          await db.query(`insert into public.${table}(user_id,role,chapter_id,granted_by) values ($1,$2,$3,$1)`, [userId, grant.chapterRole, `${prefix}-ch-${grant.chapter}`]);
        }
      }
    }
    // Callers: a verified factor and an aal2 session each.
    const callers = {};
    for (const grant of staff.filter((entry) => entry.caller)) {
      const userId = id(prefix, grant.n);
      await db.query("insert into auth.mfa_factors(id,user_id,friendly_name,factor_type,status,secret,created_at,updated_at) values (gen_random_uuid(),$1,'scale','totp','verified','scale',now(),now())", [userId]);
      callers[grant.caller] = { id: userId, session: id(`${prefix.slice(0, 7)}5`, grant.n) };
    }
    return { callers, otherOrganization };
  }

  async function insertForm(prefix, n, owner, { template = "grievance", version = 1, status = "draft", minutesAgo = n } = {}) {
    const formId = id(`${prefix.slice(0, 7)}a`, n);
    await db.query(`insert into public.member_forms(id,user_id,template_key,template_version,status,answers,step,created_at,updated_at)
      values ($1,$2,$3,$4,$5,'{"summary":"Fixture"}'::jsonb,1,now(),now() - make_interval(mins => $6::integer))`,
    [formId, owner, template, version, status, minutesAgo]);
    return formId;
  }

  async function share(form, steward, organization, chapter) {
    await db.query("insert into private.member_draft_steward_shares(form_id,steward_id,organization_id,chapter_id) values ($1,$2,$3,$4)",
      [form, steward, organization, chapter]);
  }

  async function sessions(callers) {
    for (const caller of Object.values(callers)) {
      await db.query("insert into auth.sessions(id,user_id,created_at,updated_at,aal) values ($1,$2,now(),now(),'aal2')", [caller.session, caller.id]);
    }
  }

  let small;
  let smallForms;
  let scale;
  let scaleOrg;

  beforeAll(async () => {
    db = new pg.Client({ connectionString: assertDisposableProofUrl(process.env.SUPABASE_DB_URL), application_name: "shared-member-drafts-scale-proof" });
    await db.connect();
    await db.query("begin");
    await db.query("set local statement_timeout = '120s'");
    await db.query("set local track_functions = 'all'");
    // Fixture rows only; triggers resume before sessions and every call.
    await db.query("set local session_replication_role = replica");

    const smallOrg = id("d7353fff", 1);
    const seeded = await seedOrganization("d7353000", smallOrg, 30, {
      other: 6,
      staff: [
        { n: 1, chapterRole: "steward", chapter: 1, caller: "chapterSteward" },
        { n: 2, organizationRole: "steward", caller: "orgSteward" },
        { n: 3, chapterRole: "coordinator", chapter: 3, caller: "coordinator" },
        { n: 11, caller: "member" },
        { n: 31, chapterRole: "steward", chapter: 6, caller: "foreignSteward" },
      ],
    });
    small = seeded.callers;
    const owner = (n) => id("d7353000", n); // member n sits in chapter ((n - 1) % 5) + 1
    const chapter = (n) => `d7353000-ch-${n}`;
    smallForms = {
      shared: await insertForm("d7353000", 1, owner(11), { minutesAgo: 5 }),
      sharedReturned: await insertForm("d7353000", 2, owner(16), { status: "returned", minutesAgo: 3 }),
      sharedSubmitted: await insertForm("d7353000", 3, owner(21), { status: "submitted" }),
      sharedSealed: await insertForm("d7353000", 4, owner(26), { template: "fmla_self", version: 2 }),
      notShared: await insertForm("d7353000", 5, owner(6)),
      otherChapter: await insertForm("d7353000", 6, owner(12)),
      orgStewardChapter: await insertForm("d7353000", 7, owner(17)),
      otherOrganization: await insertForm("d7353000", 8, owner(32)),
      notCovered: await insertForm("d7353000", 9, owner(13)),
      wrongShareScope: await insertForm("d7353000", 10, owner(21)),
    };
    for (const key of ["shared", "sharedReturned", "sharedSubmitted", "sharedSealed"]) {
      await share(smallForms[key], small.chapterSteward.id, smallOrg, chapter(1));
    }
    // A share row naming the owner's chapter, not the steward's own.
    await share(smallForms.otherChapter, small.chapterSteward.id, smallOrg, chapter(2));
    // The organization steward (chapter two) holds a share in its own chapter.
    await share(smallForms.orgStewardChapter, small.orgSteward.id, smallOrg, chapter(2));
    // Another organization's draft, shared with its own steward.
    await share(smallForms.otherOrganization, small.foreignSteward.id, seeded.otherOrganization, chapter(6));
    // Stale/foreign share rows cannot grant access through the helper.
    await share(smallForms.otherOrganization, small.chapterSteward.id, seeded.otherOrganization, chapter(6));
    await share(smallForms.wrongShareScope, small.chapterSteward.id, seeded.otherOrganization, chapter(1));
    // The coordinator holds a share but no steward role covering the owner.
    await share(smallForms.notCovered, small.coordinator.id, smallOrg, chapter(3));

    scaleOrg = id("e7353fff", 1);
    scale = (await seedOrganization("e7353000", scaleOrg, SCALE_MEMBERS, {
      other: OTHER_MEMBERS,
      staff: [
        ...Array.from({ length: 45 }, (_, index) => ({ n: index + 1, chapterRole: "steward", chapter: (index % 5) + 1 })),
        { n: 1, caller: "chapterSteward" },
        { n: 46, organizationRole: "steward", caller: "orgSteward" },
      ],
    })).callers;
    // Three forms per account: a draft, a submitted grievance and an approved
    // service request, none shared.
    await db.query(`insert into public.member_forms(id,user_id,template_key,template_version,status,answers,step,created_at,updated_at)
      select ('e7353f0'||k||'-0000-4000-8000-'||lpad(n::text,12,'0'))::uuid,
        ('e7353000-0000-4000-8000-'||lpad(n::text,12,'0'))::uuid,
        case k when 3 then 'service_request' else 'grievance' end,1,
        case k when 1 then 'draft' when 2 then 'submitted' else 'approved' end,
        '{"summary":"Scale"}'::jsonb,1,now(),now() - make_interval(mins => n)
      from generate_series(1, $1::integer) n cross join generate_series(1, ${FORMS_PER_MEMBER}) k`, [SCALE_MEMBERS + OTHER_MEMBERS]);

    await db.query("set local session_replication_role = origin");
    await sessions(small);
    await sessions(scale);
    await db.query(`analyze public.member_forms, private.member_draft_steward_shares, public.member_profiles, public.organization_memberships,
      public.member_chapter_memberships, public.member_role_chapters, public.organization_role_grants, public.chapters`);

    // This broad-reader fixture is an
    // existing legacy grant; exercise its actual migration carry-over.
    await migrateLegacyStewardFixtures(db);
  }, runnerTimeout(120_000));

  afterAll(async () => {
    await db?.query("rollback").catch(() => {});
    await db?.end();
  });

  it("lists exactly the drafts shared with each caller, as the predecessor did", async () => {
    const ids = (result) => result.value?.map((draft) => draft.id);
    const installed = {};
    for (const [who, caller] of Object.entries(small)) installed[who] = await call(caller);
    installed.chapterStewardAal1 = await call(small.chapterSteward, { aal: "aal1" });

    // Chapter one's steward: its open and returned shares, newest first; never
    // a submitted or sealed form, an unshared draft or a share naming another
    // chapter.
    expect(installed.chapterSteward.error).toBeUndefined();
    expect(ids(installed.chapterSteward)).toEqual([smallForms.sharedReturned, smallForms.shared]);
    expect(installed.chapterSteward.value[0]).toMatchObject({ template_key: "grievance", user_id: id("d7353000", 16), answers: { summary: "Fixture" } });
    expect(installed.chapterSteward.value[0].template).toMatchObject({ key: "grievance", version: 1 });
    expect(ids(installed.orgSteward)).toEqual([smallForms.orgStewardChapter]);
    expect(ids(installed.foreignSteward)).toEqual([smallForms.otherOrganization]);
    for (const who of ["coordinator", "member", "chapterStewardAal1"]) {
      expect(installed[who], who).toMatchObject({ value: [] });
    }

    await db.query("savepoint predecessor");
    try {
      await db.query(predecessor());
      for (const [who, caller] of Object.entries(small)) {
        const before = await call(caller);
        expect({ value: installed[who].value, error: installed[who].error }, who).toEqual({ value: before.value, error: before.error });
      }
      const aal1 = await call(small.chapterSteward, { aal: "aal1" });
      expect(aal1.value).toEqual(installed.chapterStewardAal1.value);
    } finally {
      await db.query("rollback to savepoint predecessor");
    }
  }, runnerTimeout(60_000));

  it("answers a steward in under 1 s at 1,000 accounts with and without shares", async () => {
    // Scaled by a calibration query on a loaded machine.
    const { budget, calibrationMs } = await loadScaledBudget(db, 1_000, { label: "shared member drafts" });
    console.info("Shared drafts budget", JSON.stringify({ calibrationMs, budget }));
    const measure = async (who) => {
      await call(scale[who]);
      return policyCalls(() => call(scale[who]));
    };

    // No draft is shared (SAMPLE today): the form row policy never runs.
    for (const who of ["chapterSteward", "orgSteward"]) {
      const { result, policy } = await measure(who);
      expect(result.error, who).toBeUndefined();
      expect(result.value, who).toEqual([]);
      // The predecessor ran it for each of the 3,600 forms.
      expect(policy, who).toBe(0);
      // The best of three runs, each judged by a calibration beside it.
      const judged = await pairedFastest(db, result.ms, () => call(scale[who]), { baseMs: 1_000, budget });
      reportPaired(`shared member drafts, ${who}`, judged.runs);
      expect(judged.best.ms, `${who} ${JSON.stringify(judged.runs)}`).toBeLessThan(judged.best.bound);
    }

    // Members 6, 11, ... 46 of chapter one share their drafts with its
    // steward, and member 21 also shares its submitted form: the policy runs
    // for those rows only.
    await db.query("savepoint shared");
    try {
      const owners = [6, 11, 16, 21, 26, 31, 36, 41, 46];
      const draft = (n) => `e7353f01-0000-4000-8000-${String(n).padStart(12, "0")}`;
      for (const n of owners) await db.query("insert into private.member_draft_steward_shares(form_id,steward_id,organization_id,chapter_id) values ($1,$2,$3,'e7353000-ch-1')", [draft(n), scale.chapterSteward.id, scaleOrg]);
      await db.query("insert into private.member_draft_steward_shares(form_id,steward_id,organization_id,chapter_id) values ($1,$2,$3,'e7353000-ch-1')",
        [`e7353f02-0000-4000-8000-${String(21).padStart(12, "0")}`, scale.chapterSteward.id, scaleOrg]);
      const { result, policy } = await measure("chapterSteward");
      expect(result.error).toBeUndefined();
      // Newest first: a smaller n was updated more recently.
      expect(result.value.map((entry) => entry.id)).toEqual(owners.map(draft));
      expect(policy).toBeLessThanOrEqual(owners.length + 1);
      const judged = await pairedFastest(db, result.ms, () => call(scale.chapterSteward), { baseMs: 1_000, budget });
      reportPaired("shared member drafts, chapterSteward with shared drafts", judged.runs);
      expect(judged.best.ms, JSON.stringify(judged.runs)).toBeLessThan(judged.best.bound);
      // The organization steward holds no share.
      expect((await call(scale.orgSteward)).value).toEqual([]);
    } finally {
      await db.query("rollback to savepoint shared");
    }
  }, runnerTimeout(90_000));

  //  covers the remaining helper, not 's invoker-RPC scan or
  // 's member_forms policies. Count real per-form checks at both entry
  // points as unrelated forms grow; elapsed time is diagnostic only.
  it("preserves helper and RPC results, withdrawals, step-up and grant boundaries (#7618)", async () => {
    const lookup = "select private.caller_shared_draft_form_ids() value";
    const snapshot = async () => {
      const values = {};
      const capture = async (key, caller, options = {}) => {
        const helper = await call(caller, { ...options, sql: lookup });
        const rpc = await call(caller, options);
        values[key] = { helper: helper.value?.sort(), helperError: helper.error, rpc: rpc.value, rpcError: rpc.error };
      };
      for (const [who, caller] of Object.entries(small)) await capture(who, caller);
      await capture("aal1", small.chapterSteward, { aal: "aal1" });
      await capture("noIdentity", { id: null, session: null });
      await capture("anon", small.chapterSteward, { role: "anon" });
      await capture("service", small.chapterSteward, { role: "service_role" });
      await db.query("savepoint restricted");
      try {
        await db.query("insert into private.member_pin_sessions(session_id,user_id) values($1,$2)", [small.chapterSteward.session, small.chapterSteward.id]);
        await capture("pin", small.chapterSteward);
      } finally {
        await db.query("rollback to savepoint restricted");
      }
      await db.query("savepoint withdrawn");
      try {
        await db.query("delete from private.member_draft_steward_shares where form_id=$1 and steward_id=$2", [smallForms.sharedReturned, small.chapterSteward.id]);
        await capture("withdrawn", small.chapterSteward);
      } finally {
        await db.query("rollback to savepoint withdrawn");
      }
      return values;
    };
    const installed = await snapshot();
    expect(installed.chapterSteward.helper).toEqual([smallForms.shared, smallForms.sharedReturned].sort());
    expect(installed.chapterSteward.rpc.map((row) => row.id)).toEqual([smallForms.sharedReturned, smallForms.shared]);
    expect(Object.keys(installed.chapterSteward.rpc[0]).sort()).toEqual(["id", "template_key", "user_id", "answers", "updated_at", "template"].sort());
    expect(installed.orgSteward.helper).toEqual([smallForms.orgStewardChapter]);
    expect(installed.foreignSteward.helper).toEqual([smallForms.otherOrganization]);
    for (const who of ["coordinator", "member", "aal1", "pin", "noIdentity"]) {
      expect(installed[who], who).toEqual({ helper: [], helperError: undefined, rpc: [], rpcError: undefined });
    }
    for (const who of ["anon", "service"]) {
      expect(installed[who], who).toMatchObject({ helperError: "42501", rpcError: "42501" });
    }
    expect(installed.withdrawn.helper).toEqual([smallForms.shared]);
    expect(installed.withdrawn.rpc.map((row) => row.id)).toEqual([smallForms.shared]);
    await db.query("savepoint lookup_equivalence");
    try {
      await db.query(predecessorLookup());
      expect(await snapshot()).toEqual(installed);
    } finally {
      await db.query("rollback to savepoint lookup_equivalence");
    }
    console.info("#7618: helper/RPC equivalence for five callers, aal1, PIN, no identity, anon, service_role and withdrawal passed");
  }, runnerTimeout(90_000));

  it("keeps the RPC's 100-row cap and id tie-break after lookup bounding (#7618)", async () => {
    await db.query("savepoint capped");
    try {
      const forms = [];
      for (let n = 1; n <= 105; n++) {
        const form = await insertForm("c7618000", n, id("e7353000", 1 + n * 5), { template: "service_request", minutesAgo: -1 });
        forms.push(form);
        await share(form, scale.chapterSteward.id, scaleOrg, "e7353000-ch-1");
      }
      const installed = await call(scale.chapterSteward);
      expect(installed.error).toBeUndefined();
      expect(installed.value.map((row) => row.id)).toEqual(forms.sort().slice(0, 100));
      await db.query(predecessorLookup());
      expect((await call(scale.chapterSteward)).value).toEqual(installed.value);
    } finally {
      await db.query("rollback to savepoint capped");
    }
  }, runnerTimeout(90_000));

  it("bounds helper and RPC authorization work by sparse caller shares as unrelated forms grow (#7618)", async () => {
    await db.query("savepoint lookup_scale");
    try {
      const draft = (n) => `e7353f01-0000-4000-8000-${String(n).padStart(12, "0")}`;
      const owners = [6, 11, 16];
      for (const n of owners) await share(draft(n), scale.chapterSteward.id, scaleOrg, "e7353000-ch-1");
      // Many unrelated shares, held by another steward, are typical of a
      // busy organization; the caller still holds only three.
      await db.query(`insert into private.member_draft_steward_shares(form_id,steward_id,organization_id,chapter_id)
        select f.id,$1,c.organization_id,p.chapter_id from public.member_forms f
        join public.member_profiles p on p.id=f.user_id
        join public.chapters c on c.id=p.chapter_id
        where f.id::text like 'e7353f%'`, [scale.orgSteward.id]);
      await db.query("analyze public.member_forms, private.member_draft_steward_shares");
      const measure = async (label) => {
        const helper = await shareCheckCalls(() => call(scale.chapterSteward, { sql: "select private.caller_shared_draft_form_ids() value" }));
        const rpc = await shareCheckCalls(() => call(scale.chapterSteward));
        evidence({ label, forms: Number((await db.query("select count(*) from public.member_forms")).rows[0].count), shares: owners.length, helperChecks: helper.checks, rpcChecks: rpc.checks, helperMs: helper.result.ms, rpcMs: rpc.result.ms });
        expect(helper.result.error).toBeUndefined();
        expect([...helper.result.value].sort()).toEqual(owners.map(draft).sort());
        expect(rpc.result.value?.map((entry) => entry.id)).toEqual(owners.map(draft));
        return { helper, rpc };
      };
      await lookupPlans(scale.chapterSteward, "installed lookup plan");
      const smaller = await measure("installed, sparse shares");
      await db.query(`insert into public.member_forms(id,user_id,template_key,template_version,status,answers,step,created_at,updated_at)
        select ('e7618f0'||k||'-0000-4000-8000-'||lpad(n::text,12,'0'))::uuid,
          ('e7353000-0000-4000-8000-'||lpad(n::text,12,'0'))::uuid,
          'grievance',1,'approved','{"summary":"Tamarack unrelated form"}',1,now(),now()
        from generate_series(1,1200) n cross join generate_series(1,3) k`);
      await db.query("analyze public.member_forms, private.member_draft_steward_shares");
      const larger = await measure("installed, twice as many unrelated forms");
      // Exercise a plan that checks the form side before joining the shares,
      // even when this standalone fixture currently favors a nested loop.
      // No function, policy or authorization is mocked.
      await db.query("set local enable_nestloop=off");
      await lookupPlans(scale.chapterSteward, "installed, alternate join plan");
      const alternateJoin = await measure("installed, alternate join");
      await db.query("savepoint predecessor_lookup");
      try {
        await db.query(predecessorLookup());
        await lookupPlans(scale.chapterSteward, "predecessor lookup plan");
        await measure("predecessor, twice as many unrelated forms");
      } finally {
        await db.query("rollback to savepoint predecessor_lookup");
      }
      for (const measured of [smaller, larger, alternateJoin]) {
        expect(measured.helper.checks).toBeLessThanOrEqual(owners.length);
        // The RPC also runs its final check and the table policies' checks.
        expect(measured.rpc.checks).toBeLessThanOrEqual(owners.length * 4);
      }
      const unshared = await shareCheckCalls(() => call(small.member, { sql: "select private.caller_shared_draft_form_ids() value" }));
      expect(unshared.result.value).toEqual([]);
      expect(unshared.checks).toBe(0);
    } finally {
      await db.query("rollback to savepoint lookup_scale");
    }
  }, runnerTimeout(120_000));
});
