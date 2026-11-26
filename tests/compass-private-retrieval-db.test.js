// @vitest-environment node
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { fnBody, loadMigrationSql, migrationNames } from "./helpers/migration.js";
import { assertDisposableProofUrl } from "../scripts/run-required-db-proofs.mjs";

// Real PostgreSQL ranking/RLS, in a database owned by this test. No production
// schemas or real accounts are used, even when run by the required CI lane.
describe.skipIf(process.env.RUN_COMPASS_RETRIEVAL_DB_TESTS !== "1")("Compass private-source retrieval", () => {
  let admin;
  let client;
  let database;
  beforeAll(async () => {
    const connectionString = assertDisposableProofUrl(process.env.SUPABASE_DB_URL);
    admin = new pg.Client({ connectionString });
    await admin.connect();
    database = `compass_retrieval_${process.pid}_${Date.now()}`;
    await admin.query(`create database ${database} template template0`);
    const url = new URL(connectionString); url.pathname = `/${database}`;
    client = new pg.Client({ connectionString: url.toString() });
    await client.connect();
    await client.query(`
      create schema private; create schema auth;
      create function private.current_member_chapter() returns text language sql stable as $$ select 'chapter-a'::text $$;
      create function auth.uid() returns uuid language sql stable as $$ select '00000000-0000-4000-8000-000000000001'::uuid $$;
      -- 20260906024000 binds Storage-derived imported clauses to the ledger
      -- verdict of the organization-knowledge object they were extracted from.
      -- This fixture stands the predicate up as a table-driven stub: the real
      -- ledger arithmetic is proved against the real schema in
      -- tests/private-file-workflow-gates-db.test.js. Here it only has to
      -- answer for a source, so the retrieval boundary itself can be proved.
      create table private.knowledge_source_verdicts (source_id uuid primary key, is_current boolean not null);
      create function private.knowledge_source_verdict_current(p_source_id uuid)
        returns boolean language sql stable security definer as $$
          select case when p_source_id is null then true
            else coalesce((select v.is_current from private.knowledge_source_verdicts v
                           where v.source_id = p_source_id), false) end
        $$;
      create table public.member_kb_articles (
        id uuid not null default gen_random_uuid(),
        slug text, kind text, title text, article_ref text, body text, keywords text[], order_index integer,
        chapter_id text, is_sample boolean, status text, verified_by uuid, verified_at timestamptz, visible boolean default true,
        knowledge_source_id uuid, content_origin text not null,
        compass_corpus_rule text default 'published-document', compass_filing jsonb, compass_classification jsonb
      );
      create table public.member_rights_lessons (id text, title text, label text, description text, script text, order_index integer);
      create table public.chapter_documents (id text, title text, document_type text, summary text, body text, chapter_id text, status text);
      create table public.member_cases (id text, title text, reference text, articles text, case_type text, user_id uuid);
      alter table public.member_kb_articles enable row level security;
      create policy published_fixture on public.member_kb_articles for select to authenticated using (visible);
      grant usage on schema private, auth to authenticated;
      grant select on all tables in schema public to authenticated;
      insert into public.member_kb_articles (slug, kind, title, article_ref, body, keywords, order_index, chapter_id, is_sample, status, verified_by, verified_at, content_origin)
      select 'safe-' || n, 'contract', 'Agreement', 'Article 12', 'General guidance about a grievance.', array['grievance'], n,
        'chapter-a', false, 'published', auth.uid(), now(), 'authored' from generate_series(1,6) n;
      insert into public.member_kb_articles (slug, kind, title, article_ref, body, keywords, order_index, chapter_id, is_sample, status, verified_by, verified_at, visible, content_origin)
      values ('hidden', 'contract', 'grievance', 'Article 12', repeat('grievance ',100), array['grievance'], 0, 'chapter-a', false, 'published', auth.uid(), now(), false, 'authored'),
        ('other-chapter', 'contract', 'grievance', 'Article 12', repeat('grievance ',100), array['grievance'], 0, 'chapter-b', false, 'published', auth.uid(), now(), true, 'authored'),
        ('draft', 'contract', 'grievance', 'Article 12', repeat('grievance ',100), array['grievance'], 0, 'chapter-a', false, 'draft', auth.uid(), now(), true, 'authored'),
        ('unverified', 'contract', 'grievance', 'Article 12', repeat('grievance ',100), array['grievance'], 0, 'chapter-a', false, 'published', null, null, true, 'authored');
      insert into private.knowledge_source_verdicts values
        ('00000000-0000-4000-8000-0000000000c1', true),
        ('00000000-0000-4000-8000-0000000000c2', false);
      insert into public.member_kb_articles (slug, kind, title, article_ref, body, keywords, order_index, chapter_id, is_sample, status, verified_by, verified_at, visible, knowledge_source_id, content_origin)
      values ('imported-current', 'contract', 'Imported clause', 'Article 40', repeat('narwhal ',20), array['narwhal'], 40, 'chapter-a', false, 'published', auth.uid(), now(), true, '00000000-0000-4000-8000-0000000000c1', 'derived'),
        ('imported-lapsed', 'contract', 'Imported clause', 'Article 41', repeat('narwhal ',20), array['narwhal'], 41, 'chapter-a', false, 'published', auth.uid(), now(), true, '00000000-0000-4000-8000-0000000000c2', 'derived'),
        -- 20260906030000: a WITHHELD article, on a source whose verdict is
        -- CURRENT. Nothing but content_origin separates it from
        -- 'imported-current', which is the point: the article-level gate is no
        -- longer the source's verdict alone.
        ('imported-withheld', 'contract', 'Imported clause', 'Article 42', repeat('narwhal ',20), array['narwhal'], 42, 'chapter-a', false, 'published', auth.uid(), now(), true, '00000000-0000-4000-8000-0000000000c1', 'unresolved');
      insert into public.member_cases select 'private-' || n, 'grievance', 'case-' || n, repeat('grievance ',100), 'grievance', auth.uid() from generate_series(1,8) n;
    `);
    const names = migrationNames().filter((name) => /create\s+(?:or\s+replace\s+)?function\s+public\.search_member_kb\s*\(/i.test(loadMigrationSql(name)));
    // Only the function, not the whole file. Since 20260906024000 the live
    // definition ships alongside the knowledge-lifecycle gates, which reference
    // the real organization_knowledge_* schema this deliberately minimal
    // fixture does not have; loading the whole migration would fail on tables
    // that have nothing to do with what this proof measures.
    // 20260906030000 moved the article-level conjunct onto
    // private.knowledge_article_content_current, so the fixture loads THAT
    // function's real body too rather than restating the predicate: the stub
    // stops at the ledger wrapper above, which is the only part this minimal
    // schema cannot host.
    await client.query(fnBody(
      loadMigrationSql("20260906030000_knowledge_article_provenance"),
      "private.knowledge_article_content_current",
    ));
    await client.query(
      "grant execute on function private.knowledge_article_content_current(public.member_kb_articles) to authenticated",
    );
    // Stand up the shipping classification helpers on this owned fixture so
    // the latest lexical eligibility and approved-text ranking are exercised.
    const classificationSql = loadMigrationSql("compass_document_ingestion_classification");
    for (const name of ["private.compass_document_input_sha", "private.classify_compass_document", "private.compass_article_classification_current"]) {
      await client.query(fnBody(classificationSql, name));
    }
    await client.query("update public.member_kb_articles set compass_classification=private.classify_compass_document(title,article_ref,body,compass_corpus_rule,compass_filing)");
    await client.query("revoke all on function private.classify_compass_document(text,text,text,text,jsonb) from public,anon,authenticated");
    // This slice proves private-source exclusion and publication/provenance
    // ranking. Stand up its chapter-a scope, preserving the foreign-chapter
    // refusal; the real membership resolver and binding triggers are exercised
    // separately in compass-scope-resolver-db.test.js.
    await client.query(`
      alter table public.member_kb_articles
        add column compass_organization_id uuid,
        add column compass_scope_path text[],
        add column compass_scope_level text default 'chapter';
      update public.member_kb_articles set
        compass_organization_id = case when chapter_id = 'chapter-a'
          then '00000000-0000-4000-8000-00000000000a'::uuid
          else '00000000-0000-4000-8000-00000000000b'::uuid end,
        compass_scope_path = array[chapter_id];
      create function private.compass_context_organization() returns uuid
        language sql stable as $$ select '00000000-0000-4000-8000-00000000000a'::uuid $$;
      create function private.compass_scope_path_for_chapter(p_chapter text) returns text[]
        language sql stable as $$ select array[p_chapter] $$;
      create function private.compass_scope_specificity(p_org uuid, p_path text[], p_level text) returns integer
        language sql stable as $$ select case when p_org = private.compass_context_organization()
          and p_path = array['chapter-a']::text[] and p_level = 'chapter' then 4 else 0 end $$;
      create function private.compass_article_scope_current(p_article public.member_kb_articles) returns boolean
        language sql stable as $$ select p_article.compass_scope_path = array[p_article.chapter_id]
          and p_article.compass_organization_id = private.compass_context_organization() $$;
    `);
    await client.query(fnBody(loadMigrationSql(names.at(-1)), "public.search_member_kb"));
    await client.query("revoke all on function public.search_member_kb(text, integer) from public, anon");
    await client.query("grant execute on function public.search_member_kb(text, integer) to authenticated");
    await client.query("set role authenticated");
  }, 30_000);
  afterAll(async () => {
    if (client) await client.end();
    if (admin) {
      if (database) await admin.query(`drop database if exists ${database} with (force)`);
      await admin.end();
    }
  }, 30_000);
  it("fills the nonprivate limit even when matching cases outrank published sources", async () => {
    const { rows } = await client.query("select * from public.search_member_kb('grievance',4)");
    expect(rows).toHaveLength(4);
    expect(rows.every((row) => row.source_id.startsWith("kb:safe-"))).toBe(true);
    expect(JSON.stringify(rows)).not.toContain("private-");
  });
  it("retrieves a storage-derived clause only while its originating source keeps a current verdict", async () => {
    // The two imported rows are identical published, verified, in-chapter
    // clauses; the only difference is whether the organization-knowledge object
    // they were extracted from still holds a current ledger verdict. A source
    // that goes stale, failed, blocked or deleted must stop grounding Compass
    // answers without anything having to re-edit the derived text.
    const { rows } = await client.query("select * from public.search_member_kb('narwhal',6)");
    const sources = rows.map((row) => row.source_id);
    expect(sources).toContain("kb:imported-current");
    expect(sources).not.toContain("kb:imported-lapsed");
    // 20260906030000. The withheld row's source verdict is CURRENT — it shares
    // one with 'imported-current' — so a gate that read only the source would
    // ground an answer in text nothing proves came out of that file.
    expect(sources).not.toContain("kb:imported-withheld");

    await client.query("reset role");
    await client.query("update private.knowledge_source_verdicts set is_current = false where source_id = '00000000-0000-4000-8000-0000000000c1'");
    await client.query("set role authenticated");
    const lapsed = await client.query("select * from public.search_member_kb('narwhal',6)");
    expect(lapsed.rows.map((row) => row.source_id)).not.toContain("kb:imported-current");

    await client.query("reset role");
    await client.query("update private.knowledge_source_verdicts set is_current = true where source_id = '00000000-0000-4000-8000-0000000000c1'");
    await client.query("set role authenticated");
    const restored = await client.query("select * from public.search_member_kb('narwhal',6)");
    expect(restored.rows.map((row) => row.source_id)).toContain("kb:imported-current");
  });
  it("preserves invoker RLS, publication/chapter scope, limits and anonymous denial", async () => {
    const { rows } = await client.query("select * from public.search_member_kb('grievance',99)");
    expect(rows).toHaveLength(6);
    expect(rows.every((row) => row.source_id.startsWith("kb:safe-"))).toBe(true);
    const { rows: flags } = await client.query("select prosecdef, has_function_privilege('anon','public.search_member_kb(text,integer)','EXECUTE') as anonymous from pg_proc where oid='public.search_member_kb(text,integer)'::regprocedure");
    expect(flags[0]).toEqual({ prosecdef: false, anonymous: false });
  });
});
