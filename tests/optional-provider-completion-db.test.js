// @vitest-environment node
import pg from "pg";
import { expect, it } from "vitest";

const databaseIt = process.env.RUN_OPTIONAL_PROVIDER_DB_TESTS === "1" ? it : it.skip;

const ids = {
  admin: "50970000-0000-4000-8000-000000000001",
  session: "50970000-0000-4000-8000-000000000011",
  organization: "50970000-0000-4000-8000-000000000101",
  foreignOrganization: "50970000-0000-4000-8000-000000000102",
  firstUpload: "50970000-0000-4000-8000-000000000201",
  secondUpload: "50970000-0000-4000-8000-000000000202",
  chapterlessUpload: "50970000-0000-4000-8000-000000000203",
  firstComplete: "50970000-0000-4000-8000-000000000211",
  secondComplete: "50970000-0000-4000-8000-000000000212",
  publishDecision: "50970000-0000-4000-8000-000000000220",
  keepDecision: "50970000-0000-4000-8000-000000000221",
  retireDecision: "50970000-0000-4000-8000-000000000222",
  authoredArticle: "50970000-0000-4000-8000-000000000230",
};

const originalArticles = [
  { clauseKey: "article:i", articleRef: "Article I", title: "Recognition", body: "Original one.", keywords: ["article", "recognition"] },
  { clauseKey: "article:ii", articleRef: "Article II", title: "Hours", body: "Original two.", keywords: ["article", "hours"] },
];

const changedWithInsertion = [
  { clauseKey: "section:0.1", articleRef: "Section 0.1", title: "Preamble", body: "New clause.", keywords: ["preamble", "section"] },
  { clauseKey: "article:i", articleRef: "Article I", title: "Recognition", body: "Changed one.", keywords: ["article", "recognition"] },
  { clauseKey: "article:ii", articleRef: "Article II", title: "Hours", body: "Original two.", keywords: ["article", "hours"] },
];

const canonicalWithRemoval = [
  changedWithInsertion[0],
  originalArticles[0],
];

function authenticatedClaims() {
  return JSON.stringify({
    sub: ids.admin,
    session_id: ids.session,
    role: "authenticated",
    aal: "aal2",
  });
}

async function asAuthenticated(client) {
  await client.query("reset role");
  await client.query("select set_config('request.jwt.claims', $1, true)", [authenticatedClaims()]);
  await client.query("set local role authenticated");
}

async function asServiceRole(client) {
  await client.query("reset role");
  await client.query("select set_config('request.jwt.claims', $1, true)", [JSON.stringify({ role: "service_role" })]);
  await client.query("set local role service_role");
}

async function expectState(client, label, query, values, state) {
  const savepoint = `optional_provider_${label}`;
  await client.query(`savepoint ${savepoint}`);
  try {
    await client.query(query, values);
    throw new Error(`${label}: expected SQLSTATE ${state}`);
  } catch (error) {
    expect(error.code, `${label}: ${error.message}`).toBe(state);
  } finally {
    await client.query(`rollback to savepoint ${savepoint}`);
    await client.query(`release savepoint ${savepoint}`);
  }
}

async function prepareContract(client, name, chapterId, prepareKey, completeKey) {
  await asAuthenticated(client);
  const prepared = (await client.query(`
    select public.prepare_steward_library_upload(
      $1, 1024, repeat('a', 64), $2, 'Disposable agreement proof',
      'contract', $3, $4
    ) value
  `, [name, name, prepareKey, chapterId])).rows[0].value;
  expect(prepared.chapterId).toBe(chapterId);
  // complete_steward_library_upload is gated on a current private_upload_scans
  // verdict for the stored object (SEC-UG-CLEANROOM-UPLOAD-SECURITY-
  // 20260904 slice 4), so this fixture now stands the object and its ledger row
  // up the way a real inspected upload would. The verdict itself is proved by
  // tests/private-file-workflow-gates-db.test.js; here it is only a precondition.
  const target = (await client.query(
    "select public.get_knowledge_file_storage_target($1, $2, 'upload') value",
    [prepared.fileId, prepared.storageHandle],
  )).rows[0].value;
  await client.query("reset role");
  await client.query(`
    insert into storage.objects (bucket_id, name, owner, version, metadata)
    values ($1, $2, $3, 'optional-provider-version', '{"size":1024,"mimetype":"application/pdf"}'::jsonb)
  `, [target.bucketId, target.objectName, ids.admin]);
  await client.query(`
    update private.private_upload_scans
    set status = 'clean', sha256 = repeat('a', 64), engine = 'ClamAV 1.5.4',
        signature_version = 28113, signature_updated_at = now(), scanned_at = now(),
        clean_until = now() + interval '1 hour'
    where bucket_id = $1 and object_name = $2
  `, [target.bucketId, target.objectName]);
  await asAuthenticated(client);
  const completed = (await client.query(
    "select public.complete_steward_library_upload($1, $2) value",
    [prepared.fileId, completeKey],
  )).rows[0].value;
  return completed.sourceId;
}

