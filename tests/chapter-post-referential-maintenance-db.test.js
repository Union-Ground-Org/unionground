// @vitest-environment node
//
// SEC-UG-POST-BODY-MUTATION-AUDIT-20260904 — the live half of the revoke
// branch, against a disposable Supabase stack.
//
// tests/chapter-post-body-mutation-revoke-migration.test.js pins the migration's
// statement TEXT. Text pins cannot see the defect this file exists for: the
// first revision of private.guard_chapter_post_body_mutation() also compared
// author_id, parent_post_id, chapter_id, thread_id and created_at, and
// PostgreSQL performs a referential ON DELETE SET NULL / ON UPDATE CASCADE as a
// real UPDATE on the referencing table which fires ordinary row triggers. That
// guard therefore refused
//
//   * member account deletion for anyone who had ever posted in a chapter
//     thread (chapter_thread_posts.author_id references auth.users ON DELETE
//     SET NULL — set that way by 20260812180000_member_account_lifecycle
//     precisely because an earlier implementation broke this), and
//   * the deletion of any post that had replies (parent_post_id is a self-FK
//     ON DELETE SET NULL), which also breaks the SAMPLE and demo teardowns.
//
// Every offline gate in the batch stayed green while that was true. So this
// file drives the real triggers, and it re-installs the pre-repair guard body
// inside a rolled-back savepoint to prove the case would still catch a
// regression rather than passing for free.
import pg from "pg";
import { expect, it } from "vitest";

const databaseIt = process.env.RUN_CHAPTER_POST_REFERENTIAL_DB_TESTS === "1" ? it : it.skip;

const ids = {
  author: "50930000-0000-4000-8000-000000000001",
  space: "50930000-0000-4000-8000-000000000011",
  thread: "50930000-0000-4000-8000-000000000021",
  parentPost: "50930000-0000-4000-8000-000000000031",
  replyPost: "50930000-0000-4000-8000-000000000032",
};

// The guard exactly as it was before the repair, so the negative control is the
// real defect rather than an approximation of it.
const PRE_REPAIR_GUARD = `
create or replace function private.guard_chapter_post_body_mutation()
returns trigger
language plpgsql
set search_path = ''
as $function$
begin
  if private.chapter_post_edit_contract_active() then
    return new;
  end if;
  if new.body is distinct from old.body
     or new.edited_at is distinct from old.edited_at
     or new.deleted_at is distinct from old.deleted_at
     or new.thread_id is distinct from old.thread_id
     or new.chapter_id is distinct from old.chapter_id
     or new.author_id is distinct from old.author_id
     or new.parent_post_id is distinct from old.parent_post_id
     or new.created_at is distinct from old.created_at then
    raise exception 'chapter post body mutation is not permitted'
      using errcode = '42501';
  end if;
  return new;
end;
$function$;
`;

async function connect(applicationName) {
  const rawUrl = process.env.SUPABASE_DB_URL;
  expect(rawUrl).toBeTruthy();
  const url = new URL(rawUrl);
  // Never a shared or hosted database: the owned disposable loopback block only.
  expect(["127.0.0.1", "localhost"]).toContain(url.hostname);
  expect(Number(url.port)).toBeGreaterThanOrEqual(55000);
  expect(Number(url.port)).toBeLessThanOrEqual(59999);
  const client = new pg.Client({ connectionString: rawUrl, application_name: applicationName });
  await client.connect();
  return client;
}

