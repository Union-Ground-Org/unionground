// @vitest-environment node
//
// SEC-UG-THREAD-PIN-REVEALS-ANOTHER-CHAPTERS-THREAD-20261115 (#8901): public.set_chapter_thread_pinned
// read the thread by id with a row lock before any access check. A missing id was refused P0002 "thread
// unavailable", while another chapter's or organization's live thread was refused 42501 "staff role required"
// (a caller who is not staff) or 22023 "space unavailable" (staff of another chapter), so the refusal told that
// the thread exists. The lock taken first also made a caller wait on another organization's locked thread.
//
// Live proof against a disposable database (skipped without SUPABASE_DB_URL). The first part runs in one
// transaction that is rolled back. The second needs a thread another connection can lock, so it commits one
// other organization's thread and removes it afterwards.
import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { assertDisposableProofUrl } from "../scripts/run-required-db-proofs.mjs";
import { connectLocal } from "./helpers/local-lifecycle-contention.mjs";

const live = process.env.SUPABASE_DB_URL ? describe : describe.skip;

// [persona, organization roles, chapter roles]: chapter staff of the first chapter, and a member.
const PERSONAS = [
  ["staff", ["admin", "vp", "advisor", "coordinator", "steward"], []],
  ["steward", [], ["steward"]],
  ["coordinator", [], ["coordinator"]],
  ["president", [], ["vp"]],
  ["member", [], []],
];
const PIN = "select public.set_chapter_thread_pinned($1, true) as result";

// One person whose account exists: aal2 session, verified factor, membership and roles, profile chapter.
async function person(client, user, org, chapter, orgRoles = [], chapterRoles = []) {
  const session = randomUUID();
  await client.query("insert into auth.sessions (id, user_id, created_at, updated_at, aal) values ($1, $2, now(), now(), 'aal2')", [session, user]);
  await client.query(
    "insert into auth.mfa_factors (id, user_id, friendly_name, factor_type, status, created_at, updated_at) values ($1, $2, 'Thread pin proof factor', 'totp', 'verified', now(), now())",
    [randomUUID(), user],
  );
  await client.query("insert into public.organization_memberships (organization_id, user_id, status) values ($1, $2, 'active') on conflict do nothing", [org, user]);
  await client.query("insert into public.member_chapter_memberships (user_id, chapter_id, status) values ($1, $2, 'active')", [user, chapter]);
  await client.query("update public.member_profiles set chapter_id = $2, full_name = $3 where id = $1", [user, chapter, `Thread pin ${user.slice(0, 8)}`]);
  for (const role of orgRoles) {
    await client.query("insert into public.organization_role_grants (organization_id, user_id, role, granted_by) values ($1, $2, $3, $2)", [org, user, role]);
  }
  for (const role of [...orgRoles, ...chapterRoles]) {
    await client.query("insert into public.member_roles (user_id, role, chapter_id) values ($1, $2, $3) on conflict do nothing", [user, role, chapter]);
    await client.query("insert into public.member_role_chapters (user_id, role, chapter_id) values ($1, $2, $3) on conflict do nothing", [user, role, chapter]);
  }
  return { sub: user, role: "authenticated", session_id: session, aal: "aal2" };
}

async function organization(client, org, chapters, owner) {
  await client.query("insert into public.organizations (id, slug, name, created_by) values ($1, $2, $2, $3)", [org, chapters[0], owner]);
  for (const [index, chapter] of chapters.entries()) {
    await client.query(
      "insert into public.chapters (id, name, slug, organization_id, is_default, order_index) values ($1, $1, $1, $2, false, $3)",
      [chapter, org, 9930 + index],
    );
  }
}

// A channel and one thread in it, created by a person of the thread's chapter.
async function thread(client, creator, title) {
  const space = randomUUID();
  const id = randomUUID();
  // stamp_product_identity takes chapter and creator from auth.uid().
  await client.query("select set_config('request.jwt.claims', $1, true)", [JSON.stringify({ sub: creator, role: "authenticated" })]);
  await client.query("insert into public.chapter_spaces (id, name, visibility) values ($1, $2, 'chapter')", [space, title]);
  await client.query("insert into public.chapter_threads (id, space_id, title, kind) values ($1, $2, $3, 'topic')", [id, space, `${title} thread`]);
  await client.query("select set_config('request.jwt.claims', '', true)");
  return { space, id };
}

