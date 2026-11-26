// @vitest-environment node
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import pg from "pg";
import { createHash } from "node:crypto";
import { loadMigrationSql, fnBody } from "./helpers/migration.js";
import { assertDisposableProofUrl } from "../scripts/run-required-db-proofs.mjs";
import { SAMPLE_KB_ARTICLES } from "./helpers/compass-kb-fixture-articles.mjs";
import { buildGuideMessages, minimizeCompassEmbeddingSource } from "../api/_lib/compassPrompts.js";
import { backfillEmbeddings } from "../scripts/backfill-member-kb-embeddings.mjs";
import { COMPASS_EMBEDDING_MODEL_DIGEST } from "../api/_lib/compassEmbeddings.js";

const sql = loadMigrationSql("compass_document_ingestion_classification");
const sha = (s) => createHash("sha256").update(s).digest("hex");
const member = "00000000-0000-4000-8000-000000000001";
const spanish = "El empleador no podrá imponer una sanción disciplinaria sin causa justificada. El plazo es de 15 días hábiles.";
const control = "The employer shall not discipline or discharge an employee without just cause.";
const filing = { identity: "Synthetic LM-2 filing 001", source: "https://example.invalid/filing/001", year: 2024 };
const vector = Array.from({ length: 1024 }, (_, i) => i === 0 ? 1 : 0);