// One author, one space, one thread, a parent post and a reply to it. Inserted
// through the real triggers, so chapter_id and author_id are stamped the way
// the product stamps them.
async function seedChapterThread(client) {
  // Owned rollback-only Tamarack fixtures; the retired IDs stay forbidden.
  await client.query("set local session_replication_role = replica");
  await client.query("insert into public.chapters (id,name,slug,order_index) values ('tamarack-post-proof-a','Tamarack proof A','tamarack-post-proof-a',901), ('tamarack-post-proof-b','Tamarack proof B','tamarack-post-proof-b',902) on conflict(id) do nothing");
  await client.query("set local session_replication_role = origin");
  await client.query(
    "insert into auth.users (id, email, raw_user_meta_data) values ($1, 'b03-referential-proof@example.invalid', '{}'::jsonb)",
    [ids.author],
  );
  // handle_new_member creates the profile; the fixture only needs it to resolve
  // a chapter so private.current_member_chapter() can stamp the rows.
  const profile = await client.query(
    "update public.member_profiles set chapter_id = 'tamarack-post-proof-a' where id = $1 returning id",
    [ids.author],
  );
  expect(profile.rowCount, "auth.users insert must have created a member profile").toBe(1);
  await client.query("select set_config('request.jwt.claims', $1, true)", [
    JSON.stringify({ sub: ids.author, role: "authenticated" }),
  ]);
  await client.query("insert into public.chapter_spaces (id, name) values ($1, 'B03 referential proof space')", [ids.space]);
  await client.query(
    "insert into public.chapter_threads (id, space_id, title) values ($1, $2, 'B03 referential proof thread')",
    [ids.thread, ids.space],
  );
  await client.query(
    "insert into public.chapter_thread_posts (id, thread_id, body) values ($1, $2, 'parent body')",
    [ids.parentPost, ids.thread],
  );
  await client.query(
    "insert into public.chapter_thread_posts (id, thread_id, body, parent_post_id) values ($1, $2, 'reply body', $3)",
    [ids.replyPost, ids.thread, ids.parentPost],
  );
}

async function refused(client, label, statement, values) {
  const savepoint = `b03_refused_${Math.random().toString(36).slice(2, 10)}`;
  await client.query(`savepoint ${savepoint}`);
  try {
    await client.query(statement, values);
    throw new Error(`expected ${label} to be refused`);
  } catch (error) {
    return { code: error.code, message: error.message };
  } finally {
    await client.query(`rollback to savepoint ${savepoint}`);
    await client.query(`release savepoint ${savepoint}`);
  }
}

databaseIt("passes referential ON DELETE SET NULL maintenance through the chapter-post body guard", async () => {
  const client = await connect("b03-chapter-post-referential-maintenance-proof");
  await client.query("begin");
  try {
    // The trigger really is installed and really is a BEFORE UPDATE row trigger
    // on this table, or everything below would pass vacuously.
    const trigger = await client.query(`
      select t.tgname, p.proname, t.tgtype
      from pg_catalog.pg_trigger t
      join pg_catalog.pg_proc p on p.oid = t.tgfoid
      where t.tgrelid = 'public.chapter_thread_posts'::regclass
        and t.tgname = 'chapter_thread_posts_guard_body_mutation'
        and not t.tgisinternal
    `);
    expect(trigger.rowCount).toBe(1);
    expect(trigger.rows[0].proname).toBe("guard_chapter_post_body_mutation");
    // tgtype bit 0 = BEFORE, bit 1 = FOR EACH ROW, bit 4 = UPDATE.
    expect(Number(trigger.rows[0].tgtype) & 0b10011).toBe(0b10011);

    // NEGATIVE CONTROL FIRST, in its own savepoint: re-install the pre-repair
    // guard and prove BOTH deletions fail against it. Without this a future
    // editor could restore the identity comparisons and this case would still
    // pass if the fixture stopped exercising the cascade. DDL is transactional,
    // so the rollback restores the shipped guard.
    await client.query("savepoint pre_repair_guard");
    await seedChapterThread(client);
    await client.query(PRE_REPAIR_GUARD);
    const parentDeleteRefusal = await refused(
      client,
      "the pre-repair guard to refuse a parent-post deletion",
      "delete from public.chapter_thread_posts where id = $1",
      [ids.parentPost],
    );
    expect(parentDeleteRefusal.code).toBe("42501");
    expect(parentDeleteRefusal.message).toContain("chapter post body mutation is not permitted");
    const authorDeleteRefusal = await refused(
      client,
      "the pre-repair guard to refuse an auth.users deletion",
      "delete from auth.users where id = $1",
      [ids.author],
    );
    expect(authorDeleteRefusal.code).toBe("42501");
    expect(authorDeleteRefusal.message).toContain("chapter post body mutation is not permitted");
    await client.query("rollback to savepoint pre_repair_guard");
    await client.query("release savepoint pre_repair_guard");

    // Now the shipped guard, on a clean fixture.
    await seedChapterThread(client);

    // (i) Deleting a post that has replies. parent_post_id is a self-FK ON
    // DELETE SET NULL, so PostgreSQL issues an UPDATE on the reply row.
    await client.query("delete from public.chapter_thread_posts where id = $1", [ids.parentPost]);
    const afterParentDelete = await client.query(
      "select id, parent_post_id, body from public.chapter_thread_posts where id = $1",
      [ids.replyPost],
    );
    expect(afterParentDelete.rowCount, "the reply must survive its parent").toBe(1);
    expect(afterParentDelete.rows[0].parent_post_id).toBeNull();
    expect(afterParentDelete.rows[0].body).toBe("reply body");

    // (ii) Deleting the author's auth.users row — what api/account-lifecycle.js
    // asks Supabase Auth to do at the end of an account deletion.
    await client.query("delete from auth.users where id = $1", [ids.author]);
    const afterAuthorDelete = await client.query(
      "select id, author_id, chapter_id, body from public.chapter_thread_posts where id = $1",
      [ids.replyPost],
    );
    expect(afterAuthorDelete.rowCount, "the post must survive the account deletion").toBe(1);
    expect(afterAuthorDelete.rows[0].author_id, "authorship is detached, not restored").toBeNull();
    expect(afterAuthorDelete.rows[0].chapter_id).toBe("tamarack-post-proof-a");
    expect(afterAuthorDelete.rows[0].body, "content is preserved; only attribution is removed").toBe("reply body");
  } finally {
    await client.query("rollback");
    await client.end();
  }
});