// The refusal one call gives, as { code, message }, in a savepoint that is rolled back.
async function refusal(client, claims, threadId) {
  await client.query("savepoint thread_pin_attempt");
  try {
    await client.query("select set_config('request.jwt.claims', $1, true)", [JSON.stringify(claims)]);
    await client.query("set local role authenticated");
    const { rows: [row] } = await client.query(PIN, [threadId]);
    return { code: "", message: "", result: row.result };
  } catch (error) {
    return { code: error.code, message: error.message };
  } finally {
    await client.query("rollback to savepoint thread_pin_attempt");
    await client.query("release savepoint thread_pin_attempt");
    await client.query("reset role");
  }
}

live("thread pinning refuses another chapter's or organization's thread as a missing one (#8901)", () => {
  let client;
  const orgA = randomUUID();
  const orgB = randomUUID();
  const chapters = { a1: `pin-a1-${orgA.slice(0, 8)}`, a2: `pin-a2-${orgA.slice(0, 8)}`, b: `pin-b-${orgB.slice(0, 8)}` };
  const owners = { a2: randomUUID(), b: randomUUID() };
  const sessions = {};
  const threads = {};

  beforeAll(async () => {
    client = new pg.Client({ connectionString: assertDisposableProofUrl(process.env.SUPABASE_DB_URL), ssl: false, application_name: "thread-pin-refusals-proof" });
    await client.connect();
    await client.query("begin");
    await client.query("set local statement_timeout = '60s'");
    await client.query("set local lock_timeout = '15s'");
    const users = Object.fromEntries(PERSONAS.map(([name]) => [name, randomUUID()]));
    for (const user of [...Object.values(users), ...Object.values(owners)]) {
      await client.query("insert into auth.users (id, email, raw_user_meta_data) values ($1, $2, '{}')", [user, `${user}@example.invalid`]);
    }
    await organization(client, orgA, [chapters.a1, chapters.a2], users.staff);
    await organization(client, orgB, [chapters.b], owners.b);
    for (const [name, orgRoles, chapterRoles] of PERSONAS) {
      sessions[name] = await person(client, users[name], orgA, chapters.a1, orgRoles, chapterRoles);
    }
    await person(client, owners.a2, orgA, chapters.a2, [], ["steward"]);
    await person(client, owners.b, orgB, chapters.b, ["admin"], ["steward"]);
    threads.own = await thread(client, users.staff, "Own chapter");
    threads.otherChapter = await thread(client, owners.a2, "Other chapter");
    threads.otherOrganization = await thread(client, owners.b, "Other organization");
  }, 120_000);

  afterAll(async () => {
    await client?.query("rollback").catch(() => {});
    await client?.end();
  });

  it("gives every persona the same refusal for a missing thread and for another chapter's or organization's live thread", async () => {
    const seen = {};
    for (const [name] of PERSONAS) {
      seen[name] = {
        missing: await refusal(client, sessions[name], randomUUID()),
        otherChapter: await refusal(client, sessions[name], threads.otherChapter.id),
        otherOrganization: await refusal(client, sessions[name], threads.otherOrganization.id),
      };
    }
    for (const [name] of PERSONAS) {
      const { missing, otherChapter, otherOrganization } = seen[name];
      expect(missing.code, `${name}: ${missing.message}`).not.toBe("");
      expect(otherChapter, name).toEqual(missing);
      expect(otherOrganization, name).toEqual(missing);
    }
    expect(seen.member.missing).toEqual({ code: "42501", message: "staff role required" });
    expect(seen.steward.missing).toEqual({ code: "P0002", message: "thread unavailable" });
  });

  it("still lets the channel's own chapter staff pin and unpin, and still refuses a member of that chapter", async () => {
    for (const name of ["staff", "steward", "coordinator", "president"]) {
      const pinned = await refusal(client, sessions[name], threads.own.id);
      expect(pinned, name).toMatchObject({ code: "", result: { threadId: threads.own.id, spaceId: threads.own.space } });
      expect(pinned.result.pinnedAt, name).not.toBeNull();
    }
    expect(await refusal(client, sessions.member, threads.own.id)).toEqual({ code: "42501", message: "staff role required" });
    const untouched = (await client.query("select id, pinned_at from public.chapter_threads where id = any($1::uuid[])",
      [[threads.otherChapter.id, threads.otherOrganization.id]])).rows;
    expect(untouched.map((row) => row.pinned_at)).toEqual([null, null]);
  });
});

