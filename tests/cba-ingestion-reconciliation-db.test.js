// @vitest-environment node
import pg from "pg";
import { afterAll, beforeAll, expect, it } from "vitest";

const enabled = process.env.RUN_CBA_INGEST_DB_TESTS === "1";
const databaseIt = enabled ? it : it.skip;

const ids = {
  actor: "50913770-0000-4000-8000-000000000001",
  actorSession: "50913770-0000-4000-8000-000000000011",
  organization: "50913770-0000-4000-8000-000000000101",
  oldFile: "50913770-0000-4000-8000-000000000201",
  oldSource: "50913770-0000-4000-8000-000000000301",
  retryFile: "50913770-0000-4000-8000-000000000202",
  retrySource: "50913770-0000-4000-8000-000000000302",
  article: "50913770-0000-4000-8000-000000000401",
  prepareKey: "50913770-0000-4000-8000-000000000501",
  foreignPrepareKey: "50913770-0000-4000-8000-000000000502",
  restoreKey: "50913770-0000-4000-8000-000000000503",
  raceFileA: "50913770-0000-4000-8000-000000000211",
  raceFileB: "50913770-0000-4000-8000-000000000212",
  raceSourceA: "50913770-0000-4000-8000-000000000311",
  raceSourceB: "50913770-0000-4000-8000-000000000312",
};

const chapterA = "cba-proof-a";
const chapterB = "cba-proof-b";
const barrierKey = 5091377001;
let admin;

function databaseUrl() {
  const raw = process.env.SUPABASE_DB_URL;
  expect(raw).toBeTruthy();
  const url = new URL(raw);
  expect(["127.0.0.1", "localhost"]).toContain(url.hostname);
  expect(Number(url.port)).toBeGreaterThanOrEqual(55000);
  expect(Number(url.port)).toBeLessThanOrEqual(59999);
  return raw;
}

async function asRole(client, role, userId = null) {
  await client.query("reset role");
  await client.query("select set_config('request.jwt.claims', $1, true)", [JSON.stringify({
    role,
    ...(userId ? { sub: userId, session_id: ids.actorSession, aal: "aal2" } : {}),
  })]);
  await client.query(`set local role ${role}`);
}

async function seedContractSource(client, fileId, sourceId, chapterId, suffix) {
  await client.query(`
    insert into public.organization_knowledge_files (
      id, organization_id, chapter_id, library, title, summary, category,
      file_name, byte_size, content_sha256, storage_path, created_by
    ) values (
      $1, $2, $3, 'steward', $4, '', 'contract', $5, 128,
      repeat('a', 64), $6, $7
    )
  `, [
    fileId,
    ids.organization,
    chapterId,
    `Agreement ${suffix}`,
    `agreement-${suffix}.txt`,
    `org/${ids.organization}/${fileId}/agreement-${suffix}.txt`,
    ids.actor,
  ]);
  await client.query(`
    insert into public.organization_knowledge_sources (
      id, organization_id, file_id, source_kind, label
    ) values ($1, $2, $3, 'steward_file', $4)
  `, [sourceId, ids.organization, fileId, `Agreement ${suffix}`]);
  // 20260906024000 rechecks the ledger under the owning Storage row's lock
  // before either service-role completion RPC writes derived rows, and every
  // storage-derived read consults the same verdict. A contract source with no
  // object and no ledger row is therefore no longer a reconcilable fixture:
  // it is exactly the fail-closed case. Give this seed the real precondition —
  // a live object whose AFTER INSERT trigger mints the ledger row, promoted to
  // a current clean verdict — so the proof still exercises reconciliation
  // rather than the refusal, which tests/private-file-workflow-gates-db.test.js
  // proves separately.
  const objectName = `org/${ids.organization}/${fileId}/agreement-${suffix}.txt`;
  await client.query(`
    insert into storage.objects (bucket_id, name, owner, version, metadata)
    values ('organization-knowledge', $1, $2, $3, '{"size":128,"mimetype":"text/plain"}'::jsonb)
  `, [objectName, ids.actor, `cba-proof-version-${suffix}`]);
  await client.query(`
    update private.private_upload_scans
    set status = 'clean', sha256 = repeat('a', 64), engine = 'ClamAV 1.5.4',
        signature_version = 28113, signature_updated_at = pg_catalog.now(),
        scanned_at = pg_catalog.now(), clean_until = pg_catalog.now() + interval '1 hour'
    where bucket_id = 'organization-knowledge' and object_name = $1
  `, [objectName]);
}

