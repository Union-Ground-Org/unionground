// @vitest-environment node
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { codeOnly, readMigrationFunctions } from "../scripts/account-case-graph-inventory.mjs";
import { fnBody, migrationFiles, stripComments } from "./helpers/migration.js";
import { beforeSameRefusals, SAME_REFUSALS_MIGRATION } from "./helpers/refusals-same-for-other-organizations.js";

// 20260917133000 replaces public.coordinator_update_case, and
// 20260917104000 replaces private.coordinator_case_for_update. Reading the
// original 20260810200000 text stays green after either live validation rule
// is removed, so validation pins resolve the last migration definition first.
const ORIGIN_MIGRATION = "20260810200000_coordinator_case_writes.sql";
const LIVE_UPDATE_MIGRATION = "20260917133000_casework_procedures_retire_w2.sql";
const LIVE_GATE_MIGRATION = "20260917104000_coordinator_case_write_restriction_gate.sql";
const LIVE_READ_POLICY_MIGRATION = "20260917103000_case_child_row_restriction_gate.sql";
// REQ-UG-LEARNING-PERIOD-CASE-RECORDS-20261103 re-emits these writers
// with the graph lock first and one journal call; every rule below still holds
// on that live body.
const LEARNING_CASE_RECORDS = "20261104075000_learning_period_case_records.sql";
// Part 2 (20261104123000) re-emits the outcome writer to keep a kept outcome's status change.
const LEARNING_CASE_WORKFLOW = "20261104123000_learning_period_case_workflow.sql";
// #7195 (20261106216000) re-emits the outcome writer to notify the case owner.
const OUTCOME_NOTICE = "20261106216000_member_case_outcome_visible_to_owner.sql";

const migrationsDir = resolve(import.meta.dirname, "../supabase/migrations");
const source = readFileSync(resolve(migrationsDir, ORIGIN_MIGRATION), "utf8").toLowerCase();
const sql = stripComments(source).replace(/\s+/g, " ");
const functions = readMigrationFunctions(migrationsDir);

function collapse(text) {
  return stripComments(text).toLowerCase().replace(/\s+/g, " ");
}

function latestFunction(name, arity) {
  const found = functions.find((fn) => fn.name === name && fn.arity === arity);
  if (!found) throw new Error(`missing effective function ${name}/${arity}`);
  return found;
}

function bodyText(fn) {
  return codeOnly(fn.source).replace(/\s+/g, " ");
}

function latestPolicy(policyName) {
  let found = null;
  for (const entry of migrationFiles()) {
    const code = collapse(entry.sql);
    const at = Math.max(...["create", "alter"].map((verb) => code.lastIndexOf(`${verb} policy ${policyName} `)));
    if (at === -1) continue;
    const end = code.indexOf(";", at);
    found = { file: entry.name, statement: code.slice(at, end === -1 ? undefined : end) };
  }
  if (!found) throw new Error(`missing policy ${policyName}`);
  return found;
}

const READ_POLICIES = [
  "member_case_contacts_select_coordinator",
  "member_case_outcomes_select_coordinator",
  "coordinator_case_audit_select_coordinator",
];

const ORIGIN_WRITERS = [
  ["public.coordinator_add_case_note", 2, "coordinator_add_case_note", "note_added", "coordinator_add_case_note(uuid,text)"],
  ["public.coordinator_log_case_contact", 5, "coordinator_log_case_contact", "contact_logged", "coordinator_log_case_contact(uuid,text,text,text,timestamptz)"],
  ["public.coordinator_record_case_outcome", 3, "coordinator_record_case_outcome", "outcome_recorded", "coordinator_record_case_outcome(uuid,text,text)"],
];

