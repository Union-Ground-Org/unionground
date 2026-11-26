// @vitest-environment node
//
// REQ-UG-CASEWORK-CONSOLE-51-PROCEDURE-EVERY-PLANE-20260917 — retire the
// dormant W2 case-flow layer (20260826151000) in favour of the casework suite
// plus the organization-configurable procedure. Modelled on
// tests/messaging-retired-channel-controls.test.js: this file is the durable
// half of the disposition. It proves the reverse dependencies are gone and it
// fails if any future migration, client, script or contract reintroduces a
// retired table or RPC.
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { migrationFiles, stripComments } from "./helpers/migration.js";

const root = process.cwd();
const read = (path) => readFileSync(resolve(root, path), "utf8");
const migrations = migrationFiles();
const entry = migrations.find((file) => file.name === "20260917133000_casework_procedures_retire_w2.sql");
const raw = entry.sql;
const sql = stripComments(raw).toLowerCase();

const RETIRED_TABLES = [
  "case_deadline_changes", "case_deadline_audit", "case_checklist_progress", "case_step_transitions",
  "case_generated_work", "case_restrictions", "case_restriction_access", "case_alerts",
  "case_alert_acknowledgements", "case_reminders",
];
const RETIRED_PUBLIC_RPCS = [
  ["public.advance_case_step", "uuid, text"],
  ["public.request_case_deadline_change", "uuid, text, date, text"],
  ["public.review_case_deadline_change", "uuid, text"],
  ["public.patch_case_checklist", "uuid, jsonb"],
  ["public.acknowledge_case_alert", "uuid"],
  ["public.escalate_unacknowledged_case_alerts", ""],
  ["public.upsert_case_reminder", "jsonb"],
  ["public.dispose_case_reminder", "uuid, text"],
  ["public.get_organization_case_flow_snapshot", ""],
  ["public.set_case_restriction", "uuid, boolean, text, uuid[], uuid"],
];
const RETIRED_PRIVATE_HELPERS = [
  ["private.mi1_w2_generate_case_work", "uuid, public.member_cases, text"],
  ["private.mi1_w2_normalize_case_step", "text, text"],
  ["private.mi1_w2_require_visible_case", "uuid, uuid"],
  ["private.mi1_w2_append_only", ""],
];
const RETIRED_NAMES = [
  ...RETIRED_TABLES,
  ...RETIRED_PUBLIC_RPCS.map(([name]) => name.split(".")[1]),
  ...RETIRED_PRIVATE_HELPERS.map(([name]) => name.split(".")[1]),
];

function walk(directory, extensions) {
  const results = [];
  for (const name of readdirSync(directory)) {
    if (name === "node_modules" || name === ".expo" || name === "dist" || name === "coverage") continue;
    const path = join(directory, name);
    const stats = statSync(path);
    if (stats.isDirectory()) results.push(...walk(path, extensions));
    else if (extensions.some((extension) => name.endsWith(extension))) results.push(path);
  }
  return results;
}

