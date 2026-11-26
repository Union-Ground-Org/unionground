// @vitest-environment node
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import pg from "pg";
import { createHash } from "node:crypto";
import { loadMigrationSql, fnBody } from "./helpers/migration.js";
import { assertDisposableProofUrl } from "../scripts/run-required-db-proofs.mjs";
import { SAMPLE_KB_ARTICLES } from "./helpers/compass-kb-fixture-articles.mjs";
import { buildGuideMessages, minimizeCompassEmbeddingSource } from "../api/_lib/compassPrompts.js";

const uid = "00000000-0000-4000-8000-000000000001";
const org = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const proof = { source: "https://example.invalid/synthetic-scope", sha256: "a".repeat(64) };
const digest = (s) => createHash("sha256").update(s).digest("hex");
const pinned = "sha256:7907646426070047a77226ac3e684fbbe8410524f7b4a74d02837e43f2146bab";
const vector = Array.from({ length: 1024 }, (_, i) => i === 0 ? 1 : 0);

describe.skipIf(!process.env.SUPABASE_DB_URL)("Compass active membership scope (disposable PostgreSQL)", () => {
  let admin; let client; let database;
  beforeAll(async () => {
    const url = new URL(assertDisposableProofUrl(process.env.SUPABASE_DB_URL));
    admin = new pg.Client({ connectionString: url.toString() }); await admin.connect();
    database = `compass_scope_${process.pid}_${Date.now()}`;
    await admin.query(`create database ${database} template template0`);
    url.pathname = `/${database}`;
    client = new pg.Client({ connectionString: url.toString() }); await client.connect();
    await client.query(`
      create schema private; create schema auth; create schema extensions;
      create extension vector with schema extensions;
      create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('test.member',true),'')::uuid $$;
      create function auth.role() returns text language sql stable as $$ select coalesce(nullif(current_setting('test.actor',true),''),'service_role') $$;
      create function private.mfa_satisfied() returns boolean language sql stable as $$ select coalesce(current_setting('test.mfa',true),'on') <> 'off' $$;
      create function private.lock_case_graph(uuid[],uuid[]) returns void language sql as $$ select $$;
      create function private.lock_case_graph_statement() returns trigger language plpgsql as $$ begin return null; end $$;
      create function private.lock_case_graph_row_keys() returns trigger language plpgsql as $$ begin return coalesce(new,old); end $$;
      create table public.organizations(id uuid primary key,status text default 'active');
      create table public.chapters(id text primary key,organization_id uuid references public.organizations(id));
      create table public.member_profiles(id uuid primary key,chapter_id text);
      create table public.organization_memberships(user_id uuid,organization_id uuid,status text default 'active',primary key(user_id,organization_id));
      create table public.member_chapter_memberships(user_id uuid,chapter_id text,status text default 'active',pinned boolean default false,
        last_selected_at timestamptz,joined_at timestamptz default now(),revoked_at timestamptz,primary key(user_id,chapter_id));
      create function private.member_organization_for(p_user uuid) returns uuid language sql stable security definer set search_path='' as $$
        select c.organization_id from public.member_profiles p
        join public.member_chapter_memberships m on m.user_id=p.id and m.chapter_id=p.chapter_id and m.status='active'
        join public.chapters c on c.id=p.chapter_id
        join public.organization_memberships om on om.user_id=p.id and om.organization_id=c.organization_id and om.status='active'
        join public.organizations o on o.id=c.organization_id and o.status='active' where p.id=p_user
      $$;
      create function private.current_member_chapter() returns text language sql stable security definer set search_path='' as $$
        select p.chapter_id from public.member_profiles p where p.id=(select auth.uid()) and private.member_organization_for(p.id) is not null
      $$;
      create function public.member_has_role(text[]) returns boolean language sql stable as $$ select false $$;
      create table private.organization_catalog_placements(organization_id uuid,identity_catalog_key text,verification_status text,verified_at timestamptz);
      create table private.catalog_edges(child_key text,parent_key text,edge_kind text,certainty text,retired_release_id uuid);
      create table private.catalog_organizations(catalog_key text,tier text,retired_release_id uuid,duplicate_of text);
      create table public.member_kb_articles(id uuid primary key default gen_random_uuid(),slug text unique,kind text default 'contract',title text,
        article_ref text,body text,chapter_id text,keywords text[] default '{}',order_index integer default 1,status text default 'published',
        is_sample boolean default false,verified_by uuid,verified_at timestamptz default now(),content_origin text default 'authored',knowledge_source_id uuid,source_current boolean default true);
      create function private.knowledge_article_content_current(a public.member_kb_articles) returns boolean language sql stable as $$ select a.source_current $$;
      create table public.member_rights_lessons(id text,title text,label text,description text,script text,order_index integer);
      create table public.chapter_documents(id text,title text,document_type text,summary text,body text,chapter_id text,status text);
      create table public.member_kb_article_embeddings(article_id uuid references public.member_kb_articles(id),chunk_no integer,chunk text,
        embedding extensions.vector(1024),model text,digest text,body_sha256 text,primary key(article_id,chunk_no));
      alter table public.member_kb_articles enable row level security;
      create policy member_kb_articles_member_read on public.member_kb_articles for select to authenticated using(chapter_id=private.current_member_chapter());
      alter table public.member_kb_article_embeddings enable row level security;
      create policy member_kb_article_embeddings_member_read on public.member_kb_article_embeddings for select to authenticated using(true);
      grant usage on schema public,private,auth,extensions to authenticated,service_role;
      grant select on all tables in schema public to authenticated;
      create table private.account_lifecycle_manifest(schema_name text,table_name text,user_column text,export_columns text[]);
      insert into private.account_lifecycle_manifest values('public','member_chapter_memberships','user_id',array['user_id','chapter_id','status','pinned','last_selected_at','joined_at','revoked_at']);
      create table private.account_lifecycle_trigger_review(kind text,schema_name text,table_name text,object_name text,definition_hash text);
    `);
    await client.query(fnBody(loadMigrationSql("restore_review_hotfixes"), "private.compass_quota_organization"));
    await client.query(fnBody(loadMigrationSql("restore_review_hotfixes"), "private.compass_context_organization"));
    await client.query(fnBody(loadMigrationSql("account_lifecycle_manifest"), "private.account_lifecycle_trigger_surface"));
    await client.query(loadMigrationSql("compass_document_ingestion_classification"));
    await client.query(loadMigrationSql("compass_scope_path_resolver"));
    await client.query("grant execute on function public.search_member_kb(text,integer),public.search_member_kb_hybrid(text,extensions.vector,integer),public.get_compass_ai_context(text,jsonb) to authenticated");
    for (let n = 10; n <= 12; n++) {
      await client.query("insert into public.organizations(id) values($1)", [org(n)]);
      await client.query("insert into public.chapters(id,organization_id) values($1,$2)", [`chapter-${n}`, org(n)]);
      await client.query("insert into public.organization_memberships(user_id,organization_id) values($1,$2)", [uid, org(n)]);
      await client.query("insert into public.member_chapter_memberships(user_id,chapter_id) values($1,$2)", [uid, `chapter-${n}`]);
      await article(`article-${n}`, `chapter-${n}`, `The employer shall pay wages within ${n} days.`);
    }
    await client.query("insert into public.member_profiles(id,chapter_id) values($1,'chapter-10')", [uid]);
  }, 30000);
  afterAll(async () => {
    if (client) await client.end();
    if (admin) { if (database) await admin.query(`drop database if exists ${database} with (force)`); await admin.end(); }
  }, 60_000);
  async function article(slug, chapter, body, extra = {}) {
    const row = (await client.query(`insert into public.member_kb_articles(slug,title,article_ref,body,chapter_id,verified_by,compass_scope_level,compass_scope_unit_key)
      values($1,$7,$8,$2,$3,$4,$5,$6) returning *`, [slug, body, chapter, uid, extra.level || "chapter", extra.unit || null, extra.title || "Article 12", extra.ref || "Contract · Article 12"])).rows[0];
    await client.query(`insert into public.member_kb_article_embeddings(article_id,chunk_no,chunk,embedding,model,digest,body_sha256,classification_sha256)
      values($1,0,$2,$3,'bge-m3',$4,$5,$6)`, [row.id, body, JSON.stringify(vector), pinned, digest(body), row.compass_classification.input_sha256]);
    return row;
  }
  async function selectChapter(chapter) { await client.query("update public.member_profiles set chapter_id=$1 where id=$2", [chapter, uid]); }
  async function context(query = "Article 12", kind = "lexical", embedding = vector) {
    await client.query("select set_config('test.member',$1,false),set_config('test.actor','authenticated',false)", [uid]);
    await client.query("set role authenticated");
    try { return (await client.query("select public.get_compass_ai_context($1,$2) as envelope", [kind, { p_query: query, p_embedding: embedding === null ? null : JSON.stringify(embedding) }])).rows[0].envelope; }
    finally { await client.query("reset role; select set_config('test.member','',false),set_config('test.actor','service_role',false)"); }
  }
  for (const kind of ["lexical", "hybrid"]) {
    it(`${kind}: Article 12 never mixes three active organizations`, async () => {
      for (let n = 10; n <= 12; n++) {
        await selectChapter(`chapter-${n}`);
        const envelope = await context("Article 12", kind);
        expect(envelope.organization_id).toBe(org(n));
        expect(envelope.data.map((s) => s.source_id)).toEqual([`kb:article-${n}`]);
        expect(envelope.data[0].snippet).toContain(`within ${n} days`);
        expect(envelope.data[0].organization_id).toBe(org(n));
        expect(envelope.scope.matching_organization_ids).toEqual([10, 11, 12].filter((x) => x !== n).map(org));
        expect(JSON.stringify(envelope.scope)).not.toMatch(/wages|Article 12|article-/);
      }
      await selectChapter("chapter-10");
    });
  }
  it("blocks an unresolved or ambiguous selected organization", async () => {
    await selectChapter(null);
    await expect(context()).rejects.toThrow("organization context required");
    await selectChapter("missing-chapter");
    await expect(context()).rejects.toThrow("organization context required");
    await selectChapter("chapter-10");
  });
  it("revoked organization membership cannot fall through to another tenant", async () => {
    await client.query("update public.organization_memberships set status='revoked' where user_id=$1 and organization_id=$2", [uid, org(10)]);
    await expect(context()).rejects.toThrow("organization context required");
    await client.query("update public.organization_memberships set status='active' where user_id=$1 and organization_id=$2", [uid, org(10)]);
  });
  it("requires MFA before retrieval", async () => {
    await client.query("select set_config('test.mfa','off',false)");
    await expect(context()).rejects.toThrow("sign in required");
    await client.query("select set_config('test.mfa','on',false)");
  });
  it("derives article and chunk paths instead of accepting forged tenant metadata", async () => {
    const a = await article("forgery", "chapter-10", "The employer shall provide written notice.");
    await client.query("update public.member_kb_articles set compass_organization_id=$1,compass_scope_path=array['foreign'] where id=$2", [org(11), a.id]);
    await client.query("update public.member_kb_article_embeddings set compass_organization_id=$1,compass_scope_path=array['foreign'] where article_id=$2", [org(11), a.id]);
    const result = (await client.query("select a.compass_organization_id,a.compass_scope_path,e.compass_scope_path as chunk from public.member_kb_articles a join public.member_kb_article_embeddings e on e.article_id=a.id where a.id=$1", [a.id])).rows[0];
    expect(result.compass_organization_id).toBe(org(10));
    expect(result.compass_scope_path).toEqual([`organization:${org(10)}`, "chapter:chapter-10"]);
    expect(result.chunk).toEqual(result.compass_scope_path);
  });
  it("a member of A alone sees neither B/C rows nor membership notices", async () => {
    await client.query("update public.organization_memberships set status='revoked' where user_id=$1 and organization_id<>$2", [uid, org(10)]);
    const envelope = await context();
    expect(envelope.data.every((s) => s.organization_id === org(10))).toBe(true);
    expect(envelope.scope.matching_organization_ids).toEqual([]);
    await client.query("select set_config('test.member',$1,false),set_config('test.actor','authenticated',false)", [uid]);
    await client.query("set role authenticated");
    try {
      expect((await client.query("select distinct compass_organization_id as org from public.member_kb_articles")).rows).toEqual([{ org: org(10) }]);
    } finally { await client.query("reset role; select set_config('test.member','',false),set_config('test.actor','service_role',false)"); }
    await client.query("update public.organization_memberships set status='active' where user_id=$1", [uid]);
  });
  it("distinguishes a rehabilitation agency's disability determination unit from Developmental Services using sourced identities", async () => {
    for (const [chapter, agency] of [["rehab-north", "agency:rehab-services"], ["dds-det", "agency:rehab-services"], ["dds", "agency:developmental-services"]]) {
      await client.query("insert into public.chapters(id,organization_id) values($1,$2)", [chapter, org(10)]);
      await client.query("insert into private.compass_chapter_scope_bindings(chapter_id,organization_id,agency_key,provenance) values($1,$2,$3,$4)", [chapter, org(10), agency, proof]);
    }
    await client.query("insert into public.member_chapter_memberships(user_id,chapter_id) values($1,'rehab-north')", [uid]);
    await article("dds-det-policy", "dds-det", "The employer shall provide disability determination employees with paid leave.", { level: "agency" });
    await article("dds-developmental-policy", "dds", "The employer shall provide disability determination employees with a different leave policy.", { level: "agency" });
    await article("dds-det-chapter-only", "dds-det", "The employer shall provide disability determination employees with chapter-only benefits.");
    await selectChapter("rehab-north");
    for (const kind of ["lexical", "hybrid"]) {
      const result = await context("disability determination", kind);
      expect(result.data[0].source_id).toBe("kb:dds-det-policy");
      expect(result.data.some((s) => ["kb:dds-developmental-policy", "kb:dds-det-chapter-only"].includes(s.source_id))).toBe(false);
      expect(result.data[0].snippet).toContain("paid leave");
      expect(result.scope.local_fallback).toBe(false);
    }
    await selectChapter("chapter-10");
  });
  it("offers a switch for a sibling agency source but never for a sibling chapter source", async () => {
    await selectChapter("chapter-11");
    const eligible = await context("disability determination");
    expect(eligible.scope.matching_organization_ids).toContain(org(10));
    await client.query("update public.member_kb_articles set compass_scope_level='chapter' where slug='dds-det-policy'");
    const restricted = await context("disability determination");
    expect(restricted.scope.matching_organization_ids).not.toContain(org(10));
    await client.query("update public.member_kb_articles set compass_scope_level='agency' where slug='dds-det-policy'");
    await selectChapter("chapter-10");
  });
  it("exports unit verification only with the reviewed lifecycle projection", async () => {
    const columns = (await client.query("select export_columns from private.account_lifecycle_manifest where table_name='member_chapter_memberships'")).rows[0].export_columns;
    const rows = (await client.query("select private.account_lifecycle_export_member_chapter_memberships($1) as data", [uid])).rows[0].data;
    expect(Object.keys(rows[0]).sort()).toEqual([...columns].sort());
    expect(columns).toContain("compass_scope_verification");
  });
  it("uses local documents with a truthful fallback when no narrower source matches", async () => {
    await article("local-overtime", "chapter-10", "The employer shall pay an overtime premium.", { level: "local" });
    const result = await context("overtime premium");
    expect(result.data.map((s) => s.source_id)).toEqual(["kb:local-overtime"]);
    expect(result.data[0].scope_level).toBe("local");
    expect(result.scope.local_fallback).toBe(true);
    await client.query("insert into public.chapter_documents(id,title,document_type,body,chapter_id,status) values('scope-library','Overtime premium','policy','The employer shall pay an overtime premium.','chapter-10','published')");
    for (const kind of ["lexical", "hybrid"]) {
      const scoped = await context("overtime premium", kind, null);
      expect(scoped.data.map((s) => s.source_id)).toEqual(["doc:scope-library"]);
      expect(scoped.scope.local_fallback).toBe(false);
    }
    await client.query("delete from public.chapter_documents where id='scope-library'");
  });
  it("unit lists do not grant membership: only the verified unit assignment retrieves its contract", async () => {
    await client.query("insert into private.compass_chapter_scope_bindings(chapter_id,organization_id,agency_key,unit_keys,provenance) values('chapter-10',$1,'agency:synthetic',array['unit:8','unit:10'],$2)", [org(10), proof]);
    // Binding changes make stored paths stale until the bounded metadata backfill.
    await client.query("select public.backfill_compass_document_scopes(null,100)");
    await article("unit-8", "chapter-10", "The employer shall provide a bargainingunitpremium.", { level: "unit", unit: "unit:8" });
    await article("unit-10", "chapter-10", "The employer shall provide a different bargainingunitpremium.", { level: "unit", unit: "unit:10" });
    expect((await context("bargainingunitpremium")).data).toEqual([]);
    await client.query("update public.member_chapter_memberships set compass_unit_keys=array['unit:8'],compass_scope_verification=$1 where user_id=$2 and chapter_id='chapter-10'", [proof, uid]);
    for (const kind of ["lexical", "hybrid"]) {
      const result = await context("bargainingunitpremium", kind);
      expect(result.data[0].source_id).toBe("kb:unit-8");
      expect(result.data.some((s) => s.source_id === "kb:local-overtime")).toBe(false);
      expect(result.data.some((s) => s.source_id === "kb:unit-10")).toBe(false);
    }
    const exported = (await client.query("select private.account_lifecycle_export_member_chapter_memberships($1) as data", [uid])).rows[0].data;
    expect(exported.find((m) => m.chapter_id === "chapter-10").compass_unit_keys).toEqual(["unit:8"]);
  });
  it("ordinary membership updates cannot forge a unit verification or broaden document scope", async () => {
    await client.query("grant update on public.member_chapter_memberships,public.member_kb_articles to authenticated");
    await client.query("create policy scoped_writer_fixture on public.member_kb_articles for update to authenticated using(chapter_id=private.current_member_chapter())");
    await client.query("select set_config('test.member',$1,false),set_config('test.actor','authenticated',false)", [uid]);
    await client.query("set role authenticated");
    try {
      await expect(client.query("update public.member_chapter_memberships set compass_unit_keys=array['unit:10'] where user_id=$1 and chapter_id='chapter-10'", [uid])).rejects.toThrow("unit membership verification requires the operator");
      await expect(client.query("update public.member_kb_articles set compass_scope_level='local' where slug='article-10'")).rejects.toThrow("document scope changes require the operator");
      await expect(client.query("insert into private.compass_chapter_scope_bindings values('chapter-11',$1,'agency:synthetic','{}',$2)", [org(11), proof])).rejects.toThrow(/permission denied/);
    } finally { await client.query("reset role; select set_config('test.member','',false),set_config('test.actor','service_role',false)"); }
  });
  it("a changed binding fails closed until scoped articles and chunks are backfilled", async () => {
    await client.query("update private.compass_chapter_scope_bindings set agency_key='agency:changed' where chapter_id='chapter-10'");
    expect((await context("bargainingunitpremium", "hybrid")).data.some((s) => s.source_id.startsWith("kb:unit-"))).toBe(false);
    const page = (await client.query("select public.backfill_compass_document_scopes(null,100) as page")).rows[0].page;
    expect(page.scoped + page.unresolved).toBe(page.selected);
    expect(page.chunksWritten).toBeGreaterThan(0);
    expect((await context("bargainingunitpremium", "hybrid")).data.map((s) => s.source_id)).toContain("kb:unit-8");
    expect((await client.query("select public.backfill_compass_document_scopes($1,100) as page", [page.nextCursor])).rows[0].page.selected).toBe(0);
  });
  it("retains all eight SAMPLE document paths and the eval control after scope binding", async () => {
    for (const [index, sample] of SAMPLE_KB_ARTICLES.entries()) {
      const row = await article(`scoped-${sample.slug}`, "chapter-10", sample.body, { title: sample.title, ref: sample.articleRef });
      await client.query("update public.member_kb_articles set keywords=array[$1] where id=$2", [`scopeseed${index}`, row.id]);
      const result = await context(`scopeseed${index}`);
      expect(result.data.map((s) => s.source_id)).toEqual([`kb:scoped-${sample.slug}`]);
      expect(buildGuideMessages("Help", {}, [], result.data)[0].content).toContain(sample.body.slice(0, 50));
      expect(minimizeCompassEmbeddingSource(sample.body, row.compass_classification)).toBe(sample.body);
      const chunks = (await client.query("select compass_scope_path from public.member_kb_article_embeddings where article_id=$1", [row.id])).rows;
      expect(chunks[0].compass_scope_path).toEqual(row.compass_scope_path);
    }
    const body = "The employer shall not discipline or discharge an employee without just cause.";
    const control = await article("scoped-eval-control", "chapter-10", body);
    expect(minimizeCompassEmbeddingSource(body, control.compass_classification)).toBe(body);
  });
  it("does not accept an empty provenance object or a foreign scope binding", async () => {
    await expect(client.query("insert into private.compass_chapter_scope_bindings(chapter_id,organization_id,agency_key,provenance) values('chapter-11',$1,'agency:fixture','{}')", [org(11)])).rejects.toThrow(/compass_scope_provenance/);
    await expect(client.query("insert into private.compass_chapter_scope_bindings(chapter_id,organization_id,agency_key,provenance) values('chapter-11',$1,'agency:fixture',$2)", [org(10), proof])).rejects.toThrow("scope binding must name the chapter organization");
  });
  it("revoked chapter and reactivated membership cannot reuse a former unit assignment", async () => {
    await client.query("update public.member_chapter_memberships set status='revoked' where user_id=$1 and chapter_id='chapter-10'", [uid]);
    await expect(context("bargainingunitpremium")).rejects.toThrow(/organization context required/);
    await client.query("select set_config('test.member',$1,false),set_config('test.actor','authenticated',false)", [uid]);
    await client.query("update public.member_chapter_memberships set status='active' where user_id=$1 and chapter_id='chapter-10'", [uid]);
    await client.query("select set_config('test.member','',false),set_config('test.actor','service_role',false)");
    expect((await context("bargainingunitpremium")).data).toEqual([]);
    const membership = (await client.query("select compass_unit_keys,compass_scope_verification from public.member_chapter_memberships where user_id=$1 and chapter_id='chapter-10'", [uid])).rows[0];
    expect(membership).toEqual({ compass_unit_keys: [], compass_scope_verification: null });
  });
  it("scope never revives draft, unverified, stale-source or privacy-excluded documents", async () => {
    const rows = [];
    for (const slug of ["draft", "unverified", "stale", "private"]) {
      rows.push(await article(`scope-gate-${slug}`, "chapter-10", slug === "private"
        ? "Member record: Jane Example, case CASE-100, received a disciplinary warning."
        : "The employer shall provide a gateexclusionbenefit."));
    }
    await client.query("update public.member_kb_articles set status='draft' where id=$1", [rows[0].id]);
    await client.query("update public.member_kb_articles set verified_by=null where id=$1", [rows[1].id]);
    await client.query("update public.member_kb_articles set source_current=false where id=$1", [rows[2].id]);
    expect(rows[3].compass_classification.status).not.toBe("ready");
    for (const kind of ["lexical", "hybrid"]) {
      const result = await context("gateexclusionbenefit", kind);
      expect(result.data.some((source) => source.source_id.startsWith("kb:scope-gate-"))).toBe(false);
    }
  });
  it("national ancestry comes only from one verified filed catalog identity and never grants a tenant", async () => {
    await client.query("insert into private.catalog_organizations(catalog_key,tier) values('olms-1','national'),('olms-2','national')");
    await client.query("insert into private.organization_catalog_placements values($1,'olms-3','self_reported',null)", [org(10)]);
    await client.query("insert into private.catalog_edges(child_key,parent_key,edge_kind,certainty) values('olms-3','olms-1','olms_parent','filed')");
    const path = async () => (await client.query("select private.compass_scope_path_for_chapter('chapter-10') as path")).rows[0].path;
    expect((await path())[0]).toBe(`organization:${org(10)}`);
    await client.query("update private.organization_catalog_placements set verification_status='verified',verified_at=now() where organization_id=$1", [org(10)]);
    expect((await path())[0]).toBe("national:olms-1");
    await client.query("select public.backfill_compass_document_scopes(null,100)");
    const result = await context("Article 12");
    expect(result.data.every((source) => source.organization_id === org(10))).toBe(true);
    await client.query("insert into private.catalog_edges(child_key,parent_key,edge_kind,certainty) values('olms-3','olms-2','olms_parent','confirmed')");
    expect((await path())[0]).toBe(`organization:${org(10)}`);
  });

});
