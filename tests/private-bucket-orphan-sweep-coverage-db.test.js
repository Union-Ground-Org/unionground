// @vitest-environment node
//
// SEC-UG-PRIVATE-BUCKET-ORPHAN-SWEEP-COVERAGE-20260920
// public.reconcile_chapter_task_files swept rowless objects only in
// 'case-files' and 'chapter-task-files'. This proof executes it on a
// disposable catalog: an hour-old member-form-files or organization-knowledge
// object with no registration row is reported as an exact Storage API deletion
// target, a registered object and a fresh upload are not, and the second pass
// accepts targets in both buckets.
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { assertDisposableProofUrl } from "../scripts/run-required-db-proofs.mjs";
import { loadMigrationSql, stripComments } from "./helpers/migration.js";

const repairSql = stripComments(loadMigrationSql("private_bucket_orphan_sweep_coverage")).replace(/\s+/g, " ");

describe("private bucket orphan sweep coverage (offline pins)", () => {
  it("covers all four private buckets in SQL and in the Storage API endpoint", () => {
    expect(repairSql).toContain("where o.bucket_id in ('case-files', 'chapter-task-files', 'member-form-files', 'organization-knowledge')");
    expect(repairSql).toContain("select 1 from public.member_form_files f where f.bucket_id = o.bucket_id and f.object_name = o.name");
    expect(repairSql).toContain("select 1 from public.organization_knowledge_files f where f.storage_path = o.name and f.storage_path <> 'pending'");
    expect(repairSql).toContain("begin perform private.lock_case_graph(array[auth.uid()], array[]::uuid[]); declare");
    const endpoint = readFileSync(new URL("../api/task-files-reconcile.js", import.meta.url), "utf8");
    expect(endpoint).toContain('const BUCKETS = new Set(["case-files", "chapter-task-files", "member-form-files", "organization-knowledge"]);');
  });
});

const live = process.env.SUPABASE_DB_URL ? describe : describe.skip;

live("reconcile_chapter_task_files over member-form-files and organization-knowledge", () => {
  let client;
  const ids = { actor: randomUUID(), form: randomUUID(), run: randomUUID().slice(0, 8) };
  const names = {};

  async function object(bucket, name, age) {
    await client.query(
      `insert into storage.objects (bucket_id, name, owner, version, metadata, created_at)
       values ($1, $2, $3, $4, '{"size":16,"mimetype":"text/plain"}'::jsonb, now() - $5::interval)`,
      [bucket, name, ids.actor, `sweep-proof-${randomUUID()}`, age],
    );
  }

  async function reconcile(expected = []) {
    await client.query("reset role");
    await client.query("select set_config('request.jwt.claims',$1,true)", [JSON.stringify({ role: "service_role" })]);
    await client.query("set local role service_role");
    const { rows } = await client.query(
      "select public.reconcile_chapter_task_files(500, $1::jsonb) as value",
      [JSON.stringify(expected)],
    );
    await client.query("reset role");
    return rows[0].value;
  }

  const key = (target) => `${target.bucketId}|${target.objectName}`;

  beforeAll(async () => {
    client = new pg.Client({
      connectionString: assertDisposableProofUrl(process.env.SUPABASE_DB_URL),
      application_name: "private-bucket-orphan-sweep-coverage-proof",
    });
    await client.connect();
    await client.query("begin");
    await client.query("set local statement_timeout = '30s'");
    await client.query("set local lock_timeout = '15s'");
    await client.query("insert into auth.users(id,email) values ($1,$2)", [ids.actor, `${ids.actor}@example.invalid`]);
    await client.query("insert into public.member_forms(id,user_id,template_key) values ($1,$2,'grievance')", [ids.form, ids.actor]);

    names.formOrphan = `${ids.actor}/${ids.form}/orphan-${ids.run}.txt`;
    names.formRegistered = `${ids.actor}/${ids.form}/registered-${ids.run}.txt`;
    names.formFresh = `${ids.actor}/${ids.form}/fresh-${ids.run}.txt`;
    names.knowledgeOrphan = `org/${randomUUID()}/${randomUUID()}/orphan-${ids.run}.txt`;
    await object("member-form-files", names.formOrphan, "2 hours");
    await object("member-form-files", names.formRegistered, "2 hours");
    await object("member-form-files", names.formFresh, "5 minutes");
    await object("organization-knowledge", names.knowledgeOrphan, "2 hours");
    await client.query(
      `insert into public.member_form_files(form_id,object_name,filename,mime_type,size_bytes,uploaded_by,confirmed_at)
       values ($1,$2,'registered.txt','text/plain',16,$3,now())`,
      [ids.form, names.formRegistered, ids.actor],
    );
  });

  afterAll(async () => {
    if (!client) return;
    await client.query("rollback").catch(() => {});
    await client.end();
  });

  it("reports rowless hour-old objects in both buckets and nothing registered or fresh", async () => {
    const report = await reconcile();
    const targets = new Set(report.objectDeletes.map(key));
    expect(targets.has(`member-form-files|${names.formOrphan}`)).toBe(true);
    expect(targets.has(`organization-knowledge|${names.knowledgeOrphan}`)).toBe(true);
    expect(targets.has(`member-form-files|${names.formRegistered}`)).toBe(false);
    expect(targets.has(`member-form-files|${names.formFresh}`)).toBe(false);
    expect(report.orphanTotal).toBeGreaterThanOrEqual(2);
  });

  it("accepts expected-deletion targets in both buckets and reports the ones still present", async () => {
    const report = await reconcile([
      { bucketId: "member-form-files", objectName: names.formOrphan },
      { bucketId: "organization-knowledge", objectName: `org/${randomUUID()}/gone-${ids.run}.txt` },
    ]);
    expect(report.expectedObjectsRemaining).toEqual([
      { bucketId: "member-form-files", objectName: names.formOrphan },
    ]);
  });
});