async function seedPublishedArticle(client, sourceId, position, overrides = {}) {
  const articleId = overrides.articleId || ids.article;
  const clauseKey = overrides.clauseKey || ({ 1: "article:i", 2: "article:ii" }[position] ?? `article:${position}`);
  await client.query(`
    insert into public.member_kb_articles (
      id, slug, kind, title, article_ref, body, keywords, order_index,
      chapter_id, status, is_sample, version, created_by, updated_by,
      verified_by, verified_at, knowledge_source_id, import_key, content_origin
    ) values (
      $1, $2, 'contract', $3, $4, $5, $6, $7,
      $8, 'published', false, 3, $9, $9, $9, pg_catalog.now(),
      $10, pg_catalog.md5('clause:' || $11), 'derived'
    )
  `, [
    articleId,
    overrides.slug || `cba-proof-${position}-${articleId.slice(-6)}`,
    overrides.title || `Clause ${position}`,
    overrides.articleRef || `Article ${position}`,
    overrides.body || `Published clause ${position}`,
    overrides.keywords || ["published", `clause-${position}`],
    position,
    chapterA,
    ids.actor,
    sourceId,
    clauseKey,
  ]);
  return articleId;
}

async function replaceCba(client, sourceId, articles) {
  await asRole(client, "service_role", ids.actor);
  return (await client.query(
    `select public.replace_cba_knowledge_drafts($1, $2, $3, $4, $5::jsonb) as value`,
    [ids.organization, sourceId, ids.actor, chapterA, JSON.stringify(articles)],
  )).rows[0].value;
}

