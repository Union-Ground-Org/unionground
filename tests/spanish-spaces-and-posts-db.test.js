// @vitest-environment node
// REQ-UG-SPANISH-SPACES-AND-POSTS-20261030: a chapter space's Spanish
// name and description and a channel post's Spanish body on a live database
// (supabase/migrations/20261030234500_spanish_spaces_and_posts.sql). Chapter
// staff write a space's Spanish version when they create it, or with the rest
// of the space in one call; a member cannot. A post's Spanish version is written
// with the post and never changes afterwards, for every role; the briefing
// invalidation, the account export and the cleanup row fingerprint all see it.
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

// Required proof (scripts/run-required-db-proofs.mjs): live whenever the
// owned disposable stack is named, rolled back afterwards.
const runLive = Boolean(process.env.SUPABASE_DB_URL);
const IDS = {
  org: "50963200-0000-4000-8000-000000000001",
  steward: "50963200-0000-4000-8000-000000000101",
  member: "50963200-0000-4000-8000-000000000102",
  outsider: "50963200-0000-4000-8000-000000000103",
};
const CHAPTER = "tamarack-spanish-spaces";
const OTHER_CHAPTER = "tamarack-spanish-spaces-b";
const SESSIONS = {
  [IDS.steward]: "50963200-0000-4000-8000-000000000901",
  [IDS.member]: "50963200-0000-4000-8000-000000000902",
  [IDS.outsider]: "50963200-0000-4000-8000-000000000903",
};

// The guard body from 20260907120000, before body_es joined it.
const PRE_SPANISH_GUARD = `
create or replace function private.guard_chapter_post_body_mutation()
returns trigger language plpgsql set search_path = '' as $function$
begin
  if private.chapter_post_edit_contract_active() then return new; end if;
  if new.body is distinct from old.body
     or new.edited_at is distinct from old.edited_at
     or new.deleted_at is distinct from old.deleted_at then
    raise exception 'chapter post body mutation is not permitted' using errcode = '42501';
  end if;
  return new;
end;
$function$`;