// This fixture runs the complete new migration in an owned database. Identity,
// source-verdict, scope eligibility and graph-lock helpers are explicit stubs; the classifier,
// ingestion trigger, lifecycle inventory, retrieval SQL, RLS and backfill are
// the shipping code.
describe.skipIf(!process.env.SUPABASE_DB_URL)("Compass ingestion classification (disposable PostgreSQL)", () => {
  let admin; let client; let database;
  beforeAll(async () => {
    const url = new URL(assertDisposableProofUrl(process.env.SUPABASE_DB_URL));
    admin = new pg.Client({ connectionString: url.toString() }); await admin.connect();
    database = `compass_classification_${process.pid}_${Date.now()}`;
    await admin.query(`create database ${database} template template0`);
    url.pathname = `/${database}`;
    client = new pg.Client({ connectionString: url.toString() }); await client.connect();
    await client.query(`
      create schema private; create schema auth; create schema extensions;
      create extension vector with schema extensions;
      create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('test.member',true),'')::uuid $$;
      create function auth.role() returns text language sql stable as $$ select coalesce(current_setting('test.role',true),'') $$;
      create function private.current_member_chapter() returns text language sql stable as $$ select 'chapter-a'::text $$;
      create function private.compass_context_organization() returns uuid language sql stable as $$ select '${member}'::uuid $$;
      create function private.lock_case_graph(uuid[], uuid[]) returns void language sql as $$ select $$;
      create table public.member_kb_articles (
        id uuid primary key default gen_random_uuid(), slug text unique, kind text default 'contract', title text,
        article_ref text, body text, chapter_id text default 'chapter-a', keywords text[] default '{}',
        compass_organization_id uuid default '${member}', compass_scope_path text[] default array['chapter:chapter-a'],
        order_index integer default 1, status text default 'published', is_sample boolean default false,
        verified_by uuid default '${member}', verified_at timestamptz default now(),
        content_origin text default 'authored', knowledge_source_id uuid, source_current boolean default true
      );
      create function private.compass_article_scope_current(a public.member_kb_articles) returns boolean language sql stable as $$ select a.compass_organization_id='${member}'::uuid and a.compass_scope_path=array['chapter:chapter-a'] $$;
      create function private.knowledge_article_content_current(a public.member_kb_articles) returns boolean language sql stable as $$ select a.source_current $$;
      create table public.member_rights_lessons (id text,title text,label text,description text,script text,order_index integer);
      create table public.chapter_documents (id text,title text,document_type text,summary text,body text,chapter_id text,status text);
      create table public.member_kb_article_embeddings (
        article_id uuid references public.member_kb_articles(id),chunk_no integer,chunk text,embedding extensions.vector(1024),
        model text,digest text,body_sha256 text,compass_organization_id uuid default '${member}',
        compass_scope_path text[] default array['chapter:chapter-a'],primary key(article_id,chunk_no)
      );
      alter table public.member_kb_articles enable row level security;
      create policy article_fixture on public.member_kb_articles for select to authenticated using(chapter_id=private.current_member_chapter());
      alter table public.member_kb_article_embeddings enable row level security;
      create policy member_kb_article_embeddings_member_read on public.member_kb_article_embeddings for select to authenticated using(true);
      grant usage on schema private,auth,extensions to authenticated,service_role;
      grant select on all tables in schema public to authenticated;
      create table private.account_lifecycle_trigger_review(kind text,schema_name text,table_name text,object_name text,definition_hash text);
    `);
    await client.query(fnBody(loadMigrationSql("account_lifecycle_manifest"), "private.account_lifecycle_trigger_surface"));
    await client.query(fnBody(loadMigrationSql("knowledge_article_provenance"), "search_member_kb"));
    await client.query(fnBody(loadMigrationSql("compass_hybrid_retrieval_pgvector"), "search_member_kb_hybrid"));
    await client.query(sql);
    await client.query("grant execute on function public.search_member_kb(text,integer),public.search_member_kb_hybrid(text,extensions.vector,integer) to authenticated");
  }, 30000);
  afterAll(async () => {
    if (client) await client.end();
    if (admin) { if (database) await admin.query(`drop database if exists ${database} with (force)`); await admin.end(); }
  }, 30_000);
  async function classify(body, title = "Article 12", rule = "published-document", provenance = null) {
    return (await client.query("select private.classify_compass_document($1,'Contract · Article 12',$2,$3,$4) as c", [title, body, rule, provenance])).rows[0].c;
  }
  async function insert(slug, body, extra = {}) {
    const { rows } = await client.query(`insert into public.member_kb_articles(slug,title,article_ref,body,chapter_id,status,verified_by,source_current,compass_corpus_rule,compass_filing)
      values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) returning *`, [slug, extra.title || "Article 12", extra.ref || "Contract · Article 12", body, extra.chapter || "chapter-a", extra.status || "published", extra.unverified ? null : member, extra.current !== false, extra.rule || "published-document", extra.filing || null]);
    return rows[0];
  }
  async function context(query, kind = "lexical", embedding = null) {
    await client.query(`set role authenticated`);
    try { return (await client.query("select public.get_compass_ai_context($1,$2) as c", [kind, { p_query: query, p_embedding: embedding }])).rows[0].c.data; }
    finally { await client.query("reset role"); }
  }
  it("passes accented Spanish contract text through ingestion, chat and embedding", async () => {
    const reviewed = (await client.query("select kind,object_name,definition_hash from private.account_lifecycle_trigger_review")).rows;
    expect(reviewed).toHaveLength(4);
    expect(reviewed.filter(row=>row.kind==="function").map(row=>row.object_name.split("(")[0]).sort())
      .toEqual(["classify_compass_article_on_ingestion","classify_compass_document","compass_document_input_sha"]);
    expect(reviewed.every(row=>/^[a-f0-9]{32}$/.test(row.definition_hash))).toBe(true);
    expect((await classify(control,"Sick Leave")).status).toBe("ready");
    expect((await classify(control,"Social Security Benefits")).status).toBe("ready");
    expect((await classify(spanish,"Prestaciones del Seguro Social")).status).toBe("ready");
    const article = await insert("es-contract", spanish,{title:"Permisos Retribuidos",ref:"Convenio Colectivo · Artículo 12"});
    expect(article.compass_classification.status).toBe("ready");
    expect(minimizeCompassEmbeddingSource(spanish, article.compass_classification)).toBe(spanish);
    const source = (await context("sanción")).find(s => s.source_id === "kb:es-contract");
    expect(source).toBeDefined();
    expect(buildGuideMessages("Help", {}, [], [source])[0].content).toContain("sanción disciplinaria");
  });
  it("keeps all eight SAMPLE articles usable on both classified document paths", async () => {
    for (const [index, sample] of SAMPLE_KB_ARTICLES.entries()) {
      const article = await insert(sample.slug, sample.body, { title: sample.title, ref: sample.articleRef });
      expect(article.compass_classification.status, sample.slug).toBe("ready");
      expect(minimizeCompassEmbeddingSource(article.body, article.compass_classification)).toBe(sample.body);
      const keyword = `seedfixture${index}`;
      await client.query("update public.member_kb_articles set keywords=array[$2] where id=$1",[article.id,keyword]);
      const source = (await context(keyword)).find(s=>s.source_id===`kb:${sample.slug}`);
      expect(source, sample.slug).toBeDefined();
      expect(buildGuideMessages("Help", {}, [], [source])[0].content).toContain(source.snippet);
    }
  });
  it.each(["Member record: 007. Case: GRV-12345.", "Registro de miembro: 007. Caso: C-123.", "SSN 123-45-6789.", "Contact fake.person@example.invalid."])("excludes synthetic member records and case references: %s", async (body) => {
    const result = await classify(body); expect(result.status).toBe("excluded");
    expect(result.text).toBe(""); expect(JSON.stringify(result.flags)).not.toContain(body);
    if(body.startsWith("SSN"))expect((await classify("SSN 123456789.")).status).toBe("excluded");
    expect(() => minimizeCompassEmbeddingSource(body,result)).toThrow();
  });
  it("strips complete record sentences without turning them into apparent contract facts", async () => {
    const result = await classify(`${spanish} Case: GRV-12345 belongs to Example Member.`);
    expect(result.status).toBe("ready"); expect(result.excluded_sentences).toBe(1);
    expect(result.text).toBe(spanish);
  });
  it.each(["Marisol Alvarez was suspended yesterday.", "The member has a pending grievance.", "Mi suspensión fue injusta.", "La empleada fue suspendida ayer."])("flags private narratives for publisher correction: %s", async (body) => {
    const result = await classify(`${control} ${body}`);
    expect(result.status).toBe("review-required"); expect(result.text).toBe(control);
    expect(() => minimizeCompassEmbeddingSource(body,result)).toThrow();
  });
  it("permits synthetic named public officers and figures only with filing/source/year", async () => {
    const body = "Officer Marisol Alvarez received $75,000 in 2024.";
    expect((await classify(`${control} ${body}`)).status).toBe("review-required");
    expect((await classify(body)).flags).toContain("personal-narrative");
    expect((await classify(body,"Article 12","public-filing",filing)).status).toBe("ready");
    for (const provenance of [null, { ...filing, year:"2024" }, { ...filing, source:"file:///private" }, { ...filing, identity:"fixture\ninvalid" }, { identity:"fixture",year:2024 }]) {
      expect((await classify(body,"Article 12","public-filing",provenance)).status).toBe("excluded");
    }
    expect((await classify("Case: GRV-12345.","Article 12","public-filing",filing)).status).toBe("excluded");
    const article = await insert("public-filing",body,{rule:"public-filing",filing});
    expect(minimizeCompassEmbeddingSource(body,article.compass_classification)).toBe(body);
    await client.query("update public.member_kb_articles set keywords=array['filingfixture'] where id=$1",[article.id]);
    const source = (await context("filingfixture")).find(s=>s.source_id==="kb:public-filing");
    expect(source).toBeDefined();
    const prompt = buildGuideMessages("Help",{},[],[source])[0].content;
    expect(prompt).toContain(filing.identity);
    expect(prompt).toContain(filing.source);
    expect(prompt).toContain("year: 2024");
  });
  it("reauthorizes public-filing content edits even when provenance is unchanged", async () => {
    const article = await insert("filing-edit", "Officer Marisol Alvarez received $75,000 in 2024.", {rule:"public-filing",filing});
    await client.query("select set_config('test.member',$1,false),set_config('test.role','authenticated',false)",[member]);
    try {
      for (const field of ["title","article_ref","body"]) {
        await expect(client.query(`update public.member_kb_articles set ${field}=$2 where id=$1`,[article.id,"Marisol Alvarez was suspended yesterday."]))
          .rejects.toThrow(/platform filing provenance required/);
      }
      // A normal verified publisher may still save a published-document article.
      const ordinary = await insert("ordinary-edit",control);
      await client.query("update public.member_kb_articles set body=$2 where id=$1",[ordinary.id,spanish]);
    } finally {
      await client.query("select set_config('test.member','',false),set_config('test.role','',false)");
    }
    await client.query("update public.member_kb_articles set body=$2 where id=$1",[article.id,"Officer Marisol Alvarez reported $80,000 in 2024."]);
    const result=(await client.query("select compass_classification as c from public.member_kb_articles where id=$1",[article.id])).rows[0].c;
    expect(result.status).toBe("ready");
    // Keep later backfill expectations independent of this authorization case.
    await client.query("delete from public.member_kb_articles where id=$1",[article.id]);
  });
  it("filters unavailable articles before lexical and hybrid result limits", async () => {
    const target=await insert("rank-eligible", "Rankfixture contract requires just cause.");
    await client.query("update public.member_kb_articles set order_index=99 where id=$1",[target.id]);
    const blocked=[];
    for(let index=0;index<8;index++) {
      const row=await insert(`rank-unavailable-${index}`,"Rankfixture contract requires just cause. The member has a pending grievance.",{title:"Rankfixture Rankfixture Rankfixture"});
      blocked.push(row.id);
      await client.query("update public.member_kb_articles set order_index=$2 where id=$1",[row.id,index]);
    }
    await client.query("alter table public.member_kb_articles disable trigger compass_document_ingestion_classification");
    await client.query("update public.member_kb_articles set compass_classification=null where id=$1",[blocked[0]]);
    await client.query("alter table public.member_kb_articles enable trigger compass_document_ingestion_classification");
    for(const kind of ["lexical","hybrid"]) {
      const sources=await context("rankfixture",kind);
      expect(sources.map(source=>source.source_id)).toEqual(["kb:rank-eligible"]);
    }
  });
  it("preserves the existing eval control without a model dispatch", async () => {
    const c = await classify(control); expect(c.status).toBe("ready");
    expect(minimizeCompassEmbeddingSource(control,c)).toBe(control);
    expect(buildGuideMessages("What does Article 12 say?", {}, [], [{source_id:"kb:eval",kind:"contract",title:"Article 12",ref:"Contract · Article 12",snippet:control}])[0].content).toContain(control);
  });
  it("reclassifies edits and restores; ignores a forged classification", async () => {
    const a = await insert("update-contract",control);
    const changed = (await client.query("update public.member_kb_articles set body=$2,compass_classification=$3 where id=$1 returning *",[a.id,spanish,a.compass_classification])).rows[0];
    expect(changed.compass_classification.body_sha256).toBe(sha(spanish));
    const forged = (await client.query("update public.member_kb_articles set compass_classification=$2 where id=$1 returning *",[a.id,{...changed.compass_classification,text:"forged"}])).rows[0];
    expect(forged.compass_classification).toEqual(changed.compass_classification);
    expect(() => minimizeCompassEmbeddingSource(control,changed.compass_classification)).toThrow();
    const source = (await context("sanción")).find(s=>s.source_id==="kb:update-contract");
    expect(() => buildGuideMessages("Help",{},[],[{...source,snippet:"forged"}])).toThrow();
  });
  it("does not classify publication or a foreign/expired source as retrieval authority", async () => {
    for (const [slug,extra] of [["foreign",{chapter:"chapter-b"}],["draft",{status:"draft"}],["unverified",{unverified:true}],["expired",{current:false}]])await insert(`isolated-${slug}`,"Unicorn contract requires just cause.",extra);
    expect((await context("unicorn")).filter(s=>s.source_id.startsWith("kb:isolated-"))).toEqual([]);
  });
  it("backfills existing rows in bounded count-only pages and refuses member invocation", async () => {
    const row = await insert("legacy-contract",control);
    // Simulate a pre-migration row; only this fixture owns the trigger/table.
    await client.query("alter table public.member_kb_articles disable trigger compass_document_ingestion_classification");
    await client.query("update public.member_kb_articles set compass_classification=null where id=$1",[row.id]);
    await client.query("alter table public.member_kb_articles enable trigger compass_document_ingestion_classification");
    expect((await context("just cause")).map(s=>s.source_id)).not.toContain("kb:legacy-contract");
    const result = (await client.query("select public.backfill_compass_document_classification(null,500) as c")).rows[0].c;
    expect(result.ready).toBeGreaterThan(8); expect(JSON.stringify(result)).not.toContain("just cause");
    const last = (await client.query("select id from public.member_kb_articles order by id desc limit 1")).rows[0].id;
    expect(result.nextCursor).toBe(last);
    expect((await client.query("select public.backfill_compass_document_classification($1,1) as c",[last])).rows[0].c)
      .toMatchObject({selected:0,nextCursor:null});
    expect((await client.query("select private.compass_article_classification_current(a) as current from public.member_kb_articles a where id=$1",[row.id])).rows[0].current).toBe(true);
    await client.query("set role authenticated");
    try { await expect(client.query("select public.backfill_compass_document_classification(null,1)")).rejects.toThrow(/permission denied/); }
    finally { await client.query("reset role"); }
  });
  it("refuses unapproved embedding providers and retains stale-vector exclusion", async () => {
    const old = await insert("old-vector",control);
    await client.query("insert into public.member_kb_article_embeddings values($1,0,$2,$3,'bge-m3',$4,$5,null)",[old.id,control,JSON.stringify(vector),COMPASS_EMBEDDING_MODEL_DIGEST,sha(control)]);
    expect((await context("unmatched","hybrid",JSON.stringify(vector))).map(s=>s.source_id)).not.toContain("kb:old-vector");
    const calls=[];
    await expect(backfillEmbeddings({client,dryRun:false,limit:500,endpoint:"http://127.0.0.1:11440/v1/embeddings",bearer:"synthetic-test-bearer",envTag:"mesh-app",fetchImplementation:async(_url,options)=>{
      const input=JSON.parse(options.body).input;calls.push(...input);
      return {ok:true,headers:new Headers({"x-ug-mesh-host":"mesh-host-1","x-ug-mesh-model-digest":COMPASS_EMBEDDING_MODEL_DIGEST,"x-ug-mesh-request-id":"synthetic-classification-proof"}),json:async()=>({model:"bge-m3",data:input.map((_,index)=>({index,embedding:vector}))})};
    }})).rejects.toThrow(/embedding.*proof.*refused/i);
    expect(calls.join(" ")).not.toMatch(/GRV-|SSN|was suspended|pending grievance/);
    expect(calls.length).toBeGreaterThan(0);
    expect((await context("unmatched","hybrid",JSON.stringify(vector))).map(s=>s.source_id)).not.toContain("kb:old-vector");
    const readable=(await client.query("select classification_sha256 from public.member_kb_article_embeddings where article_id=$1",[old.id])).rows;
    // Stale vectors are purged before dispatch; refusal cannot publish replacements.
    expect(readable).toEqual([]);
  });
});
