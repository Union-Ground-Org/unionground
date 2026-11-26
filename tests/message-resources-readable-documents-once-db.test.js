// @vitest-environment node
//
// BUG-UG-MESSAGE-RESOURCES-POLICY-CHECKS-EVERY-ROW-20261108 (#7501)
// The web shell reads public.member_message_resources with no filter on every
// load. member_message_resources_read ran
// private.current_actor_can_read_message_source for every row in the table
// (0.7 to 0.9 s on SAMPLE for 141 rows, 0 to 7 of them returned).
// 20261108110300 first tests the caller's published chapter documents,
// resolved once per statement, and runs the per-row checks only for rows that
// can pass them.
//
// 1. Every hat (conversation owner, a member of the same chapter, a member of
//    another chapter, steward, coordinator, admin, another organization's
//    member, an aal1 session, a profile with no chapter) sees exactly the
//    rows the predecessor policy showed it, over chapter, staff-only and
//    draft documents in the reader's chapter and in another chapter, on
//    readable and unreadable messages.
// 2. At 1,000 accounts and 360 resources, the per-row source check runs only
//    for the rows whose document is a published document of the caller's
//    chapter (the predecessor ran it for every row), and the read answers in
//    under 1 s (runner-scaled) with the predecessor's rows.
// Everything runs in one transaction that is rolled back.
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { assertDisposableProofUrl } from "../scripts/run-required-db-proofs.mjs";
import { runnerTimeout } from "../scripts/lib/runner-timeout.mjs";

const live = process.env.SUPABASE_DB_URL ? describe : describe.skip;
const READ = "select id, message_id, document_id, created_at from public.member_message_resources";
// The policy exactly as 20260812200000 installed it (md5 05a76baa103854514e654195a585498d
// under search_path pg_catalog, which the migration's preflight requires).
const PREDECESSOR = `drop policy member_message_resources_read on public.member_message_resources;
create policy member_message_resources_read on public.member_message_resources
  for select to authenticated using (
    private.current_actor_can_read_message_source('private', message_id, null, null)
    and private.current_actor_can_read_document(document_id)
  )`;
const P = "a7501000";
const MEMBERS = 1000;
const OTHER_MEMBERS = 50;
const CHAPTERS = 6;
// Documents per chapter: chapter-visible, staff-only and draft.
const DOCUMENTS = [["chapter", "published"], ["chapter", "published"], ["staff", "published"], ["chapter", "draft"]];
// Members 1..CONVERSATIONS each own one conversation; members 1..12 own a second.
const CONVERSATIONS = 300;

const id = (prefix, n) => `${prefix}-0000-4000-8000-${String(n).padStart(12, "0")}`;
const user = (n) => id(P, n);
const chapter = (n) => `${P}-ch-${n}`;

