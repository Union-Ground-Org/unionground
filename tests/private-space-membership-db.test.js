// @vitest-environment node
//
// TEST-UG-PRIVATE-SPACE-MEMBERSHIP-RPCS-NO-LIVE-DB-PROOF-20260920
//
// 20260810201500_private_space_membership_management is still the only (and
// so the last) migration that defines private.assert_space_manager and the
// three staff membership RPCs for private chapter spaces. The offline pins in
// tests/private-space-membership-migration.test.js read that text, and the API
// and UI suites mock rpc(), so nothing executed the gate, the chapter bound,
// the archived and creator guards, or the search bounds. This proof calls the
// installed functions as real authenticated callers against an owned
// disposable stack, inside one transaction that is always rolled back.
import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { assertDisposableProofUrl } from "../scripts/run-required-db-proofs.mjs";

const live = process.env.RUN_PRIVATE_SPACE_MEMBERSHIP_DB_TESTS === "1" ? describe : describe.skip;

const LIST = "select public.list_chapter_space_members($1) value";
const SEARCH = "select public.search_chapter_space_members($1,$2,$3) value";
const SEARCH_DEFAULT = "select public.search_chapter_space_members($1,$2) value";
const SET = "select public.set_chapter_space_member($1,$2,$3) value";
const CAP_MEMBERS = 55;

