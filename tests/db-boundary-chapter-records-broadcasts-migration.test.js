// @vitest-environment node
//
// Static contract for the db-boundary batch:
//
//   SEC-UG-CHAPTER-RECORDS-CONTACT-READ-20260817
//   SEC-UG-BROADCASTS-CHAPTER-BOUNDARY-20260817
//
// These pins are the offline half. The live half is
// scripts/verify-db-boundary-tenancy.mjs, which stands two organizations up
// with colliding chapter names and asks the database directly; it needs a
// database, so it cannot run in this suite. What text pins CAN do that a live
// proof cannot is fail when a guard is deleted from the migration but the
// deployed database still carries the old definition — the drift class that
// keeps a green suite pointing at a boundary nobody is maintaining any more.
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { assertNoCommit, makeDenied } from "../scripts/verify-db-boundary-tenancy.mjs";
import { findMigrationName, fnBody, loadMigrationSql, stripComments } from "./helpers/migration.js";
import { normalise } from "../scripts/verify-migration-history.mjs";

const FRAGMENT = "20260826140000_chapter_record_publication_and_broadcast_audience";
const sql = loadMigrationSql(FRAGMENT);
const code = stripComments(sql);
const body = (name) => stripComments(fnBody(sql, name));

const STAFF = "array['steward', 'coordinator', 'advisor', 'admin', 'vp']";

describe("reserved migration placement", () => {
  it("lands after the organization-scope foundation it builds on", () => {
    // Both policies here replace policies created by 20260822010000. Applied
    // in the other order, `drop policy if exists` would silently no-op and the
    // foundation would then re-create the superseded pair.
    expect(findMigrationName(FRAGMENT) > findMigrationName("20260822010000_mi1_organization_scope_foundation")).toBe(true);
  });

  it("does not port PR #930's backdated single-tenant migration", () => {
    // The 2026-08-21 audit note is explicit that #930's policy is unsafe and
    // must not be replayed. A fresh file is the whole point of the record.
    expect(code).not.toContain("member_broadcasts_read_authenticated on public.member_broadcasts\n  using (true)");
    expect(code).not.toMatch(/audience_scope\s*=\s*'global'/);
    expect(code).not.toMatch(/organization_id\s+is\s+not\s+distinct\s+from\s+\(select\s+private\.current_member_organization/);
  });

  it("adds no table, column, constraint, or index, so nothing needs backfilling", () => {
    // The migration-safety claim in the header, mechanically. A column added
    // here would have to be backfilled before it could be constrained, on both
    // an empty production database and the seeded SAMPLE one.
    expect(code).not.toMatch(/\balter table\b/i);
    expect(code).not.toMatch(/\bcreate (unique )?index\b/i);
    expect(code).not.toMatch(/\bcreate table\b/i);
  });

  it("never backfills an organization onto quarantined legacy rows", () => {
    // Inventing a tenant for the orphan rows would satisfy "every broadcast
    // carries an organization" by manufacturing a fictional organization,
    // which the repository tenancy contract forbids outright.
    expect(code).not.toMatch(/update\s+public\.(chapters|member_broadcasts)\s+set[\s\S]{0,120}organization_id\s*=/i);
    expect(code).not.toMatch(/insert\s+into\s+public\.organizations/i);
  });
});

describe("chapter-record publication rules", () => {
  it("names an audience for every record type the table's CHECK constraint allows", () => {
    // The rule and the constraint have to agree, or a record type ships
    // readable-by-nobody (or, worse, readable by the wrong list) with nothing
    // pointing that out. The constraint is read from the migration that
    // declares it, so adding a sixth type there fails this test until a
    // publication decision is written down here.
    const source = stripComments(loadMigrationSql("20260727211853_full_product_completion"));
    const constraint = source.match(/record_type text not null check \(record_type in \(([^)]*)\)\)/);
    expect(constraint, "chapter_records.record_type CHECK constraint still parses").not.toBeNull();
    const declared = constraint[1].split(",").map((entry) => entry.trim());
    expect(declared.length).toBeGreaterThan(0);
    const rule = body("private.chapter_record_publication");
    for (const type of declared) {
      expect(rule, `record type ${type} has no publication decision`).toContain(`when ${type} then`);
    }
  });

  it("fails closed for any record type nobody has decided about", () => {
    const rule = body("private.chapter_record_publication");
    expect(rule).toContain("else 'denied'");
    expect(rule).toContain("'chapter_members'");
    expect(rule).toContain("'chapter_staff'");
    // Contact notes are never on the member-facing side of the rule.
    expect(rule).toMatch(/when 'member_contact' then 'chapter_staff'/);
    expect(rule).toMatch(/when 'management_contact' then 'chapter_staff'/);
  });

  it("carries the record's minutes/decisions/milestones visibility decision in the database", () => {
    // Acceptance criterion 4 is a DOCUMENTED decision, not a code comment that
    // ships nowhere. comment on policy puts it in the catalog, where the next
    // reviewer of this table actually looks.
    expect(code).toContain("comment on policy chapter_records_read_chapter on public.chapter_records is");
    expect(code).toContain("comment on policy chapter_records_read_contacts on public.chapter_records is");
    const decision = sql.slice(sql.indexOf("comment on policy chapter_records_read_chapter"));
    expect(decision).toContain("DELIBERATE VISIBILITY DECISION");
    expect(decision).toContain("SEC-UG-CHAPTER-RECORDS-CONTACT-READ-20260817");
    expect(decision).toMatch(/minutes, decisions, and milestones remain chapter-wide/);
  });

  it("rebuilds both read policies behind the publication rule", () => {
    expect(code).toContain("drop policy if exists chapter_records_read_chapter on public.chapter_records");
    expect(code).toContain("drop policy if exists chapter_records_read_contacts on public.chapter_records");
    expect(code).toContain("private.chapter_record_publication(record_type) = 'chapter_members'");
    expect(code).toContain("private.chapter_record_publication(record_type) = 'chapter_staff'");
    expect(code).toContain("private.can_read_chapter_member_record(chapter_id)");
    expect(code).toContain("private.can_read_chapter_contact_record(chapter_id)");
    // No literal record_type list survives in either policy: the rule is the
    // single place a type's audience is decided.
    const policies = code.slice(code.indexOf("create policy chapter_records_read_chapter"));
    expect(policies).not.toContain("record_type in (");
  });
});

