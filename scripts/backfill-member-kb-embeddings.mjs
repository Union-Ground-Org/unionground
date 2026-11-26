#!/usr/bin/env node
// Reviewed operator backfill. Defaults to a read-only dry run; --apply writes
// only to an explicitly selected target. Hosted writes additionally require
// COMPASS_EMBED_HOSTED_CONFIRM=reviewed-operator-window and owner authorization.
// SUPABASE_DB_URL names the database. COMPASS_EMBED_ENDPOINT defaults to the
// local mesh proxy; COMPASS_EMBED_BEARER and COMPASS_EMBED_ENV_TAG authenticate
// that proxy. Logs contain counts and an opaque article UUID continuation cursor,
// never source text, slugs, credentials or raw exceptions. Continue with --after=UUID
// until nextCursor is null; restart without a cursor to revisit changed sources.
import pg from "pg";
import { createHash } from "node:crypto";
import { pathToFileURL } from "node:url";
import {
  COMPASS_EMBEDDING_MODEL,
  COMPASS_EMBEDDING_MODEL_DIGEST,
  readEmbeddingResponse,
} from "../api/_lib/compassEmbeddings.js";
import { minimizeCompassEmbeddingSource } from "../api/_lib/compassPrompts.js";

export const CHUNK_CHARACTERS = 1200;
export const CHUNK_OVERLAP = 200;
export const MAX_CHUNKS = 1000;
export const EMBEDDING_BATCH_SIZE = 64;

export function permittedEndpoint(value) {
  let url;
  try { url = new URL(value); } catch { return null; }
  const host = url.hostname.replace(/^\[|\]$/g, "");
  const octets = /^\d{1,3}(\.\d{1,3}){3}$/.test(host) ? host.split(".").map(Number) : null;
  const permittedHost = host === "localhost" || host === "::1"
    || (octets && octets.every((o) => o <= 255) && (octets[0] === 127 || (octets[0] === 100 && octets[1] >= 64 && octets[1] <= 127)));
  if (!/^https?:$/.test(url.protocol) || url.pathname !== "/v1/embeddings" || url.search || url.hash || url.username || url.password || !permittedHost) return null;
  return url.toString();
}

// Slice only ingestion-classified text, after verifying the original body and
// safe-text digests. No truncated sentence is reclassified during chunking.
export function chunkBody(body, classification) {
  const text = minimizeCompassEmbeddingSource(body, classification).replace(/\s+/g, " ").trim();
  const chunks = [];
  let start = 0;
  while (start < text.length) {
    if (chunks.length >= MAX_CHUNKS) throw new Error("chunk bound exceeded");
    let end = Math.min(text.length, start + CHUNK_CHARACTERS);
    if (end < text.length) {
      const space = text.lastIndexOf(" ", end);
      if (space > start + CHUNK_CHARACTERS / 2) end = space;
    }
    chunks.push(text.slice(start, end).trim());
    if (end >= text.length) break;
    const next = Math.max(end - CHUNK_OVERLAP, start + 1);
    const nextSpace = text.indexOf(" ", next);
    start = nextSpace === -1 || nextSpace >= end ? next : nextSpace + 1;
  }
  return chunks.filter(Boolean);
}

export function bodySha256(body) {
  return createHash("sha256").update(String(body || ""), "utf8").digest("hex");
}

export function vectorLiteral(vector) {
  return JSON.stringify(vector);
}