live("private space membership RPCs (disposable database)", () => {
  let client;
  const id = Object.fromEntries([
    "org", "staffA", "staffB", "plain", "creator", "member", "candidate", "outsider",
    "spaceA", "spaceArchived", "spaceB",
  ].map((key) => [key, randomUUID()]));
  const sessions = {};
  const suffix = id.org.slice(0, 8);
  const chapterA = `space-proof-a-${suffix}`;
  const chapterB = `space-proof-b-${suffix}`;
  const capIds = Array.from({ length: CAP_MEMBERS }, () => randomUUID());

  async function as(user) {
    await client.query("reset role");
    await client.query("select set_config('request.jwt.claims',$1,true)", [JSON.stringify({
      role: "authenticated", sub: user, session_id: sessions[user], aal: "aal2",
    })]);
    await client.query("set local role authenticated");
  }

  let savepoint = 0;
  async function call(statement, params) {
    const label = `space_probe_${++savepoint}`;
    await client.query(`savepoint ${label}`);
    try {
      const result = await client.query(statement, params);
      await client.query(`release savepoint ${label}`);
      return { value: result.rows[0].value };
    } catch (error) {
      await client.query(`rollback to savepoint ${label}`);
      await client.query(`release savepoint ${label}`);
      return { code: error.code, message: error.message };
    }
  }

  async function members(space) {
    await client.query("reset role");
    const rows = await client.query(
      "select user_id, role from public.chapter_space_members where space_id=$1 order by user_id",
      [space],
    );
    return rows.rows;
  }

  const names = (value) => value.map((row) => row.fullName);

  beforeAll(async () => {
    client = new pg.Client({
      connectionString: assertDisposableProofUrl(process.env.SUPABASE_DB_URL),
      ssl: false,
      application_name: "private-space-membership-proof",
    });
    await client.connect();
    await client.query("begin");
    await client.query("set local statement_timeout = '60s'");
    await client.query("set local lock_timeout = '15s'");

    const people = [
      [id.staffA, chapterA, "Space Proof Steward A"],
      [id.staffB, chapterB, "Space Proof Steward B"],
      [id.plain, chapterA, "Space Proof Plain Member"],
      [id.creator, chapterA, "Quillon Creator"],
      [id.member, chapterA, "Quillon Member"],
      [id.candidate, chapterA, "Quillon Candidate"],
      [id.outsider, chapterB, "Quillon Outsider"],
      ...capIds.map((user, index) => [user, chapterA, `Capstone ${String(index).padStart(2, "0")}`]),
    ];
    await client.query(
      "insert into auth.users(id,email,raw_user_meta_data) select u, u::text || '@example.invalid', '{}' from unnest($1::uuid[]) u",
      [people.map(([user]) => user)],
    );
    await client.query(
      "insert into public.organizations(id,slug,name,created_by) values($1,$2,$2,$3)",
      [id.org, `space-proof-${suffix}`, id.staffA],
    );
    await client.query(
      `insert into public.chapters(id,name,slug,organization_id,is_default,order_index)
       values($1,$1,$1,$3,false,9910),($2,$2,$2,$3,false,9911)`,
      [chapterA, chapterB, id.org],
    );
    await client.query(
      `update public.member_profiles p set chapter_id=f.chapter_id, full_name=f.full_name
       from unnest($1::uuid[],$2::text[],$3::text[]) f(user_id,chapter_id,full_name) where p.id=f.user_id`,
      [people.map(([user]) => user), people.map(([, chapter]) => chapter), people.map(([, , name]) => name)],
    );
    await client.query(
      `insert into public.member_chapter_memberships(user_id,chapter_id,status)
       select f.user_id, f.chapter_id, 'active' from unnest($1::uuid[],$2::text[]) f(user_id,chapter_id)
       on conflict (user_id,chapter_id) do update set status='active', revoked_at=null`,
      [people.map(([user]) => user), people.map(([, chapter]) => chapter)],
    );
    await client.query(
      "insert into public.organization_memberships(organization_id,user_id,status) select $1, u, 'active' from unnest($2::uuid[]) u",
      [id.org, people.map(([user]) => user)],
    );
    // Chapter-scoped steward roles, one per chapter. Transaction-only fixture:
    // the grant triggers expect an admin granter this proof does not need.
    await client.query("set local session_replication_role = replica");
    for (const [user, chapter] of [[id.staffA, chapterA], [id.staffB, chapterB]]) {
      await client.query("insert into public.member_roles(user_id,role,chapter_id,granted_by) values($1,'steward',$2,$1)", [user, chapter]);
      await client.query("insert into public.member_role_chapters(user_id,role,chapter_id,granted_by) values($1,'steward',$2,$1)", [user, chapter]);
    }
    await client.query("set local session_replication_role = origin");
    for (const user of [id.staffA, id.staffB, id.plain]) {
      sessions[user] = randomUUID();
      await client.query("insert into auth.sessions(id,user_id,aal,created_at,updated_at) values($1,$2,'aal2',now(),now())", [sessions[user], user]);
      await client.query(
        "insert into auth.mfa_factors(id,user_id,friendly_name,factor_type,status,created_at,updated_at) values(gen_random_uuid(),$1,'space-proof-totp','totp','verified',now(),now())",
        [user],
      );
    }
    // private.stamp_product_identity takes a space's chapter and creator from
    // the caller's claims, so each space is inserted under its creator's sub.
    for (const [space, creator, name] of [
      [id.spaceA, id.creator, "Space proof private"],
      [id.spaceArchived, id.creator, "Space proof archived"],
      [id.spaceB, id.staffB, "Space proof chapter B"],
    ]) {
      await client.query("select set_config('request.jwt.claims',$1,true)", [JSON.stringify({ role: "authenticated", sub: creator })]);
      await client.query("insert into public.chapter_spaces(id,name,visibility) values($1,$2,'private')", [space, name]);
    }
    await client.query("select set_config('request.jwt.claims','',true)");
    await client.query("update public.chapter_spaces set archived_at=now() where id=$1", [id.spaceArchived]);
    const stamped = await client.query(
      "select id, chapter_id, created_by, archived_at is not null archived from public.chapter_spaces where id = any($1::uuid[]) order by name",
      [[id.spaceA, id.spaceArchived, id.spaceB]],
    );
    expect(stamped.rows).toEqual([
      { id: id.spaceArchived, chapter_id: chapterA, created_by: id.creator, archived: true },
      { id: id.spaceB, chapter_id: chapterB, created_by: id.staffB, archived: false },
      { id: id.spaceA, chapter_id: chapterA, created_by: id.creator, archived: false },
    ]);
    // The creator also holds a moderator row, so a removal that slipped past
    // the creator guard would delete a real row rather than nothing.
    await client.query(
      `insert into public.chapter_space_members(space_id,user_id,role) values
       ($1,$3,'moderator'),($1,$4,'member'),($2,$3,'moderator'),($2,$4,'member')
       on conflict (space_id,user_id) do update set role=excluded.role`,
      [id.spaceA, id.spaceArchived, id.creator, id.member],
    );
  }, 120_000);

  afterAll(async () => {
    if (!client) return;
    try { await client.query("rollback"); } finally { await client.end(); }
  });

  it("keeps private.assert_space_manager unexecutable by public, anon and authenticated", async () => {
    await client.query("reset role");
    const acl = await client.query(
      `select coalesce(bool_or(a.grantee = 0 and a.privilege_type = 'EXECUTE'), false) public_execute,
              has_function_privilege('anon', p.oid, 'EXECUTE') anon_execute,
              has_function_privilege('authenticated', p.oid, 'EXECUTE') authenticated_execute
         from pg_proc p left join lateral aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a on true
        where p.oid = 'private.assert_space_manager(uuid)'::regprocedure
        group by p.oid`,
    );
    expect(acl.rows[0]).toEqual({ public_execute: false, anon_execute: false, authenticated_execute: false });
    // A staff caller who would pass the gate still cannot call it directly.
    await as(id.staffA);
    const direct = await call("select private.assert_space_manager($1) value", [id.spaceA]);
    expect(direct.code, direct.message).toBe("42501");
    expect(direct.message).toMatch(/permission denied/);
  });

  it("lets a same-chapter steward list the space with its creator first", async () => {
    await as(id.staffA);
    const listed = await call(LIST, [id.spaceA]);
    expect(listed.code, listed.message).toBeUndefined();
    expect(listed.value).toEqual([
      expect.objectContaining({ userId: id.creator, fullName: "Quillon Creator", role: "creator" }),
      expect.objectContaining({ userId: id.member, fullName: "Quillon Member", role: "member" }),
    ]);
  });

  it("refuses list, search and set to an authenticated caller holding no publishing staff role", async () => {
    await as(id.plain);
    for (const [statement, params] of [
      [LIST, [id.spaceA]],
      [SEARCH, [id.spaceA, "quillon", 20]],
      [SET, [id.spaceA, id.candidate, true]],
      [SET, [id.spaceA, id.member, false]],
    ]) {
      const refused = await call(statement, params);
      expect(refused, statement).toMatchObject({ code: "42501", message: "staff role required" });
    }
    expect(await members(id.spaceA)).toEqual(
      [{ user_id: id.creator, role: "moderator" }, { user_id: id.member, role: "member" }]
        .sort((a, b) => a.user_id.localeCompare(b.user_id)),
    );
  });

  it("refuses a staff caller from another chapter on every entry point", async () => {
    // Positive control: the chapter B steward is staff for its own space.
    await as(id.staffB);
    const own = await call(LIST, [id.spaceB]);
    expect(own.code, own.message).toBeUndefined();
    expect(own.value).toEqual([expect.objectContaining({ userId: id.staffB, role: "creator" })]);
    const before = await members(id.spaceA);
    await as(id.staffB);
    for (const [statement, params] of [
      [LIST, [id.spaceA]],
      [SEARCH, [id.spaceA, "quillon", 20]],
      [SET, [id.spaceA, id.outsider, true]],
      [SET, [id.spaceA, id.candidate, true]],
      [SET, [id.spaceA, id.member, false]],
    ]) {
      const refused = await call(statement, params);
      expect(refused, statement).toMatchObject({ code: "22023", message: "space unavailable" });
    }
    expect(await members(id.spaceA)).toEqual(before);
  });

  it("search excludes existing members, the space creator and other chapters", async () => {
    await as(id.staffA);
    const found = await call(SEARCH, [id.spaceA, "quillon", 20]);
    expect(found.code, found.message).toBeUndefined();
    expect(found.value).toEqual([{ userId: id.candidate, fullName: "Quillon Candidate", initials: expect.any(String) }]);
    // Removing the ordinary member makes them a candidate again; the creator,
    // whose moderator row is untouched, stays excluded.
    const removed = await call(SET, [id.spaceA, id.member, false]);
    expect(removed.value).toEqual({ spaceId: id.spaceA, userId: id.member, member: false, changed: true });
    await as(id.staffA);
    expect(names((await call(SEARCH, [id.spaceA, "quillon", 20])).value)).toEqual(["Quillon Candidate", "Quillon Member"]);
    await as(id.staffA);
    const added = await call(SET, [id.spaceA, id.member, true]);
    expect(added.value).toEqual({ spaceId: id.spaceA, userId: id.member, member: true, changed: true });
    await as(id.staffA);
    expect(names((await call(SEARCH, [id.spaceA, "quillon", 20])).value)).toEqual(["Quillon Candidate"]);
    // The chapter B space's creator holds no membership row, so only the
    // creator exclusion keeps them out of their own space's search.
    await as(id.staffB);
    expect(names((await call(SEARCH, [id.spaceB, "space proof", 20])).value)).toEqual([]);
    await as(id.staffB);
    expect(names((await call(SEARCH, [id.spaceB, "quillon", 20])).value)).toEqual(["Quillon Outsider"]);
  });

  it("search enforces its two-character minimum after trimming", async () => {
    await as(id.staffA);
    for (const query of [null, "", "q", "  q  ", "   "]) {
      const refused = await call(SEARCH, [id.spaceA, query, 20]);
      expect(refused, JSON.stringify(query)).toMatchObject({ code: "22023", message: "query too short" });
    }
    const shortest = await call(SEARCH, [id.spaceA, "  qu  ", 20]);
    expect(shortest.code, shortest.message).toBeUndefined();
    expect(names(shortest.value)).toEqual(["Quillon Candidate"]);
  });

  it("search caps its result count server-side whatever limit the caller asks for", async () => {
    await as(id.staffA);
    const counts = {};
    for (const [label, statement, params] of [
      ["huge", SEARCH, [id.spaceA, "capstone", 1000]],
      ["fifty-one", SEARCH, [id.spaceA, "capstone", 51]],
      ["seven", SEARCH, [id.spaceA, "capstone", 7]],
      ["zero", SEARCH, [id.spaceA, "capstone", 0]],
      ["negative", SEARCH, [id.spaceA, "capstone", -5]],
      ["null", SEARCH, [id.spaceA, "capstone", null]],
      ["default", SEARCH_DEFAULT, [id.spaceA, "capstone"]],
    ]) {
      const result = await call(statement, params);
      expect(result.code, `${label}: ${result.message}`).toBeUndefined();
      counts[label] = result.value.length;
      expect(names(result.value), label).toEqual(names(result.value).toSorted());
    }
    expect(counts).toEqual({ huge: 50, "fifty-one": 50, seven: 7, zero: 1, negative: 1, null: 20, default: 20 });
    // The fixture really holds more matches than the cap.
    await client.query("reset role");
    const available = await client.query(
      "select count(*)::int n from public.member_profiles where chapter_id=$1 and full_name ilike 'Capstone %'",
      [chapterA],
    );
    expect(available.rows[0].n).toBe(CAP_MEMBERS);
  });

  it("refuses every membership change on an archived space", async () => {
    const before = await members(id.spaceArchived);
    await as(id.staffA);
    for (const [statement, params] of [
      [SET, [id.spaceArchived, id.candidate, true]],
      [SET, [id.spaceArchived, id.member, false]],
      [LIST, [id.spaceArchived]],
    ]) {
      const refused = await call(statement, params);
      expect(refused, statement).toMatchObject({ code: "22023", message: "space unavailable" });
    }
    expect(await members(id.spaceArchived)).toEqual(before);
    // The same change on the live space in the same chapter succeeds.
    await as(id.staffA);
    const added = await call(SET, [id.spaceA, id.candidate, true]);
    expect(added.value).toEqual({ spaceId: id.spaceA, userId: id.candidate, member: true, changed: true });
  });

  it("never removes the space creator", async () => {
    await as(id.staffA);
    const refused = await call(SET, [id.spaceA, id.creator, false]);
    expect(refused).toMatchObject({ code: "22023", message: "space creator cannot be removed" });
    expect(await members(id.spaceA)).toContainEqual({ user_id: id.creator, role: "moderator" });
    await as(id.staffA);
    const listed = await call(LIST, [id.spaceA]);
    expect(listed.value[0]).toMatchObject({ userId: id.creator, role: "creator" });
  });
});
