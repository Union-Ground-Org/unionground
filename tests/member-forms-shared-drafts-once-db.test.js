// @vitest-environment node
//
// BUG-UG-MEMBER-FORMS-POLICY-CHECKS-EVERY-ROW-20261108
// The web shell reads public.member_forms (the forms page) on every load.
// member_forms_select ran private.member_draft_shared_to_caller for every
// form its earlier branches rejected, and the restrictive
// member_forms_case_identity_scope ran
// private.member_form_scope_and_identity_allowed for every form (0.5 to 0.8 s
// on SAMPLE for 420 forms). 20261108110400 tests the draft-sharing branch
// only for the caller's shared drafts (private.caller_steward_share_form_ids,
// once per statement, from the share rows alone), and runs the restrictive scope check only for forms
// member_forms_select can admit (its branches without their per-row calls).
//
// 1. Every hat (form owner, chapter steward with shares, organization steward,
//    coordinator holding a share without steward coverage, another
//    organization's steward, accepted and invited co-signers, an aal1
//    session) sees exactly the forms the predecessor policies showed it, over
//    own, submitted, shared, returned, sealed, unshared, other-chapter,
//    other-organization and alliance grievance forms.
// 2. At 1,000 accounts plus 200 in another organization, with 3,600 forms,
//    the forms page runs both per-row checks only for the forms the caller
//    may read (the predecessor ran the scope check for every form) and
//    answers in under 1 s (runner-scaled) with the predecessor's rows.
// 3. member_forms_select is the table's only permissive read policy, which
//    the restrictive policy's guard relies on.
// Everything runs in one transaction that is rolled back.
import { migrateLegacyStewardFixtures } from "./helpers/steward-unit-fixtures.js";
import { assertScopedMemberEquivalence } from "./helpers/scoped-member-equivalence.js";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { assertDisposableProofUrl } from "../scripts/run-required-db-proofs.mjs";
import { runnerTimeout } from "../scripts/lib/runner-timeout.mjs";
import { loadScaledBudget, pairedFastest, reportPaired } from "./helpers/db-load-budget.mjs";

const live = process.env.SUPABASE_DB_URL ? describe : describe.skip;
const ALL = "select id from public.member_forms order by id";
const PAGE = `select id,user_id,template_key,template_version,status,answers,step,review_note,submitted_at,updated_at,filer_signed_at,
  filer_signature_digest,content_digest,artifact_digest,artifact_approved_at,artifact_approved_by
  from public.member_forms order by updated_at desc, id desc limit 200`;
// Both policies exactly as 20261102005607 left them
// (policy md5s 1a76efe2b86643d42e15798138d5551b and
// 086f71161ad5b6527b8ecf2ca82d98d0 under search_path pg_catalog, which the
// migration's preflight requires).
const PREDECESSOR = `alter policy member_forms_select on public.member_forms using ((((( SELECT auth.uid() AS uid) = user_id) OR ((template_key = 'alliance_grievance'::text) AND public.caller_is_accepted_cosigner(id)) OR ((status = ANY (ARRAY['submitted'::text, 'in_review'::text])) AND (user_id IN ( SELECT private.staff_visible_member_ids('steward'::text) AS staff_visible_member_ids))))) OR (private.member_draft_shared_to_caller(member_forms.*)));
alter policy member_forms_case_identity_scope on public.member_forms using (private.member_form_scope_and_identity_allowed(member_forms))`;
const SCALE_MEMBERS = 1000;
const OTHER_MEMBERS = 200;
const FORMS_PER_MEMBER = 3;

const id = (prefix, n) => `${prefix}-0000-4000-8000-${String(n).padStart(12, "0")}`;

