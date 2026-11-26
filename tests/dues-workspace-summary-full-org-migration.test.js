// @vitest-environment node
//
// BUG-UG-DUES-SUMMARY-TOTALS-FILTERED-SUBSET-20260921
//
// 20260831211500 pointed the staff Dues header totals at the `filtered` CTE, so
// a status/name/due-on filter rewrote outstandingCents, overdueCents,
// collectedCents and memberCount. This migration re-emits public.get_dues_workspace
// so those four aggregates read from `classified` (full-org standing). The
// obligation page still pages `filtered`.
import { execFileSync } from "node:child_process";
import { afterAll, describe, expect, it } from "vitest";
import pg from "pg";
import { findMigrationName, fnBody, loadMigrationSql, stripComments } from "./helpers/migration.js";

const NAME = "dues_workspace_summary_full_org";
const sql = loadMigrationSql(NAME);
const code = stripComments(sql);
const body = fnBody(sql, "public.get_dues_workspace");
const summaryStart = body.indexOf("'summary', pg_catalog.jsonb_build_object(");
const obligationsStart = body.indexOf("'obligations', pg_catalog.jsonb_build_object(");
const summary = body.slice(summaryStart, obligationsStart);
const obligations = body.slice(obligationsStart);

const squash = (text) => text.replace(/\s+/g, " ").trim();

function dockerPostgresAvailable() {
  try {
    execFileSync("docker", ["info"], { stdio: "ignore", timeout: 4000 });
    execFileSync("docker", ["image", "inspect", "postgres:16-alpine"], { stdio: "ignore", timeout: 4000 });
    return true;
  } catch {
    return false;
  }
}

describe("Dues workspace summary full-org migration", () => {
  it("re-creates public.get_dues_workspace after the review-repairs definition", () => {
    const name = findMigrationName(NAME);
    expect(name).toMatch(/^\d{14}_dues_workspace_summary_full_org\.sql$/);
    expect(name > "20260831211500_mi1_dues_review_repairs.sql").toBe(true);
    expect(code.trimStart().startsWith("begin;")).toBe(true);
    expect(code.trimEnd().endsWith("commit;")).toBe(true);
    expect(code).toContain("set local lock_timeout = '5s';");
    expect(code).toContain("create or replace function public.get_dues_workspace(");
    expect(body).toContain("security definer");
    expect(body).toContain("set search_path = ''");
    expect(body).toContain("private.dues_require_financial_hat(p_selected_hat)");
    expect(code).not.toMatch(/\bgrant\b/);
    expect(code).not.toMatch(/\brevoke\b/);
  });

  it("computes the four header aggregates from classified, never from filtered", () => {
    expect(summaryStart).toBeGreaterThan(0);
    expect(obligationsStart).toBeGreaterThan(summaryStart);
    expect(summary).toMatch(/'outstandingCents'[\s\S]*from classified/);
    expect(summary).toMatch(/'overdueCents'[\s\S]*from classified where due_on < current_date/);
    expect(summary).toMatch(/'collectedCents'[\s\S]*from classified/);
    expect(summary).toMatch(/'memberCount'[\s\S]*from classified/);
    expect(summary).not.toContain("from filtered");
    expect(squash(summary).match(/from classified/g)).toEqual([
      "from classified",
      "from classified",
      "from classified",
      "from classified",
    ]);
  });

  it("keeps the obligation page on filtered/visible/page", () => {
    expect(body).toContain("filtered as (");
    expect(body).toContain("select * from classified");
    expect(body).toContain("select * from filtered");
    expect(obligations).toContain("from visible");
    expect(obligations).toContain("from page");
    expect(obligations).toContain("select id from visible order by id desc limit 1");
  });
});

const live = dockerPostgresAvailable() ? describe : describe.skip;