async function replaceAgreement(client, sourceId, articles) {
  await asServiceRole(client);
  return (await client.query(
    "select public.replace_cba_knowledge_drafts($1, $2, $3, $4, $5::jsonb) value",
    [ids.organization, sourceId, ids.admin, "optional-provider-b", JSON.stringify(articles)],
  )).rows[0].value;
}

databaseIt("keeps replacement CBA lineage stable and makes verified removals an explicit decision", async () => {
  const rawUrl = process.env.SUPABASE_DB_URL;
  expect(rawUrl).toBeTruthy();
  const url = new URL(rawUrl);
  expect(["127.0.0.1", "localhost"]).toContain(url.hostname);
  expect(Number(url.port)).toBeGreaterThanOrEqual(55000);
  expect(Number(url.port)).toBeLessThanOrEqual(59999);

  const client = new pg.Client({
    connectionString: rawUrl,
    application_name: "optional-provider-completion-rollback-proof",
  });
  await client.connect();
  await client.query("begin");
  try {
    await client.query(
      "insert into auth.users (id, email) values ($1, 'optional-provider-admin@example.invalid')",
      [ids.admin],
    );
    await client.query(`
      insert into public.organizations (id, slug, name, created_by) values
        ($1, 'optional-provider-proof', 'Optional Provider Proof', $3),
        ($2, 'optional-provider-foreign', 'Optional Provider Foreign', $3)
    `, [ids.organization, ids.foreignOrganization, ids.admin]);
    await client.query(`
      insert into public.chapters (id, name, slug, is_default, order_index, organization_id) values
        ('optional-provider-a', 'Optional Provider A', 'optional-provider-a', true, 1, $1),
        ('optional-provider-b', 'Optional Provider B', 'optional-provider-b', false, 2, $1),
        ('optional-provider-foreign', 'Optional Provider Foreign', 'optional-provider-foreign', false, 3, $2)
    `, [ids.organization, ids.foreignOrganization]);
    await client.query(
      "insert into public.organization_memberships (organization_id, user_id, status) values ($1, $2, 'active')",
      [ids.organization, ids.admin],
    );
    await client.query(`
      insert into public.member_chapter_memberships (user_id, chapter_id, status) values
        ($1, 'optional-provider-a', 'active'), ($1, 'optional-provider-b', 'active')
    `, [ids.admin]);
    await client.query(
      "update public.member_profiles set chapter_id = 'optional-provider-a', full_name = 'Optional Provider Admin' where id = $1",
      [ids.admin],
    );
    await client.query(`
      insert into public.organization_role_grants (organization_id, user_id, role, granted_by)
      values ($1, $2, 'admin', $2)
    `, [ids.organization, ids.admin]);
    await client.query(`
      insert into public.org_security_policy (id, organization_id, require_staff_mfa, updated_by)
      values (true, $1, false, $2)
    `, [ids.organization, ids.admin]);
    await client.query(`
      insert into auth.sessions (id, user_id, created_at, updated_at, aal)
      values ($1, $2, now(), now(), 'aal2')
    `, [ids.session, ids.admin]);

    await asAuthenticated(client);
    const chapters = (await client.query("select public.list_knowledge_upload_chapters() value")).rows[0].value;
    expect(chapters).toEqual([
      { id: "optional-provider-a", name: "Optional Provider A" },
      { id: "optional-provider-b", name: "Optional Provider B" },
    ]);
    await expectState(client, "cross_tenant_chapter", `
      select public.prepare_steward_library_upload(
        'foreign.txt', 1024, repeat('b', 64), 'Foreign', '',
        'contract', $1, 'optional-provider-foreign'
      )
    `, ["50970000-0000-4000-8000-000000000299"], "42501");

    const firstSource = await prepareContract(
      client, "agreement-v1.txt", "optional-provider-b", ids.firstUpload, ids.firstComplete,
    );
    const initial = await replaceAgreement(client, firstSource, originalArticles);
    expect(initial).toMatchObject({ articleCount: 2, stagedPublishedCount: 0 });

    await client.query("reset role");
    const draftStateBeforeRetry = await client.query(`
      select article.import_key, article.version, article.order_index,
        (select pg_catalog.count(*)::integer
         from public.member_kb_article_revisions revision
         where revision.article_id = article.id) revision_count
      from public.member_kb_articles article
      where article.chapter_id = 'optional-provider-b'
      order by article.import_key
    `);
    const unchangedRetry = await replaceAgreement(client, firstSource, originalArticles);
    expect(unchangedRetry).toMatchObject({ articleCount: 0 });
    await client.query("reset role");
    const draftStateAfterRetry = await client.query(`
      select article.import_key, article.version, article.order_index,
        (select pg_catalog.count(*)::integer
         from public.member_kb_article_revisions revision
         where revision.article_id = article.id) revision_count
      from public.member_kb_articles article
      where article.chapter_id = 'optional-provider-b'
      order by article.import_key
    `);
    expect(draftStateAfterRetry.rows).toEqual(draftStateBeforeRetry.rows);

    await client.query(`
      update public.member_kb_articles
      set status = 'published', verified_by = $1, verified_at = now(), updated_by = $1
      where chapter_id = 'optional-provider-b' and knowledge_source_id = $2
    `, [ids.admin, firstSource]);
    const originalRows = await client.query(`
      select id, import_key, body
      from public.member_kb_articles
      where chapter_id = 'optional-provider-b' and knowledge_source_id is not null
      order by article_ref
    `);
    const originalByKey = new Map(originalRows.rows.map((row) => [row.import_key, row]));
    const articleOneKey = (await client.query("select md5('clause:article:i') value")).rows[0].value;
    const articleTwoKey = (await client.query("select md5('clause:article:ii') value")).rows[0].value;
    const preambleKey = (await client.query("select md5('clause:section:0.1') value")).rows[0].value;

    // A chapter author may add material immediately after the imported
    // agreement. A later replacement that grows must shift that material,
    // rather than assigning an imported clause the same display position.
    await client.query(`
      insert into public.member_kb_articles (
        id, slug, kind, title, article_ref, body, keywords, order_index,
        chapter_id, status, is_sample, version, created_by, updated_by,
        content_origin
      ) values (
        $1, 'optional-provider-authored-faq', 'faq', 'Locally authored FAQ',
        'Chapter FAQ', 'Preserve this chapter-authored article.', '{}'::text[], 3,
        'optional-provider-b', 'draft', false, 1, $2, $2,
        'authored'
      )
    `, [ids.authoredArticle, ids.admin]);
    await asAuthenticated(client);
    const ownChapterSnapshot = (await client.query(
      "select public.list_accessible_knowledge_articles_snapshot(true, null) value",
    )).rows[0].value;
    expect(ownChapterSnapshot).toEqual([]);
    const staffSnapshot = (await client.query(
      "select public.list_accessible_knowledge_articles_snapshot(false, $1) value",
      ["optional-provider-b"],
    )).rows[0].value;
    expect(staffSnapshot.map((article) => article.title)).toEqual([
      "Recognition", "Hours", "Locally authored FAQ",
    ]);
    expect(staffSnapshot.every((article) => article.chapter_id === "optional-provider-b")).toBe(true);
    await expectState(client, "member_hat_cross_chapter_snapshot", `
      select public.list_accessible_knowledge_articles_snapshot(true, $1)
    `, ["optional-provider-b"], "42501");
    await expectState(client, "foreign_chapter_snapshot", `
      select public.list_accessible_knowledge_articles_snapshot(false, $1)
    `, ["optional-provider-foreign"], "42501");

    // Organization staff without a profile/home chapter must still be able to
    // operate the explicitly selected same-organization chapter end to end.
    await client.query("reset role");
    await client.query("savepoint selected_chapter_collections");
    await client.query("update public.member_profiles set chapter_id = null where id = $1", [ids.admin]);
    await asAuthenticated(client);
    const chapterlessPrepared = (await client.query(`
      select public.prepare_steward_library_upload(
        'chapterless-agreement.txt', 1024, repeat('d', 64),
        'Chapterless agreement', 'Storage authorization proof',
        'contract', $1, $2
      ) value
    `, [ids.chapterlessUpload, "optional-provider-b"])).rows[0].value;
    const chapterlessTarget = (await client.query(
      "select public.get_knowledge_file_storage_target($1, $2, 'upload') value",
      [chapterlessPrepared.fileId, chapterlessPrepared.storageHandle],
    )).rows[0].value;
    expect(chapterlessTarget).toMatchObject({
      bucketId: "organization-knowledge",
      fileId: chapterlessPrepared.fileId,
    });
    expect((await client.query(
      "select private.can_insert_organization_knowledge_object($1, $2) value",
      [chapterlessTarget.bucketId, chapterlessTarget.objectName],
    )).rows[0].value).toBe(true);
    expect((await client.query(
      "select private.can_read_organization_knowledge_object($1, $2) value",
      [chapterlessTarget.bucketId, chapterlessTarget.objectName],
    )).rows[0].value).toBe(true);
    expect((await client.query(
      "select private.can_delete_organization_knowledge_object($1, $2) value",
      [chapterlessTarget.bucketId, chapterlessTarget.objectName],
    )).rows[0].value).toBe(true);
    await client.query(`
      insert into storage.objects (bucket_id, name, owner)
      values ($1, $2, $3)
    `, [chapterlessTarget.bucketId, chapterlessTarget.objectName, ids.admin]);
    // Feature authorization remains true, but an unscanned object is not
    // readable. Only the Storage upload context may see its pending metadata.
    expect((await client.query(`
      select pg_catalog.count(*)::integer value
      from storage.objects
      where bucket_id = $1 and name = $2
    `, [chapterlessTarget.bucketId, chapterlessTarget.objectName])).rows[0].value).toBe(0);
    const previousStorageOperation = (await client.query("select current_setting('storage.operation', true) value")).rows[0].value;
    await client.query("select set_config('storage.operation', 'storage.object.upload', true)");
    expect((await client.query(`
      select pg_catalog.count(*)::integer value from storage.objects
      where bucket_id = $1 and name = $2
    `, [chapterlessTarget.bucketId, chapterlessTarget.objectName])).rows[0].value).toBe(1);
    await client.query("select set_config('storage.operation', $1, true)", [previousStorageOperation || ""]);

    const createdCollections = (await client.query(`
      select public.save_knowledge_collection(
        null, 'Selected chapter collection', 'Explicit context proof',
        'organization', 'chapter', $1
      ) value
    `, ["optional-provider-b"])).rows[0].value;
    const selectedCollection = createdCollections.find((collection) => (
      collection.title === "Selected chapter collection"
    ));
    expect(selectedCollection).toMatchObject({ chapterId: "optional-provider-b", items: [] });
    expect((await client.query(
      "select public.list_knowledge_collections() value",
    )).rows[0].value).not.toContainEqual(expect.objectContaining({ id: selectedCollection.id }));

    const placedCollections = (await client.query(`
      select public.set_knowledge_collection_item($1, 'kb_article', $2, true, 10, $3) value
    `, [selectedCollection.id, originalByKey.get(articleOneKey).id, "optional-provider-b"])).rows[0].value;
    expect(placedCollections.find((collection) => collection.id === selectedCollection.id)).toMatchObject({
      chapterId: "optional-provider-b",
      items: [expect.objectContaining({
        itemId: originalByKey.get(articleOneKey).id,
        kind: "kb_article",
      })],
    });
    await expectState(client, "collection_missing_selected_chapter", `
      select public.delete_knowledge_collection($1)
    `, [selectedCollection.id], "P0002");
    await expectState(client, "collection_cross_tenant_chapter", `
      select public.save_knowledge_collection(
        null, 'Foreign collection', '', 'organization', 'chapter', $1
      )
    `, ["optional-provider-foreign"], "42501");

    await client.query("reset role");
    await client.query("savepoint ambiguous_organization_context");
    await client.query(`
      insert into public.organization_memberships (organization_id, user_id, status)
      values ($1, $2, 'active')
    `, [ids.foreignOrganization, ids.admin]);
    await asAuthenticated(client);
    for (const helper of ["insert", "read", "delete"]) {
      expect((await client.query(
        `select private.can_${helper}_organization_knowledge_object($1, $2) value`,
        [chapterlessTarget.bucketId, chapterlessTarget.objectName],
      )).rows[0].value).toBe(false);
    }
    expect((await client.query(`
      select pg_catalog.count(*)::integer value
      from storage.objects
      where bucket_id = $1 and name = $2
    `, [chapterlessTarget.bucketId, chapterlessTarget.objectName])).rows[0].value).toBe(0);
    await expectState(client, "collection_ambiguous_organization", `
      select public.list_knowledge_collections($1)
    `, ["optional-provider-b"], "42501");
    await client.query("reset role");
    await client.query("rollback to savepoint ambiguous_organization_context");
    await client.query("release savepoint ambiguous_organization_context");
    await asAuthenticated(client);
    expect((await client.query(
      "select private.can_delete_organization_knowledge_object($1, $2) value",
      [chapterlessTarget.bucketId, chapterlessTarget.objectName],
    )).rows[0].value).toBe(true);
    const afterDelete = (await client.query(
      "select public.delete_knowledge_collection($1, $2) value",
      [selectedCollection.id, "optional-provider-b"],
    )).rows[0].value;
    expect(afterDelete).not.toContainEqual(expect.objectContaining({ id: selectedCollection.id }));
    await client.query("reset role");
    await client.query("rollback to savepoint selected_chapter_collections");
    await client.query("release savepoint selected_chapter_collections");

    // The aggregate is one database statement and has no former 500-row
    // boundary for a reconciliation to move between requests.
    await client.query("savepoint review_article_snapshot");
    await client.query(`
      insert into public.member_kb_articles (
        id, slug, kind, title, article_ref, body, keywords, order_index,
        chapter_id, status, is_sample, version, created_by, updated_by,
        content_origin
      )
      select
        extensions.gen_random_uuid(),
        'optional-provider-review-snapshot-' || item::text,
        'faq',
        'Snapshot article ' || item::text,
        'Snapshot ' || item::text,
        'Statement-consistent review snapshot proof.',
        '{}'::text[],
        1000 + item,
        'optional-provider-b',
        'draft',
        false,
        1,
        $1,
        $1,
        'authored'
      from pg_catalog.generate_series(1, 501) item
    `, [ids.admin]);
    await asAuthenticated(client);
    const completeReviewSnapshot = (await client.query(
      "select public.list_knowledge_review_articles_snapshot($1) value",
      ["optional-provider-b"],
    )).rows[0].value;
    expect(completeReviewSnapshot).toHaveLength(504);
    expect(completeReviewSnapshot.filter((article) => article.title.startsWith("Snapshot article "))).toHaveLength(501);
    await expectState(client, "review_snapshot_cross_tenant", `
      select public.list_knowledge_review_articles_snapshot($1)
    `, ["optional-provider-foreign"], "42501");
    await client.query("reset role");
    await client.query("rollback to savepoint review_article_snapshot");
    await client.query("release savepoint review_article_snapshot");

    await client.query("savepoint explicit_editor_chapter");
    await asAuthenticated(client);
    const createdArticle = (await client.query(`
      select pg_catalog.to_jsonb(public.save_chapter_kb_article(
        null::uuid, 'faq', 'Explicit chapter FAQ', 'Chapter B FAQ',
        'Only the explicitly authorized chapter may receive this article.',
        array['chapter-b'], 'draft', false, $1
      )) value
    `, ["optional-provider-b"])).rows[0].value;
    expect(createdArticle).toMatchObject({
      chapter_id: "optional-provider-b",
      title: "Explicit chapter FAQ",
      status: "draft",
      version: 1,
    });
    const retiredArticle = (await client.query(`
      select pg_catalog.to_jsonb(public.retire_chapter_kb_article($1, $2)) value
    `, [createdArticle.id, "optional-provider-b"])).rows[0].value;
    expect(retiredArticle).toMatchObject({
      chapter_id: "optional-provider-b",
      status: "retired",
      version: 2,
    });
    await expectState(client, "save_cross_tenant", `
      select public.save_chapter_kb_article(
        null::uuid, 'faq', 'Foreign FAQ', 'Foreign', 'Denied',
        '{}'::text[], 'draft', false, $1
      )
    `, ["optional-provider-foreign"], "42501");
    const editedAcrossChapter = (await client.query(`
      select to_jsonb(public.save_chapter_kb_article(
        $1, 'faq', 'Edited selected-chapter FAQ', 'Chapter FAQ',
        'The explicit chapter editor can reach this source.', '{}'::text[],
        'draft', false, $2
      )) value
    `, [ids.authoredArticle, "optional-provider-b"])).rows[0].value;
    expect(editedAcrossChapter).toMatchObject({
      id: ids.authoredArticle,
      chapter_id: "optional-provider-b",
      title: "Edited selected-chapter FAQ",
      version: 2,
    });
    const retiredAcrossChapter = (await client.query(
      "select to_jsonb(public.retire_chapter_kb_article($1, $2)) value",
      [ids.authoredArticle, "optional-provider-b"],
    )).rows[0].value;
    expect(retiredAcrossChapter).toMatchObject({
      id: ids.authoredArticle,
      chapter_id: "optional-provider-b",
      status: "retired",
      version: 3,
    });
    await client.query("rollback to savepoint explicit_editor_chapter");
    await client.query("release savepoint explicit_editor_chapter");
    await client.query("reset role");

    const secondSource = await prepareContract(
      client, "agreement-v2.txt", "optional-provider-b", ids.secondUpload, ids.secondComplete,
    );
    const changed = await replaceAgreement(client, secondSource, changedWithInsertion);
    expect(changed).toMatchObject({ stagedPublishedCount: 1, stagedRetirementCount: 0 });
    await client.query("reset role");
    const changedCandidate = await client.query(`
      select revision.article_id, revision.body
      from public.member_kb_article_revisions revision
      where revision.version = 0 and revision.import_candidate_key is not null
    `);
    expect(changedCandidate.rows).toEqual([{
      article_id: originalByKey.get(articleOneKey).id,
      body: "Changed one.",
    }]);
    const orderedRows = (await client.query(`
      select coalesce(import_key, 'manual-later') as key, order_index
      from public.member_kb_articles
      where chapter_id = 'optional-provider-b'
      order by order_index, id
    `)).rows;
    expect(orderedRows.map((row) => row.key)).toEqual([
      preambleKey, articleOneKey, articleTwoKey, "manual-later",
    ]);
    expect(new Set(orderedRows.map((row) => row.order_index)).size).toBe(orderedRows.length);
    expect((await client.query(`
      select order_index
      from public.member_kb_articles
      where id = $1
    `, [ids.authoredArticle])).rows[0]).toEqual({ order_index: 4 });
    expect((await client.query(`
      select pg_catalog.count(*)::integer total,
        pg_catalog.count(distinct order_index)::integer unique_count
      from public.member_kb_articles
      where chapter_id = 'optional-provider-b'
    `)).rows[0]).toEqual({ total: 4, unique_count: 4 });

    await client.query("savepoint explicit_review_chapter");
    await asAuthenticated(client);
    const reviewArticles = (await client.query(
      "select public.list_knowledge_review_articles_snapshot($1) value",
      ["optional-provider-b"],
    )).rows[0].value;
    expect(reviewArticles.map((article) => article.id)).toContain(originalByKey.get(articleOneKey).id);
    await expectState(client, "foreign_chapter_review_snapshot", `
      select public.list_knowledge_review_articles_snapshot($1)
    `, ["optional-provider-foreign"], "42501");
    const changedRevisions = (await client.query(
      "select public.list_chapter_kb_revisions($1, $2) value",
      [originalByKey.get(articleOneKey).id, "optional-provider-b"],
    )).rows[0].value;
    const changedRevision = changedRevisions.find((revision) => revision.importCandidate);
    expect(changedRevision).toMatchObject({ status: "draft", body: "Changed one." });
    await client.query(
      "select public.restore_chapter_kb_revision($1, $2, true, $3, $4)",
      [originalByKey.get(articleOneKey).id, changedRevision.id, ids.publishDecision, "optional-provider-b"],
    );
    await client.query("reset role");
    expect((await client.query(
      "select body, status from public.member_kb_articles where id = $1",
      [originalByKey.get(articleOneKey).id],
    )).rows[0]).toEqual({ body: "Changed one.", status: "published" });
    await client.query("rollback to savepoint explicit_review_chapter");
    await client.query("release savepoint explicit_review_chapter");

    const reconciled = await replaceAgreement(client, secondSource, canonicalWithRemoval);
    expect(reconciled).toMatchObject({
      clearedCandidateCount: 1,
      stagedPublishedCount: 0,
      stagedRetirementCount: 1,
    });
    await client.query("reset role");
    const currentRows = await client.query(`
      select id, import_key, body, status, order_index
      from public.member_kb_articles
      where chapter_id = 'optional-provider-b'
      order by import_key
    `);
    expect(currentRows.rows.find((row) => row.import_key === articleOneKey)).toMatchObject({
      id: originalByKey.get(articleOneKey).id,
      body: "Original one.",
      status: "published",
    });
    expect(currentRows.rows.find((row) => row.import_key === articleTwoKey)).toMatchObject({
      id: originalByKey.get(articleTwoKey).id,
      body: "Original two.",
      status: "published",
    });
    expect(currentRows.rows.find((row) => row.id === ids.authoredArticle)).toMatchObject({
      body: "Preserve this chapter-authored article.",
      status: "draft",
      order_index: 4,
    });
    expect(currentRows.rowCount).toBe(4);

    let retirement = (await client.query(`
      select id, article_id, status
      from public.member_kb_article_revisions
      where version = 0 and import_candidate_key is not null
    `)).rows[0];
    expect(retirement).toMatchObject({
      article_id: originalByKey.get(articleTwoKey).id,
      status: "retired",
    });

    await asAuthenticated(client);
    const revisions = (await client.query(
      "select public.list_chapter_kb_revisions($1, $2) value",
      [retirement.article_id, "optional-provider-b"],
    )).rows[0].value;
    expect(revisions[0]).toMatchObject({ importCandidate: true, status: "retired" });
    await client.query(
      "select public.restore_chapter_kb_revision($1, $2, false, $3, $4)",
      [retirement.article_id, retirement.id, ids.keepDecision, "optional-provider-b"],
    );
    await client.query("reset role");
    expect((await client.query(
      "select count(*)::integer value from public.member_kb_article_revisions where article_id = $1 and version = 0",
      [retirement.article_id],
    )).rows[0].value).toBe(0);
    expect((await client.query(
      "select status from public.member_kb_articles where id = $1",
      [retirement.article_id],
    )).rows[0].status).toBe("published");

    await replaceAgreement(client, secondSource, canonicalWithRemoval);
    await client.query("reset role");
    retirement = (await client.query(`
      select id, article_id, status
      from public.member_kb_article_revisions
      where article_id = $1 and version = 0 and import_candidate_key is not null
    `, [originalByKey.get(articleTwoKey).id])).rows[0];
    await asAuthenticated(client);
    await client.query(
      "select public.restore_chapter_kb_revision($1, $2, true, $3, $4)",
      [retirement.article_id, retirement.id, ids.retireDecision, "optional-provider-b"],
    );
    await client.query("reset role");
    expect((await client.query(`
      select status, version, verified_by, knowledge_source_id
      from public.member_kb_articles where id = $1
    `, [retirement.article_id])).rows[0]).toMatchObject({
      status: "retired",
      version: 2,
      verified_by: null,
      // 20260906029000. A retirement candidate copies the ARTICLE's text, so
      // confirming it keeps the article on its OWN content source. Before that
      // repair the candidate was stamped with the replacement agreement and
      // confirmation moved the article onto it, which laundered the first
      // source's language onto the second.
      knowledge_source_id: firstSource,
    });
    expect((await client.query(
      "select count(*)::integer value from public.member_kb_article_revisions where article_id = $1 and version = 0",
      [retirement.article_id],
    )).rows[0].value).toBe(0);
  } finally {
    await client.query("rollback");
    await client.end();
  }
});