describe("contact-record predicate", () => {
  const contact = body("private.can_read_chapter_contact_record");

  it("is staff-only and MFA-gated on the organization branch", () => {
    expect(contact).toContain("private.mfa_satisfied()");
    expect(contact).toContain("c.organization_id = (select private.current_member_organization())");
    expect(contact).toContain("private.is_organization_member(c.organization_id)");
    expect(contact).toContain(`private.has_organization_role(\n                c.organization_id,\n                ${STAFF})`);
    expect(contact).toContain("private.member_has_chapter_role(");
  });

  it("states chapter containment and the staff-MFA rule on the orphan branch instead of borrowing them", () => {
    // Before this migration the orphan branch was contained only because the
    // policy's chapters subquery inherited chapters_select_all, and gated only
    // because private.member_has_chapter_role reaches public.member_has_role,
    // whose LAST clause happens to check a second factor. This predicate runs
    // SECURITY DEFINER, so the first no longer applies at all, and the second
    // is three helpers away from the thing it protects.
    const orphan = contact.slice(contact.indexOf("c.organization_id is null"));
    expect(orphan).toContain("(select private.current_member_organization()) is null");
    expect(orphan).toContain("public.member_chapter_memberships m");
    expect(orphan).toContain("m.chapter_id = c.id");
    expect(orphan).toContain("m.status = 'active'");
    expect(orphan).toContain("private.staff_mfa_required()");
    expect(orphan).toContain("private.has_second_factor((select auth.uid()))");
  });

  it("pins an empty search_path and is never executable by anon or PUBLIC", () => {
    for (const fn of [
      "private.chapter_record_publication(text)",
      "private.can_read_chapter_member_record(text)",
      "private.can_read_chapter_contact_record(text)",
    ]) {
      expect(code).toContain(`revoke all on function ${fn}\n  from public, anon, authenticated, service_role`);
      expect(code).toContain(`grant execute on function ${fn} to authenticated`);
    }
    expect(contact).toContain("set search_path = ''");
    expect(body("private.can_read_chapter_member_record")).toContain("set search_path = ''");
    expect(body("private.chapter_record_publication")).toContain("set search_path = ''");
  });

  it("keeps the chapter-record predicate on the caller's selected chapter", () => {
    const member = body("private.can_read_chapter_member_record");
    expect(member).toContain("p_chapter_id is distinct from (select private.current_member_chapter())");
    expect(member).toContain("m.status = 'active'");
    expect(member).toContain("private.is_organization_member(c.organization_id)");
    // A null organization is never a wildcard: the orphan branch requires the
    // CALLER to be organization-less too, so an organization-backed session
    // can never reach a quarantined chapter's records.
    expect(member).toContain("c.organization_id is null\n            and (select private.current_member_organization()) is null");
  });
});

