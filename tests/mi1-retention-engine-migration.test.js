// @vitest-environment node
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { forbiddenSupabaseRefsIn } from "../scripts/lib/sibling-deny-list.mjs";
import { fnBody, loadMigrationSql, migrationFiles, stripComments } from "./helpers/migration.js";
import { PLATFORM_ENFORCED_RETENTION_CLASSES } from "../src/features/retention/platformPurges.js";

// 20260830180000 created the engine's tables, indexes, RLS policies and grants,
// and nothing since has moved them, so the structural pins below still read this
// file directly. Its FUNCTION bodies are a different matter: 20260907121000 and
// 20260918204000 each create-or-replace parts of the engine, so every function
// pin resolves the last declaration instead.
const rawSql = loadMigrationSql("mi1_retention_engine");
const sql = stripComments(rawSql);

// The last migration that declares `name`, comment-stripped. migrationFiles() is
// filename-sorted, which is the order Postgres applies them in, so the last
// declaration is the live one. Pinning the first keeps a superseded generation
// green while the database moves on — which is how this file came to describe a
// five-class engine long after the sixth and seventh classes landed.
//
// The match demands the `create [or replace]` lead: a bare `function <name>(`
// also appears in `grant execute on function ...`, so a migration that only
// re-grants would otherwise be mistaken for the declaring one.
// The corpus is read-only during this suite. Parse it once, including new
// catalog code lists, rather than rereading every migration for each pin.
const migrationSnapshot = migrationFiles().map((entry) => stripComments(entry.sql));
function latestDeclaration(name) {
  const lead = new RegExp(`create\\s+(or\\s+replace\\s+)?function\\s+${name.replace(/\./g, "\\.")}\\s*\\(`, "i");
  const declaring = migrationSnapshot.filter((text) => lead.test(text));
  if (declaring.length === 0) throw new Error(`no migration declares ${name}`);
  return fnBody(declaring.at(-1), name);
}

const config = latestDeclaration("private.retention_data_class_config");
const worker = latestDeclaration("private.perform_organization_retention_run");
const dbContract = JSON.parse(readFileSync(new URL("../scripts/db-contract.json", import.meta.url), "utf8"));
const publicFunctions = [
  "get_organization_retention_engine",
  "upsert_organization_retention_policy",
  "preview_organization_retention_run",
  "authorize_organization_retention_run",
  "execute_organization_retention_run",
];

// Derived from the live config, never hand-written, so no count below can go on
// describing a shape the database has already left behind.
const dataClasses = [...config.matchAll(/when '([a-z_]+)' then/g)].map((match) => match[1]);

// The row writers that implement the redaction shape. They destroy a body in
// place under the row lock and re-check the preservation order while doing it;
// a `delete from` in their place would be a different operation, not a
// stricter one.
const REDACTORS = ["private.redact_member_message_row", "private.redact_member_scheduled_message_row"];

// One entry per class the live config carries: the operation shape the config
// declares, the worker text that implements it, and how many bounded batches
// that implementation takes. The allowlist test asserts these keys are exactly
// `dataClasses`, so a class added to the config without an entry here fails the
// file instead of quietly going uncovered.
const CLASS_COVERAGE = {
  organization_page_views: { operation: "delete", target: "public.organization_page_views", batches: 1 },
  organization_engagement_events: { operation: "delete", target: "public.organization_engagement_events", batches: 1 },
  integration_job_history: { operation: "delete", target: "public.integration_jobs", batches: 1 },
  public_event_rsvps: { operation: "delete", target: "public.public_event_rsvps", batches: 1 },
  deleted_chapter_tasks: { operation: "delete", target: "public.chapter_tasks", batches: 1 },
  // Two loops, one bound each: the delivered messages, and the never-dispatched
  // scheduled copies that nothing points at.
  member_message_bodies: { operation: "redact", redactors: REDACTORS, batches: 2 },
  casework_record_versions: { operation: "delete", target: "private.casework_record_versions", batches: 1 },
  // REQ-UG-RETENTION-DEFAULT-POLICIES-20261001: the old default-on classes.
  member_notifications: { operation: "delete", target: "public.member_notifications", batches: 1 },
  // Two statements sharing ONE bound: the expired messages, then the threads
  // left holding no message at all. 20261010064500 made the second statement's
  // limit `5000 - removed` — still a `limit 5000` occurrence, still one budget.
  ai_assistant_conversations: { operation: "delete", target: "public.member_guide_messages", batches: 2, deletes: 2 },
  ai_usage_counters: { operation: "delete", target: "public.member_ai_requests", batches: 1 },
};

