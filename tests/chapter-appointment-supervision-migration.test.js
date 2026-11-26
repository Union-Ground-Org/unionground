// @vitest-environment node
//
// Static tripwires supplement the rollback-only local Postgres proof. They
// keep the migration and scripts/db-contract.json in lockstep when CI has no
// database; runtime authorization and transaction semantics are proved against
// local Postgres before handoff.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { fnBody, loadMigrationSql, migrationFiles, stripComments } from "./helpers/migration.js";
import { expectMi1OrganizationRlsContract } from "./helpers/mi1Contract.js";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const originMigration = "20260812204000_chapter_appointment_supervision.sql";
const rawSql = loadMigrationSql("20260812204000_chapter_appointment_supervision");
const sql = rawSql.toLowerCase();
const executableSql = stripComments(sql);
const contract = JSON.parse(readFileSync(join(repoRoot, "scripts/db-contract.json"), "utf8"));
const migrations = migrationFiles();
const consolidationMigration = "20260925030000_appointment_authorization_consolidation.sql";

// The origin supervision migration still defines the candidate and reassign
// RPCs checked below. The report was replaced later; follow its latest body so
// a live gate or privacy regression cannot stay green against superseded text.
const report = () => {
  const latest = latestFunction("list_chapter_appointments");
  expect(latest.name > originMigration).toBe(true);
  return latest.body;
};
const candidates = () => fnBody(sql, "list_chapter_appointment_reassignment_candidates");
const reassign = () => fnBody(sql, "reassign_chapter_appointment");

// Last definition, not a later grant or comment that merely names the function.
function latestFunction(name) {
  const needle = `function public.${name.toLowerCase()}(`;
  const migration = [...migrations].reverse().find(({ sql: text }) => {
    const executable = stripComments(text).toLowerCase();
    return executable.includes(`create or replace ${needle}`) || executable.includes(`create ${needle}`);
  });
  expect(migration, `missing migration for ${name}`).toBeTruthy();
  return { name: migration.name, body: stripComments(fnBody(migration.sql, name)).toLowerCase() };
}

function expectSupervisorGate(body) {
  expect(body).toContain("caller uuid := (select auth.uid())");
  expect(body).toContain("not private.mfa_satisfied()");
  expect(body).toMatch(/public\.member_has_role\(array\['coordinator',\s*'advisor',\s*'admin'\]\)/);
  expect(body).toContain("from public.member_profiles p where p.id = caller");
  expect(body).toMatch(/r\.role in \('coordinator',\s*'advisor',\s*'admin'\)/);
  expect(body).toContain("r.chapter_id is null or r.chapter_id = caller_chapter");
  expect(body).toContain("errcode = '42501'");
  expect(body).toContain("security definer");
  expect(body).toContain("set search_path = ''");
}