live("message resource reads resolve the caller's readable documents once per statement (#7501)", () => {
  let db;

  async function as(caller, run) {
    await db.query("savepoint call");
    try {
      await db.query("select set_config('request.jwt.claims',$1,true)", [JSON.stringify({ sub: caller.id, role: "authenticated", aal: caller.aal, session_id: caller.session })]);
      await db.query("set local role authenticated");
      // The hosted authenticated role's limit.
      await db.query("set local statement_timeout = '30s'");
      return await run();
    } finally {
      await db.query("rollback to savepoint call");
      await db.query("reset role");
    }
  }

  const read = (caller) => as(caller, async () => {
    const started = performance.now();
    const { rows } = await db.query(`${READ} order by id`);
    return { ms: performance.now() - started, ids: rows.map((row) => row.id) };
  });

  async function sourceCalls(run) {
    const calls = async () => (await db.query(
      `select coalesce(sum(calls),0)::integer calls from pg_stat_xact_user_functions
        where schemaname = 'private' and funcname = 'current_actor_can_read_message_source'`,
    )).rows[0].calls;
    const before = await calls();
    const result = await run();
    return { result, calls: (await calls()) - before };
  }

  let hats;
  let total;

  beforeAll(async () => {
    db = new pg.Client({ connectionString: assertDisposableProofUrl(process.env.SUPABASE_DB_URL), application_name: "message-resources-documents-once-proof" });
    await db.connect();
    await db.query("begin");
    await db.query("set local statement_timeout = '120s'");
    await db.query("set local track_functions = 'all'");

    const organization = id(`${P.slice(0, 7)}f`, 1);
    const other = id(`${P.slice(0, 7)}f`, 2);
    // Fixture rows only; triggers resume before the analyze.
    await db.query("set local session_replication_role = replica");
    await db.query("insert into public.organizations(id,slug,name,status) values ($1,'k7501-scale','k7501-scale','active'),($2,'k7501-other','k7501-other','active')", [organization, other]);
    await db.query(`insert into public.chapters(id,name,region,is_default,order_index,organization_id,slug)
      select '${P}-ch-'||n,'Scale chapter '||n,'scale',false,9600+n,case when n <= $3 then $1::uuid else $2::uuid end,'${P}-ch-'||n
      from generate_series(1, $3 + 1) n`, [organization, other, CHAPTERS]);
    // Member n is in chapter ((n - 1) mod 6) + 1; the other organization's
    // members are in chapter 7.
    const home = `case when n > ${MEMBERS} then ${CHAPTERS + 1} else ((n - 1) % ${CHAPTERS}) + 1 end`;
    const uid = `('${P}-0000-4000-8000-'||lpad(n::text,12,'0'))::uuid`;
    await db.query(`insert into auth.users(id,aud,role,email,raw_app_meta_data,raw_user_meta_data,created_at,updated_at,is_sso_user,is_anonymous)
      select ${uid},'authenticated','authenticated','${P}-'||n||chr(64)||'example.invalid','{"provider":"email","providers":["email"]}','{}',now(),now(),false,false
      from generate_series(1, $1::integer) n`, [MEMBERS + OTHER_MEMBERS]);
    await db.query(`insert into public.member_profiles(id,first_name,full_name,initials,chapter_id,role_line,member_since,language,
        notification_prefs,dnd_enabled,quiet_hours_timezone,urgent_notifications_enabled,shortcut_keys,work_widget_order,created_at,updated_at)
      select ${uid},'Scale','Scale member '||lpad(n::text,5,'0'),'SM','${P}-ch-'||(${home}),'Member',2020,'en','{}',false,'UTC',true,'{}','{}',now(),now()
      from generate_series(1, $1::integer) n`, [MEMBERS + OTHER_MEMBERS]);
    await db.query(`insert into public.member_chapter_memberships(user_id,chapter_id,status,pinned,joined_at)
      select ${uid},'${P}-ch-'||(${home}),'active',true,now() from generate_series(1, $1::integer) n`, [MEMBERS + OTHER_MEMBERS]);
    await db.query(`insert into public.organization_memberships(organization_id,user_id,status)
      select case when n > $2::integer then $3::uuid else $1::uuid end,${uid},'active' from generate_series(1, $4::integer) n`,
    [organization, MEMBERS, other, MEMBERS + OTHER_MEMBERS]);
    for (const [n, role] of [[19, "steward"], [25, "coordinator"], [31, "admin"]]) {
      for (const table of ["member_roles", "member_role_chapters"]) {
        await db.query(`insert into public.${table}(user_id,role,chapter_id,granted_by) values ($1,$2,$3,$1)`, [user(n), role, chapter(1)]);
      }
    }
    // Member 49 (chapter one) has no profile chapter.
    await db.query("update public.member_profiles set chapter_id = null where id = $1", [user(49)]);

    // Four documents per chapter, the other organization's chapter included.
    await db.query(`insert into public.chapter_documents(id,chapter_id,title,document_type,visibility,status,created_by)
      select ('${P.slice(0, 7)}d-0000-4000-8000-'||lpad((c*10+k)::text,12,'0'))::uuid,'${P}-ch-'||c,'Resource proof','other',
             ($1::text[])[k],($2::text[])[k],('${P}-0000-4000-8000-'||lpad(c::text,12,'0'))::uuid
      from generate_series(1, $3::integer) c, generate_series(1, $4::integer) k`,
    [DOCUMENTS.map(([visibility]) => visibility), DOCUMENTS.map(([, status]) => status), CHAPTERS + 1, DOCUMENTS.length]);
    const doc = (c, k) => `('${P.slice(0, 7)}d-0000-4000-8000-'||lpad(((${c})*10+(${k}))::text,12,'0'))::uuid`;
    // One conversation and message per member 1..300 (and the other
    // organization's first 30), each with a resource. Most point at a
    // document of the owner's chapter; every fifth points at chapter (c mod 6) + 1.
    const owners = `select n from generate_series(1, ${CONVERSATIONS}) n union all select n from generate_series(${MEMBERS + 1}, ${MEMBERS + 30}) n`;
    const conversation = `('${P.slice(0, 7)}c-0000-4000-8000-'||lpad(n::text,12,'0'))::uuid`;
    const message = `('${P.slice(0, 7)}e-0000-4000-8000-'||lpad(n::text,12,'0'))::uuid`;
    await db.query(`insert into public.member_conversations(id,user_id,organization_id,title)
      select ${conversation},${uid},case when n > $2::integer then $3::uuid else $1::uuid end,'Resource proof' from (${owners}) o`, [organization, MEMBERS, other]);
    await db.query(`insert into public.member_messages(id,conversation_id,user_id,sender_kind,sender_name,body,created_at)
      select ${message},${conversation},${uid},'member','Proof','see attached',now() from (${owners}) o`);
    const target = `case when n % 5 = 0 and n <= ${MEMBERS} then (((${home}) % ${CHAPTERS}) + 1) else ${home} end`;
    await db.query(`insert into public.member_message_resources(message_id,document_id,added_by)
      select ${message},${doc(target, `((n - 1) % ${DOCUMENTS.length}) + 1`)},${uid} from (${owners}) o`);
    // Members 1..12 have a second message in their conversation pointing at
    // each kind of document in their own chapter and the next.
    await db.query(`insert into public.member_messages(id,conversation_id,user_id,sender_kind,sender_name,body,created_at)
      select ('${P.slice(0, 7)}9-0000-4000-8000-'||lpad((n*10+k)::text,12,'0'))::uuid,${conversation},${uid},'member','Proof','more',now()
      from generate_series(1, 12) n, generate_series(1, 2 * $1::integer) k`, [DOCUMENTS.length]);
    await db.query(`insert into public.member_message_resources(message_id,document_id,added_by)
      select ('${P.slice(0, 7)}9-0000-4000-8000-'||lpad((n*10+k)::text,12,'0'))::uuid,
             ${doc(`case when k <= ${DOCUMENTS.length} then ${home} else ((${home}) % ${CHAPTERS}) + 1 end`, `((k - 1) % ${DOCUMENTS.length}) + 1`)},${uid}
      from generate_series(1, 12) n, generate_series(1, 2 * $1::integer) k`, [DOCUMENTS.length]);

    const callers = {
      owner: 1, sameChapter: 301 + 6 * 10, otherChapter: 302 + 6 * 10, steward: 19, coordinator: 25, admin: 31,
      aal1Session: 7, noChapter: 49, otherOrganization: MEMBERS + 1,
    };
    hats = {};
    for (const [hat, n] of Object.entries(callers)) {
      const session = id(`${P.slice(0, 7)}5`, n);
      await db.query("insert into auth.mfa_factors(id,user_id,friendly_name,factor_type,status,secret,created_at,updated_at) values (gen_random_uuid(),$1,'scale','totp','verified','scale',now(),now())", [user(n)]);
      await db.query("insert into auth.sessions(id,user_id,created_at,updated_at,aal) values ($1,$2,now(),now(),$3)", [session, user(n), hat === "aal1Session" ? "aal1" : "aal2"]);
      hats[hat] = { id: user(n), session, aal: hat === "aal1Session" ? "aal1" : "aal2" };
    }
    await db.query("set local session_replication_role = origin");
    await db.query(`analyze public.member_message_resources, public.member_messages, public.member_conversations, public.chapter_documents,
      public.member_profiles, public.member_chapter_memberships, public.organization_memberships, public.chapters, public.member_roles, public.member_role_chapters`);
    total = Number((await db.query("select count(*) from public.member_message_resources")).rows[0].count);
  }, runnerTimeout(120_000));

  afterAll(async () => {
    await db?.query("rollback").catch(() => {});
    await db?.end();
  });

  async function everyHat() {
    const result = {};
    for (const [hat, caller] of Object.entries(hats)) result[hat] = (await read(caller)).ids;
    return result;
  }

  // Resources whose document is a published document of the caller's profile chapter.
  async function candidates(caller) {
    return Number((await db.query(`select count(*) from public.member_message_resources r
      join public.chapter_documents d on d.id = r.document_id
      join public.member_profiles p on p.id = $1 and p.chapter_id = d.chapter_id
      where d.status = 'published'`, [caller.id])).rows[0].count);
  }

  it("shows every hat exactly the rows the predecessor policy showed it", async () => {
    const installed = await everyHat();
    // The owner reads its own message's resources whose document is
    // published in its chapter, including the staff-only one for staff only.
    const owned = Number((await db.query(`select count(*) from public.member_message_resources r
      join public.member_messages m on m.id = r.message_id join public.member_conversations c on c.id = m.conversation_id
      join public.chapter_documents d on d.id = r.document_id
      where c.user_id = $1 and d.status = 'published' and d.visibility = 'chapter' and d.chapter_id = $2`, [user(1), chapter(1)])).rows[0].count);
    expect(owned).toBeGreaterThan(1);
    expect(installed.owner).toHaveLength(owned);
    // The steward reads its chapter members' resources on published
    // documents of its chapter, the staff-only ones included.
    expect(installed.steward.length).toBeGreaterThan(owned);
    for (const hat of ["sameChapter", "otherChapter", "aal1Session", "noChapter"]) {
      expect(installed[hat], hat).toEqual([]);
    }
    expect(installed.otherOrganization.length).toBeGreaterThan(0);

    await db.query("savepoint predecessor");
    try {
      await db.query(PREDECESSOR);
      const before = await everyHat();
      for (const hat of Object.keys(installed)) expect(installed[hat], hat).toEqual(before[hat]);
    } finally {
      await db.query("rollback to savepoint predecessor");
    }
  }, runnerTimeout(60_000));

  it("runs the per-row checks only for rows on the caller's published chapter documents at 1,000 accounts, in under 1 s", async () => {
    const budget = runnerTimeout(1_000);
    expect(total).toBeGreaterThan(CONVERSATIONS);
    const installed = {};
    for (const hat of ["owner", "otherChapter", "steward", "coordinator", "admin", "otherOrganization"]) {
      await read(hats[hat]);
      const { result, calls } = await sourceCalls(() => read(hats[hat]));
      expect(calls, hat).toBeLessThanOrEqual(await candidates(hats[hat]));
      expect(calls, hat).toBeLessThan(total / 4);
      expect(result.ms, hat).toBeLessThan(budget);
      installed[hat] = result.ids;
    }

    await db.query("savepoint predecessor");
    try {
      await db.query(PREDECESSOR);
      for (const hat of Object.keys(installed)) {
        const { result, calls } = await sourceCalls(() => read(hats[hat]));
        expect(result.ids, hat).toEqual(installed[hat]);
        // The predecessor checked the message of every row in the table.
        expect(calls, hat).toBeGreaterThanOrEqual(total);
      }
    } finally {
      await db.query("rollback to savepoint predecessor");
    }
  }, runnerTimeout(120_000));
});