// One class's implementation inside the worker's `case run_row.data_class`
// dispatch: the text from its `when` through the next one.
function workerBranches(text) {
  const block = text.slice(text.indexOf("case run_row.data_class"), text.indexOf("end case;"));
  const marks = [...block.matchAll(/when '([a-z_]+)' then/g)];
  return Object.fromEntries(marks.map((mark, at) => [
    mark[1],
    block.slice(mark.index, at + 1 < marks.length ? marks[at + 1].index : block.length),
  ]));
}

describe("CR-104 organization retention engine migration", () => {
  it("creates tenant-owned policy and count-only run history with RLS and no seeded tenant", () => {
    expect(sql).toContain("create table public.organization_retention_policies");
    expect(sql).toContain("create table public.organization_retention_runs");
    expect(sql).toMatch(/organization_id uuid not null\s+references public\.organizations\(id\)/);
    expect(sql).toContain("Counts only; never retained row content.");
    expect(sql).toContain("alter table public.organization_retention_policies enable row level security");
    expect(sql).toContain("alter table public.organization_retention_runs enable row level security");
    for (const index of [
      "organization_page_views_retention_idx",
      "organization_engagement_events_retention_idx",
      "integration_jobs_retention_idx",
      "public_event_rsvps_retention_idx",
      "chapter_tasks_retention_idx",
    ]) expect(sql).toContain(`create index ${index}`);
    expect(sql).toContain("private.mfa_satisfied()");
    expect(sql).toContain("private.has_organization_role(organization_id, array['admin'])");
    expect(sql).not.toMatch(/insert into public\.organizations/i);
    const beforeWriters = sql.slice(0, sql.indexOf("create function public.upsert_organization_retention_policy"));
    expect(beforeWriters).not.toMatch(/insert into public\.organization_retention_policies/i);
  });

  it("keeps every authenticated entry point definer-pinned and admin/MFA scoped", () => {
    for (const name of publicFunctions) {
      const body = latestDeclaration(`public.${name}`);
      expect(body, name).toContain("security definer");
      expect(body, name).toContain("set search_path = ''");
      expect(body, name).toContain("private.assert_retention_admin(org)");
      // The grants were made once, in 20260830180000, and no later migration
      // revokes them; a create-or-replace leaves them in place.
      expect(sql, name).toContain(`grant execute on function public.${name}`);
    }
    const guard = latestDeclaration("private.assert_retention_admin");
    expect(guard).toContain("p_organization_id is distinct from private.current_member_organization()");
    expect(guard).toContain("not private.mfa_satisfied()");
    expect(guard).toContain("private.has_organization_role(p_organization_id, array['admin'])");
    expect(guard).toContain("for key share");
  });

  it("uses a closed allowlist, minimum windows, and exact typed enable/authorization phrases", () => {
    expect(dataClasses.length).toBeGreaterThan(0);
    for (const dataClass of dataClasses) expect(config).toContain(`when '${dataClass}'`);
    expect(Object.keys(CLASS_COVERAGE).sort()).toEqual([...dataClasses].sort());
    // Each class states its own operation shape, and the shape is what the
    // worker pins below are read against.
    for (const [dataClass, coverage] of Object.entries(CLASS_COVERAGE)) {
      expect(config, dataClass).toMatch(
        new RegExp(`when '${dataClass}' then[\\s\\S]*?'operation', '${coverage.operation}'`),
      );
    }
    // The settings surface carries a second, hand-written copy of the same list;
    // a class added to the config and not to the catalogue is invisible to every
    // administrator.
    const catalogue = latestDeclaration("public.get_organization_retention_engine")
      .match(/catalog\(data_class\) as \(values([\s\S]*?)\), policy_rows as \(/);
    expect(catalogue, "the engine catalogue must stay a literal values list").not.toBeNull();
    expect([...catalogue[1].matchAll(/'([a-z_]+)'/g)].map((match) => match[1])).toEqual(dataClasses);
    const upsert = latestDeclaration("public.upsert_organization_retention_policy");
    expect(upsert).toContain("'ENABLE ' || p_data_class");
    expect(upsert).toContain("p_retention_days < minimum_days");
    expect(upsert).toContain("p_retention_days > maximum_days");
    expect(config).toContain("'minimumDays', 90, 'maximumDays', 90, 'defaultDays', 90");
    const authorize = latestDeclaration("public.authorize_organization_retention_run");
    expect(authorize).toContain("'AUTHORIZE ' || run_row.data_class");
    expect(authorize).toContain("interval '15 minutes'");
  });

  it("previews only the caller organization and rechecks policy authorization before deletion", () => {
    const preview = latestDeclaration("public.preview_organization_retention_run");
    const authorize = latestDeclaration("public.authorize_organization_retention_run");
    const execute = latestDeclaration("public.execute_organization_retention_run");
    expect(preview).toContain("p.organization_id = org");
    expect(authorize).toContain("r.id = p_run_id and r.organization_id = org");
    expect(execute).toContain("run_organization is distinct from org");
    expect(worker).toContain("not policy_row.execution_enabled");
    expect(worker).toContain("policy_row.retention_days <> run_row.retention_days");
    expect(worker).toContain("pg_advisory_xact_lock");
  });

  it("gives every live class a tenant-filtered, bounded implementation in its declared operation shape", () => {
    const branches = workerBranches(worker);
    expect(Object.keys(branches).sort()).toEqual([...dataClasses].sort());
    for (const [dataClass, coverage] of Object.entries(CLASS_COVERAGE)) {
      const branch = branches[dataClass];
      expect(branch, dataClass).toContain("run_row.organization_id");
      expect(branch.match(/\blimit 5000\b/g), dataClass).toHaveLength(coverage.batches);
      if (coverage.operation === "delete") {
        expect(branch, dataClass).toContain(`delete from ${coverage.target} target`);
        expect(branch, dataClass).toMatch(/for update (of [a-z] )?skip locked/);
        for (const redactor of REDACTORS) expect(branch, dataClass).not.toContain(redactor);
      } else {
        for (const redactor of coverage.redactors) expect(branch, dataClass).toContain(`${redactor}(`);
        expect(branch, dataClass).not.toMatch(/delete from /);
      }
    }
    // Deliberately not the class count: the redaction class bounds two loops
    // where every deleting class bounds one statement.
    const batches = Object.values(CLASS_COVERAGE).reduce((total, coverage) => total + coverage.batches, 0);
    expect(worker.match(/\blimit 5000\b/g)).toHaveLength(batches);
    const deleting = Object.values(CLASS_COVERAGE).filter((coverage) => coverage.operation === "delete");
    const deletes = deleting.reduce((total, coverage) => total + (coverage.deletes ?? 1), 0);
    expect(worker.match(/delete from \S+ target/g)).toHaveLength(deletes);
  });

  // BUG-UG-AI-RETENTION-CASCADE-BATCH-COUNT-20261010. The thread
  // foreign key is `on delete cascade` (20260721000709), so the thread
  // statement of this class deletes member_guide_messages rows as a side
  // effect. While it selected threads "with no RECENT message", a thread older
  // than the window whose expired messages had not fitted in the message
  // statement's own 5,000 rows still qualified, and the cascade destroyed
  // those rows past the batch bound and outside `removed` — the number the run
  // reports as deletedCount. The two pins below are the two halves of the
  // repair: one budget across both statements, and a thread deleted only when
  // nothing points at it.
  it("gives the AI conversation class one shared batch budget and deletes only empty threads", () => {
    const branch = workerBranches(worker).ai_assistant_conversations;
    const at = branch.indexOf("public.member_guide_threads");
    expect(at, "the class must still delete threads as well as messages").toBeGreaterThan(-1);
    const messageHalf = branch.slice(0, at);
    const threadHalf = branch.slice(at);

    // The messages take the literal bound; the threads take what is left of it.
    expect(messageHalf).toContain("delete from public.member_guide_messages target");
    expect(messageHalf.match(/\blimit 5000\b/g)).toHaveLength(1);
    expect(messageHalf).toContain("get diagnostics removed = row_count");
    expect(threadHalf).toContain("limit 5000 - removed");
    expect(threadHalf).toContain("delete from public.member_guide_threads target");
    expect(threadHalf).toContain("removed := removed + extra");
    // Not a second independent 5,000: the only bound on the thread side is the
    // remainder of the one the message statement already spent.
    expect(threadHalf).not.toMatch(/limit 5000(?! - removed)/);

    // Emptiness, not recency — and asserted twice, because the candidate scan
    // cannot be the only guard against a message inserted into an expired
    // thread between the scan and the delete.
    const emptiness = /not exists \(\s*select 1 from public\.member_guide_messages m\s*where m\.thread_id = (?:t|target)\.id\s*\)/g;
    expect(threadHalf.match(emptiness)).toHaveLength(2);
    expect(threadHalf, "a thread test on message age is what the cascade escaped through")
      .not.toMatch(/m\.created_at/);
    // The surviving boundaries: tenant and cutoff on the thread itself.
    expect(threadHalf).toContain("t.organization_id = run_row.organization_id");
    expect(threadHalf).toMatch(/t\.updated_at < pg_catalog\.now\(\) - pg_catalog\.make_interval\(days => run_row\.retention_days\)/);
    expect(threadHalf).toContain("for update of t skip locked");

    // private.retention_eligible_count is the source of remaining_count, and
    // it counts an expired thread with no message newer than the cutoff. A
    // thread that is not yet empty is therefore still counted as eligible
    // while its messages drain, which is exactly what makes the continuation's
    // remaining_count exact. Pinned here so a later edit to one arm without
    // the other fails.
    const counter = latestDeclaration("private.retention_eligible_count");
    const arm = counter.slice(counter.indexOf("when 'ai_assistant_conversations' then"));
    expect(arm.slice(0, arm.indexOf("when 'ai_usage_counters' then")))
      .toMatch(/m\.thread_id = t\.id and m\.created_at >= cutoff/);
  });

  it("bounds candidate selection and preserves the audit ledger and message rows", () => {
    expect(worker).toContain("for update skip locked");
    expect(worker).toContain("for update of t skip locked");
    expect(worker).not.toMatch(/delete from public\.organization_audit_ledger/i);
    expect(worker).not.toMatch(/delete from public\.member_messages/i);
    expect(worker).not.toMatch(/delete from public\.member_scheduled_messages/i);
    expect(worker).not.toMatch(/execute\s+format|execute\s+p_data_class/i);
  });

  it("records attributable results and schedules only explicitly enabled organization policies", () => {
    const scheduler = latestDeclaration("private.run_due_organization_retention_jobs");
    expect(worker).toContain("'retention.completed'");
    expect(worker).toContain("'eligibleCount', run_row.eligible_count");
    expect(worker).toContain("'deletedCount', removed");
    expect(worker).toContain("'remainingCount', remaining");
    expect(scheduler).toContain("where p.execution_enabled");
    expect(scheduler).toContain("r.created_at >= pg_catalog.now() - interval '20 hours'");
    expect(scheduler).toContain("greatest(1, least(coalesce(p_limit, 25), 100))");
    expect(sql).toContain("union-ground-organization-retention");
    expect(sql).toContain("if pg_catalog.to_regnamespace('cron') is not null");
  });

  it("pins the retention scheduler's live cron row, command included, in the db contract", () => {
    // DEBT-UG-DB-CONTRACT-RETENTION-CRON-COMMANDS-UNPINNED-20260921: the
    // schedule block swallows unique_violation and retention_scheduler_configured()
    // only checks the jobname, so verify:db is the only place a stale or
    // re-pointed command can surface.
    const entry = dbContract.cron.find((job) => job.jobname === "union-ground-organization-retention");
    expect(entry).toMatchObject({ schedule: "47 3 * * *", active: true });
    expect(entry.commandContains).toContain("private.run_due_organization_retention_jobs(25)");
    expect(sql).toContain("'47 3 * * *'");
    for (const needle of entry.commandContains) {
      expect(sql).toContain(`'select ${needle};'`);
    }
  });

  it("flags every class a global purge cron already deletes within its window as platform-enforced", () => {
    // DOCS-UG-RETENTION-PLATFORM-PURGES-BYPASS-POLICY-AUDIT-20260921: two
    // global crons purged public_event_rsvps and deleted_chapter_tasks at the
    // same 90 days as the class window, whatever execution_enabled said, so the
    // Admin toggle for those classes controlled nothing. Resolve every other
    // db-contract cron to the private functions its command runs (one call
    // level deep, so run_task_maintenance reaches purge_deleted_chapter_tasks)
    // and each `delete from <table> ... interval 'N days'` they perform.
    const stripped = migrationFiles().map((entry) => stripComments(entry.sql));
    const bodyOf = (name) => {
      const lead = new RegExp(`create\\s+(or\\s+replace\\s+)?function\\s+${name.replace(/\./g, "\\.")}\\s*\\(`, "i");
      const declaring = stripped.filter((text) => lead.test(text));
      if (declaring.length === 0) return "";
      try { return fnBody(declaring.at(-1), name); } catch { return ""; }
    };
    const purges = [];
    for (const job of dbContract.cron) {
      if (job.jobname === "union-ground-organization-retention") continue;
      const direct = job.commandContains.flatMap((needle) => [...needle.matchAll(/private\.[a-z_]+/g)].map((match) => match[0]));
      const called = new Set(direct);
      for (const name of direct) {
        for (const inner of bodyOf(name).matchAll(/private\.[a-z_]+(?=\s*\()/g)) called.add(inner[0]);
      }
      for (const name of called) {
        for (const statement of bodyOf(name).split(";")) {
          const target = statement.match(/delete\s+from\s+((?:public|private)\.[a-z_]+)/i);
          const age = statement.match(/interval\s+'(\d+)\s+days'/i);
          if (target && age) purges.push({ job: job.jobname, fn: name, table: target[1], days: Number(age[1]) });
        }
      }
    }
    // Not vacuous: the two purges the record names are found.
    expect(purges).toEqual(expect.arrayContaining([
      { job: "mi1-public-rsvp-retention", fn: "private.purge_expired_public_event_rsvps", table: "public.public_event_rsvps", days: 90 },
      { job: "task-maintenance-daily", fn: "private.purge_deleted_chapter_tasks", table: "public.chapter_tasks", days: 90 },
    ]));

    const flagged = [];
    for (const [dataClass, coverage] of Object.entries(CLASS_COVERAGE)) {
      if (coverage.operation !== "delete") continue;
      const bounds = config.match(new RegExp(`when '${dataClass}' then[\\s\\S]*?'minimumDays', (\\d+), 'maximumDays', (\\d+)`));
      expect(bounds, dataClass).not.toBeNull();
      const maximumDays = Number(bounds[2]);
      const preempting = purges.filter((purge) => purge.table === coverage.target && purge.days <= maximumDays);
      if (preempting.length === 0) continue;
      flagged.push(dataClass);
      const declared = PLATFORM_ENFORCED_RETENTION_CLASSES[dataClass];
      expect(declared, `${dataClass} is purged by ${preempting[0].job} but not flagged platform-enforced`).toBeTruthy();
      expect(preempting, dataClass).toContainEqual(expect.objectContaining({ job: declared.cronJob, fn: declared.purgeFunction }));
      // A platform-enforced class is a fixed window equal to the purge.
      expect(Number(bounds[1]), dataClass).toBe(maximumDays);
      expect(preempting.map((purge) => purge.days), dataClass).toContain(maximumDays);
    }
    // And nothing is flagged that no global purge actually pre-empts.
    expect(flagged.sort()).toEqual(Object.keys(PLATFORM_ENFORCED_RETENTION_CLASSES).sort());
  });

  it("extends both guarded SAMPLE parity lanes with deterministic reversible history", () => {
    const seed = latestDeclaration("private.demo_seed_retention_engine");
    const remove = latestDeclaration("private.demo_seed_remove_retention_engine");
    expect(seed).toContain("private.presg_demo_authorize(p_target_ref, p_confirm_token)");
    expect(seed).toContain("private.uniondemo_authorize(p_target_ref, p_confirm_token)");
    expect(seed).toContain("from pg_catalog.generate_series(1, 18)");
    expect(seed).toContain("organization_role_grants");
    expect(seed).toContain("grant_row.role = 'admin'");
    expect(remove).toContain("delete from public.organization_retention_runs");
    expect(remove).toContain("delete from public.organization_retention_policies");
    expect(sql).toContain("'retentionEngine', retention");
    expect(sql).toContain("set coverage = 'seeded', evidence_key = 'retention-engine'");
    expect(forbiddenSupabaseRefsIn(sql)).toEqual([]);
  });

  it("documents and rejects the donor's global authorization and secret-bearing architecture", () => {
    expect(rawSql).toContain("Donor baseline donor-baseline-20260721");
    expect(sql).not.toContain("data_retention_settings");
    expect(sql).not.toContain("is_hq_staff");
    expect(sql).not.toContain("purge_confirm_token");
    expect(sql).not.toMatch(/service[_-]?role.*key|supabase_service_role/i);
  });
});