live("disposable Postgres: summary is identical with and without p_status=paid", () => {
  const container = `c21-dues-summary-${process.pid}-${Date.now()}`;
  let client;
  let started = false;

  afterAll(async () => {
    if (client) {
      try { await client.end(); } catch { /* ignore */ }
    }
    if (started) {
      try {
        execFileSync("docker", ["rm", "-f", container], { stdio: "ignore", timeout: 15000 });
      } catch { /* ignore */ }
    }
  });

  it("asserts org-wide totals across filters, and that the superseded body does not", async () => {
    execFileSync("docker", [
      "run", "-d", "--rm",
      "--name", container,
      "-e", "POSTGRES_HOST_AUTH_METHOD=trust",
      "-p", "127.0.0.1::5432",
      "postgres:16-alpine",
    ], { timeout: 30000 });
    started = true;

    let port;
    for (let attempt = 0; attempt < 40; attempt += 1) {
      try {
        execFileSync("docker", ["exec", container, "pg_isready", "-U", "postgres"], {
          stdio: "ignore",
          timeout: 4000,
        });
        const mapping = execFileSync("docker", ["port", container, "5432"], {
          encoding: "utf8",
          timeout: 4000,
        }).trim();
        port = mapping.split(":").at(-1);
        if (port) break;
      } catch {
        await new Promise((resolve) => setTimeout(resolve, 250));
      }
    }
    expect(port).toBeTruthy();

    client = new pg.Client({
      host: "127.0.0.1",
      port: Number(port),
      user: "postgres",
      database: "postgres",
    });
    await client.connect();

    await client.query(`
      create schema if not exists private;
      create table public.member_profiles (
        id uuid primary key,
        full_name text
      );
      create table public.chapters (
        id text not null,
        organization_id uuid not null,
        name text not null
      );
      create table public.dues_member_subjects (
        id uuid primary key,
        organization_id uuid not null,
        user_id uuid
      );
      create table public.dues_assessment_batches (
        id uuid primary key,
        organization_id uuid not null,
        title text not null
      );
      create table public.dues_obligations (
        id uuid primary key,
        organization_id uuid not null,
        batch_id uuid not null,
        member_subject_id uuid not null,
        chapter_id text,
        issued_cents integer not null,
        due_on date not null
      );
      create table public.dues_ledger_events (
        id uuid primary key default gen_random_uuid(),
        organization_id uuid not null,
        obligation_id uuid not null,
        event_kind text not null,
        amount_cents integer not null
      );
      create function private.dues_require_financial_hat(p_selected_hat text)
      returns uuid
      language sql
      stable
      as $stub$ select 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'::uuid $stub$;
      create function private.dues_provider_projection(p_org uuid)
      returns jsonb
      language sql
      stable
      as $stub$ select '{}'::jsonb $stub$;
    `);

    await client.query(`
      insert into public.member_profiles (id, full_name) values
        ('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', 'Ada'),
        ('cccccccc-cccc-cccc-cccc-cccccccccccc', 'Bob');
      insert into public.dues_member_subjects (id, organization_id, user_id) values
        ('dddddddd-dddd-dddd-dddd-dddddddddddd', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb'),
        ('eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'cccccccc-cccc-cccc-cccc-cccccccccccc');
      insert into public.dues_assessment_batches (id, organization_id, title) values
        ('ffffffff-ffff-ffff-ffff-ffffffffffff', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'Fall assessment');
      insert into public.dues_obligations
        (id, organization_id, batch_id, member_subject_id, issued_cents, due_on)
      values
        ('11111111-1111-1111-1111-111111111111', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
         'ffffffff-ffff-ffff-ffff-ffffffffffff', 'dddddddd-dddd-dddd-dddd-dddddddddddd',
         5000, current_date + 30),
        ('22222222-2222-2222-2222-222222222222', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
         'ffffffff-ffff-ffff-ffff-ffffffffffff', 'eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee',
         7000, current_date + 30);
      insert into public.dues_ledger_events
        (organization_id, obligation_id, event_kind, amount_cents)
      values
        ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '11111111-1111-1111-1111-111111111111',
         'payment', 5000);
    `);

    const expected = {
      outstandingCents: 7000,
      overdueCents: 0,
      collectedCents: 5000,
      memberCount: 2,
    };

    const readSummary = async (args = {}) => {
      const result = await client.query(
        `select public.get_dues_workspace($1, $2, $3, $4, $5, $6) as workspace`,
        [
          args.query ?? null,
          args.status ?? null,
          args.dueOn ?? null,
          args.afterId ?? null,
          args.limit ?? 25,
          args.hat ?? "admin",
        ],
      );
      return result.rows[0].workspace;
    };

    const asTotals = (workspace) => ({
      outstandingCents: Number(workspace.summary.outstandingCents),
      overdueCents: Number(workspace.summary.overdueCents),
      collectedCents: Number(workspace.summary.collectedCents),
      memberCount: Number(workspace.summary.memberCount),
    });

    await client.query(fnBody(loadMigrationSql("20260831211500_mi1_dues_review_repairs"), "public.get_dues_workspace"));
    const priorOpen = asTotals(await readSummary());
    const priorPaid = asTotals(await readSummary({ status: "paid" }));
    expect(priorOpen).toEqual(expected);
    expect(priorPaid).not.toEqual(expected);
    expect(priorPaid).toEqual({
      outstandingCents: 0,
      overdueCents: 0,
      collectedCents: 5000,
      memberCount: 1,
    });

    await client.query(body);
    const open = await readSummary();
    const paid = await readSummary({ status: "paid" });
    const named = await readSummary({ query: "Ada" });
    expect(asTotals(open)).toEqual(expected);
    expect(asTotals(paid)).toEqual(expected);
    expect(asTotals(named)).toEqual(expected);
    expect(paid.obligations.items).toHaveLength(1);
    expect(paid.obligations.items[0].memberLabel).toBe("Ada");
    expect(named.obligations.items).toHaveLength(1);
    expect(named.obligations.items[0].memberLabel).toBe("Ada");
    expect(open.obligations.items).toHaveLength(2);
  }, 60000);
});
