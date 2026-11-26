// @vitest-environment node
//
// BUG-UG-STAFF-BOOT-LOAD-SLOW-RECORDS-AND-REACTIONS-READS-20261106 (#7210)
// Every staff screen's first load waited 5-6 s at about 1,000 accounts on two
// reads whose policies called security-definer helpers once per row: the
// newest 300 chapter_records and every member_message_reactions row.
// 20261106222000 answers the chapter_records helpers once per distinct
// chapter or scope per statement (private.chapter_records_scope_memo), accepts
// the reactions the caller reads through the plain own-conversation, channel
// and task branches from one per-statement list, and adds
// public.list_member_message_reactions so the web boot reads only the
// reactions on the messages it loaded.
//
// 1. On a mixed fixture (members, unit and committee members, stewards,
//    scoped and unscoped records officers, org-wide hats, another tenant)
//    every caller reads exactly the rows the predecessor policies return, and
//    the RPC returns exactly the predecessor's reactions on the ids it names.
// 2. At 1,000 accounts plus 200 in another organization both first-load reads
//    answer in under 1 s (runner-scaled) with a fixed number of helper calls;
//    the predecessor policies make one or more helper calls per row.
// Everything runs in one transaction that is rolled back.
import { migrateLegacyStewardFixtures } from "./helpers/steward-unit-fixtures.js";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { assertDisposableProofUrl } from "../scripts/run-required-db-proofs.mjs";
import { runnerTimeout } from "../scripts/lib/runner-timeout.mjs";

const live = process.env.SUPABASE_DB_URL ? describe : describe.skip;

// The predecessor expressions exactly as pg_policy held them before
// 20261106222000 (the migration's own preflight refuses any other).
const PREDECESSOR = {
  chapter_records: {
    chapter_records_select: "(((private.chapter_record_publication(record_type) = 'chapter_members'::text) AND (lifecycle_status = 'published'::text) AND (visibility = 'chapter'::text) AND (archived_at IS NULL) AND private.can_read_chapter_member_record(chapter_id)) OR ((archived_at IS NULL) AND private.can_read_chapter_contact_record(chapter_id)) OR ((private.chapter_record_publication(record_type) = 'chapter_members'::text) AND private.chapter_officer_can_for_scope(chapter_id, 'records'::text, access_unit_id, access_committee_id)))",
    chapter_records_container_scope: "(((access_unit_id IS NULL) AND (access_committee_id IS NULL)) OR private.chapter_record_manageable(chapter_id, access_unit_id, access_committee_id) OR private.chapter_scope_member_allowed(chapter_id, access_unit_id, access_committee_id, ( SELECT auth.uid() AS uid)))",
  },
  member_message_reactions: {
    member_message_reactions_read: "private.current_actor_can_read_message_source(source_kind, private_message_id, channel_post_id, task_message_id)",
  },
};

const RECORD_HELPERS = ["can_read_chapter_member_record", "can_read_chapter_contact_record", "chapter_officer_can_for_scope", "chapter_record_manageable", "chapter_scope_member_allowed"];
const REACTION_HELPERS = ["current_actor_can_read_message_source", "can_read_message_source"];
const BOOT_RECORDS = "select coalesce(jsonb_agg(r.id order by r.occurred_at desc, r.id), '[]') value from (select * from public.chapter_records where archived_at is null order by occurred_at desc limit 300) r";
const ALL_RECORDS = "select coalesce(jsonb_agg(id order by id), '[]') value from public.chapter_records";
const ALL_REACTIONS = "select coalesce(jsonb_agg(id order by id), '[]') value from public.member_message_reactions";
// The ids the web boot loads (memberApi loadMemberApp), read as the caller.
const BOOT_IDS = `select jsonb_build_object(
  'private', (select coalesce(array_agg(id), '{}') from (select id from public.member_messages where user_id = auth.uid() order by created_at limit 1000) m),
  'channel', (select coalesce(array_agg(id), '{}') from (select id from public.chapter_thread_posts where deleted_at is null order by created_at desc limit 1000) p),
  'task', (select coalesce(array_agg(id), '{}') from (select id from public.chapter_task_messages order by created_at limit 1000) t)) value`;
const RPC = "select public.list_member_message_reactions($1::uuid[], $2::uuid[], $3::uuid[]) value";
const SCALE_MEMBERS = 1000;
const OTHER_MEMBERS = 200;