describe("coordinator case writes migration", () => {
  it("creates bounded contact, outcome, and immutable audit records", () => {
    for (const table of ["member_case_contacts", "member_case_outcomes", "coordinator_case_audit"]) expect(sql).toContain(`create table public.${table}`);
    expect(sql).toContain("contact_type in ('phone','email','meeting','letter','other')");
    expect(sql).toContain("direction in ('outbound','inbound','internal')");
    expect(sql).toContain("outcome in ('upheld','settled','withdrawn','denied','other')");
    expect(sql).toContain("action in ('case_updated','note_added','contact_logged','outcome_recorded')");
    expect(sql).toContain("jsonb_typeof(after_value) = 'object'");
    expect(sql).not.toMatch(/grant\s+(insert|update|delete)[^;]*coordinator_case_audit/);
  });

  it("keeps every read and write inside coordinator scope plus MFA", () => {
    expect(source.match(/create policy mfa_assurance/g)).toHaveLength(3);
    for (const policyName of READ_POLICIES) {
      const policy = latestPolicy(policyName);
      expect(policy.file).toBe(policyName === "coordinator_case_audit_select_coordinator" ? "20261105191400_case_article_write_intent_and_audit_scope.sql" : LIVE_READ_POLICY_MIGRATION);
      expect(policy.statement).toContain("public.staff_can_see_user(user_id, 'coordinator')");
      expect(policy.statement).toContain("from public.member_cases c");
    }

    const gate = latestFunction("private.coordinator_case_for_update", 1);
    // #8365 re-emits the gate so both refusals use 42501; with that undone it
    // is the gate migration's body, whose grants still hold.
    expect(gate.file).toBe(SAME_REFUSALS_MIGRATION);
    const origin = functions.historical.find((fn) => fn.name === gate.name && fn.file === LIVE_GATE_MIGRATION);
    expect(beforeSameRefusals(gate.name, gate.source)).toBe(origin.source);
    const gateBody = bodyText(gate);
    expect(gateBody).not.toContain("errcode = '22023'");
    expect(gateBody).toContain("not private.mfa_satisfied()");
    expect(gateBody).toContain("member_has_role(array['coordinator'])");
    expect(gateBody).toContain("staff_can_see_user(c.user_id, 'coordinator')");
    expect(gateBody).toContain("for update of c");
    const gateFile = collapse(readFileSync(resolve(migrationsDir, LIVE_GATE_MIGRATION), "utf8"));
    expect(gateFile).toContain("revoke all on function private.coordinator_case_for_update(uuid) from public, anon, authenticated, service_role");
  });

  it("rejects direct step changes and deadline retreats on the live coordinator_update_case body", () => {
    const fn = latestFunction("public.coordinator_update_case", 6);
    expect(fn.file).toBe("20261105191400_case_article_write_intent_and_audit_scope.sql");
    const body = bodyText(fn);
    expect(body).toContain("perform private.learning_case_journal('case_edit', changed.id, null)");
    expect(body).toContain("if p_step is not null and p_step is distinct from old_case.step then raise exception 'step changes go through the procedure transition'");
    expect(body).toContain("next_status := coalesce(p_status, old_case.status)");
    expect(body).toContain("next_deadline := case when p_deadline = '-infinity'::date then old_case.deadline else p_deadline end");
    expect(body).toContain("if old_case.deadline is not null and (next_deadline is null or next_deadline < old_case.deadline)");
    expect(body).toContain("raise exception 'deadline may only be extended'");
    expect(body).toContain("update public.member_cases set status=next_status, deadline=next_deadline");
    expect(body).not.toContain("step=clean_step");
    expect(body).toContain("insert into public.coordinator_case_audit");
    expect(body).toContain("'case_updated'");
    expect(body).toContain("clean_reason");
  });

  it("atomically audits notes, contacts, and outcomes", () => {
    for (const [name, arity, bare, action] of ORIGIN_WRITERS) {
      const fn = latestFunction(name, arity);
      expect([ORIGIN_MIGRATION, LEARNING_CASE_RECORDS, LEARNING_CASE_WORKFLOW, OUTCOME_NOTICE]).toContain(fn.file);
      for (const text of ["coordinator_case_for_update", "insert into public.coordinator_case_audit", `'${action}'`]) {
        expect(bodyText(fn), `${name} live body`).toContain(text);
      }
      const body = fnBody(source, bare);
      expect(body).toContain("coordinator_case_for_update");
      expect(body).toContain("insert into public.coordinator_case_audit");
      expect(body).toContain(`'${action}'`);
    }
    const outcome = fnBody(source, "coordinator_record_case_outcome");
    expect(outcome).toContain("on conflict(case_id) do update");
    expect(outcome).toContain("update public.member_cases set status='resolved'");
  });

  it("grants only RPC execution and table reads to authenticated", () => {
    expect(sql).toContain("grant select on table public.member_case_contacts, public.member_case_outcomes, public.coordinator_case_audit to authenticated");
    for (const [, , , , signature] of ORIGIN_WRITERS) {
      expect(sql).toContain(`grant execute on function public.${signature} to authenticated`);
    }
    // The grant is made where the signature was last created; a later
    // create or replace keeps it.
    const updateFile = collapse(readFileSync(resolve(migrationsDir, LIVE_UPDATE_MIGRATION), "utf8"));
    expect(updateFile).toContain("public.coordinator_update_case(uuid, text, text, date, text) to authenticated");
  });
});