live("member form reads check draft sharing and scope only for readable forms (#7502)", () => {
  let db;

  async function as(caller, sql, { aal = "aal2" } = {}) {
    await db.query("savepoint call");
    try {
      await db.query("select set_config('request.jwt.claims',$1,true)", [JSON.stringify({ sub: caller.id, role: "authenticated", aal, session_id: caller.session })]);
      await db.query("set local role authenticated");
      // The hosted authenticated role's limit.
      await db.query("set local statement_timeout = '30s'");
      const started = performance.now();
      const { rows } = await db.query(sql);
      return { ms: performance.now() - started, ids: rows.map((row) => row.id) };
    } finally {
      await db.query("rollback to savepoint call");
      await db.query("reset role");
    }
  }

  async function checkCalls(run) {
    const calls = async () => Object.fromEntries((await db.query(
      `select funcname, coalesce(sum(calls),0)::integer calls from pg_stat_xact_user_functions
        where schemaname = 'private' and funcname in ('member_draft_shared_to_caller','member_form_scope_and_identity_allowed') group by funcname`,
    )).rows.map((row) => [row.funcname, row.calls]));
    const before = await calls();
    const result = await run();
    const after = await calls();
    const delta = (name) => (after[name] ?? 0) - (before[name] ?? 0);
    return { result, shared: delta("member_draft_shared_to_caller"), scope: delta("member_form_scope_and_identity_allowed") };
  }

  // n members in five chapters of one organization (chapter = n mod 5), plus
  // `other` members in a sixth chapter of a second organization.
  async function seedOrganization(prefix, organization, members, { other = 0, staff = [] } = {}) {
    const user = (n) => `'${prefix}-0000-4000-8000-'||lpad((${n})::text,12,'0')`;
    const otherOrganization = id(`${prefix.slice(0, 7)}f`, 9);
    await db.query(`insert into public.organizations(id,slug,name,status) values ($1,$2,$2,'active'),($3,$4,$4,'active')`,
      [organization, `scale-${prefix}`, otherOrganization, `scale-${prefix}-other`]);
    await db.query(`insert into public.chapters(id,name,region,is_default,order_index,organization_id,slug)
      select '${prefix}-ch-'||n,'Scale chapter '||n,'scale',false,9500+n,
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
  let total;

  beforeAll(async () => {
    db = new pg.Client({ connectionString: assertDisposableProofUrl(process.env.SUPABASE_DB_URL), application_name: "member-forms-shared-drafts-once-proof" });
    await db.connect();
    await db.query("begin");
    await db.query("set local statement_timeout = '120s'");
    await db.query("set local track_functions = 'all'");
    // Fixture rows only; triggers resume before sessions and every read.
    await db.query("set local session_replication_role = replica");

    const smallOrg = id("d7502fff", 1);
    const seeded = await seedOrganization("d7502000", smallOrg, 30, {
      other: 6,
      staff: [
        { n: 1, chapterRole: "steward", chapter: 1, caller: "chapterSteward" },
        { n: 2, organizationRole: "steward", caller: "orgSteward" },
        { n: 3, chapterRole: "coordinator", chapter: 3, caller: "coordinator" },
        { n: 11, caller: "owner" },
        { n: 12, caller: "acceptedCosigner" },
        { n: 13, caller: "invitedCosigner" },
        { n: 31, chapterRole: "steward", chapter: 6, caller: "foreignSteward" },
      ],
    });
    small = seeded.callers;
    const owner = (n) => id("d7502000", n); // member n sits in chapter ((n - 1) % 5) + 1
    const chapter = (n) => `d7502000-ch-${n}`;
    smallForms = {
      shared: await insertForm("d7502000", 1, owner(11), { minutesAgo: 5 }),
      sharedReturned: await insertForm("d7502000", 2, owner(16), { status: "returned", minutesAgo: 3 }),
      sharedSubmitted: await insertForm("d7502000", 3, owner(21), { status: "submitted" }),
      sharedSealed: await insertForm("d7502000", 4, owner(26), { template: "fmla_self", version: 2 }),
      notShared: await insertForm("d7502000", 5, owner(6)),
      otherChapter: await insertForm("d7502000", 6, owner(12)),
      orgStewardChapter: await insertForm("d7502000", 7, owner(17)),
      otherOrganization: await insertForm("d7502000", 8, owner(32)),
      notCovered: await insertForm("d7502000", 9, owner(13)),
      ownService: await insertForm("d7502000", 10, owner(11), { template: "service_request", status: "approved" }),
      submittedChapterOne: await insertForm("d7502000", 11, owner(6), { status: "in_review" }),
      submittedChapterTwo: await insertForm("d7502000", 12, owner(7), { status: "submitted" }),
      alliance: await insertForm("d7502000", 13, owner(26), { template: "alliance_grievance", status: "submitted" }),
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
    // The coordinator holds a share but no steward role covering the owner.
    await share(smallForms.notCovered, small.coordinator.id, smallOrg, chapter(3));
    // Co-signers on the alliance grievance: one accepted, one still invited.
    await db.query(`insert into public.member_form_cosigners(form_id,invited_email,cosigner_user_id,status,invited_by,responded_at)
      values ($1,'d7502000-12@example.invalid',$2,'accepted',$4,now()),($1,'d7502000-13@example.invalid',$3,'invited',$4,null)`,
    [smallForms.alliance, small.acceptedCosigner.id, small.invitedCosigner.id, owner(26)]);

    const scaleOrg = id("e7502fff", 1);
    scale = (await seedOrganization("e7502000", scaleOrg, SCALE_MEMBERS, {
      other: OTHER_MEMBERS,
      staff: [
        ...Array.from({ length: 45 }, (_, index) => ({ n: index + 1, chapterRole: "steward", chapter: (index % 5) + 1 })),
        { n: 1, caller: "chapterSteward" },
        { n: 46, organizationRole: "steward", caller: "orgSteward" },
        { n: 300, caller: "member" },
        { n: SCALE_MEMBERS + 1, caller: "otherOrganization" },
      ],
    })).callers;
    // Three forms per account: a draft, a submitted grievance and an approved
    // service request, none shared.
    await db.query(`insert into public.member_forms(id,user_id,template_key,template_version,status,answers,step,created_at,updated_at)
      select ('e7502f0'||k||'-0000-4000-8000-'||lpad(n::text,12,'0'))::uuid,
        ('e7502000-0000-4000-8000-'||lpad(n::text,12,'0'))::uuid,
        case k when 3 then 'service_request' else 'grievance' end,1,
        case k when 1 then 'draft' when 2 then 'submitted' else 'approved' end,
        '{"summary":"Scale"}'::jsonb,1,now(),now() - make_interval(mins => n)
      from generate_series(1, $1::integer) n cross join generate_series(1, ${FORMS_PER_MEMBER}) k`, [SCALE_MEMBERS + OTHER_MEMBERS]);

    await db.query("set local session_replication_role = origin");
    await sessions(small);
    await sessions(scale);
    await db.query(`analyze public.member_forms, public.member_form_cosigners, private.member_draft_steward_shares, public.member_profiles, public.organization_memberships,
      public.member_chapter_memberships, public.member_role_chapters, public.organization_role_grants, public.chapters`);
    total = Number((await db.query("select count(*) from public.member_forms")).rows[0].count);

    // This broad-reader fixture is an
    // existing legacy grant; exercise its actual migration carry-over.
    await migrateLegacyStewardFixtures(db);
  }, runnerTimeout(120_000));

  afterAll(async () => {
    await db?.query("rollback").catch(() => {});
    await db?.end();
  });

  async function everyHat() {
    const result = {};
    for (const [hat, caller] of Object.entries(small)) result[hat] = (await as(caller, ALL)).ids;
    result.chapterStewardAal1 = (await as(small.chapterSteward, ALL, { aal: "aal1" })).ids;
    return result;
  }

  it("shows every hat exactly the forms the predecessor policies showed it", async () => {
    const installed = await everyHat();
    const sees = (hat, key) => installed[hat].includes(smallForms[key]);
    // The owner reads its own forms only.
    expect(sees("owner", "shared") && sees("owner", "ownService")).toBe(true);
    expect(installed.owner.every((formId) => [smallForms.shared, smallForms.ownService].includes(formId))).toBe(true);
    // The chapter steward reads its open shares and chapter one's submitted
    // forms; never a sealed share, an unshared draft or a share naming
    // another chapter.
    for (const key of ["shared", "sharedReturned", "sharedSubmitted", "submittedChapterOne", "alliance"]) expect(sees("chapterSteward", key), key).toBe(true);
    for (const key of ["sharedSealed", "notShared", "otherChapter", "submittedChapterTwo", "otherOrganization"]) expect(sees("chapterSteward", key), key).toBe(false);
    expect(sees("orgSteward", "orgStewardChapter")).toBe(true);
    expect(sees("foreignSteward", "otherOrganization")).toBe(true);
    expect(sees("foreignSteward", "shared")).toBe(false);
    expect(sees("coordinator", "notCovered")).toBe(false);
    // The accepted co-signer reads the alliance grievance; the invited one does not.
    expect(sees("acceptedCosigner", "alliance")).toBe(true);
    expect(sees("invitedCosigner", "alliance")).toBe(false);
    expect(installed.chapterStewardAal1).toEqual([]);

    await db.query("savepoint predecessor");
    try {
      await db.query(PREDECESSOR);
      const before = await everyHat();
      for (const hat of Object.keys(installed)) expect(installed[hat], hat).toEqual(before[hat]);
    } finally {
      await db.query("rollback to savepoint predecessor");
    }
  }, runnerTimeout(60_000));

  it("runs the per-row checks only for readable forms at 1,000 accounts, in under 1 s", async () => {
    // Scaled by a calibration query on a loaded machine.
    const { budget, calibrationMs } = await loadScaledBudget(db, 1_000, { label: "member forms shared drafts" });
    console.info("Member forms budget", JSON.stringify({ calibrationMs, budget }));
    expect(total).toBeGreaterThan(SCALE_MEMBERS * FORMS_PER_MEMBER);
    const alliance = Number((await db.query("select count(*) from public.member_forms where template_key = 'alliance_grievance'")).rows[0].count);
    const installed = {};
    for (const hat of ["member", "chapterSteward", "orgSteward", "otherOrganization"]) {
      const readable = (await as(scale[hat], ALL)).ids.length;
      expect(readable, hat).toBeGreaterThan(0);
      await as(scale[hat], PAGE);
      const { result, shared, scope } = await checkCalls(() => as(scale[hat], PAGE));
      // At most once per readable form, plus once per alliance grievance
      // (a template any caller may co-sign).
      expect(scope, hat).toBeLessThanOrEqual(readable + alliance);
      // The scope check is the only caller of the draft-sharing check here: no
      // draft is shared, and the share-id set never calls it per form.
      expect(shared, hat).toBeLessThanOrEqual(scope);
      // The best of three runs, each judged by a calibration taken beside it
      // on this connection (ledgers 254 and 319).
      const judged = await pairedFastest(db, result.ms, () => as(scale[hat], PAGE), { baseMs: 1_000, budget });
      reportPaired(`member forms shared drafts, ${hat}`, judged.runs);
      expect(judged.best.ms, `${hat} ${JSON.stringify(judged.runs)}`).toBeLessThan(judged.best.bound);
      installed[hat] = { ids: result.ids, readable };
    }

    await db.query("savepoint predecessor");
    try {
      await db.query(PREDECESSOR);
      for (const hat of Object.keys(installed)) {
        const { result, shared, scope } = await checkCalls(() => as(scale[hat], PAGE));
        expect(result.ids, hat).toEqual(installed[hat].ids);
        // The predecessor ran the scope check for every form in the table and
        // the draft-sharing check for every form the other branches rejected.
        expect(scope, hat).toBeGreaterThanOrEqual(total);
        expect(shared, hat).toBeGreaterThanOrEqual(total - installed[hat].readable);
      }
    } finally {
      await db.query("rollback to savepoint predecessor");
    }
  }, runnerTimeout(120_000));

  it("keeps member_forms_select the only permissive read policy on the table", async () => {
    const { rows } = await db.query(`select polname from pg_policy
      where polrelid = 'public.member_forms'::regclass and polpermissive and polcmd in ('r', '*') order by polname`);
    expect(rows.map((row) => row.polname)).toEqual(["member_forms_select"]);
  });

  it("matches the unchanged scalar scope oracle for every forms caller and role", async () => {
    for (const [fixture, callers] of [["small", small], ["scale", scale]]) {
      for (const [hat, caller] of Object.entries(callers)) {
        await db.query("savepoint scope_oracle");
        try {
          await db.query("select set_config('request.jwt.claims',$1,true)", [JSON.stringify({
            sub: caller.id, role: "authenticated", aal: "aal2", session_id: caller.session,
          })]);
          await db.query("set local role authenticated");
          await assertScopedMemberEquivalence(db, `${fixture}/${hat}`);
        } finally {
          await db.query("rollback to savepoint scope_oracle");
          await db.query("release savepoint scope_oracle");
        }
      }
    }
  }, 60_000);
});
