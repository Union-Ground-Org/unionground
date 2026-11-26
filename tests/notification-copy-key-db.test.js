// @vitest-environment node
//
// BUG-UG-NOTIFICATION-ITEMS-DO-NOT-OPEN-WHAT-THEY-ANNOUNCE-20261004
//
// "Meeting minutes published" could not open what it announced: the row kept
// only rendered text, and its kind ('general') is shared with unrelated
// notices. 20261005100000 adds member_notifications.copy_key, which
// private.notify_member fills with the copy key, readable (not writable) by
// the member. The offline half pins the migration and the contract; the live
// half (disposable loopback only) drives notify_member and reads the row back
// as the member.
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { assertDisposableProofUrl } from "../scripts/run-required-db-proofs.mjs";
import { findMigrationName, fnBody, latestFnBody, loadMigrationSql, stripComments } from "./helpers/migration.js";

const MIGRATION = "notification_copy_key";
const sql = stripComments(loadMigrationSql(MIGRATION));
const squash = (text) => text.replace(/\s+/g, " ").trim();
const contract = JSON.parse(readFileSync(new URL("../scripts/db-contract.json", import.meta.url), "utf8"));
const SIG = "private.notify_member(p_user_id uuid, p_key text, p_args jsonb default '{}'::jsonb, p_kind text default 'general'::text)";

describe("notification copy key migration", () => {
  it("is one bounded transaction guarded on the reviewed notify_member body", () => {
    expect(findMigrationName(MIGRATION)).toBe("20261005100000_notification_copy_key.sql");
    expect(sql.trimStart().startsWith("begin;")).toBe(true);
    expect(sql.trimEnd().endsWith("commit;")).toBe(true);
    expect(sql).toContain("set local lock_timeout = '5s';");
    expect(squash(sql)).toContain("if installed is distinct from '7984201fd2abaa03f7b9820fbaa4fac1' then");
    expect(squash(sql)).toContain("alter table public.member_notifications add column copy_key text");
    expect(squash(sql)).toContain("alter table public.member_notifications add column source_chapter_id text;");
    expect(squash(sql)).toContain("grant select (copy_key, source_chapter_id) on public.member_notifications to authenticated;");
    expect(squash(sql)).not.toMatch(/grant (update|insert|all)/i);
  });

  it("changes only the insert of notify_member", () => {
    const body = squash(stripComments(fnBody(sql, SIG)));
    expect(body).toContain("insert into public.member_notifications (user_id, title, body, kind, copy_key, source_chapter_id) values (p_user_id, rendered_title, rendered_body, p_kind, p_key, private.current_member_chapter());");
    expect(body).toContain("perform private.lock_case_graph(array[auth.uid()], array[]::uuid[]);");
    expect(body).toContain("from private.member_stress_ledger l");
    expect(body).toContain("raise exception 'unknown notification copy key: %', p_key;");
    expect(squash(stripComments(latestFnBody(SIG)))).toBe(body);
  });

  it("pins the new body and keeps copy_key out of the member's writable columns", () => {
    const entry = contract.functions.find((row) => row.sig === "private.notify_member(p_user_id uuid, p_key text, p_args jsonb, p_kind text)");
    expect(entry).toMatchObject({ bodyMd5: "ae8e0d849a9e0e355b817187289d6367", sourceMd5: "cecb4c57a8a8aee9820e58658810bb21", exec: "" });
    expect(entry.bodyContains).toContain("insert into public.member_notifications (user_id, title, body, kind, copy_key, source_chapter_id)");
    const update = contract.columnGrants.find((row) => row.table === "public.member_notifications" && row.privilege === "UPDATE");
    expect(update.columns).toBe("read_at");
    expect(update.denied).toEqual(expect.arrayContaining(["copy_key", "source_chapter_id"]));
  });
});

const live = process.env.SUPABASE_DB_URL ? describe : describe.skip;

