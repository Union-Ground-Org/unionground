// @vitest-environment node
//
// REQ-UG-COMPASS-HYBRID-RETRIEVAL-PGVECTOR-20260929.
// Static half: pins the migration text. Live half (SUPABASE_DB_URL on the
// disposable loopback target): the hybrid RPC returns a semantically matched
// article under the same gates as search_member_kb, ignores stale chunks and
// every invisible article, fuses ranks, degrades to the lexical ranking on a
// null embedding, and the side table is readable only through those gates and
// never writable by a member.
// REQ-UG-COMPASS-HYBRID-RETRIEVAL-HYGIENE-20261004 adds the iterative HNSW
// scan (a small organization's chunks are found behind nearer foreign chunks)
// and the hybrid_ready readiness kind of get_compass_ai_context.
import pg from "pg";
import { backfillEmbeddings } from "../scripts/backfill-member-kb-embeddings.mjs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { assertDisposableProofUrl } from "../scripts/run-required-db-proofs.mjs";
import { findMigrationName, latestFnBody, loadMigrationSql, stripComments } from "./helpers/migration.js";

const sql = stripComments(loadMigrationSql("compass_hybrid_retrieval_pgvector"));
const hygiene = stripComments(loadMigrationSql("compass_hybrid_retrieval_hygiene"));
const EMBED_MODEL = "bge-m3";
const EMBED_DIGEST = "sha256:7907646426070047a77226ac3e684fbbe8410524f7b4a74d02837e43f2146bab";
const ids = {
  member: "50916240-0000-4000-8000-000000000001",
  organization: "50916240-0000-4000-8000-000000000101",
  chapter: "compass-hybrid-proof",
  otherChapter: "compass-hybrid-proof-other",
  session: "50916240-0000-4000-8000-000000000201",
  foreignOrganization: "50916240-0000-4000-8000-000000000102",
  foreignChapter: "compass-hybrid-proof-foreign",
};
const article = (n) => `50916240-0000-4000-8000-0000000003${String(n).padStart(2, "0")}`;