export async function embedChunks(chunks, { endpoint, bearer, envTag, fetchImplementation = fetch }) {
  if (!permittedEndpoint(endpoint) || !/^[a-z][a-z0-9-]{0,31}$/.test(envTag)
    || typeof bearer !== "string" || !/^[!-~]{16,512}$/.test(bearer)) throw new Error("invalid embedding access");
  if (!Array.isArray(chunks) || !chunks.length || chunks.length > MAX_CHUNKS
    || chunks.some((chunk) => typeof chunk !== "string" || !chunk || chunk.length > CHUNK_CHARACTERS)) throw new Error("invalid chunks");
  const vectors = [];
  for (let start = 0; start < chunks.length; start += EMBEDDING_BATCH_SIZE) {
    const batch = chunks.slice(start, start + EMBEDDING_BATCH_SIZE);
    const response = await fetchImplementation(endpoint, {
      method: "POST", redirect: "error",
      headers: { Authorization: `Bearer ${bearer}`, "Content-Type": "application/json", "X-UG-Mesh-Env": envTag },
      body: JSON.stringify({ model: COMPASS_EMBEDDING_MODEL, input: batch }),
      signal: AbortSignal.timeout(120_000),
    });
    if (!response.ok) throw new Error("embedding request refused");
    const payload = await response.json();
    if (!Array.isArray(payload?.data) || payload.data.length !== batch.length) throw new Error("invalid embedding count");
    const ordered = Array(batch.length);
    for (const item of payload.data) {
      if (!Number.isInteger(item?.index) || item.index < 0 || item.index >= batch.length || ordered[item.index]) throw new Error("invalid embedding indexes");
      const vector = readEmbeddingResponse({ model: payload.model, data: [{ index: 0, embedding: item.embedding }] }, response.headers);
      if (!vector) throw new Error("embedding proof refused");
      ordered[item.index] = vector;
    }
    vectors.push(...ordered);
  }
  return vectors;
}

const ELIGIBLE = `a.status = 'published' and not a.is_sample and a.verified_by is not null
  and a.verified_at is not null and private.knowledge_article_content_current(a)
  and private.compass_article_classification_current(a)
  and private.compass_article_scope_current(a)`;
const BODY_HASH = "pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(a.body, 'UTF8')), 'hex')";
const PINS = [COMPASS_EMBEDDING_MODEL, COMPASS_EMBEDDING_MODEL_DIGEST];

export async function backfillEmbeddings({ client, dryRun = true, pruneOnly = false, limit = 100, after = null, log = () => {}, ...access }) {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 500) throw new Error("invalid article limit");
  if (after !== null && !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(after)) throw new Error("invalid cursor");
  const stale = `not exists (select 1 from public.member_kb_articles a where a.id=e.article_id
    and ${ELIGIBLE} and e.body_sha256=${BODY_HASH} and e.model=$1 and e.digest=$2
    and e.classification_sha256=a.compass_classification->>'input_sha256'
    and e.compass_organization_id=a.compass_organization_id and e.compass_scope_path=a.compass_scope_path)`;
  const pruned = dryRun
    ? await client.query(`select count(*)::integer as count from public.member_kb_article_embeddings e where ${stale}`, PINS)
    : await client.query(`delete from public.member_kb_article_embeddings where (article_id,chunk_no) in (
        select e.article_id,e.chunk_no from public.member_kb_article_embeddings e where ${stale} limit 10000)`, PINS);
  // written counts articles whose replacement committed; chunksWritten counts the
  // rows those committed inserts reported, never selected or generated chunks.
  const counts = { stale: dryRun ? pruned.rows[0].count : pruned.rowCount, selected: 0, written: 0, chunksWritten: 0, withheld: 0, changed: 0, chunks: 0, indexRows: 0, nextCursor: null };
  if (!pruneOnly) {
    const { rows: articles } = await client.query(`select a.id, a.body, a.compass_classification, ${BODY_HASH} as body_sha256
      from public.member_kb_articles a where ${ELIGIBLE} and ($4::uuid is null or a.id > $4::uuid) and not exists (
        select 1 from public.member_kb_article_embeddings e where e.article_id=a.id
        and e.body_sha256=${BODY_HASH} and e.model=$1 and e.digest=$2
        and e.classification_sha256=a.compass_classification->>'input_sha256'
    and e.compass_organization_id=a.compass_organization_id and e.compass_scope_path=a.compass_scope_path)
      order by a.id limit $3`, [...PINS, limit, after]);
    counts.selected = articles.length;
    counts.nextCursor = articles.at(-1)?.id ?? null;
    for (const article of articles) {
      let chunks;
      try { chunks = chunkBody(article.body, article.compass_classification ?? null); } catch { counts.withheld++; continue; }
      counts.chunks += chunks.length;
      if (dryRun) continue;
      const vectors = await embedChunks(chunks, access);
      await client.query("begin");
      try {
        await client.query("set local lock_timeout = '5s'");
        await client.query("set local statement_timeout = '30s'");
        // Acquire the same graph gate before the source row or child rows.
        await client.query("select private.lock_case_graph(array[]::uuid[],array[]::uuid[])");
        const current = await client.query(`select a.id from public.member_kb_articles a
          where a.id=$1 and ${BODY_HASH}=$2 and ${ELIGIBLE}
          and a.compass_classification->>'input_sha256'=$3 for update`,
        [article.id, article.body_sha256, article.compass_classification.input_sha256]);
        if (!current.rowCount) {
          await client.query("rollback");
          counts.changed++;
          continue;
        }
        await client.query("delete from public.member_kb_article_embeddings where article_id=$1", [article.id]);
        let inserted = 0;
        for (const [index, chunk] of chunks.entries()) {
          const insert = await client.query(`insert into public.member_kb_article_embeddings
            (article_id,chunk_no,chunk,embedding,model,digest,body_sha256,classification_sha256)
            values ($1,$2,$3,$4::extensions.vector,$5,$6,$7,$8)`,
          [article.id, index, chunk, vectorLiteral(vectors[index]), ...PINS, article.body_sha256,
            article.compass_classification.input_sha256]);
          inserted += insert.rowCount;
        }
        if (inserted !== chunks.length) throw new Error("embedding write incomplete");
        await client.query("commit");
        counts.written++;
        counts.chunksWritten += inserted;
      } catch {
        await client.query("rollback");
        throw new Error("embedding write refused");
      }
    }
  }
  // Rows the hybrid lane can serve after this run, across every organization:
  // the readiness check opens for an organization only when it owns one.
  const current = await client.query(`select count(*)::integer as count from public.member_kb_article_embeddings e where not ${stale}`, PINS);
  counts.indexRows = current.rows[0].count;
  log({ dryRun, ...counts });
  return counts;
}