describe("broadcast audience boundary", () => {
  const guard = body("private.forbid_ownerless_broadcast_write");

  it("keeps the ownerless-write and organization-immutability guards", () => {
    expect(guard).toContain("ownerless broadcast writes are prohibited");
    expect(guard).toContain("broadcast organization is immutable");
    expect(guard).toContain("legacy broadcast reassignment is operator disposition");
    expect(guard).toContain("broadcast chapter is outside organization");
  });

  it("pins the audience and the chapter once a broadcast is published", () => {
    // Widening a chapter broadcast to the whole organization after the fact is
    // a republication to an audience that never authorized it, and it leaves
    // no trace in the row: same id, same body, more readers.
    expect(guard).toContain("broadcast audience is immutable");
    expect(guard).toContain("broadcast chapter is immutable");
    expect(guard).toContain("broadcast audience is required");
    expect(guard).toMatch(/old\.audience_scope is not null[\s\S]{0,80}new\.audience_scope is distinct from old\.audience_scope/);
    expect(guard).toMatch(/old\.chapter_id is not null[\s\S]{0,80}new\.chapter_id is distinct from old\.chapter_id/);
  });

  it("bounds the steward desk pager to the caller's own organization, page and total alike", () => {
    const pager = body("public.list_steward_broadcasts");
    expect(code).toContain("drop function if exists public.list_steward_broadcasts(text, text, timestamptz, text, integer)");
    expect(pager).toContain("desk_org uuid := private.current_member_organization()");
    expect(pager).toContain("if desk_org is null then");
    // Both the page and the count, because a total_count computed over a wider
    // set leaks how many broadcasts a foreign tenant has published even when
    // no row itself is returned.
    const occurrences = pager.split("b.organization_id = desk_org").length - 1;
    expect(occurrences).toBe(2);
    expect(pager).toContain("b.audience_scope, b.chapter_id");
    expect(pager).toContain("audience_scope text");
  });

  it("bounds the 30-day broadcast KPI to the same organization", () => {
    const kpis = body("public.get_steward_desk_kpis");
    expect(kpis).toContain("desk_org uuid := private.current_member_organization()");
    expect(kpis).toContain("b.organization_id is not null");
    expect(kpis).toContain("b.organization_id = desk_org");
  });

  it("re-narrows EXECUTE after rebuilding the pager", () => {
    // A function recreated after DROP is born with EXECUTE to PUBLIC. Missing
    // this revoke would hand the desk pager to anon.
    expect(code).toContain("revoke all on function public.list_steward_broadcasts(text, text, timestamptz, text, integer) from public, anon");
    expect(code).toContain("grant execute on function public.list_steward_broadcasts(text, text, timestamptz, text, integer) to authenticated, service_role");
    expect(code).toContain("revoke all on function public.get_steward_desk_kpis() from public, anon");
  });
});