databaseIt("records event-import failure without erasing active free-busy or opaque events", async () => {
  const rawUrl = process.env.SUPABASE_DB_URL;
  expect(rawUrl).toBeTruthy();
  const url = new URL(rawUrl);
  expect(["127.0.0.1", "localhost"]).toContain(url.hostname);
  expect(Number(url.port)).toBeGreaterThanOrEqual(55000);
  expect(Number(url.port)).toBeLessThanOrEqual(59999);

  const client = new pg.Client({
    connectionString: rawUrl,
    application_name: "optional-provider-calendar-import-error-proof",
  });
  await client.connect();
  await client.query("begin");
  try {
    await client.query(
      "insert into auth.users (id, email) values ($1, 'optional-provider-admin@example.invalid')",
      [ids.admin],
    );
    await client.query(`
      insert into public.member_calendar_connections (
        steward_id, provider, status, last_event_import_at,
        last_event_import_count, last_event_import_window_start,
        last_event_import_window_end, last_event_import_status
      ) values (
        $1, 'google', 'active', '2026-09-01T12:00:00Z',
        1, '2026-09-01T00:00:00Z', '2026-10-31T00:00:00Z', 'complete'
      )
    `, [ids.admin]);
    await client.query(`
      insert into public.member_calendar_busy (
        steward_id, provider, starts_at, ends_at
      ) values ($1, 'google', '2026-09-04T12:00:00Z', '2026-09-04T13:00:00Z')
    `, [ids.admin]);
    await client.query(`
      insert into public.member_calendar_import_events (
        steward_id, provider, provider_event_key, starts_at, ends_at
      ) values ($1, 'google', repeat('c', 64), '2026-09-05T12:00:00Z', '2026-09-05T13:00:00Z')
    `, [ids.admin]);

    await asServiceRole(client);
    await client.query(
      "select public.mark_calendar_import_error($1, 'google')",
      [ids.admin],
    );
    await client.query("reset role");

    const connection = (await client.query(`
      select status, last_event_import_status, last_event_import_at,
        last_event_import_count, last_event_import_window_start,
        last_event_import_window_end, last_event_import_error_at
      from public.member_calendar_connections
      where steward_id = $1 and provider = 'google'
    `, [ids.admin])).rows[0];
    expect(connection).toMatchObject({
      status: "active",
      last_event_import_status: "error",
      last_event_import_at: new Date("2026-09-01T12:00:00Z"),
      last_event_import_count: 1,
      last_event_import_window_start: new Date("2026-09-01T00:00:00Z"),
      last_event_import_window_end: new Date("2026-10-31T00:00:00Z"),
    });
    expect(connection.last_event_import_error_at).toBeInstanceOf(Date);
    expect((await client.query(
      "select count(*)::integer value from public.member_calendar_busy where steward_id = $1",
      [ids.admin],
    )).rows[0].value).toBe(1);
    expect((await client.query(
      "select count(*)::integer value from public.member_calendar_import_events where steward_id = $1",
      [ids.admin],
    )).rows[0].value).toBe(1);
  } finally {
    await client.query("rollback");
    await client.end();
  }
});