describe.skipIf(!runLive)("Spanish versions of chapter spaces and posts on a live database", () => {
  let client;

  async function callAs(userId, sql, values = []) {
    await client.query("savepoint spanish_probe");
    try {
      await client.query("select set_config('request.jwt.claims', $1, true)", [
        JSON.stringify({ sub: userId, role: "authenticated", aal: "aal2", session_id: SESSIONS[userId] }),
      ]);
      await client.query("set local role authenticated");
      const result = await client.query(sql, values);
      await client.query("reset role");
      await client.query("release savepoint spanish_probe");
      return { code: "", rows: result.rows };
    } catch (error) {
      await client.query("rollback to savepoint spanish_probe");
      return { code: error.code || "?", message: error.message || "", rows: [] };
    }
  }

  // As the table owner, inside a savepoint that is always rolled back.
  async function asOwner(work) {
    await client.query("savepoint spanish_owner");
    try {
      return await work();
    } catch (error) {
      return { code: error.code || "?", message: error.message || "" };
    } finally {
      await client.query("rollback to savepoint spanish_owner");
    }
  }

  async function asFixture(sql, values = []) {
    await client.query("savepoint spanish_fixture");
    await client.query("set local session_replication_role = replica");
    try {
      await client.query(sql, values);
    } catch (error) {
      await client.query("rollback to savepoint spanish_fixture");
      throw error;
    } finally {
      await client.query("set local session_replication_role = origin");
    }
    await client.query("release savepoint spanish_fixture");
  }

  let spaceId;
  let threadId;
  let postId;

  beforeAll(async () => {
    client = new pg.Client({ connectionString: process.env.SUPABASE_DB_URL, ssl: false, application_name: "spanish-spaces-and-posts-test" });
    await client.connect();
    await client.query("begin");
    const people = [IDS.steward, IDS.member, IDS.outsider];
    await client.query(
      `insert into auth.users (id, email) values
       ($1, 'spanish-spaces-steward@example.test'), ($2, 'spanish-spaces-member@example.test'), ($3, 'spanish-spaces-outsider@example.test')`,
      people,
    );
    await client.query("insert into public.organizations (id, slug, name, created_by) values ($1, 'spanish-spaces', 'Tamarack Valley Spanish Spaces', $2)", [IDS.org, IDS.steward]);
    await asFixture(
      "insert into public.chapters (id,name,slug,order_index,organization_id) values ($1,'Tamarack Spanish spaces',$1,904,$3), ($2,'Tamarack Spanish spaces B',$2,905,$3)",
      [CHAPTER, OTHER_CHAPTER, IDS.org],
    );
    await client.query("insert into public.chapter_workstreams(chapter_id,name) values ($1,'General'), ($2,'General') on conflict(chapter_id,name) do nothing", [CHAPTER, OTHER_CHAPTER]);
    await client.query(
      "update public.member_profiles set chapter_id = case when id = $2 then $4 else $3 end where id = any($1::uuid[])",
      [people, IDS.outsider, CHAPTER, OTHER_CHAPTER],
    );
    await client.query(
      `insert into public.member_chapter_memberships (user_id, chapter_id, status, pinned, last_selected_at)
       select id, case when id = $2 then $4 else $3 end, 'active', true, now() from pg_catalog.unnest($1::uuid[]) id
       on conflict (user_id, chapter_id) do update set status = 'active', revoked_at = null, last_selected_at = now()`,
      [people, IDS.outsider, CHAPTER, OTHER_CHAPTER],
    );
    await client.query(
      "insert into public.organization_memberships (organization_id, user_id) select $1::uuid, id from pg_catalog.unnest($2::uuid[]) id",
      [IDS.org, people],
    );
    await client.query(
      "insert into public.organization_role_grants (organization_id, user_id, role, granted_by, granted_at) values ($1,$2,'steward',$2, now() - interval '1 day')",
      [IDS.org, IDS.steward],
    );
    await client.query(
      `insert into auth.mfa_factors (id, user_id, friendly_name, factor_type, status, created_at, updated_at)
       select gen_random_uuid(), id, 'spanish-spaces-totp-' || id::text, 'totp', 'verified', now(), now()
       from pg_catalog.unnest($1::uuid[]) id`,
      [[IDS.steward]],
    );
    await client.query(
      `insert into auth.sessions (id, user_id, created_at, updated_at, aal)
       select (value ->> 'sessionId')::uuid, (value ->> 'userId')::uuid, now(), now(), 'aal2'
       from pg_catalog.jsonb_array_elements($1::jsonb) value`,
      [JSON.stringify(Object.entries(SESSIONS).map(([userId, sessionId]) => ({ userId, sessionId })))],
    );

    const space = await callAs(IDS.steward,
      `insert into public.chapter_spaces (name, description, visibility, name_es, description_es)
       values ('Night shift', 'Overnight staffing questions', 'chapter', 'Turno de noche', 'Preguntas sobre el personal de noche')
       returning id, name_es, description_es`);
    expect(space.code, space.message).toBe("");
    spaceId = space.rows[0].id;
    const thread = await callAs(IDS.steward,
      "insert into public.chapter_threads (space_id, title, kind) values ($1, 'Holdover rest', 'topic') returning id", [spaceId]);
    expect(thread.code, thread.message).toBe("");
    threadId = thread.rows[0].id;
    const post = await callAs(IDS.member,
      "insert into public.chapter_thread_posts (thread_id, body, body_es) values ($1, 'Rest before the next shift?', '¿Descanso antes del siguiente turno?') returning id, body_es",
      [threadId]);
    expect(post.code, post.message).toBe("");
    postId = post.rows[0].id;
  }, 30_000);

  afterAll(async () => {
    if (!client) return;
    await client.query("rollback");
    await client.end();
  });

  it("lets chapter staff create a space with its Spanish version, which chapter members read", async () => {
    const read = await callAs(IDS.member, "select name, name_es, description_es from public.chapter_spaces where id = $1", [spaceId]);
    expect(read.rows).toEqual([{ name: "Night shift", name_es: "Turno de noche", description_es: "Preguntas sobre el personal de noche" }]);
    const outside = await callAs(IDS.outsider, "select name_es from public.chapter_spaces where id = $1", [spaceId]);
    expect(outside.rows).toEqual([]);
  });

  it("saves a space's Spanish version with the space in one call, keeps it when omitted and clears it on empty", async () => {
    const save = (userId, args) => callAs(userId,
      "select public.update_chapter_space_content($1, 'Night shift', 'Overnight staffing questions', $2, false, $3, $4) result",
      [spaceId, args.visibility ?? "chapter", args.nameEs, args.descriptionEs]);
    const changed = await save(IDS.steward, { nameEs: " Turno nocturno ", descriptionEs: "" });
    expect(changed.code, changed.message).toBe("");
    expect(changed.rows[0].result).toMatchObject({ name_es: "Turno nocturno", description_es: null });
    const kept = await callAs(IDS.steward,
      "select public.update_chapter_space_content($1, 'Night shift', 'Overnight staffing questions', 'chapter', false) result", [spaceId]);
    expect(kept.rows[0].result).toMatchObject({ name_es: "Turno nocturno", description_es: null });
    // Visibility and the Spanish version change together, or not at all.
    const together = await save(IDS.steward, { visibility: "staff", nameEs: "Solo personal", descriptionEs: "Turnos" });
    expect(together.rows[0].result).toMatchObject({ visibility: "staff", name_es: "Solo personal", description_es: "Turnos" });
    const refused = await save(IDS.steward, { visibility: "chapter", nameEs: "x".repeat(81), descriptionEs: "Turnos" });
    expect(refused.code).toBe("23514");
    const after = await client.query("select visibility, name_es from public.chapter_spaces where id = $1", [spaceId]);
    expect(after.rows).toEqual([{ visibility: "staff", name_es: "Solo personal" }]);
    for (const userId of [IDS.member, IDS.outsider]) {
      expect((await save(userId, { nameEs: "Cambiado", descriptionEs: "" })).code, userId).toBe("42501");
    }
    // Back to a chapter space, so the members in the cases below can post.
    const restored = await save(IDS.steward, { visibility: "chapter", nameEs: "Turno de noche", descriptionEs: "" });
    expect(restored.code, restored.message).toBe("");
  });

  it("offers no direct update of a space's Spanish version", async () => {
    const direct = await callAs(IDS.steward, "update public.chapter_spaces set name_es = 'Cambiado' where id = $1", [spaceId]);
    expect(direct.code).toBe("42501");
    const signatures = await client.query(
      "select p.oid::regprocedure::text sig from pg_catalog.pg_proc p where p.proname = 'update_chapter_space_content' and p.pronamespace = 'public'::regnamespace");
    expect(signatures.rows.map((row) => row.sig)).toEqual(["update_chapter_space_content(uuid,text,text,text,boolean,text,text)"]);
  });

  it("bounds the Spanish fields like the originals", async () => {
    for (const [column, value] of [["name_es", "   "], ["name_es", "x".repeat(81)], ["description_es", "x".repeat(1001)]]) {
      const result = await callAs(IDS.steward, `insert into public.chapter_spaces (name, visibility, ${column}) values ('Bounds', 'chapter', $1)`, [value]);
      expect(result.code, `${column} ${value.length}`).toBe("23514");
    }
    for (const value of ["  ", "x".repeat(8001)]) {
      const result = await callAs(IDS.member, "insert into public.chapter_thread_posts (thread_id, body, body_es) values ($1, 'ok', $2)", [threadId, value]);
      expect(result.code, `body_es ${value.length}`).toBe("23514");
    }
    const constraints = await client.query(
      `select conname from pg_catalog.pg_constraint
       where conrelid in ('public.chapter_spaces'::regclass, 'public.chapter_thread_posts'::regclass) and conname like '%\\_es\\_bounded' order by conname`);
    expect(constraints.rows.map((row) => row.conname)).toEqual([
      "chapter_spaces_description_es_bounded", "chapter_spaces_name_es_bounded", "chapter_thread_posts_body_es_bounded",
    ]);
  });

  it("grants Spanish columns exactly beside the originals", async () => {
    const { rows } = await client.query(
      `select table_name, privilege_type, column_name from information_schema.column_privileges
       where table_schema = 'public' and grantee = 'authenticated' and column_name like '%\\_es'
         and privilege_type in ('INSERT', 'UPDATE') and table_name in ('chapter_spaces', 'chapter_thread_posts') order by 1, 2, 3`);
    expect(rows.map((row) => `${row.table_name}.${row.column_name}:${row.privilege_type}`)).toEqual([
      "chapter_spaces.description_es:INSERT", "chapter_spaces.name_es:INSERT",
      "chapter_thread_posts.body_es:INSERT",
    ]);
  });

  it("never lets a post's Spanish version change, not even for the table owner", async () => {
    const author = await callAs(IDS.member, "update public.chapter_thread_posts set body_es = 'Cambiado' where id = $1", [postId]);
    expect(author.code).toBe("42501");
    const owner = await asOwner(() => client.query("update public.chapter_thread_posts set body_es = 'Cambiado' where id = $1", [postId]));
    expect(owner).toMatchObject({ code: "42501", message: "chapter post body mutation is not permitted" });
    const cleared = await asOwner(() => client.query("update public.chapter_thread_posts set body_es = null where id = $1", [postId]));
    expect(cleared).toMatchObject({ code: "42501" });
    // An update that leaves the content alone (referential maintenance) still passes.
    const untouched = await asOwner(async () => {
      const result = await client.query("update public.chapter_thread_posts set body_es = body_es where id = $1", [postId]);
      return { code: "", count: result.rowCount };
    });
    expect(untouched).toEqual({ code: "", count: 1 });
    // Negative control: the guard as it stood before this delivery let the
    // Spanish version change, so this case would catch its return.
    const before = await asOwner(async () => {
      await client.query(PRE_SPANISH_GUARD);
      const result = await client.query("update public.chapter_thread_posts set body_es = 'Cambiado' where id = $1", [postId]);
      return { code: "", count: result.rowCount };
    });
    expect(before).toEqual({ code: "", count: 1 });
  });

  it("invalidates the channel briefing when the Spanish version changes, and only then", async () => {
    const trigger = await client.query(
      "select pg_catalog.pg_get_triggerdef(oid) def from pg_catalog.pg_trigger where tgrelid = 'public.chapter_thread_posts'::regclass and tgname = 'invalidate_message_briefings'");
    expect(trigger.rows[0].def).toContain("UPDATE OF body, body_es");
    const briefings = async () => (await client.query(
      "select count(*)::int n from public.compass_message_briefings where source_kind = 'channel' and target_id = $1", [threadId])).rows[0].n;
    const result = await asOwner(async () => {
      await asFixture(
        "insert into public.compass_message_briefings (organization_id, source_kind, target_id, summary) values ($1, 'channel', $2, 'Rest question')",
        [IDS.org, threadId]);
      const seeded = await briefings();
      await client.query("update public.chapter_thread_posts set body_es = body_es where id = $1", [postId]);
      const afterSame = await briefings();
      // The guard refuses a real change; switch it off inside this rolled-back
      // savepoint to watch the invalidation alone.
      await client.query("alter table public.chapter_thread_posts disable trigger chapter_thread_posts_guard_body_mutation");
      await client.query("update public.chapter_thread_posts set body_es = 'Otra versión' where id = $1", [postId]);
      return { seeded, afterSame, afterChange: await briefings() };
    });
    expect(result).toEqual({ seeded: 1, afterSame: 1, afterChange: 0 });
  });

  it("alerts on a keyword or @here that only the Spanish version carries", async () => {
    const enabled = await client.query(
      "select private.organization_feature_enabled($1, 'features.messaging.keyword_alerts') keywords, private.organization_feature_enabled($1, 'features.messaging.here_mentions') here",
      [IDS.org]);
    expect(enabled.rows[0]).toEqual({ keywords: true, here: true });
    const alerts = (keyword) => asOwner(async () => {
      await asFixture(
        `insert into public.chapter_space_notification_settings (organization_id, space_id, user_id, keywords)
         values ($1, $2, $3, $4) on conflict (space_id, user_id) do update set keywords = excluded.keywords`,
        [IDS.org, spaceId, IDS.steward, [keyword]]);
      const before = (await client.query("select count(*)::int n from public.member_notifications where user_id = $1 and copy_key = 'channel.keyword'", [IDS.steward])).rows[0].n;
      const { rows } = await client.query("select private.produce_channel_post_alerts($1) delivered", [postId]);
      const after = (await client.query("select count(*)::int n from public.member_notifications where user_id = $1 and copy_key = 'channel.keyword'", [IDS.steward])).rows[0].n;
      return { delivered: rows[0].delivered, keyword: after - before };
    });
    // "descanso" appears only in the Spanish version, "shift" only in the original.
    expect(await alerts("descanso")).toEqual({ delivered: 1, keyword: 1 });
    expect(await alerts("shift")).toEqual({ delivered: 1, keyword: 1 });
    expect(await alerts("aguinaldo")).toEqual({ delivered: 0, keyword: 0 });
    const source = await client.query("select pg_catalog.pg_get_functiondef('private.produce_channel_post_alerts(uuid)'::regprocedure) def");
    expect(source.rows[0].def).toContain("private.channel_body_has_here(post.body_es)");
    expect(source.rows[0].def).toContain("private.channel_keywords_match(post.body_es, s.keywords)");
  });

  it("finds a Spanish-only @here and a Spanish search term in Your mentions, with the Spanish versions", async () => {
    const enabled = await client.query(
      "select private.organization_feature_enabled($1, 'features.messaging.mention_search') search", [IDS.org]);
    expect(enabled.rows[0]).toEqual({ search: true });
    const hereOnly = await callAs(IDS.member,
      "insert into public.chapter_thread_posts (thread_id, body, body_es) values ($1, 'Meeting at noon', '@here Reunión al mediodía') returning id",
      [threadId]);
    expect(hereOnly.code, hereOnly.message).toBe("");
    const search = (query) => callAs(IDS.steward, "select public.search_my_channel_mentions($1, 30) result", [query]);
    const all = await search(null);
    expect(all.code, all.message).toBe("");
    expect(all.rows[0].result).toEqual([expect.objectContaining({
      postId: hereOnly.rows[0].id, reason: "here", body: "Meeting at noon", bodyEs: "@here Reunión al mediodía", spaceNameEs: "Turno de noche",
    })]);
    expect((await search("mediodía")).rows[0].result.map((hit) => hit.postId)).toEqual([hereOnly.rows[0].id]);
    expect((await search("noon")).rows[0].result.map((hit) => hit.postId)).toEqual([hereOnly.rows[0].id]);
    expect((await search("aguinaldo")).rows[0].result).toEqual([]);
  });

  it("exports the author's Spanish version and keeps it inside the cleanup row fingerprint", async () => {
    const manifest = await client.query(
      "select export_columns from private.account_lifecycle_manifest where schema_name = 'public' and table_name = 'chapter_thread_posts' and user_column = 'author_id'");
    expect(manifest.rows[0].export_columns).toContain("body_es");
    const exported = await client.query("select private.account_lifecycle_export_chapter_thread_posts($1) rows", [IDS.member]);
    expect(exported.rows[0].rows).toEqual(expect.arrayContaining([expect.objectContaining({ id: postId, body_es: "¿Descanso antes del siguiente turno?" })]));
    // scripts/lib/production-cleanup-content-invariant.mjs hashes (row_value)::text.
    const fingerprint = await client.query("select (row_value)::text as text from public.chapter_thread_posts row_value where id = $1", [postId]);
    expect(fingerprint.rows[0].text).toContain("¿Descanso antes del siguiente turno?");
  });

  it("keeps the lifecycle trigger review current for every changed definition", async () => {
    const { rows } = await client.query(
      `select r.object_name,
              r.definition_hash = case
                when r.kind = 'function' then pg_catalog.md5(pg_catalog.pg_get_functiondef(('private.' || pg_catalog.regexp_replace(r.object_name, 'p_post_id ', ''))::regprocedure))
                else (select pg_catalog.md5(pg_catalog.pg_get_triggerdef(t.oid) || ':' || t.tgenabled::text) from pg_catalog.pg_trigger t
                      where t.tgrelid = 'public.chapter_thread_posts'::regclass and t.tgname = r.object_name) end as current
       from private.account_lifecycle_trigger_review r
       where (r.kind = 'function' and r.schema_name = 'private' and r.object_name in ('guard_chapter_post_body_mutation()', 'invalidate_message_briefings()', 'produce_channel_post_alerts(p_post_id uuid)'))
          or (r.kind = 'trigger' and r.table_name = 'chapter_thread_posts' and r.object_name = 'invalidate_message_briefings')
       order by 1`);
    expect(rows).toHaveLength(4);
    expect(rows.every((row) => row.current)).toBe(true);
  });
});