describe("the live two-organization proof this migration ships with", () => {
  const proof = readFileSync(new URL("../scripts/verify-db-boundary-tenancy.mjs", import.meta.url), "utf8");

  it("can never commit its fixtures", () => {
    // Two fictional organizations left behind on a shared database would
    // violate the tenancy contract, so the proof's only terminating statement
    // is rollback and it refuses to send anything that could end the
    // transaction another way.
    expect(proof).toContain("function assertNoCommit");
    expect(proof).toContain('await client.query("rollback")');
    expect(proof.match(/client\.query\("commit"\)/g)).toBeNull();
  });

  // TEST-UG-DB-BOUNDARY-PROOF-REPLAYS-SUPERSEDED-MIGRATION-20260921: the
  // proof used to replay 20260826140000 inside its transaction, which dies on a
  // stack migrated to Main and re-creates retired policies on an older one.
  it("never reads a migration file and sends it to the database", () => {
    const code = proof.replace(/^\s*\/\/.*$/gm, "");
    expect(code).not.toMatch(/readFileSync\([\s\S]{0,200}?supabase[\s\S]{0,40}?migrations[\s\S]*?(?:run|client\.query)\(/);
    expect(code).not.toMatch(/\.sql["'`]/);
    expect(code).toContain("migrationDigestDrift(localMigrations()");
  });

  it("asserts the shipped read policies by name", () => {
    // One merged read policy since 20261028210000 (the OR of _read_chapter and _read_staff).
    expect(proof).toContain('"chapter_records_select", await readPolicies("chapter_records")');
    expect(proof).toContain('"member_broadcasts_read_authenticated", await readPolicies("member_broadcasts")');
  });

  it("refuses a stack whose recorded migrations differ from supabase/migrations", async () => {
    const { migrationDigestDrift } = await import("../scripts/verify-db-boundary-tenancy.mjs");
    const local = new Map([
      ["20260826140000", { file: "20260826140000_a.sql", hash: normalise("create function private.a() returns int as $$ select 1 $$ language sql;") }],
      ["20260830060000", { file: "20260830060000_b.sql", hash: normalise("create policy b on public.t for select using (true);") }],
    ]);
    const recorded = [
      { version: "20260826140000", sql: "create function private.a() returns int as $$ select 1 $$ language sql;" },
      { version: "20260830060000", sql: "-- same statement, other layout\ncreate policy b on public.t\n  for select using (true);" },
    ];
    expect(migrationDigestDrift(local, recorded)).toEqual([]);
    expect(migrationDigestDrift(local, recorded.slice(0, 1))).toEqual(["20260830060000_b.sql is not applied"]);
    expect(migrationDigestDrift(local, [recorded[0], { ...recorded[1], sql: "create policy b on public.t for select using (false);" }]))
      .toEqual(["20260830060000_b.sql differs from the recorded statements"]);
    expect(migrationDigestDrift(local, [...recorded, { version: "20260909080000", sql: "select 1;" }]))
      .toEqual(["20260909080000 is recorded but has no local file"]);
  });

  // SYS-UG-DB-BOUNDARY-PROOF-ABSENT-FROM-CI-20260921: an unset URL used to
  // SKIP and exit 0 everywhere, so a CI lane that reached the proof without its
  // database read green. On a GitHub Actions runner it is now a failure; a
  // developer machine without a stack still skips.
  it("fails instead of skipping when a GitHub Actions runner reaches it without a URL", () => {
    const repoRoot = fileURLToPath(new URL("../", import.meta.url));
    const runProof = (extra) => {
      const env = { ...process.env, ...extra };
      for (const name of ["SUPABASE_DB_URL", "DB_BOUNDARY_DB_URL", "REQUIRE_DB_VERIFY", "GITHUB_ACTIONS"]) {
        if (!(name in extra)) delete env[name];
      }
      return spawnSync(process.execPath, ["scripts/verify-db-boundary-tenancy.mjs"], { cwd: repoRoot, encoding: "utf8", env });
    };
    const onRunner = runProof({ GITHUB_ACTIONS: "true" });
    expect(onRunner.status, onRunner.stdout + onRunner.stderr).toBe(1);
    expect(onRunner.stderr).toContain("FAIL: SUPABASE_DB_URL not set on a GitHub Actions runner");
    expect(onRunner.stdout).not.toContain("SKIP");
    const offRunner = runProof({});
    expect(offRunner.status, offRunner.stdout + offRunner.stderr).toBe(0);
    expect(offRunner.stdout).toContain("SKIP: SUPABASE_DB_URL not set");
    const armed = runProof({ REQUIRE_DB_VERIFY: "1" });
    expect(armed.status).toBe(1);
    expect(armed.stderr).toContain("FAIL: SUPABASE_DB_URL not set but REQUIRE_DB_VERIFY=1");
  }, 60_000);

  it("refuses production, SAMPLE, and non-loopback targets", () => {
    expect(proof).toContain("forbiddenProjectRefIn(contract.target, haystack)");
    expect(proof).toContain("contract.target.projectRef");
    expect(proof).toContain("refusing a non-loopback host");
  });

  it("covers every acceptance criterion both records name", () => {
    for (const needle of [
      "two organizations may reuse a chapter name and slug",
      "ordinary member reads ZERO contact records",
      "MFA staff read ZERO foreign-organization contact records",
      "staff without a second factor read ZERO contact records",
      "organization-wide is NOT global",
      "cross-organization read counts return nothing",
      "cross-organization task derivation from a broadcast is refused",
      "the second organization's 30-day broadcast KPI is zero",
      "a published broadcast's audience cannot be widened afterwards",
      // The immutability clauses run on every UPDATE, retraction included. A
      // guard that cannot tell "retract this" from "republish this wider"
      // would take the steward's only takeback with it.
      "retracting a broadcast still works with the audience pinned",
    ]) {
      expect(proof, `missing coverage: ${needle}`).toContain(needle);
    }
  });
});

describe("assertNoCommit", () => {
  const refused = ["end;", "END ;", "commit", "select 1; commit", "prepare transaction x", "select 'end;'; commit"];

  it("refuses end;, END ;, commit, a commit after another statement, and prepare transaction", () => {
    for (const statement of refused) {
      expect(() => assertNoCommit(statement), statement).toThrow(/this proof may never commit/);
    }
  });

  it("allows migration text and plpgsql end inside a dollar-quoted body", () => {
    // This migration's `end;` / `end if;` tokens are PL/pgSQL inside
    // `$function$` and `$$`, not transaction control.
    expect(() => assertNoCommit(sql)).not.toThrow();
    expect(() => assertNoCommit(`
      create function demo() returns void language plpgsql as $function$
      begin
        if true then
          null;
        end if;
      end;
      $function$;
    `)).not.toThrow();
    expect(() => assertNoCommit(`
      create function demo() returns void language plpgsql as $$
      begin
        if true then
          null;
        end if;
      end;
      $$;
    `)).not.toThrow();
  });

  it("ignores terminators hidden in comments or literals, and allows the proof's own transaction statements", () => {
    for (const statement of [
      "select 'commit'",
      "select 'end;'",
      "select '; commit'",
      "select 'it''s the end;'",
      "-- commit\nselect 1",
      "/* end; */ select 1",
      "/* prepare transaction x */ select 1",
      "select case when true then 1 else 0 end as value",
      "begin",
      "rollback to savepoint probe",
      "release savepoint probe",
      "savepoint probe",
    ]) {
      expect(() => assertNoCommit(statement), statement).not.toThrow();
    }
  });
});

describe("denied() requires the expected SQLSTATE", () => {
  function fakePgClient(probeError) {
    const calls = [];
    const client = {
      async query(sql, params) {
        calls.push({ sql, params });
        if (/^(savepoint|rollback to savepoint|release savepoint)\b/i.test(sql)) {
          return { rows: [] };
        }
        throw probeError;
      },
    };
    return { client, calls };
  }

  async function probe(label, probeError, expectedState, sql = "select public.create_chapter_task_from_source('broadcast', $1)", params = ["bc-proof"]) {
    const { client, calls } = fakePgClient(probeError);
    const seen = [];
    const check = (name, ok, detail = "") => {
      seen.push({
        label: name,
        ok,
        detail,
        rolledBack: calls.some((call) => /^rollback to savepoint\b/i.test(call.sql)),
      });
    };
    const denied = makeDenied({ run: (statement, values) => client.query(statement, values), check });
    const returned = await denied(label, expectedState, sql, params);
    return { seen, calls, returned };
  }

  it("records a failure when a fake pg client throws 42883", async () => {
    const error = Object.assign(
      new Error("function public.create_chapter_task_from_source(unknown) does not exist"),
      { code: "42883" },
    );
    const { seen, calls } = await probe(
      "cross-organization task derivation from a broadcast is refused",
      error,
      "22023",
    );
    expect(seen).toEqual([
      {
        label: "cross-organization task derivation from a broadcast is refused",
        ok: false,
        detail: "expected SQLSTATE 22023, got 42883",
        rolledBack: true,
      },
    ]);
    expect(calls.map((call) => call.sql)).toEqual([
      "savepoint probe",
      "select public.create_chapter_task_from_source('broadcast', $1)",
      "rollback to savepoint probe",
      "release savepoint probe",
    ]);
  });

  it("records a failure when 42501 is a missing EXECUTE grant rather than the named refusal", async () => {
    const error = Object.assign(
      new Error("permission denied for function publish_member_broadcast"),
      { code: "42501" },
    );
    const { seen } = await probe(
      "a chapter steward cannot publish an organization audience without an org-wide hat",
      error,
      { code: "42501", message: "organization-wide steward role required" },
      "select public.publish_member_broadcast('Proof org denied', 'Denied', 'en', 'organization')",
    );
    expect(seen).toEqual([
      {
        label: "a chapter steward cannot publish an organization audience without an org-wide hat",
        ok: false,
        detail: 'expected SQLSTATE 42501 mentioning "organization-wide steward role required", got "permission denied for function publish_member_broadcast"',
        rolledBack: true,
      },
    ]);
  });

  it("records success when the SQLSTATE and the refusal text match", async () => {
    const error = Object.assign(
      new Error("broadcast not found, not yours, or already retracted"),
      { code: "22023" },
    );
    const { seen, returned } = await probe(
      "a retracted broadcast cannot be retracted twice",
      error,
      { code: "22023", message: "broadcast not found, not yours, or already retracted" },
      "select public.retract_member_broadcast($1)",
      ["bc-retracted"],
    );
    expect(returned).toBe("broadcast not found, not yours, or already retracted");
    expect(seen).toEqual([
      {
        label: "a retracted broadcast cannot be retracted twice",
        ok: true,
        detail: "",
        rolledBack: true,
      },
    ]);
  });
});