const id = (prefix, n) => `${prefix}-0000-4000-8000-${String(n).padStart(12, "0")}`;

live("chapter_records and member_message_reactions first-load reads at organization scale (#7210)", () => {
  let db;

  async function call(user, sql, params = []) {
    await db.query("savepoint call");
    try {
      await db.query("select set_config('request.jwt.claims',$1,true)", [JSON.stringify({ sub: user.id, role: "authenticated", aal: "aal2", session_id: user.session })]);
      await db.query("set local role authenticated");
      // The hosted authenticated role's limit.
      await db.query("set local statement_timeout = '30s'");
      const started = performance.now();
      const { rows } = await db.query(sql, params);
      return { ms: performance.now() - started, value: rows[0].value };
    } catch (error) {
      return { error: error.code, message: error.message };
    } finally {
      await db.query("rollback to savepoint call");
      await db.query("reset role");
    }
  }

  async function helperCalls(names, run) {
    const read = async () => Object.fromEntries((await db.query(
      `select funcname, calls::integer from pg_stat_xact_user_functions
        where schemaname = 'private' and funcname = any($1)`, [names],
    )).rows.map((row) => [row.funcname, row.calls]));
    const before = await read();
    const result = await run();
    const after = await read();
    return { result, calls: names.reduce((sum, name) => sum + (after[name] ?? 0) - (before[name] ?? 0), 0) };
  }

  // Runs fn with the predecessor policies installed, then restores the
  // installed ones.
  async function withPredecessorPolicies(fn) {
    await db.query("savepoint predecessor");
    try {
      for (const [table, policies] of Object.entries(PREDECESSOR)) {
        for (const [name, qual] of Object.entries(policies)) {
          await db.query(`alter policy ${name} on public.${table} using (${qual})`);
        }
      }
      return await fn();
    } finally {
      await db.query("rollback to savepoint predecessor");
    }
  }

  async function bootReactions(user) {
    const ids = await call(user, BOOT_IDS);
    expect(ids.error).toBeUndefined();
    return call(user, RPC, [ids.value.private, ids.value.channel, ids.value.task]);
  }

  // Accounts with profiles, an active chapter and organization membership, a
  // verified factor and an aal2 session. people: [{ n, chapter, organization }].
  async function seedPeople(prefix, people) {
    const rows = people.map((person) => [id(prefix, person.n), person.chapter, person.organization, id(`${prefix.slice(0, 7)}5`, person.n)]);
    const values = (column) => rows.map((row) => row[column]);
    await db.query(`insert into auth.users(id,aud,role,email,raw_app_meta_data,raw_user_meta_data,created_at,updated_at,is_sso_user,is_anonymous)
      select u,'authenticated','authenticated',replace(u::text,'-','')||chr(64)||'example.invalid','{"provider":"email","providers":["email"]}','{}',now(),now(),false,false
      from unnest($1::uuid[]) u`, [values(0)]);
    await db.query(`insert into public.member_profiles(id,first_name,full_name,initials,chapter_id,role_line,member_since,language,
        notification_prefs,dnd_enabled,quiet_hours_timezone,urgent_notifications_enabled,shortcut_keys,work_widget_order,created_at,updated_at)
      select u,'Scale','Scale member','SM',c,'Member',2020,'en','{}',false,'UTC',true,'{}','{}',now(),now()
      from unnest($1::uuid[], $2::text[]) x(u, c)`, [values(0), values(1)]);
    await db.query(`insert into public.member_chapter_memberships(user_id,chapter_id,status,pinned,joined_at)
      select u,c,'active',true,now() from unnest($1::uuid[], $2::text[]) x(u, c)`, [values(0), values(1)]);
    await db.query(`insert into public.organization_memberships(organization_id,user_id,status)
      select o,u,'active' from unnest($1::uuid[], $2::uuid[]) x(u, o)`, [values(0), values(2)]);
    await db.query(`insert into auth.mfa_factors(id,user_id,friendly_name,factor_type,status,secret,created_at,updated_at)
      select gen_random_uuid(),u,'scale','totp','verified','scale',now(),now() from unnest($1::uuid[]) u`, [values(0)]);
    return Object.fromEntries(rows.map(([user, , , session], index) => [people[index].n, { id: user, session }]));
  }

  async function sessions(users) {
    for (const user of Object.values(users)) {
      await db.query("insert into auth.sessions(id,user_id,created_at,updated_at,aal) values ($1,$2,now(),now(),'aal2')", [user.session, user.id]);
    }
  }

  async function chapterRole(user, role, chapter) {
    await db.query("insert into public.member_roles(user_id,role,chapter_id,granted_by) values ($1,$2,$3,$1)", [user.id, role, chapter]);
    await db.query("insert into public.member_role_chapters(user_id,role,chapter_id,granted_by) values ($1,$2,$3,$1)", [user.id, role, chapter]);
  }

  async function organizationRole(user, role, organization) {
    await db.query("insert into public.organization_role_grants(organization_id,user_id,role,granted_by) values ($1,$2,$3,$2)", [organization, user.id, role]);
  }

  // Channel spaces, threads and posts; member conversations and messages;
  // task messages; and reactions on all of them by chapter members.
  async function seedMessaging(prefix, chapters, members) {
    await db.query(`insert into public.chapter_spaces(id,chapter_id,name,visibility,created_by)
      select gen_random_uuid(), c.id, v || ' space', v, null
      from unnest($1::text[]) c(id) cross join unnest(array['chapter','staff']) v`, [chapters]);
    await db.query(`insert into public.chapter_threads(id,space_id,chapter_id,title)
      select gen_random_uuid(), s.id, s.chapter_id, 'Thread ' || n
      from public.chapter_spaces s cross join generate_series(1, 4) n where s.chapter_id = any($1)`, [chapters]);
    await db.query(`insert into public.chapter_thread_posts(id,thread_id,chapter_id,author_id,body,created_at,deleted_at)
      select gen_random_uuid(), t.id, t.chapter_id, null, 'Post ' || n, now() - make_interval(mins => n),
        case when n % 9 = 0 then now() end
      from public.chapter_threads t cross join generate_series(1, $2::integer) n where t.chapter_id = any($1)`, [chapters, members.postsPerThread]);
    await db.query(`insert into public.member_conversations(id,user_id,title)
      select gen_random_uuid(), p.id, 'Chapter steward' from public.member_profiles p where p.id = any($1)`, [members.conversationUsers]);
    await db.query(`insert into public.member_messages(id,conversation_id,user_id,sender_kind,sender_name,body,created_at,learning_removal_held_at)
      select gen_random_uuid(), c.id, c.user_id, case when n % 2 = 0 then 'member' else 'steward' end, 'Sender', 'Message ' || n,
        now() - make_interval(mins => n), case when n = 3 then now() end
      from public.member_conversations c cross join generate_series(1, $2::integer) n where c.user_id = any($1)`, [members.conversationUsers, members.messagesPerConversation]);
    await db.query(`insert into public.chapter_tasks(id,chapter_id,title,task_number)
      select gen_random_uuid(), c.id, 'Task', 1 from unnest($1::text[]) c(id)`, [chapters]);
    await db.query(`insert into public.chapter_task_messages(id,task_id,chapter_id,sender_id,recipient_id,body,created_at)
      select gen_random_uuid(), t.id, t.chapter_id, pair.sender, pair.recipient, 'Task note', now() - make_interval(mins => pair.n::integer)
      from unnest($1::uuid[], $2::uuid[], $3::text[]) with ordinality pair(sender, recipient, chapter, n)
      join public.chapter_tasks t on t.chapter_id = pair.chapter`, [members.taskPairs.map((pair) => pair[0]), members.taskPairs.map((pair) => pair[1]), members.taskPairs.map((pair) => pair[2])]);
    // Up to reactionsPerSource reactions per source by distinct members of the
    // source's chapter (any account for private messages).
    const reactors = `(select array_agg(p.id order by p.id) from public.member_profiles p where p.id::text like '${prefix}%')`;
    await db.query(`with r as (select ${reactors} a)
      insert into public.member_message_reactions(actor_id,source_kind,channel_post_id,reaction)
      select r.a[1 + ((k * 7 + abs(hashtext(post.id::text))) % cardinality(r.a))], 'channel', post.id, 'like'
      from public.chapter_thread_posts post cross join r cross join generate_series(1, $2::integer) k where post.chapter_id = any($1)
      on conflict do nothing`, [chapters, members.reactionsPerSource]);
    await db.query(`with r as (select ${reactors} a)
      insert into public.member_message_reactions(actor_id,source_kind,private_message_id,reaction)
      select r.a[1 + ((k * 11 + abs(hashtext(m.id::text))) % cardinality(r.a))], 'private', m.id, 'support'
      from public.member_messages m cross join r cross join generate_series(1, $2::integer) k where m.user_id = any($1)
      on conflict do nothing`, [members.conversationUsers, members.reactionsPerSource]);
    await db.query(`insert into public.member_message_reactions(actor_id,source_kind,task_message_id,reaction)
      select m.recipient_id, 'task', m.id, 'celebrate' from public.chapter_task_messages m where m.chapter_id = any($1)`, [chapters]);
  }

  // Records of every type, lifecycle, visibility and archive state, unscoped
  // and scoped to each listed unit or committee.
  async function seedRecords(chapter, scopes, copies) {
    await db.query(`insert into public.chapter_records(id,chapter_id,record_type,title,body,occurred_at,lifecycle_status,visibility,published_at,archived_at,access_unit_id,access_committee_id)
      select gen_random_uuid(), $1, t, 'Record', 'Body', now() - make_interval(hours => row_number() over ()::integer), l, v,
        case when l = 'published' then now() end, case when a then now() end, s.unit, s.committee
      from unnest(array['minutes','decision','milestone','member_contact','management_contact']) t
      cross join unnest(array['draft','published']) l cross join unnest(array['chapter','staff']) v
      cross join unnest(array[false,true]) a
      cross join (select null::uuid unit, null::uuid committee union all
        select unnest($2::uuid[]), null union all select null, unnest($3::uuid[])) s
      cross join generate_series(1, $4::integer)`, [chapter, scopes.units ?? [], scopes.committees ?? [], copies]);
  }

  let small;
  let scale;

  // 1,000 accounts in five chapters and 200 in another tenant. The scale case
  // seeds it, so the comparison case reads only the mixed fixture.
  async function seedScale() {
    await db.query("set local session_replication_role = replica");
    const cp = "e7210000";
    const orgS = id("e7210fff", 1);
    const orgT = id("e7210fff", 2);
    await db.query(`insert into public.organizations(id,slug,name,status) values ($1,'scale-7210-s','Scale S','active'),($2,'scale-7210-t','Scale T','active')`, [orgS, orgT]);
    await db.query(`insert into public.chapters(id,name,region,is_default,order_index,organization_id,slug)
      select '${cp}-ch-'||n,'Scale chapter '||n,'scale',false,9900+n,case when n <= 5 then $1::uuid else $2::uuid end,'${cp}-ch-'||n
      from generate_series(1, 6) n`, [orgS, orgT]);
    const sc = (n) => `${cp}-ch-${n}`;
    const scaleUnit = id("e7210aaa", 1);
    await db.query("insert into private.chapter_units(id,organization_id,chapter_id,name) values ($1,$2,$3,'Scale unit')", [scaleUnit, orgS, sc(1)]);
    const everyone = Array.from({ length: SCALE_MEMBERS + OTHER_MEMBERS }, (_, index) => {
      const n = index + 1;
      return { n, chapter: n > SCALE_MEMBERS ? sc(6) : sc(((n - 1) % 5) + 1), organization: n > SCALE_MEMBERS ? orgT : orgS };
    });
    const accounts = await seedPeople(cp, everyone);
    scale = { steward: accounts[1], coordinator: accounts[2], orgAdmin: accounts[SCALE_MEMBERS], member: accounts[500] };
    for (let n = 1; n <= 60; n += 1) await chapterRole(accounts[n], n === 2 ? "coordinator" : "steward", sc(((n - 1) % 5) + 1));
    await organizationRole(scale.orgAdmin, "admin", orgS);
    // About 400 active-tenant and 80 other-tenant records, as on SAMPLE.
    for (let n = 1; n <= 6; n += 1) await seedRecords(sc(n), n === 1 ? { units: [scaleUnit] } : {}, 2);
    // About 2,500 reactions: channel posts in every chapter, member
    // conversations and task messages.
    await seedMessaging(cp, [1, 2, 3, 4, 5, 6].map(sc), {
      postsPerThread: 25,
      conversationUsers: Array.from({ length: 150 }, (_, index) => accounts[index * 8 + 1].id),
      messagesPerConversation: 3,
      taskPairs: Array.from({ length: 60 }, (_, index) => [accounts[index + 1].id, accounts[((index + 5) % 60) + 1].id, sc((index % 5) + 1)]),
      reactionsPerSource: 2,
    });
    await db.query("set local session_replication_role = origin");
    await sessions(scale);
    await db.query(`analyze public.chapter_records, public.member_message_reactions, public.chapter_thread_posts, public.chapter_threads,
      public.chapter_spaces, public.member_messages, public.member_conversations, public.chapter_task_messages, public.member_profiles,
      public.member_chapter_memberships, public.member_roles, public.member_role_chapters, public.organization_role_grants, public.chapters`);
  }

  beforeAll(async () => {
    db = new pg.Client({ connectionString: assertDisposableProofUrl(process.env.SUPABASE_DB_URL), application_name: "chapter-records-reactions-scale-proof" });
    await db.connect();
    await db.query("begin");
    // #8568: the predecessor reads the session day and the current reader the
    // Eastern day; compare them on one day, the Eastern one.
    await db.query("set local timezone to 'America/New_York'");
    await db.query("set local statement_timeout = '300s'");
    await db.query("set local track_functions = 'all'");
    // Fixture rows only; triggers and foreign keys resume before sessions and every call.
    await db.query("set local session_replication_role = replica");

    // ---- small mixed fixture: organization A (chapters 1, 2), B (chapter 3)
    const sp = "d7210000";
    const orgA = id("d7210fff", 1);
    const orgB = id("d7210fff", 2);
    await db.query(`insert into public.organizations(id,slug,name,status) values ($1,'mixed-7210-a','Mixed A','active'),($2,'mixed-7210-b','Mixed B','active')`, [orgA, orgB]);
    await db.query(`insert into public.chapters(id,name,region,is_default,order_index,organization_id,slug) values
      ('${sp}-ch-1','Mixed 1','mixed',false,9801,$1,'${sp}-ch-1'),('${sp}-ch-2','Mixed 2','mixed',false,9802,$1,'${sp}-ch-2'),
      ('${sp}-ch-3','Mixed 3','mixed',false,9803,$2,'${sp}-ch-3')`, [orgA, orgB]);
    const ch = (n) => `${sp}-ch-${n}`;
    const unit = id("d7210aaa", 1);
    const committee = id("d7210bbb", 1);
    const endedCommittee = id("d7210bbb", 2);
    await db.query("insert into private.chapter_units(id,organization_id,chapter_id,name) values ($1,$2,$3,'Unit one')", [unit, orgA, ch(1)]);
    await db.query(`insert into private.chapter_committees(id,chapter_id,name,purpose,starts_on,ends_on) values
      ($1,$3,'Committee one','Proof',current_date - 30,null),($2,$3,'Committee two','Proof',current_date - 60,current_date - 1)`, [committee, endedCommittee, ch(1)]);
    const people = [
      ["member", 1, 1], ["unitMember", 2, 1], ["committeeMember", 3, 1], ["steward", 4, 1], ["coordinatorTwo", 5, 2],
      ["orgAdmin", 6, 1], ["unitRecordsOfficer", 7, 1], ["recordsOfficer", 8, 1], ["memberTwo", 9, 2], ["otherTenant", 10, 3],
      ["orgSteward", 11, 1], ["spaceOwner", 12, 1], ["endedCommitteeMember", 13, 1], ["otherTenantPeer", 14, 3],
    ];
    const seeded = await seedPeople(sp, people.map(([, n, chapter]) => ({ n, chapter: ch(chapter), organization: chapter === 3 ? orgB : orgA })));
    small = Object.fromEntries(people.map(([who, n]) => [who, seeded[n]]));
    await db.query("insert into private.chapter_unit_members(unit_id,chapter_id,user_id) values ($1,$2,$3)", [unit, ch(1), small.unitMember.id]);
    await db.query("insert into private.chapter_committee_members(committee_id,chapter_id,user_id) values ($1,$3,$2),($4,$3,$5)", [committee, small.committeeMember.id, ch(1), endedCommittee, small.endedCommitteeMember.id]);
    await chapterRole(small.steward, "steward", ch(1));
    await chapterRole(small.coordinatorTwo, "coordinator", ch(2));
    await chapterRole(small.recordsOfficer, "records", ch(1));
    await chapterRole(small.unitRecordsOfficer, "records", ch(1));
    await db.query("insert into private.chapter_role_scopes(user_id,chapter_id,role,unit_id) values ($1,$2,'records',$3)", [small.unitRecordsOfficer.id, ch(1), unit]);
    await organizationRole(small.orgAdmin, "admin", orgA);
    await organizationRole(small.orgSteward, "steward", orgA);
    for (const chapter of [1, 2, 3]) await seedRecords(ch(chapter), chapter === 1 ? { units: [unit], committees: [committee, endedCommittee] } : {}, 1);
    await seedMessaging(sp, [ch(1), ch(2), ch(3)], {
      postsPerThread: 3,
      conversationUsers: [small.member.id, small.unitMember.id, small.memberTwo.id, small.otherTenant.id, small.steward.id],
      messagesPerConversation: 4,
      taskPairs: [[small.member.id, small.steward.id, ch(1)], [small.steward.id, small.recordsOfficer.id, ch(1)], [small.memberTwo.id, small.coordinatorTwo.id, ch(2)], [small.otherTenant.id, small.otherTenantPeer.id, ch(3)]],
      reactionsPerSource: 2,
    });
    // A private space with a creator and one member, and a staff-only space
    // reaction, so each channel branch is reached.
    const privateSpace = id("d7210ccc", 1);
    await db.query("insert into public.chapter_spaces(id,chapter_id,name,visibility,created_by) values ($1,$2,'Private space','private',$3)", [privateSpace, ch(1), small.spaceOwner.id]);
    await db.query("insert into public.chapter_space_members(space_id,user_id) values ($1,$2)", [privateSpace, small.unitMember.id]);
    await db.query(`with t as (insert into public.chapter_threads(id,space_id,chapter_id,title) values (gen_random_uuid(),$1,$2,'Private thread') returning id),
      p as (insert into public.chapter_thread_posts(id,thread_id,chapter_id,body) select gen_random_uuid(), t.id, $2, 'Private post' from t returning id)
      insert into public.member_message_reactions(actor_id,source_kind,channel_post_id,reaction) select $3, 'channel', p.id, 'like' from p`, [privateSpace, ch(1), small.member.id]);


    await db.query("set local session_replication_role = origin");
    await sessions(small);
    await db.query(`analyze public.chapter_records, public.member_message_reactions, public.chapter_thread_posts, public.chapter_threads,
      public.chapter_spaces, public.member_messages, public.member_conversations, public.chapter_task_messages, public.member_profiles,
      public.member_chapter_memberships, public.member_roles, public.member_role_chapters, public.organization_role_grants, public.chapters`);

    // This broad-reader fixture is an
    // existing legacy grant; exercise its actual migration carry-over.
    await migrateLegacyStewardFixtures(db);
  }, runnerTimeout(240_000));

  afterAll(async () => {
    await db?.query("rollback").catch(() => {});
    await db?.end();
  });

  it("shows every caller exactly the records and reactions the predecessor policies show", async () => {
    const read = async () => {
      const seen = {};
      for (const [who, user] of Object.entries(small)) {
        const allReactions = await call(user, ALL_REACTIONS);
        seen[who] = {
          records: await call(user, ALL_RECORDS),
          boot: await call(user, BOOT_RECORDS),
          reactions: allReactions,
          rpc: await call(user, RPC, [allIds.private, allIds.channel, allIds.task]),
        };
      }
      return seen;
    };
    const allIds = (await db.query(`select
      (select array_agg(private_message_id) from public.member_message_reactions where source_kind = 'private') private,
      (select array_agg(channel_post_id) from public.member_message_reactions where source_kind = 'channel') channel,
      (select array_agg(task_message_id) from public.member_message_reactions where source_kind = 'task') task`)).rows[0];
    const installed = await read();
    const predecessor = await withPredecessorPolicies(read);
    for (const who of Object.keys(small)) {
      for (const field of ["records", "boot", "reactions"]) {
        expect(installed[who][field].error, `${who} ${field}`).toBeUndefined();
        expect(installed[who][field].value, `${who} ${field}`).toEqual(predecessor[who][field].value);
      }
      expect(installed[who].rpc.error, `${who} rpc`).toBeUndefined();
      expect(installed[who].rpc.value.map((row) => row.id).sort(), `${who} rpc`).toEqual(predecessor[who].reactions.value);
    }
    // The fixture reaches the branches the comparison is meant to cover.
    const count = (who, field) => installed[who][field].value.length;
    expect(count("otherTenant", "records")).toBeGreaterThan(0);
    expect(count("member", "records")).toBeLessThan(count("steward", "records"));
    expect(count("unitMember", "records")).toBeGreaterThan(count("member", "records"));
    expect(count("committeeMember", "records")).toBeGreaterThan(count("member", "records"));
    expect(count("endedCommitteeMember", "records")).toBe(count("member", "records"));
    expect(count("recordsOfficer", "records")).toBeGreaterThan(count("member", "records"));
    expect(count("unitRecordsOfficer", "records")).toBeGreaterThan(count("unitMember", "records"));
    expect(count("orgAdmin", "records")).toBeGreaterThan(count("steward", "records"));
    expect(count("steward", "reactions")).toBeGreaterThan(count("member", "reactions"));
    expect(count("spaceOwner", "reactions")).toBeGreaterThan(0);
    expect(count("otherTenant", "reactions")).toBeGreaterThan(0);
    // A field-for-field row, not only the id.
    const row = installed.member.rpc.value[0];
    expect(Object.keys(row).sort()).toEqual(["actor_id", "channel_post_id", "created_at", "id", "private_message_id", "reaction", "source_kind", "task_message_id"]);
  }, runnerTimeout(120_000));

  it("refuses an oversized id list and needs a session", async () => {
    const many = Array.from({ length: 1001 }, (_, n) => id("d7210ddd", n));
    expect((await call(small.member, RPC, [many, [], []])).error).toBe("22023");
    expect((await call(small.member, RPC, [[], [], []])).value).toEqual([]);
    expect((await call(small.member, RPC, [null, null, null])).value).toEqual([]);
    expect((await call({ id: small.member.id, session: id("d7210eee", 1) }, RPC, [[], [], []])).error).toBe("42501");
  }, runnerTimeout(30_000));

  it("answers both first-load reads at 1,000 accounts in under 1 s with fixed helper work", async () => {
    await seedScale();
    const budget = runnerTimeout(1_000);
    const reactionTotal = Number((await db.query("select count(*) from public.member_message_reactions where actor_id::text like 'e7210000%'")).rows[0].count);
    const recordTotal = Number((await db.query("select count(*) from public.chapter_records where chapter_id like 'e7210000%'")).rows[0].count);
    expect(reactionTotal).toBeGreaterThan(2_000);
    expect(recordTotal).toBeGreaterThan(400);
    for (const [who, user] of Object.entries(scale)) {
      await call(user, BOOT_RECORDS);
      const records = await helperCalls(RECORD_HELPERS, () => call(user, BOOT_RECORDS));
      expect(records.result.error, `${who} records`).toBeUndefined();
      expect(records.result.value.length, `${who} records`).toBeGreaterThan(0);
      // One call per distinct chapter or scope in the table, not per row.
      expect(records.calls, `${who} records`).toBeLessThan(60);
      expect(records.result.ms, `${who} records`).toBeLessThan(budget);

      await bootReactions(user);
      const reactions = await helperCalls(REACTION_HELPERS, () => bootReactions(user));
      expect(reactions.result.error, `${who} reactions`).toBeUndefined();
      expect(reactions.result.value.length, `${who} reactions`).toBeGreaterThan(0);
      expect(reactions.calls, `${who} reactions`).toBeLessThan(20);
      expect(reactions.result.ms, `${who} reactions`).toBeLessThan(budget);
    }
    // The same reads under the predecessor policies call a helper per row.
    await withPredecessorPolicies(async () => {
      const records = await helperCalls(RECORD_HELPERS, () => call(scale.steward, BOOT_RECORDS));
      expect(records.calls).toBeGreaterThan(300);
      const reactions = await helperCalls(REACTION_HELPERS, () => bootReactions(scale.steward));
      expect(reactions.calls).toBeGreaterThan(300);
    });
  }, runnerTimeout(180_000));
});