export function parseOptions(args) {
  if (new Set(args).size !== args.length || args.some((arg) => !["--dry-run", "--apply", "--prune-only"].includes(arg) && !/^--limit=[1-9][0-9]{0,2}$/.test(arg) && !/^--after=[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(arg))
    || args.filter((arg) => arg.startsWith("--limit=")).length > 1 || args.filter((arg) => arg.startsWith("--after=")).length > 1 || (args.includes("--apply") && args.includes("--dry-run"))) throw new Error("invalid options");
  const limit = Number(args.find((arg) => arg.startsWith("--limit="))?.slice(8) || 100);
  if (limit > 500) throw new Error("invalid article limit");
  return { dryRun: !args.includes("--apply"), pruneOnly: args.includes("--prune-only"), limit, after: args.find((arg) => arg.startsWith("--after="))?.slice(8) ?? null };
}

async function main() {
  const options = parseOptions(process.argv.slice(2));
  const databaseUrl = process.env.SUPABASE_DB_URL;
  const url = new URL(databaseUrl);
  if (!/^postgres(?:ql)?:$/.test(url.protocol) || [...url.searchParams.keys()].some((key) => ["host", "hostaddr", "port"].includes(key.toLowerCase()))) throw new Error("invalid database target");
  if (!options.dryRun && !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)
    && process.env.COMPASS_EMBED_HOSTED_CONFIRM !== "reviewed-operator-window") throw new Error("hosted operator window required");
  const endpoint = permittedEndpoint(process.env.COMPASS_EMBED_ENDPOINT || "http://127.0.0.1:11440/v1/embeddings");
  if (!endpoint) throw new Error("invalid embedding endpoint");
  const client = new pg.Client({ connectionString: databaseUrl, application_name: "backfill-member-kb-embeddings" });
  await client.connect();
  try {
    await backfillEmbeddings({ client, ...options, endpoint, bearer: process.env.COMPASS_EMBED_BEARER, envTag: process.env.COMPASS_EMBED_ENV_TAG || "mesh-app", log: (counts) => console.log(JSON.stringify(counts)) });
  } finally { await client.end(); }
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  main().catch(() => { console.error("Embedding backfill failed; no raw source, credential or database error is logged."); process.exitCode = 1; });
}