// Another organization's thread, locked by its own chapter's writer: the caller's pin must be refused at once,
// exactly as a missing id is, without waiting on that lock. Before #8901 it waited for the lock and then failed
// with 55P03 instead, which also told that the thread exists.
live("thread pinning takes no lock on another organization's thread before refusing it (#8901)", () => {
  it("refuses another organization's locked thread at once, as a missing one, and leaves it untouched", async () => {
    const url = process.env.SUPABASE_DB_URL;
    const owner = await connectLocal(url, "thread-pin-owner");
    const holder = await connectLocal(url, "thread-pin-holder");
    const caller = await connectLocal(url, "thread-pin-caller");
    const org = randomUUID();
    const chapter = `pin-lock-${org.slice(0, 8)}`;
    const creator = randomUUID();
    let target;
    try {
      // Committed: the holder and the caller must both see this thread.
      await owner.query("begin");
      await owner.query("insert into auth.users (id, email, raw_user_meta_data) values ($1, $2, '{}')", [creator, `${creator}@example.invalid`]);
      await organization(owner, org, [chapter], creator);
      await owner.query("insert into public.organization_memberships (organization_id, user_id, status) values ($1, $2, 'active') on conflict do nothing", [org, creator]);
      await owner.query("insert into public.member_chapter_memberships (user_id, chapter_id, status) values ($1, $2, 'active')", [creator, chapter]);
      await owner.query("update public.member_profiles set chapter_id = $2 where id = $1", [creator, chapter]);
      target = await thread(owner, creator, "Locked elsewhere");
      await owner.query("commit");

      // The caller is staff of its own organization; its fixtures stay uncommitted in its own transaction.
      const callerOrg = randomUUID();
      const callerChapter = `pin-caller-${callerOrg.slice(0, 8)}`;
      const steward = randomUUID();
      await caller.query("begin");
      await caller.query("insert into auth.users (id, email, raw_user_meta_data) values ($1, $2, '{}')", [steward, `${steward}@example.invalid`]);
      await organization(caller, callerOrg, [callerChapter], steward);
      const claims = await person(caller, steward, callerOrg, callerChapter, [], ["steward"]);
      await caller.query("set local lock_timeout = '2s'");

      // The thread's own chapter writer holds its row lock.
      await holder.query("begin");
      await holder.query("select id from public.chapter_threads where id = $1 for update", [target.id]);

      const timed = async (threadId) => {
        const started = Date.now();
        const answer = await refusal(caller, claims, threadId);
        return { ...answer, ms: Date.now() - started };
      };
      const missing = await timed(randomUUID());
      const locked = await timed(target.id);
      await holder.query("rollback");

      expect({ code: locked.code, message: locked.message }).toEqual({ code: missing.code, message: missing.message });
      expect(missing).toMatchObject({ code: "P0002", message: "thread unavailable" });
      expect(locked.ms, `refused after ${locked.ms} ms`).toBeLessThan(1500);
      await caller.query("rollback");
      expect((await owner.query("select pinned_at from public.chapter_threads where id = $1", [target.id])).rows).toEqual([{ pinned_at: null }]);
    } finally {
      await holder.query("rollback").catch(() => {});
      await caller.query("rollback").catch(() => {});
      await owner.query("rollback").catch(() => {});
      // Remove the committed fixture. Rows depend on each other (the creator's profile names the
      // chapter, the organization names its creator), so the deletes run in passes until none fails.
      const removals = [
        ["delete from public.chapter_threads where id = $1", [target?.id ?? null]],
        ["delete from public.chapter_spaces where id = $1", [target?.space ?? null]],
        ["update public.member_profiles set chapter_id = null where id = $1", [creator]],
        ["delete from public.member_chapter_memberships where chapter_id = $1", [chapter]],
        ["delete from public.organization_memberships where organization_id = $1", [org]],
        // An active membership files the member's dues subject.
        ["delete from public.dues_member_subjects where organization_id = $1", [org]],
        ["delete from public.chapters where id = $1", [chapter]],
        ["delete from public.organizations where id = $1", [org]],
        ["delete from auth.users where id = $1", [creator]],
      ];
      let errors = [];
      for (let pass = 0; pass < 3; pass += 1) {
        errors = [];
        for (const [statement, values] of removals) {
          await owner.query(statement, values).catch((error) => errors.push(`${statement.split(" where")[0]}: ${error.code} ${error.message}`));
        }
        if (errors.length === 0) break;
      }
      const left = (await owner.query(
        "select (select count(*)::int from public.chapters where id = $1) + (select count(*)::int from public.organizations where id = $2) as n",
        [chapter, org],
      )).rows[0].n;
      await Promise.allSettled([owner.end(), holder.end(), caller.end()]);
      expect(left, `the committed fixture was not removed: ${errors.join("; ")}`).toBe(0);
    }
  }, 60_000);
});