live("notify_member records the copy key the member can read but not change", () => {
  let client;
  const user = randomUUID();
  const session = randomUUID();
  const publisher = randomUUID();
  let chapter;

  const attempt = async (sqlText, params = []) => {
    await client.query("savepoint copy_key");
    try {
      const result = await client.query(sqlText, params);
      await client.query("release savepoint copy_key");
      return { ok: true, rows: result.rows };
    } catch (error) {
      await client.query("rollback to savepoint copy_key");
      return { ok: false, code: error.code };
    }
  };

  beforeAll(async () => {
    client = new pg.Client({
      connectionString: assertDisposableProofUrl(process.env.SUPABASE_DB_URL),
      ssl: false,
      application_name: "notification-copy-key-proof",
    });
    await client.connect();
    await client.query("begin");
    await client.query("set local statement_timeout = '60s'");
    await client.query("insert into auth.users(id,email,raw_user_meta_data) values($1,$2,'{}')", [user, `${user}@example.invalid`]);
    await client.query("insert into auth.sessions(id,user_id,created_at,updated_at,aal) values($1,$2,now(),now(),'aal1')", [session, user]);
    await client.query("delete from public.member_notifications where user_id = $1", [user]);
    // Its own organization and chapter, inside the rolled-back transaction: the
    // first existing chapter was whatever an earlier proof had committed, and
    // a database proof job may run this file before any such proof
    // (OPS-UG-DB-PROOF-SHARD-HIDDEN-CHAPTER-DEPENDENCY-20261111).
    const org = randomUUID();
    chapter = `copy-key-${org}`;
    await client.query("insert into public.organizations(id,slug,name) values ($1,$2,$2)", [org, chapter]);
    await client.query("insert into public.chapters(id,name,slug,region,organization_id,order_index) values ($1,$1,$1,'proof',$2,9900)", [chapter, org]);
    // The publisher's selected chapter becomes the notice's source chapter.
    await client.query("insert into auth.users(id,email,raw_user_meta_data) values($1,$2,'{}')", [publisher, `${publisher}@example.invalid`]);
    await client.query("update public.member_profiles set chapter_id = $2 where id = $1", [publisher, chapter]);
    await client.query("select set_config('request.jwt.claims',$1,true)", [JSON.stringify({ role: "authenticated", sub: publisher })]);
    await client.query(
      "select private.notify_member($1, 'institutional.minutes.published', jsonb_build_object('title', 'Copy key minutes'), 'general')",
      [user],
    );
    // A scheduled or service writer has no chapter.
    await client.query("select set_config('request.jwt.claims','',true)");
    await client.query(
      "select private.notify_member($1, 'institutional.minutes.published', jsonb_build_object('title', 'Unscoped minutes'), 'general')",
      [user],
    );
    await client.query("select set_config('request.jwt.claims',$1,true)", [
      JSON.stringify({ role: "authenticated", sub: user, session_id: session, aal: "aal1" }),
    ]);
    await client.query("set local role authenticated");
  }, 60000);

  afterAll(async () => {
    if (!client) return;
    await client.query("rollback").catch(() => {});
    await client.end();
  });

  it("stores the copy key and lets the member read it with the rest of the row", async () => {
    const { rows } = await client.query("select body, kind, copy_key, source_chapter_id from public.member_notifications where user_id = $1 order by body", [user]);
    expect(rows).toEqual([
      { body: expect.stringContaining("Copy key minutes"), kind: "general", copy_key: "institutional.minutes.published", source_chapter_id: chapter },
      { body: expect.stringContaining("Unscoped minutes"), kind: "general", copy_key: "institutional.minutes.published", source_chapter_id: null },
    ]);
    const star = await attempt("select * from public.member_notifications where user_id = $1", [user]);
    expect(star.ok).toBe(true);
    expect(star.rows.map((row) => row.copy_key)).toEqual(["institutional.minutes.published", "institutional.minutes.published"]);
  });

  it("refuses a member write to the copy key while read_at stays writable", async () => {
    expect(await attempt("update public.member_notifications set copy_key = 'x' where user_id = $1", [user])).toMatchObject({ ok: false, code: "42501" });
    expect(await attempt("update public.member_notifications set source_chapter_id = 'x' where user_id = $1", [user])).toMatchObject({ ok: false, code: "42501" });
    expect(await attempt("update public.member_notifications set read_at = now() where user_id = $1", [user])).toMatchObject({ ok: true });
  });
});
