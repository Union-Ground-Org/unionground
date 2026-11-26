// @vitest-environment node
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { stripComments } from "./helpers/migration.js";

const root = resolve(import.meta.dirname, "..");
const migrationPath = resolve(
  root,
  "supabase/migrations/20260812100000_authorized_source_task_creation.sql",
);
const source = readFileSync(migrationPath, "utf8");
const sql = stripComments(source).replace(/\s+/g, " ");
const lower = sql.toLowerCase();
const contract = JSON.parse(readFileSync(resolve(root, "scripts/db-contract.json"), "utf8"));
const behaviour = readFileSync(resolve(root, "scripts/verify-rpc-behaviour.mjs"), "utf8");

describe("authorized source-to-task migration", () => {
  it("adds paired typed provenance with one conversion per chapter source", () => {
    expect(lower).toContain("add column source_kind text");
    expect(lower).toContain("add column source_id text");
    expect(lower).toContain("chapter_task_attachments_source_pair_check");
    for (const kind of ["message", "broadcast", "notification", "survey", "case"]) {
      expect(lower).toContain(`'${kind}'`);
    }
    expect(lower).toContain("create unique index chapter_task_attachments_source_once_idx");
    expect(lower).toContain("on public.chapter_task_attachments (chapter_id, source_kind, source_id)");
    expect(lower).toContain("where source_kind is not null");
  });

  it("exposes one tightly granted security-definer RPC", () => {
    expect(lower).toContain("create or replace function public.create_chapter_task_from_source(");
    expect(lower).toMatch(/returns jsonb language plpgsql security definer set search_path = ''/);
    expect(lower).toContain("if caller is null or not private.mfa_satisfied() then");
    expect(lower).toContain("public.member_has_role(array['steward', 'coordinator', 'advisor', 'admin', 'vp'])");
    expect(lower).toContain("revoke all on function public.create_chapter_task_from_source(text, text) from public, anon, authenticated");
    expect(lower).toContain("grant execute on function public.create_chapter_task_from_source(text, text) to authenticated");
    expect(lower).not.toMatch(/grant execute[^;]+to anon/);
  });

  it("proves exact source access independently of the staff capability", () => {
    expect(lower).toContain("m.sender_kind = 'member'");
    expect(lower).toContain("m.user_id = caller");
    expect(lower).toContain("public.staff_can_see_user(m.user_id, 'steward')");
    expect(lower).toContain("b.retracted_at");
    expect(lower).toContain("n.user_id = caller");
    expect(lower).toContain("s.active");
    expect(lower).toContain("c.user_id = caller");
    expect(lower).toContain("c.steward_user_id = caller");
    expect(lower).toContain("public.member_has_role(array['steward'])");
    expect(lower).toContain("public.staff_can_see_user(c.user_id, 'coordinator')");
    expect(lower).toContain("raise exception 'source unavailable' using errcode = '22023'");
    expect(lower).not.toMatch(/member_has_role\(array\['advisor'\]\)[\s\S]{0,120}member_cases/);
    expect(lower).not.toMatch(/member_has_role\(array\['admin'\]\)[\s\S]{0,120}member_cases/);
    expect(lower).not.toMatch(/member_has_role\(array\['vp'\]\)[\s\S]{0,120}member_cases/);
  });

  it("serializes typed retries and returns an existing authorized outcome first", () => {
    expect(lower).toContain("pg_catalog.pg_advisory_xact_lock");
    expect(lower).toContain("chapter_task_attachments_source_once_idx");
    const existingAt = lower.indexOf("select a.* into attachment_row");
    const inactiveAt = lower.indexOf("if not source_is_current then");
    const insertAt = lower.indexOf("insert into public.chapter_tasks");
    expect(existingAt).toBeGreaterThan(-1);
    expect(inactiveAt).toBeGreaterThan(existingAt);
    expect(insertAt).toBeGreaterThan(inactiveAt);
    expect(lower).toContain("'created', false");
    expect(lower).toContain("'created', true");
  });

  it("chooses a locked existing workstream and creates one quiet Standard Task", () => {
    expect(lower).toContain("from public.chapter_workstreams w");
    expect(lower).toContain("w.chapter_id = caller_chapter");
    expect(lower).toContain("order by (pg_catalog.lower(pg_catalog.btrim(w.name)) = 'general') desc");
    expect(lower).toContain("for key share of w");
    expect(lower).toContain("chapter has no available task workstream");
    expect(lower).toMatch(/insert into public\.chapter_tasks \( title, description, status, priority, task_type, workstream, assignee_id, start_date, due_date, progress, blocked, milestone, order_index \) values \( task_title, '', 'to_do', 'medium', 'general', task_workstream, null, null, null, 0, false, false, 0 \)/);
    for (const title of [
      "Follow up on member message",
      "Review chapter broadcast",
      "Review notification",
      "Follow up on survey",
      "Follow up on grievance",
    ]) {
      expect(source).toContain(`'${title}'`);
    }
  });

  it("atomically links and audits only neutral record metadata", () => {
    expect(lower).toMatch(/insert into public\.chapter_task_attachments \( task_id, chapter_id, label, record_url, created_by, source_kind, source_id \)/);
    expect(lower).toContain("insert into public.chapter_task_activity");
    expect(lower).toContain("'attachment_added'");
    expect(lower).toContain("'/m/messages?conversation='");
    expect(lower).toContain("'/m/steward?thread='");
    expect(lower).toContain("'/m/messages?broadcast='");
    expect(lower).toContain("'/m/messages?notification='");
    expect(lower).not.toContain("'/m?notification='");
    expect(lower).toContain("'/m/voting?survey='");
    expect(lower).toContain("'/m/cases?case='");
    expect(lower).toContain("'/m/steward?case='");
    expect(lower).toContain("'/m/coordinator?case='");
    expect(lower).not.toMatch(/insert into public\.chapter_tasks[\s\S]{0,900}(m\.body|b\.body|b\.title|n\.body|n\.title|s\.title|c\.title|c\.reference)/);
  });

  it("does not add a second task or source access boundary", () => {
    expect(lower).not.toMatch(/create policy[\s\S]+on public\.chapter_tasks/);
    expect(lower).not.toMatch(/create policy[\s\S]+on public\.(member_messages|member_broadcasts|member_notifications|member_surveys|member_cases)/);
    expect(lower).not.toMatch(/create table public\.chapter_task_(permissions|members|acl)/);
    expect(lower).not.toMatch(/alter table public\.(member_broadcasts|member_surveys)[\s\S]+chapter_id/);
  });

  it("pins the live function, provenance constraint, uniqueness and RPC-only writes", () => {
    const fn = contract.functions.find((entry) => entry.sig ===
      "public.create_chapter_task_from_source(p_source_kind text, p_source_id text)");
    expect(fn?.secdef).toBe(true);
    expect(fn?.exec).toBe("authenticated,service_role");
    expect(fn?.bodyContains).toEqual(expect.arrayContaining([
      "if caller is null or not private.mfa_satisfied() then",
      "private.member_has_chapter_role(",
      "pg_advisory_xact_lock",
      "source unavailable",
      "'attachment_added'",
    ]));

    const pair = contract.constraints.find((entry) =>
      entry.table === "chapter_task_attachments"
      && entry.name === "chapter_task_attachments_source_pair_check");
    expect(pair?.convalidated).toBe(true);
    expect(pair?.defContains).toEqual(expect.arrayContaining([
      "source_kind IS NULL", "source_id IS NULL", "'message'::text", "'case'::text",
    ]));

    const unique = contract.indexes.find((entry) =>
      entry.name === "chapter_task_attachments_source_once_idx");
    expect(unique?.table).toBe("chapter_task_attachments");
    expect(unique?.defContains).toEqual(expect.arrayContaining([
      "UNIQUE", "USING btree (chapter_id, source_kind, source_id)", "WHERE (source_kind IS NOT NULL)",
    ]));

    const grant = contract.tableGrants.find((entry) =>
      entry.table === "public.chapter_task_attachments" && entry.role === "authenticated");
    expect(grant?.privileges).toBe("SELECT");
  });

  it("keeps rollback-only live probes for authorization, privacy, audit and idempotency", () => {
    for (const kind of ["message", "broadcast", "notification", "survey", "case"]) {
      expect(behaviour).toContain(`["${kind}",`);
    }
    expect(behaviour).toContain("check(`${kind} source creates a task`");
    expect(behaviour).toContain("foreign-owner conversion independently proves steward source scope");
    expect(behaviour).toContain("ordinary source owner cannot spawn chapter work");
    expect(behaviour).toContain("out-of-scope foreign staff cannot convert a member message");
    expect(behaviour).toContain("denied source callers leave tasks, links, and audit unchanged");
    expect(behaviour).toContain("source content is absent from task cards and link labels");
    expect(behaviour).toContain("source task creation and authorized-link changes are audited atomically");
    expect(behaviour).toContain("same typed source retry returns the existing outcome");
    expect(behaviour).toContain("retracted source retry still returns its prior task");
    expect(behaviour).toContain("zero source-task probe residue after rollback");
  });
});