describe("Compass hybrid retrieval migration (static)", () => {
  it("sorts after the article-provenance gate it depends on and keeps search_member_kb as the lexical lane", () => {
    expect(findMigrationName("compass_hybrid_retrieval_pgvector") > "20260906030000_knowledge_article_provenance.sql").toBe(true);
    expect(sql).toContain("create extension if not exists vector with schema extensions");
    expect(sql).toContain("create table public.member_kb_article_embeddings");
    expect(sql).toContain("using hnsw (embedding extensions.vector_cosine_ops)");
    expect(sql).toMatch(/references public\.member_kb_articles\(id\) on update cascade on delete cascade/);
    expect(sql).not.toMatch(/create or replace function public\.search_member_kb\(/);
    expect(sql).toContain("from public.search_member_kb(p_query, 6)");
  });

  it("gates the semantic lane exactly like the lexical one and stays security invoker", () => {
    const body = stripComments(latestFnBody("search_member_kb_hybrid")).replace(/\s+/g, " ");
    expect(body).toContain("security invoker");
    expect(body).not.toContain("security definer");
    for (const gate of [
      "a.compass_organization_id = (select private.compass_context_organization())",
      "private.compass_scope_specificity(a.compass_organization_id, a.compass_scope_path, a.compass_scope_level) > 0",
      "not a.is_sample",
      "a.status = 'published'",
      "a.verified_by is not null",
      "a.verified_at is not null",
      "private.knowledge_article_content_current(a)",
      "e.body_sha256 = pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(a.body, 'UTF8')), 'hex')",
    ]) expect(body).toContain(gate);
    expect(body).toContain("operator(extensions.<=>)");
    expect(body).toContain("1.0 / (60 + c.rank)");
    expect(sql).toContain("grant execute on function public.search_member_kb_hybrid(text, extensions.vector, integer) to authenticated");
    expect(sql).not.toMatch(/grant execute on function public\.search_member_kb_hybrid[^;]*to anon/);
  });

  it("mirrors the article read gate on the side table and grants members nothing but select", () => {
    expect(sql).toContain("alter table public.member_kb_article_embeddings enable row level security");
    expect(sql).toContain("alter table public.member_kb_article_embeddings force row level security");
    expect(sql).toContain("revoke all on table public.member_kb_article_embeddings from public, anon, authenticated");
    expect(sql).toContain("grant select on table public.member_kb_article_embeddings to authenticated");
    expect(sql).toMatch(/create policy mfa_assurance on public\.member_kb_article_embeddings\s+as restrictive for all to authenticated/);
    const read = sql.split("create policy member_kb_article_embeddings_member_read")[1].split(";")[0];
    for (const gate of ["a.id = member_kb_article_embeddings.article_id", "a.chapter_id = private.current_member_chapter()", "not a.is_sample", "a.status = 'published'", "a.verified_by is not null", "private.knowledge_article_content_current(a)"]) {
      expect(read).toContain(gate);
    }
    expect(sql).not.toMatch(/create policy [a-z_]+ on public\.member_kb_article_embeddings for (insert|update|delete|all) to authenticated/);
  });

  it("lets the tenant-filtered HNSW scan iterate and answers readiness under the semantic lane's gates", () => {
    expect(findMigrationName("compass_hybrid_retrieval_hygiene") > findMigrationName("compass_scope_path_resolver")).toBe(true);
    expect(hygiene.replace(/\s+/g, " ")).toContain("alter function public.search_member_kb_hybrid(text, extensions.vector, integer) set hnsw.iterative_scan = 'relaxed_order'");
    expect(hygiene).toMatch(/extversion[^;]*>= array\[0, 8, 0\]/);
    const context = stripComments(latestFnBody("get_compass_ai_context")).replace(/\s+/g, " ");
    expect(context).toContain("security invoker");
    const ready = context.split("elsif p_kind = 'hybrid_ready' then")[1].split("elsif p_kind = 'briefing'")[0];
    for (const gate of [
      "a.compass_organization_id = org",
      "e.compass_organization_id = org",
      "e.model = 'bge-m3'",
      `e.digest = '${EMBED_DIGEST}'`,
      "private.compass_article_scope_current(a)",
      "private.compass_scope_specificity(a.compass_organization_id, a.compass_scope_path, a.compass_scope_level) > 0",
      "not a.is_sample",
      "a.status = 'published'",
      "a.verified_by is not null",
      "a.verified_at is not null",
      "private.knowledge_article_content_current(a)",
      "private.compass_article_classification_current(a)",
      "e.compass_scope_path = a.compass_scope_path",
      "e.classification_sha256 = a.compass_classification ->> 'input_sha256'",
      "e.body_sha256 = pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(a.body, 'UTF8')), 'hex')",
    ]) expect(ready).toContain(gate);
  });
});

const live = process.env.SUPABASE_DB_URL ? describe : describe.skip;

live("Compass hybrid retrieval (disposable database)", () => {
  let client;

  beforeAll(async () => {
    client = new pg.Client({ connectionString: assertDisposableProofUrl(process.env.SUPABASE_DB_URL), application_name: "compass-hybrid-proof" });
    await client.connect();
  });

  afterAll(async () => {
    if (client) await client.end();
  });

  async function inTransaction(run) {
    await client.query("begin");
    try {
      await run();
    } finally {
      await client.query("rollback");
    }
  }

  async function asRole(role, claims) {
    await client.query("reset role");
    await client.query("select set_config('request.jwt.claims', $1, true)", [claims ? JSON.stringify(claims) : null]);
    if (role) await client.query(`set local role ${role}`);
  }
  const asMember = () => asRole("authenticated", { sub: ids.member, session_id: ids.session, role: "authenticated", aal: "aal2" });
  const asAnon = () => asRole("anon", { role: "anon", aal: "aal1" });
  const asOwner = () => asRole(null, null);

  // A unit vector along one axis; two different axes are orthogonal (cosine
  // distance 1), the same axis is distance 0, and a mix orders by weight.
  const unit = (axis, weight = 1) => `[${Array.from({ length: 1024 }, (_, index) => (index === axis ? weight : 0)).join(",")}]`;
  const mix = (a, wa, b, wb) => `[${Array.from({ length: 1024 }, (_, index) => (index === a ? wa : index === b ? wb : 0)).join(",")}]`;

  async function seedMember() {
    await client.query("insert into auth.users (id, email, raw_user_meta_data) values ($1, 'compass-hybrid-proof@example.invalid', '{}'::jsonb)", [ids.member]);
    await client.query("insert into public.organizations (id, slug, name, created_by) values ($1, 'compass-hybrid-proof', 'Compass Hybrid Proof', $2)", [ids.organization, ids.member]);
    await client.query("insert into public.chapters (id, name, slug, is_default, order_index, organization_id) values ($1, 'Compass Hybrid Proof', $1, false, 9902, $2), ($3, 'Compass Hybrid Other', $3, false, 9903, $2)", [ids.chapter, ids.organization, ids.otherChapter]);
    await client.query("insert into public.organization_memberships (organization_id, user_id, status) values ($1, $2, 'active')", [ids.organization, ids.member]);
    await client.query("insert into public.member_chapter_memberships (user_id, chapter_id, status) values ($1, $2, 'active')", [ids.member, ids.chapter]);
    await client.query("update public.member_profiles set chapter_id = $1 where id = $2", [ids.chapter, ids.member]);
    await client.query("insert into public.org_security_policy (id, organization_id, require_staff_mfa, updated_by) values (true, $1, false, $2)", [ids.organization, ids.member]);
    await client.query("insert into auth.sessions (id, user_id, created_at, updated_at, aal) values ($1, $2, now(), now(), 'aal2')", [ids.session, ids.member]);
  }

  async function seedArticle(n, { slug, body, chapter = ids.chapter, status = "published", isSample = false, verified = true, keywords = [] }) {
    await client.query(`
      insert into public.member_kb_articles
        (id, slug, kind, title, article_ref, body, keywords, order_index, chapter_id, status, is_sample, version, created_by, updated_by, verified_by, verified_at, content_origin)
      values ($1, $2, 'contract', $3, $4, $5, $6, $7, $8, $9, $10, 1, $11, $11, $12, $13, 'authored')
    `, [article(n), slug, `Article ${n}`, `Contract · Article ${n}`, body, keywords, n, chapter, status, isSample, ids.member, verified ? ids.member : null, verified ? new Date().toISOString() : null]);
    return article(n);
  }

  async function seedChunk(articleId, chunk, vector, { bodyFor = chunk, model = EMBED_MODEL, digest = EMBED_DIGEST } = {}) {
    await client.query(`
      insert into public.member_kb_article_embeddings (article_id, chunk_no, chunk, embedding, model, digest, body_sha256, classification_sha256)
      values ($1, 0, $2, $3::extensions.vector, $4, $5, encode(sha256(convert_to($6, 'UTF8')), 'hex'),
        (select compass_classification->>'input_sha256' from public.member_kb_articles where id=$1))
    `, [articleId, chunk, vector, model, digest, bodyFor]);
  }

  async function seedForeignOrganization() {
    await client.query("insert into public.organizations (id, slug, name, created_by) values ($1, 'compass-hybrid-foreign', 'Compass Hybrid Foreign', $2)", [ids.foreignOrganization, ids.member]);
    await client.query("insert into public.chapters (id, name, slug, is_default, order_index, organization_id) values ($1, 'Compass Hybrid Foreign', $1, false, 9904, $2)", [ids.foreignChapter, ids.foreignOrganization]);
  }

  // Deterministic pseudo-random directions (mulberry32), so the HNSW graph has
  // the uneven neighbour distances of real text rather than a symmetric simplex.
  function noise(seed) {
    let state = seed >>> 0;
    const next = () => {
      state = (state + 0x6d2b79f5) >>> 0;
      let value = state;
      value = Math.imul(value ^ (value >>> 15), value | 1);
      value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
      return ((value ^ (value >>> 14)) >>> 0) / 4294967296 - 0.5;
    };
    const vector = Array.from({ length: 1024 }, (_, index) => (index >= 100 ? next() : 0));
    const norm = Math.hypot(...vector);
    return vector.map((value) => value / norm);
  }
  // query-axis weight plus a unit noise direction with the remaining weight.
  const toward = (axis, weight, direction) => `[${direction.map((value, index) => (index === axis ? weight : 0) + value * Math.sqrt(1 - weight * weight)).join(",")}]`;

  async function seedChunkRows(articleId, vectors) {
    await client.query(`
      insert into public.member_kb_article_embeddings (article_id, chunk_no, chunk, embedding, model, digest, body_sha256, classification_sha256)
      select a.id, v.ordinality - 1, 'Foreign chunk ' || v.ordinality, v.embedding::extensions.vector,
        $3, $4, encode(sha256(convert_to(a.body, 'UTF8')), 'hex'), a.compass_classification->>'input_sha256'
      from public.member_kb_articles a, unnest($2::text[]) with ordinality v(embedding, ordinality) where a.id = $1
    `, [articleId, vectors, EMBED_MODEL, EMBED_DIGEST]);
  }

  async function hybridReady() {
    const { rows } = await client.query("select public.get_compass_ai_context('hybrid_ready', '{}'::jsonb) as envelope");
    return rows[0].envelope;
  }

  async function hybrid(query, vector, limit = 4) {
    const { rows } = await client.query("select * from public.search_member_kb_hybrid($1, $2::extensions.vector, $3)", [query, vector, limit]);
    return rows;
  }

  const bodies = {
    schedule: "Employees may request a schedule adjustment through the personnel office.",
    stale: "Stale text that has since been rewritten by the chapter.",
    grievance: "A grievance is filed with the steward within ten days.",
    steward: "Stewards receive reasonable release time for representation duties.",
  };

  it("returns a semantically matched article the lexical search misses, with the matched chunk as the snippet", async () => {
    await inTransaction(async () => {
      await seedMember();
      const schedule = await seedArticle(1, { slug: "hy-schedule", body: bodies.schedule });
      await seedChunk(schedule, bodies.schedule, unit(3));
      await asMember();
      const lexical = (await client.query("select * from public.search_member_kb('flexible hours', 4)")).rows;
      expect(lexical.map((row) => row.source_id)).not.toContain("kb:hy-schedule");
      const rows = await hybrid("flexible hours", unit(3));
      expect(rows.map((row) => row.source_id)).toContain("kb:hy-schedule");
      const hit = rows.find((row) => row.source_id === "kb:hy-schedule");
      expect(hit).toMatchObject({ kind: "contract", title: "Article 1", ref: "Contract · Article 1", snippet: bodies.schedule });
      expect(Object.keys(hit).sort()).toEqual(["kind", "ref", "snippet", "source_id", "title"]);
    });
  });

  it("ignores chunks cut from a body the chapter has since changed", async () => {
    await inTransaction(async () => {
      await seedMember();
      const stale = await seedArticle(2, { slug: "hy-stale", body: "The current text of this article." });
      await seedChunk(stale, bodies.stale, unit(5), { bodyFor: bodies.stale });
      await asMember();
      expect((await hybrid("unrelated words", unit(5))).map((row) => row.source_id)).not.toContain("kb:hy-stale");
      expect((await client.query("select article_id from public.member_kb_article_embeddings where article_id=$1", [stale])).rows).toEqual([]);
      await asOwner();
      await client.query("delete from public.member_kb_article_embeddings where article_id = $1", [stale]);
      await seedChunk(stale, "The current text of this article.", unit(5), { bodyFor: "The current text of this article." });
      await asMember();
      expect((await hybrid("unrelated words", unit(5))).map((row) => row.source_id)).toContain("kb:hy-stale");
    });
  });

  it("never returns another chapter's, a draft, a sample, or an unverified article's chunk", async () => {
    await inTransaction(async () => {
      await seedMember();
      const hidden = [
        await seedArticle(3, { slug: "hy-other-chapter", body: bodies.steward, chapter: ids.otherChapter }),
        await seedArticle(4, { slug: "hy-draft", body: bodies.steward, status: "draft" }),
        await seedArticle(5, { slug: "hy-sample", body: bodies.steward, status: "draft", isSample: true, chapter: null }),
        await seedArticle(6, { slug: "hy-unverified", body: bodies.steward, status: "draft", verified: false }),
      ];
      for (const id of hidden) await seedChunk(id, bodies.steward, unit(9));
      const visible = await seedArticle(7, { slug: "hy-visible", body: bodies.steward });
      await seedChunk(visible, bodies.steward, unit(9));
      await asMember();
      const sources = (await hybrid("unrelated words", unit(9), 6)).map((row) => row.source_id);
      expect(sources).toEqual(["kb:hy-visible"]);
    });
  });

  it("fuses lexical and semantic ranks so a source found by both lanes outranks a semantic-only one", async () => {
    await inTransaction(async () => {
      await seedMember();
      const grievance = await seedArticle(8, { slug: "hy-grievance", body: bodies.grievance, keywords: ["grievance"] });
      const steward = await seedArticle(9, { slug: "hy-steward", body: bodies.steward });
      await seedChunk(grievance, bodies.grievance, unit(11));
      await seedChunk(steward, bodies.steward, unit(13));
      await asMember();
      // The query vector is nearer the steward chunk (semantic rank 1) than the
      // grievance chunk (semantic rank 2); the lexical lane finds only the
      // grievance article (rank 1). 1/61 + 1/62 beats 1/61.
      const rows = await hybrid("grievance", mix(11, 0.5, 13, 0.87));
      expect(rows.map((row) => row.source_id)).toEqual(["kb:hy-grievance", "kb:hy-steward"]);
      expect(rows[0].snippet).toBe(bodies.grievance);
    });
  });

  it("degrades to the lexical ranking when the embedding is null", async () => {
    await inTransaction(async () => {
      await seedMember();
      const grievance = await seedArticle(10, { slug: "hy-grievance-only", body: bodies.grievance, keywords: ["grievance"] });
      await seedChunk(grievance, bodies.grievance, unit(15));
      await asMember();
      const lexical = (await client.query("select * from public.search_member_kb('grievance', 4)")).rows;
      const { rows } = await client.query("select * from public.search_member_kb_hybrid('grievance', null, 4)");
      expect(rows).toEqual(lexical);
      expect(rows.map((row) => row.source_id)).toContain("kb:hy-grievance-only");
    });
  });

  it("exposes embedding rows only through the article's gates and never to anon", async () => {
    await inTransaction(async () => {
      await seedMember();
      const visible = await seedArticle(11, { slug: "hy-rows-visible", body: bodies.schedule });
      const draft = await seedArticle(12, { slug: "hy-rows-draft", body: bodies.schedule, status: "draft" });
      const other = await seedArticle(13, { slug: "hy-rows-other", body: bodies.schedule, chapter: ids.otherChapter });
      for (const id of [visible, draft, other]) await seedChunk(id, bodies.schedule, unit(17));
      await asMember();
      const { rows } = await client.query("select article_id from public.member_kb_article_embeddings where article_id = any($1::uuid[]) order by article_id", [[visible, draft, other]]);
      expect(rows.map((row) => row.article_id)).toEqual([visible]);
      await asAnon();
      await expect(client.query("select count(*) from public.member_kb_article_embeddings")).rejects.toMatchObject({ code: "42501" });
    });
  });

  it("refuses direct writes from a member", async () => {
    await inTransaction(async () => {
      await seedMember();
      const visible = await seedArticle(14, { slug: "hy-write-probe", body: bodies.schedule });
      await asMember();
      await client.query("savepoint refused_insert");
      await expect(client.query(`
        insert into public.member_kb_article_embeddings (article_id, chunk_no, chunk, embedding, model, digest, body_sha256)
        values ($1, 0, 'probe', $2::extensions.vector, $3, $4, repeat('a', 64))
      `, [visible, unit(19), EMBED_MODEL, EMBED_DIGEST])).rejects.toMatchObject({ code: "42501" });
      await client.query("rollback to savepoint refused_insert");
      await expect(client.query("delete from public.member_kb_article_embeddings where article_id = $1", [visible])).rejects.toMatchObject({ code: "42501" });
    });
  });
  it("hides model and digest drift from both direct reads and semantic retrieval", async () => {
    await inTransaction(async () => {
      await seedMember();
      for (const [n, options] of [[15, { model: "other" }], [16, { digest: `sha256:${"a".repeat(64)}` }]]) {
        const id = await seedArticle(n, { slug: `hy-drift-${n}`, body: bodies.schedule });
        await seedChunk(id, bodies.schedule, unit(21), options);
      }
      await asMember();
      expect((await hybrid("unrelated words", unit(21))).length).toBe(0);
      expect((await client.query("select * from public.member_kb_article_embeddings")).rows).toEqual([]);
    });
  });

  it("cascades article deletion and rejects zero-vector storage", async () => {
    await inTransaction(async () => {
      await seedMember();
      const id = await seedArticle(17, { slug: "hy-delete", body: bodies.schedule });
      await seedChunk(id, bodies.schedule, unit(23));
      await client.query("delete from public.member_kb_articles where id=$1", [id]);
      expect((await client.query("select * from public.member_kb_article_embeddings where article_id=$1", [id])).rows).toEqual([]);
      const zeroId = await seedArticle(18, { slug: "hy-zero", body: bodies.schedule });
      await expect(seedChunk(zeroId, bodies.schedule, unit(0, 0))).rejects.toMatchObject({ code: "23514" });
    });
  });

  it("minimizes chunks but refuses an unapproved embedding provider without writes", async () => {
    await inTransaction(async () => {
      await seedMember();
      const body = "The employer shall not discipline or discharge an employee without just cause. Case: GRV-12345 contains excluded records.";
      const id = await seedArticle(19, { slug: "hy-backfill", body });
      // Nest the production transaction in the fixture's rollback boundary.
      const nestedClient = { query: async (sql, args) => client.query(
        sql === "begin" ? "savepoint backfill_write" : sql === "commit" ? "release savepoint backfill_write" : sql === "rollback" ? "rollback to savepoint backfill_write" : sql, args,
      ) };
      let changeDuringEmbedding = false;
      const options = { client: nestedClient, dryRun: false, limit: 1, after: article(18),
        endpoint: "http://127.0.0.1:11440/v1/embeddings", bearer: "synthetic-backfill-test", envTag: "mesh-app",
        fetchImplementation: async (_url, request) => {
          expect(request.body).not.toMatch(/GRV-|excluded records/);
          if (changeDuringEmbedding) await client.query("update public.member_kb_articles set body=body || ' Changed.' where id=$1", [id]);
          return { ok: true, headers: new Headers({ "x-ug-mesh-host": "mesh-host-1", "x-ug-mesh-model-digest": EMBED_DIGEST, "x-ug-mesh-request-id": "live-backfill-proof" }),
            json: async () => ({ model: EMBED_MODEL, data: [{ index: 0, embedding: JSON.parse(unit(25)) }] }) };
        } };
      await expect(backfillEmbeddings(options)).rejects.toThrow(/embedding.*proof.*refused/i);
      expect((await client.query("select * from public.member_kb_article_embeddings where article_id=$1", [id])).rows).toEqual([]);
      changeDuringEmbedding = true;
      await expect(backfillEmbeddings(options)).rejects.toThrow(/embedding.*proof.*refused/i);
      expect((await client.query("select * from public.member_kb_article_embeddings where article_id=$1", [id])).rows).toEqual([]);
    });
  });

  it("finds a small organization's chunk behind a hundred nearer foreign chunks", async () => {
    await inTransaction(async () => {
      await seedMember();
      await seedForeignOrganization();
      const foreign = await seedArticle(40, { slug: "hy-foreign-near", body: bodies.steward, chapter: ids.foreignChapter });
      const directions = Array.from({ length: 100 }, (_, index) => noise(index + 1));
      await seedChunkRows(foreign, directions.map((direction) => toward(30, 0.9, direction)));
      const own = await seedArticle(41, { slug: "hy-own-far", body: bodies.schedule });
      // Farther from the query (cosine distance 0.7) than every foreign chunk
      // (0.1), but closest to foreign chunk 0, so the HNSW graph reaches it the
      // way it reaches any real passage.
      const beside = directions[0].map((value, index) => value * 0.8 + noise(500)[index] * 0.2);
      const norm = Math.hypot(...beside);
      await seedChunk(own, bodies.schedule, toward(30, 0.3, beside.map((value) => value / norm)));
      await asMember();
      // Make the planner take the HNSW index for the distance order, as it does
      // once the table is large, so the filters run after the index scan.
      await client.query("set local enable_seqscan = off");
      await client.query("set local enable_sort = off");
      const nearest = async (iterative) => {
        await client.query(`set local hnsw.iterative_scan = ${iterative}`);
        const { rows } = await client.query(`
          select a.slug from public.member_kb_article_embeddings e
          join public.member_kb_articles a on a.id = e.article_id
          where a.compass_organization_id = (select private.compass_context_organization())
            and e.compass_organization_id = (select private.compass_context_organization())
          order by e.embedding operator(extensions.<=>) $1::extensions.vector
          limit 64`, [unit(30)]);
        return rows.map((row) => row.slug);
      };
      // Without iteration the scan stops at hnsw.ef_search foreign candidates.
      expect(await nearest("off")).toEqual([]);
      expect(await nearest("relaxed_order")).toEqual(["hy-own-far"]);
      await client.query("set local hnsw.iterative_scan = off");
      // The RPC carries its own setting, whatever the session says.
      expect((await hybrid("unrelated words", unit(30))).map((row) => row.source_id)).toEqual(["kb:hy-own-far"]);
      const { rows } = await client.query("select proconfig from pg_catalog.pg_proc where oid = 'public.search_member_kb_hybrid(text, extensions.vector, integer)'::pg_catalog.regprocedure");
      expect(rows[0].proconfig).toContain("hnsw.iterative_scan=relaxed_order");
    });
  });

  it("reports hybrid readiness only for a current, eligible chunk in the active organization", async () => {
    await inTransaction(async () => {
      await seedMember();
      await seedForeignOrganization();
      await asMember();
      expect(await hybridReady()).toEqual({ organization_id: ids.organization, data: false });
      await asOwner();
      const foreign = await seedArticle(42, { slug: "hy-ready-foreign", body: bodies.steward, chapter: ids.foreignChapter });
      await seedChunk(foreign, bodies.steward, unit(33));
      const stale = await seedArticle(43, { slug: "hy-ready-stale", body: "The current text of this article." });
      await seedChunk(stale, bodies.stale, unit(33), { bodyFor: bodies.stale });
      const drift = await seedArticle(44, { slug: "hy-ready-drift", body: bodies.schedule });
      await seedChunk(drift, bodies.schedule, unit(33), { digest: `sha256:${"b".repeat(64)}` });
      const draft = await seedArticle(45, { slug: "hy-ready-draft", body: bodies.schedule, status: "draft" });
      await seedChunk(draft, bodies.schedule, unit(33));
      await asMember();
      expect((await hybridReady()).data).toBe(false);
      await asOwner();
      const current = await seedArticle(46, { slug: "hy-ready-current", body: bodies.grievance });
      await seedChunk(current, bodies.grievance, unit(33));
      await asMember();
      expect(await hybridReady()).toEqual({ organization_id: ids.organization, data: true });
      await asAnon();
      await expect(client.query("select public.get_compass_ai_context('hybrid_ready', '{}'::jsonb)")).rejects.toMatchObject({ code: "42501" });
    });
  });

});