describe("the retirement migration", () => {
  it("records a written disposition in its header, not just the drops", () => {
    expect(raw).toContain("BINDING DISPOSITION");
    expect(raw).toContain("tests/casework-retired-w2-layer.test.js");
    for (const table of RETIRED_TABLES) expect(raw, `${table} has no recorded disposition`).toMatch(new RegExp(`${table}[^\\n]*RETIRED`));
    expect(raw).toContain("WHAT IT WOULD TAKE TO BRING W2 BACK");
    expect(raw).toContain("ROLLBACK");
  });

  it("drops exactly the ten W2 tables and the nine public RPCs plus their private helpers", () => {
    for (const table of RETIRED_TABLES) expect(sql).toContain(`drop table public.${table};`);
    for (const [name, args] of [...RETIRED_PUBLIC_RPCS, ...RETIRED_PRIVATE_HELPERS]) expect(sql).toContain(`drop function ${name}(${args});`.toLowerCase());
  });

  it("drops the RPCs before the tables they read so no definer body survives its storage", () => {
    const firstDrop = sql.indexOf("drop table public.");
    for (const [name] of RETIRED_PUBLIC_RPCS) expect(sql.indexOf(`drop function ${name}(`), name).toBeLessThan(firstDrop);
  });

  it("withdraws the account-lifecycle manifest rows for the retired tables in the same migration", () => {
    const withdrawal = sql.indexOf("delete from private.account_lifecycle_manifest where schema_name = 'public'");
    expect(withdrawal).toBeGreaterThan(-1);
    const clause = sql.slice(withdrawal, sql.indexOf(";", withdrawal));
    for (const table of ["case_deadline_changes", "case_step_transitions"]) expect(clause).toContain(`'${table}'`);
    expect(sql).toContain("delete from private.account_lifecycle_transitive_fk_manifest where schema_name = 'public'");
    expect(sql).toContain("delete from private.account_lifecycle_trigger_review where schema_name = 'public'");
    // The replacement configuration table is enrolled where the retired rows left.
    expect(sql).toContain("insert into private.account_lifecycle_manifest(schema_name, table_name, user_column, delete_disposition");
    expect(sql).toContain("values ('public','casework_procedures','created_by','pseudonymize'");
  });

  it("keeps the one surviving visibility adapter on its role boundary and the casework restriction model", () => {
    expect(sql).toContain("create or replace function private.can_read_restricted_case(p_organization_id uuid, p_case_id uuid)");
    const start = sql.indexOf("create or replace function private.can_read_restricted_case");
    const body = sql.slice(start, sql.indexOf("$function$;", start));
    for (const needle of ["array['admin', 'vp']", "rc.role = 'coordinator'", "not mc.is_restricted", "public.casework_access_grants g", "g.revoked_at is null"]) expect(body).toContain(needle);
    for (const retired of ["case_restrictions", "case_restriction_access"]) expect(body).not.toContain(retired);
  });

  it("installs the configurable procedure with RLS, MFA and case-graph gates on every new table", () => {
    for (const table of ["casework_procedures", "casework_procedure_steps", "organization_holidays"]) {
      expect(sql).toContain(`alter table public.${table} enable row level security;`);
      expect(sql).toContain(`create policy mfa_assurance on public.${table} as restrictive for all to authenticated`);
      expect(sql).toContain(`create trigger a00_case_graph_lock before insert or update or delete on public.${table}\nfor each statement execute function private.lock_case_graph_statement();`);
    }
    expect(sql).toContain("revoke all on public.casework_procedures, public.casework_procedure_steps, public.organization_holidays from public, anon, authenticated;");
    expect(sql).toContain("grant select on public.casework_procedures, public.casework_procedure_steps, public.organization_holidays to authenticated;");
    expect(sql).not.toMatch(/grant (insert|update|delete)[^;]*on public\.(casework_procedures|casework_procedure_steps|organization_holidays)/);
  });

  it("revokes PUBLIC execute and grants the four procedure RPCs to authenticated only", () => {
    const signatures = [
      "public.casework_save_procedure(uuid, text, text, text, jsonb, integer)",
      "public.casework_list_procedures()",
      "public.casework_get_case_procedure(uuid)",
      "public.casework_set_holidays(jsonb)",
      "public.casework_advance_step(uuid, text, text, text, uuid)",
    ];
    const revoke = sql.indexOf("revoke all on function public.casework_save_procedure");
    const revokeClause = sql.slice(revoke, sql.indexOf(";", revoke));
    const grant = sql.indexOf("grant execute on function public.casework_save_procedure");
    const grantClause = sql.slice(grant, sql.indexOf(";", grant));
    for (const signature of signatures) {
      expect(revokeClause, signature).toContain(signature);
      expect(grantClause, signature).toContain(signature);
    }
    expect(revokeClause).toContain("from public, anon, authenticated, service_role");
    expect(grantClause.trim().endsWith("to authenticated")).toBe(true);
  });

  it("keeps member_cases.step free text: no enum, no step vocabulary", () => {
    expect(sql).not.toMatch(/create type [^;]*step/);
    expect(sql).not.toMatch(/alter table public\.member_cases[^;]*(alter column step|add constraint[^;]*step in \()/);
    for (const hardcoded of ["'management_response'", "'arbitration'", "'intake', 'filing'"]) expect(sql).not.toContain(hardcoded);
  });
});

describe("reverse-dependency proof", () => {
  function assertFutureMigration(file) {
    const code = stripComments(file.sql).toLowerCase();
    for (const name of RETIRED_NAMES) {
      expect(code, `${file.name} references retired object ${name}`).not.toMatch(new RegExp(`\\b${name}\\b`));
    }
  }

  it("no subsequent migration restores a retired table, RPC or helper", () => {
    for (const file of migrations.filter((candidate) => candidate.name > entry.name)) assertFutureMigration(file);
  });

  const restorations = [
    ...RETIRED_TABLES.flatMap((table) => [
      `create table public.${table} (id uuid primary key);`,
      `grant select, insert, update on public.${table} to authenticated;`,
    ]),
    ...RETIRED_PUBLIC_RPCS.flatMap(([name, args]) => [
      `create function ${name}(${args}) returns void language sql as 'select';`,
      `grant execute on function ${name}(${args}) to authenticated;`,
    ]),
    "create trigger case_deadline_audit_append_only before update or delete on public.case_deadline_audit for each row execute function private.mi1_w2_append_only();",
  ];
  it.each(restorations)("rejects a future migration restoring %s", (statement) => {
    expect(() => assertFutureMigration({ name: "20260918000000_restore_w2_case_flow.sql", sql: statement })).toThrow();
  });

  it("no client, API, native or script source reads or writes a retired table or RPC", () => {
    const sources = [
      ...walk(resolve(root, "src"), [".js", ".jsx"]),
      ...walk(resolve(root, "api"), [".js"]),
      ...walk(resolve(root, "apps/mobile/src"), [".ts", ".tsx"]),
      ...walk(resolve(root, "apps/mobile/app"), [".ts", ".tsx"]),
      ...walk(resolve(root, "scripts"), [".mjs"]),
    ];
    expect(sources.length).toBeGreaterThan(200);
    const offenders = [];
    for (const path of sources) {
      if (/\.(test|spec)\./.test(path)) continue;
      const source = readFileSync(path, "utf8");
      for (const name of RETIRED_NAMES) {
        if (new RegExp(`\\b${name}\\b`).test(source)) offenders.push(`${path}: ${name}`);
      }
    }
    expect(offenders, "retired W2 case-flow objects have reappeared").toEqual([]);
  });

  it("removes the retired objects from the database contract and adds the procedure suite", () => {
    const contract = JSON.parse(read("scripts/db-contract.json"));
    const signatures = contract.functions.map((fn) => fn.sig);
    for (const [name] of [...RETIRED_PUBLIC_RPCS, ...RETIRED_PRIVATE_HELPERS]) {
      expect(signatures.some((sig) => sig.startsWith(`${name}(`)), name).toBe(false);
    }
    for (const name of ["public.casework_save_procedure(", "public.casework_list_procedures(", "public.casework_get_case_procedure(", "public.casework_set_holidays("]) {
      expect(signatures.some((sig) => sig.startsWith(name)), name).toBe(true);
    }
    // Structured entries only: a bodyForbids pin may legitimately NAME a
    // retired table to prove a surviving function no longer reads it.
    const structured = [...contract.tableGrants, ...contract.columnGrants, ...contract.policies, ...contract.constraints, ...contract.indexes, ...contract.triggers]
      .map((entry) => String(entry.table || "").replace(/^public\./, ""));
    for (const table of RETIRED_TABLES) expect(structured, table).not.toContain(table);
  });

  // The migration header test above keeps the written
  // disposition, and this suite keeps the objects from coming back.
});