async function waitForAdvisoryWaiters(client, names) {
  for (let attempt = 0; attempt < 160; attempt += 1) {
    const waiting = await client.query(`
      select application_name
      from pg_catalog.pg_stat_activity
      where application_name = any($1::text[])
        and wait_event_type = 'Lock'
        and wait_event = 'advisory'
    `, [names]);
    if (waiting.rowCount === names.length) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error("both CBA reconciliation calls did not reach their advisory waits");
}

beforeAll(async () => {
  if (!enabled) return;
  admin = new pg.Client({ connectionString: databaseUrl(), application_name: "cba-proof-admin" });
  await admin.connect();
  await admin.query("begin");
  try {
    await admin.query(`
      insert into auth.users (id, email, raw_user_meta_data)
      values ($1, 'cba-ingest-proof@example.invalid', '{}'::jsonb)
    `, [ids.actor]);
    await admin.query(`
      insert into auth.sessions (id, user_id, created_at, updated_at, aal)
      values ($1, $2, pg_catalog.now(), pg_catalog.now(), 'aal2')
    `, [ids.actorSession, ids.actor]);
    await admin.query(`
      insert into public.organizations (id, slug, name, created_by)
      values ($1, 'cba-ingest-proof', 'CBA Ingest Proof', $2)
    `, [ids.organization, ids.actor]);
    await admin.query(`
      insert into public.chapters (id, name, slug, is_default, order_index, organization_id)
      values
        ($1, 'CBA Proof A', $1, false, 9801, $3),
        ($2, 'CBA Proof B', $2, false, 9802, $3)
    `, [chapterA, chapterB, ids.organization]);
    await admin.query(`
      insert into public.organization_memberships (organization_id, user_id, status)
      values ($1, $2, 'active')
    `, [ids.organization, ids.actor]);
    await admin.query(`
      insert into public.member_chapter_memberships (user_id, chapter_id, status)
      values ($1, $2, 'active')
    `, [ids.actor, chapterA]);
    await admin.query(`
      update public.member_profiles set chapter_id = $1 where id = $2
    `, [chapterA, ids.actor]);
    await admin.query(`
      insert into public.organization_role_grants (organization_id, user_id, role, granted_by)
      values ($1, $2, 'admin', $2)
    `, [ids.organization, ids.actor]);
    await admin.query(`
      insert into public.org_security_policy (id, organization_id, require_staff_mfa)
      values (true, $1, false)
    `, [ids.organization]);
    await admin.query("commit");
  } catch (error) {
    await admin.query("rollback");
    throw error;
  }
}, 30_000);

afterAll(async () => {
  if (admin) await admin.end();
});

databaseIt("binds a contract upload to an explicitly selected same-organization chapter", async () => {
  await admin.query("begin");
  try {
    await asRole(admin, "authenticated", ids.actor);
    const prepared = (await admin.query(`
      select public.prepare_steward_library_upload(
        'selected-chapter.txt', 128, repeat('b', 64), 'Selected chapter', '',
        'contract', $1, $2
      ) as value
    `, [ids.prepareKey, chapterB])).rows[0].value;
    await asRole(admin, "postgres");
    const stored = await admin.query(
      "select chapter_id from public.organization_knowledge_files where id = $1",
      [prepared.fileId],
    );
    expect(stored.rows).toEqual([{ chapter_id: chapterB }]);

    await admin.query("savepoint foreign_chapter");
    await asRole(admin, "authenticated", ids.actor);
    await expect(admin.query(`
      select public.prepare_steward_library_upload(
        'foreign-chapter.txt', 128, repeat('c', 64), 'Foreign chapter', '',
        'contract', $1, 'wor'
      )
    `, [ids.foreignPrepareKey])).rejects.toMatchObject({ code: "42501" });
    await admin.query("rollback to savepoint foreign_chapter");
  } finally {
    await admin.query("rollback");
  }
});

databaseIt("removes a superseded import candidate when a retry matches the published clause", async () => {
  await admin.query("begin");
  try {
    await asRole(admin, "postgres");
    await seedContractSource(admin, ids.oldFile, ids.oldSource, chapterA, "stale-old");
    await seedContractSource(admin, ids.retryFile, ids.retrySource, chapterA, "stale-retry");
    await seedPublishedArticle(admin, ids.oldSource, 1, {
      title: "Recognition",
      articleRef: "Article I",
      body: "Published recognition language.",
      keywords: ["article", "recognition"],
    });
    await admin.query(`
      insert into public.member_kb_article_revisions (
        article_id, chapter_id, version, status, kind, title, article_ref,
        body, keywords, changed_by, import_candidate_key, knowledge_source_id,
        reconciled_by_source_id, content_origin
      ) values (
        $1, $2, 0, 'draft', 'contract', 'Stale recognition', 'Article I',
        'Stale candidate language.', array['article','recognition'], $3,
        pg_catalog.md5('stale-candidate'), $4, $4, 'derived'
      )
    `, [ids.article, chapterA, ids.actor, ids.retrySource]);

    await replaceCba(admin, ids.retrySource, [{
      clauseKey: "article:i",
      articleRef: "Article I",
      title: "Recognition",
      body: "Published recognition language.",
      keywords: ["article", "recognition"],
    }]);
    await asRole(admin, "postgres");
    const candidate = await admin.query(`
      select id from public.member_kb_article_revisions
      where article_id = $1 and version = 0
    `, [ids.article]);
    expect(candidate.rows).toEqual([]);
  } finally {
    await admin.query("rollback");
  }
});

databaseIt("stages an omitted published clause as a confirmed retirement instead of changing it silently", async () => {
  await admin.query("begin");
  try {
    await asRole(admin, "postgres");
    await seedContractSource(admin, ids.oldFile, ids.oldSource, chapterA, "retire-old");
    await seedContractSource(admin, ids.retryFile, ids.retrySource, chapterA, "retire-retry");
    await seedPublishedArticle(admin, ids.oldSource, 2);

    await replaceCba(admin, ids.retrySource, [{
      clauseKey: "article:i",
      articleRef: "Article I",
      title: "Recognition",
      body: "Current first clause.",
      keywords: ["article", "recognition"],
    }]);
    await asRole(admin, "postgres");
    const article = await admin.query(
      "select status, version from public.member_kb_articles where id = $1",
      [ids.article],
    );
    expect(article.rows).toEqual([{ status: "published", version: 3 }]);
    const candidate = await admin.query(`
      select id, status, version, content_origin, knowledge_source_id,
             reconciled_by_source_id, import_candidate_key
      from public.member_kb_article_revisions
      where article_id = $1 and version = 0
    `, [ids.article]);
    // 20260906029000. The candidate's TEXT is copied off the published article,
    // which is derived from ids.oldSource, so that is what its content
    // provenance must name — the round-3 review found this row stamped with the
    // REPLACEMENT source, which laundered the old source's language onto the
    // replacement once the old one lapsed. The replacement is the source of the
    // retirement DECISION and is recorded in its own column, which is also what
    // the candidate key already binds the row to.
    expect(candidate.rows).toEqual([expect.objectContaining({
      status: "retired",
      version: 0,
      content_origin: "derived",
      knowledge_source_id: ids.oldSource,
      reconciled_by_source_id: ids.retrySource,
    })]);
    const expectedKey = (await admin.query(
      "select pg_catalog.md5('retire:' || $1::text || ':' || article.import_key) key"
      + " from public.member_kb_articles article where article.id = $2",
      [ids.retrySource, ids.article],
    )).rows[0].key;
    expect(candidate.rows[0].import_candidate_key).toBe(expectedKey);

    await asRole(admin, "authenticated", ids.actor);
    const restored = (await admin.query(
      "select public.restore_chapter_kb_revision($1, $2, true, $3) as value",
      [ids.article, candidate.rows[0].id, ids.restoreKey],
    )).rows[0].value;
    // Confirming the retirement keeps the article on its OWN source and writes
    // the canonical retirement revision derived from it.
    expect(restored).toMatchObject({
      status: "retired",
      version: 4,
      knowledge_source_id: ids.oldSource,
    });
    await asRole(admin, "postgres");
    expect((await admin.query(`
      select content_origin, knowledge_source_id, reconciled_by_source_id
      from public.member_kb_article_revisions
      where article_id = $1 and version = 4
    `, [ids.article])).rows).toEqual([{
      content_origin: "derived",
      knowledge_source_id: ids.oldSource,
      reconciled_by_source_id: null,
    }]);
    await asRole(admin, "authenticated", ids.actor);
    await asRole(admin, "postgres");
    const pendingCandidate = await admin.query(`
      select id from public.member_kb_article_revisions
      where article_id = $1 and version = 0
    `, [ids.article]);
    expect(pendingCandidate.rows).toEqual([]);
  } finally {
    await admin.query("rollback");
  }
});

databaseIt("serializes first-time clause lineage creation across concurrent contract sources", async () => {
  await admin.query("begin");
  try {
    await seedContractSource(admin, ids.raceFileA, ids.raceSourceA, chapterA, "race-a");
    await seedContractSource(admin, ids.raceFileB, ids.raceSourceB, chapterA, "race-b");
    await admin.query(`
      create function private.cba_ingest_proof_barrier()
      returns trigger
      language plpgsql
      set search_path = ''
      as $function$
      begin
        if new.knowledge_source_id in (
          '${ids.raceSourceA}'::uuid,
          '${ids.raceSourceB}'::uuid
        ) then
          perform pg_catalog.pg_advisory_xact_lock(${barrierKey}::bigint);
        end if;
        return new;
      end;
      $function$;
      create trigger cba_ingest_proof_barrier
      before insert on public.member_kb_articles
      for each row execute function private.cba_ingest_proof_barrier();
    `);
    await admin.query("commit");
  } catch (error) {
    await admin.query("rollback");
    throw error;
  }

  const clientA = new pg.Client({ connectionString: databaseUrl(), application_name: "cba-proof-race-a" });
  const clientB = new pg.Client({ connectionString: databaseUrl(), application_name: "cba-proof-race-b" });
  let released = false;
  let calls = [];
  await clientA.connect();
  await clientB.connect();
  try {
    await admin.query("select pg_catalog.pg_advisory_lock($1::bigint)", [barrierKey]);
    const run = async (client, sourceId, title) => {
      await client.query("begin");
      try {
        const result = await replaceCba(client, sourceId, [{
          clauseKey: "article:i",
          articleRef: "Article I",
          title,
          body: `${title} body.`,
          keywords: ["article", "one"],
        }]);
        await client.query("commit");
        return result;
      } catch (error) {
        await client.query("rollback");
        throw error;
      }
    };
    calls = [
      run(clientA, ids.raceSourceA, "First source"),
      run(clientB, ids.raceSourceB, "Second source"),
    ];
    await waitForAdvisoryWaiters(admin, ["cba-proof-race-a", "cba-proof-race-b"]);
    await admin.query("select pg_catalog.pg_advisory_unlock($1::bigint)", [barrierKey]);
    released = true;
    await Promise.all(calls);

    const rows = await admin.query(`
      select id
      from public.member_kb_articles
      where chapter_id = $1 and import_key = pg_catalog.md5('clause:article:i')
        and knowledge_source_id in ($2, $3)
    `, [chapterA, ids.raceSourceA, ids.raceSourceB]);
    expect(rows.rowCount).toBe(1);
  } finally {
    if (!released) {
      await admin.query("select pg_catalog.pg_advisory_unlock($1::bigint)", [barrierKey]).catch(() => {});
    }
    await Promise.allSettled(calls);
    await clientA.end();
    await clientB.end();
    await admin.query("drop trigger if exists cba_ingest_proof_barrier on public.member_kb_articles");
    await admin.query("drop function if exists private.cba_ingest_proof_barrier()");
  }
}, 20_000);