databaseIt("still refuses every chapter-post content mutation and keeps identity immutable", async () => {
  const client = await connect("b03-chapter-post-body-mutation-refusal-proof");
  await client.query("begin");
  try {
    await seedChapterThread(client);

    // The three columns the retired grant covered, refused for the table OWNER —
    // which is what makes the refusal bind service_role and any future definer
    // function rather than resting on the grant alone.
    for (const [label, statement] of [
      ["a body rewrite", "update public.chapter_thread_posts set body = 'rewritten' where id = $1"],
      ["an edited_at write", "update public.chapter_thread_posts set edited_at = now() where id = $1"],
      ["a deleted_at tombstone", "update public.chapter_thread_posts set deleted_at = now() where id = $1"],
    ]) {
      const refusal = await refused(client, label, statement, [ids.parentPost]);
      expect(refusal.code, `${label} must raise 42501`).toBe("42501");
      expect(refusal.message).toContain("chapter post body mutation is not permitted");
    }

    // And `authenticated` cannot even name the table in an UPDATE: the grant is
    // gone, so the guard is the second line, not the only one.
    await client.query("savepoint as_authenticated");
    await client.query("set local role authenticated");
    const grantRefusal = await refused(
      client,
      "an authenticated body rewrite",
      "update public.chapter_thread_posts set body = 'rewritten' where id = $1",
      [ids.parentPost],
    );
    expect(grantRefusal.code, "the table-level UPDATE grant must be gone").toBe("42501");
    expect(grantRefusal.message).toMatch(/permission denied for table chapter_thread_posts/i);
    await client.query("rollback to savepoint as_authenticated");
    await client.query("release savepoint as_authenticated");
    await client.query("reset role");

    // Narrowing the guard did not open an identity hole: private.stamp_product_identity
    // restores thread_id / chapter_id / author_id / created_at on an ordinary
    // (depth-1) UPDATE, so a direct identity rewrite is silently reverted rather
    // than applied. This is the assertion that has to fail if someone drops the
    // identity columns from the guard AND weakens the stamp.
    const rewrite = await client.query(
      `update public.chapter_thread_posts
          set author_id = null, chapter_id = 'tamarack-post-proof-b', thread_id = $1, created_at = '2020-01-01T00:00:00Z'
        where id = $2
        returning author_id, chapter_id, thread_id, created_at`,
      [ids.thread, ids.replyPost],
    );
    expect(rewrite.rowCount).toBe(1);
    expect(rewrite.rows[0].author_id, "author identity must survive a direct rewrite").toBe(ids.author);
    expect(rewrite.rows[0].chapter_id, "chapter identity must survive a direct rewrite").toBe("tamarack-post-proof-a");
    expect(rewrite.rows[0].thread_id).toBe(ids.thread);
    expect(new Date(rewrite.rows[0].created_at).getUTCFullYear()).toBeGreaterThan(2020);
  } finally {
    await client.query("rollback");
    await client.end();
  }
});