describe("chapter appointment supervisor authorization", () => {
  it("puts the origin candidate and reassign definers behind MFA, the exact role set, and current chapter scope", () => {
    for (const body of [candidates(), reassign()]) expectSupervisorGate(body);
    for (const body of [candidates(), reassign()]) {
      expect(body).not.toMatch(/member_has_role\(array\[[^\]]*'vp'/);
      expect(body).not.toMatch(/member_has_role\(array\[[^\]]*'steward'/);
    }
  });

  it("authorizes the latest candidate and reassign RPCs with the org-era chapter-role helper", () => {
    for (const name of [
      "list_chapter_appointment_reassignment_candidates",
      "reassign_chapter_appointment",
    ]) {
      const latest = latestFunction(name);
      expect(latest.name).toBe(consolidationMigration);
      expect(latest.body).toContain("private.member_has_chapter_role(caller_chapter, array['coordinator','advisor','admin'])");
      expect(latest.body).toContain("caller_chapter text := private.current_member_chapter()");
      expect(latest.body).toContain("not private.mfa_satisfied()");
      expect(latest.body).toContain("errcode = '42501'");
      expect(latest.body).not.toContain("public.member_has_role");
      expect(latest.body).not.toMatch(/from public\.member_roles r\s+where r\.user_id = caller/);
      expect(latest.body).not.toContain("r.chapter_id is null or r.chapter_id = caller_chapter");
      // Eligible stewards come from the shared resolver, never a local member_roles read.
      expect(latest.body).toContain("private.appointment_stewards_for_chapter(appt.chapter_id)");
      expect(latest.body).not.toContain("r.role = 'steward'");
      expect(latest.body).toContain("private.appointment_slots_for");
    }
    expect(latestFunction("reassign_chapter_appointment").body)
      .toContain("private.lock_case_graph(array[auth.uid()], array[]::uuid[])");
  });

  it("authorizes the latest chapter appointment report with the selected-chapter supervisor gate", () => {
    const body = report();
    expect(body).toContain("caller uuid := (select auth.uid())");
    expect(body).toContain("caller_chapter text := private.current_member_chapter()");
    expect(body).toContain("not private.mfa_satisfied()");
    expect(body).toContain("caller_chapter is null");
    expect(body).toContain("not private.member_has_chapter_role(caller_chapter, array['coordinator','advisor','admin'])");
    expect(body).toContain("raise exception 'appointment cursor is incomplete' using errcode = '22023'");
    expect(body).toContain("errcode = '42501'");
    expect(body).toContain("security definer");
    expect(body).toContain("set search_path = ''");
    expect(body).not.toContain("public.member_has_role");
    expect(body).not.toContain("from public.member_profiles p where p.id = caller");
    expect(body).not.toContain("from public.member_roles r");
    expect(body).not.toMatch(/member_has_chapter_role\([^)]*'vp'/);
    expect(body).not.toMatch(/member_has_chapter_role\([^)]*'steward'/);
  });

  it("revokes PUBLIC and anon execution on the origin migration, then grants only authenticated and service_role", () => {
    expect(sql).toContain("revoke all on function public.list_chapter_appointments(timestamptz, uuid, integer) from public, anon;");
    expect(sql).toContain("grant execute on function public.list_chapter_appointments(timestamptz, uuid, integer) to authenticated, service_role;");
    expect(sql).toContain("revoke all on function public.list_chapter_appointment_reassignment_candidates(uuid) from public, anon;");
    expect(sql).toContain("grant execute on function public.list_chapter_appointment_reassignment_candidates(uuid) to authenticated, service_role;");
    expect(sql).toContain("revoke all on function public.reassign_chapter_appointment(uuid, uuid) from public, anon;");
    expect(sql).toContain("grant execute on function public.reassign_chapter_appointment(uuid, uuid) to authenticated, service_role;");
  });
});

describe("privacy-bounded keyset chapter report", () => {
  it("walks every chapter row over a complete descending cursor with a true chapter total", () => {
    const body = report();
    expect(body).toContain("(p_after_starts is null) <> (p_after_id is null)");
    expect(body).toContain("least(greatest(coalesce(p_limit, 50), 1), 50)");
    expect(body).toContain("a.chapter_id = caller_chapter");
    expect(body).toContain("(a.starts_at, a.id) < (p_after_starts, p_after_id)");
    expect(body).toContain("order by a.starts_at desc, a.id desc");
    expect(body).toContain("select pg_catalog.count(*)::bigint");
    expect(body).toContain("where counted.chapter_id = caller_chapter");
  });

  it("returns only the approved report fields", () => {
    const body = report();
    for (const field of [
      "a.id", "member_name", "a.appointment_type", "a.duration_minutes",
      "a.starts_at", "a.ends_at", "a.status", "a.steward_id",
      "steward_name", "total_count",
    ]) expect(body).toContain(field);
    expect(body).not.toMatch(/reason_category|routed_via|\bplace\b|email|phone|member_appointment_events|member_calendar_/);
  });

  it("ships the chapter/start/id keyset index on the origin migration", () => {
    // Historical schema. The index is created once in 20260812204000 and is
    // not restated by the live list_chapter_appointments definition.
    expect(sql).toContain("create index if not exists member_appointments_chapter_starts_id_idx");
    expect(sql).toContain("on public.member_appointments (chapter_id, starts_at desc, id desc);");
  });
});

describe("candidate eligibility and atomic reassignment", () => {
  it("offers only live alternative stewards whose accepting schedule has the exact slot", () => {
    const body = candidates();
    expect(body).toContain("a.status = 'confirmed'");
    expect(body).toContain("a.starts_at > now()");
    expect(body).toContain("r.role = 'steward'");
    expect(body).toContain("public.member_appointment_schedules s");
    expect(body).not.toContain("public.steward_appointment_schedules");
    expect(body).toContain("r.chapter_id is null or r.chapter_id = appt.chapter_id");
    expect(body).toContain("s.accepting");
    expect(body).toContain("r.user_id <> appt.steward_id");
    expect(body).toContain("private.appointment_slots_for");
    expect(body).toContain("slot.slot_start = appt.starts_at");
  });

  it("locks and repeats every decisive target check before changing only steward identity", () => {
    const body = reassign();
    expect(body).toContain("for update");
    expect(body).toContain("a.status = 'confirmed'");
    expect(body).toContain("a.starts_at > now()");
    expect(body).toContain("p_steward_id = appt.steward_id");
    expect(body).toContain("pg_advisory_xact_lock");
    expect(body).toContain("'member_appointments:' || p_steward_id::text");
    expect(body).toContain("r.role = 'steward'");
    expect(body).toContain("public.member_appointment_schedules s");
    expect(body).not.toContain("public.steward_appointment_schedules");
    expect(body).toContain("r.chapter_id is null or r.chapter_id = appt.chapter_id");
    expect(body).toContain("s.accepting");
    expect(body).toContain("private.appointment_slots_for");
    expect(body).toContain("set steward_id = p_steward_id, updated_at = now()");
    expect(body).toContain("when exclusion_violation");
    expect(body).not.toMatch(/set\s+(starts_at|ends_at|appointment_type|duration_minutes|place|reason_category)\s*=/);
  });
});

describe("non-content audit and shoulder-safe notifications", () => {
  it("adds reassigned to the appointment event vocabulary and records UUIDs only", () => {
    const body = reassign();
    expect(sql).toContain("'booked', 'rescheduled', 'reassigned', 'cancelled', 'completed', 'no_show', 'reminder_sent'");
    expect(body).toContain("'appointmentid', appt.id");
    expect(body).toContain("'fromstewardid', old_steward");
    expect(body).toContain("'tostewardid', p_steward_id");
    const auditStart = body.indexOf("insert into public.member_appointment_events");
    const auditEnd = body.indexOf("perform private.notify_member", auditStart);
    expect(body.slice(auditStart, auditEnd)).not.toMatch(/name|type|place|reason|chapter/);
  });

  it("defines and invokes generic bilingual copy for all three parties", () => {
    for (const [key, recipient] of [
      ["appointment.reassigned.member", "appt.user_id"],
      ["appointment.reassigned.previous_steward", "old_steward"],
      ["appointment.reassigned.new_steward", "p_steward_id"],
    ]) {
      expect(sql).toContain(`('${key}', 'en'`);
      expect(sql).toContain(`('${key}', 'es'`);
      expect(reassign()).toContain(`private.notify_member(${recipient}, '${key}'`);
    }
    const copyStart = sql.indexOf("insert into private.notification_copy");
    const copyEnd = sql.indexOf("on conflict (key, lang)", copyStart);
    const copy = sql.slice(copyStart, copyEnd);
    expect(copy).not.toMatch(/\{name\}|reason|grievance|office_hours|onboarding|contract_questions|https?:|@/);
  });

  it("does not widen appointment table grants or policies", () => {
    expect(executableSql).not.toMatch(/create\s+policy\s+\S+\s+on\s+public\.member_appointment/);
    expect(executableSql).not.toMatch(/grant\s+[^;]+\s+on\s+(?:table\s+)?public\.member_appointment/);
  });
});

describe("db-contract coverage", () => {
  const functionEntries = new Map([
    ["public.list_chapter_appointments(p_after_starts timestamp with time zone, p_after_id uuid, p_limit integer)", {
      bodyMd5: "540ea2dd9a9756a94cec156dca78025f",
      roleGate: "private.member_has_chapter_role(caller_chapter, array['coordinator','advisor','admin'])",
    }],
    ["public.list_chapter_appointment_reassignment_candidates(p_appointment_id uuid)", {
      bodyMd5: "040e8e44ff797124d8d6fd6f4ec43add",
      roleGate: "private.member_has_chapter_role(caller_chapter, array['coordinator','advisor','admin'])",
      stewardResolver: "private.appointment_stewards_for_chapter(appt.chapter_id)",
    }],
    ["public.reassign_chapter_appointment(p_appointment_id uuid, p_steward_id uuid)", {
      bodyMd5: "5895808e5c689b169c8458702056ebb8",
      roleGate: "private.member_has_chapter_role(caller_chapter, array['coordinator','advisor','admin'])",
      stewardResolver: "private.appointment_stewards_for_chapter(appt.chapter_id)",
    }],
  ]);

  it("pins every public RPC as a guarded definer with the exact ACL", () => {
    for (const [sig, { bodyMd5, roleGate, stewardResolver }] of functionEntries) {
      const entry = contract.functions.find((candidate) => candidate.sig === sig);
      expect(entry, `${sig} must be contracted`).toBeDefined();
      expect(entry.secdef).toBe(true);
      expect(entry.exec).toBe("authenticated,service_role");
      expect(entry.bodyContains).toContain("private.mfa_satisfied()");
      expect(entry.bodyContains).toContain(roleGate);
      expect(entry.bodyMd5).toBe(bodyMd5);
      if (stewardResolver) {
        expect(entry.bodyContains).toContain(stewardResolver);
        expect(entry.bodyForbids).toEqual([
          "member_has_role(array['coordinator', 'advisor', 'admin'])",
          "r.chapter_id is null or r.chapter_id = caller_chapter",
          "r.role = 'steward'",
        ]);
      }
    }
  });

  it("pins the index, reassigned event constraint, and current RLS coverage", () => {
    const index = contract.indexes.find((entry) => entry.name === "member_appointments_chapter_starts_id_idx");
    expect(index).toBeDefined();
    expect(index.defContains).toContain("USING btree (chapter_id, starts_at DESC, id DESC)");
    const constraint = contract.constraints.find((entry) => entry.name === "member_appointment_events_action_check");
    expect(constraint).toBeDefined();
    expect(constraint.defContains).toContain("reassigned");
    expectMi1OrganizationRlsContract(contract);
  });
});