databaseIt("marks legacy calendar grants for re-consent without exposing private scopes", async () => {
  const rawUrl = process.env.SUPABASE_DB_URL;
  expect(rawUrl).toBeTruthy();
  const url = new URL(rawUrl);
  expect(["127.0.0.1", "localhost"]).toContain(url.hostname);
  expect(Number(url.port)).toBeGreaterThanOrEqual(55000);
  expect(Number(url.port)).toBeLessThanOrEqual(59999);

  const client = new pg.Client({
    connectionString: rawUrl,
    application_name: "optional-provider-calendar-scope-upgrade-proof",
  });
  await client.connect();
  await client.query("begin");
  try {
    await client.query(
      "insert into auth.users (id, email) values ($1, 'calendar-scope-upgrade@example.invalid')",
      [ids.admin],
    );
    await client.query(`
      insert into public.organizations (id, slug, name, created_by)
      values ($1, 'calendar-scope-upgrade', 'Calendar Scope Upgrade', $2)
    `, [ids.organization, ids.admin]);
    await client.query(`
      insert into public.chapters (id, name, slug, is_default, order_index, organization_id)
      values ('calendar-scope-upgrade', 'Calendar Scope Upgrade',
        'calendar-scope-upgrade', true, 9901, $1)
    `, [ids.organization]);
    await client.query(`
      insert into public.organization_memberships (organization_id, user_id, status)
      values ($1, $2, 'active')
    `, [ids.organization, ids.admin]);
    await client.query(`
      insert into public.member_chapter_memberships (user_id, chapter_id, status)
      values ($1, 'calendar-scope-upgrade', 'active')
    `, [ids.admin]);
    await client.query(`
      update public.member_profiles
      set chapter_id = 'calendar-scope-upgrade', full_name = 'Calendar Scope Steward'
      where id = $1
    `, [ids.admin]);
    await client.query(`
      insert into public.organization_role_grants (organization_id, user_id, role, granted_by)
      values ($1, $2, 'steward', $2)
    `, [ids.organization, ids.admin]);
    await client.query(`
      insert into public.org_security_policy (id, organization_id, require_staff_mfa, updated_by)
      values (true, $1, false, $2)
    `, [ids.organization, ids.admin]);
    await client.query(`
      insert into auth.sessions (id, user_id, created_at, updated_at, aal)
      values ($1, $2, now(), now(), 'aal2')
    `, [ids.session, ids.admin]);
    await client.query(`
      insert into public.member_calendar_connections (
        steward_id, provider, status, updated_at
      ) values
        ($1, 'google', 'active', pg_catalog.now() - interval '2 seconds'),
        ($1, 'microsoft', 'active', pg_catalog.now() - interval '1 second')
    `, [ids.admin]);
    await client.query(`
      insert into private.steward_calendar_oauth_tokens (
        steward_id, provider, refresh_token_ciphertext, scopes
      ) values
        ($1, 'google', repeat('g', 40), 'https://www.googleapis.com/auth/calendar.freebusy'),
        ($1, 'microsoft', repeat('m', 40), 'offline_access User.Read Calendars.ReadBasic')
    `, [ids.admin]);

    await asServiceRole(client);
    const initialInventory = (await client.query(
      "select public.list_steward_calendar_oauth_tokens() value",
    )).rows[0].value;
    expect(initialInventory.map((row) => row.provider)).toEqual(["google", "microsoft"]);
    expect(initialInventory.every((row) => "lastSyncAttemptAt" in row)).toBe(true);
    await client.query(
      "select public.mark_steward_calendar_sync_attempt($1, 'google')",
      [ids.admin],
    );
    const advancedInventory = (await client.query(
      "select public.list_steward_calendar_oauth_tokens() value",
    )).rows[0].value;
    expect(advancedInventory.map((row) => row.provider)).toEqual(["microsoft", "google"]);

    await asAuthenticated(client);
    const status = (await client.query(
      "select public.get_my_calendar_import_status() value",
    )).rows[0].value;
    expect(status).toEqual([
      expect.objectContaining({ provider: "google", scopeUpgradeRequired: true }),
      expect.objectContaining({ provider: "microsoft", scopeUpgradeRequired: false }),
    ]);
    expect(JSON.stringify(status)).not.toContain("calendar.freebusy");
    expect(status.every((row) => !("scopes" in row))).toBe(true);

    await client.query("reset role");
    await client.query(`
      update private.steward_calendar_oauth_tokens
      set scopes = 'https://www.googleapis.com/auth/calendar.readonly'
      where steward_id = $1 and provider = 'google'
    `, [ids.admin]);
    await asAuthenticated(client);
    const upgraded = (await client.query(
      "select public.get_my_calendar_import_status() value",
    )).rows[0].value;
    expect(upgraded[0]).toMatchObject({ provider: "google", scopeUpgradeRequired: false });
    expect(upgraded[1]).toMatchObject({ provider: "microsoft", scopeUpgradeRequired: false });
  } finally {
    await client.query("rollback");
    await client.end();
  }
});
