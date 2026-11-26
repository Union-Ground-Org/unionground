// @vitest-environment node
// Text tripwires over the steward-appointments migration + the wired copies of
// its vocabulary (dispatcher templates, contract pins). The live catalog truth
// is verify:db's job; these pin what the SQL SAYS so a regression in the file
// is caught offline, before any database sees it.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { PUSH_SENSITIVE_KINDS, TEMPLATES, pushTemplateFor, templateFor } from "../api/notifications-dispatch.js";
import { expectMi1OrganizationRlsContract } from "./helpers/mi1Contract.js";
import { codeOnly, readMigrationFunctions } from "../scripts/account-case-graph-inventory.mjs";
import { fnBody, loadMigrationSql } from "./helpers/migration.js";

const sql = readFileSync(new URL("../supabase/migrations/20260801120000_steward_appointments.sql", import.meta.url), "utf8");
const contract = JSON.parse(readFileSync(new URL("../scripts/db-contract.json", import.meta.url), "utf8"));

const TABLES = [
  "member_appointment_schedules",
  "member_appointment_windows",
  "member_appointment_blackouts",
  "member_appointments",
  "member_appointment_events",
  "member_calendar_connections",
  "member_calendar_busy",
];

const COPY_KEYS = [
  "appointment.booked",
  "appointment.booked.steward",
  "appointment.cancelled",
  "appointment.cancelled.steward",
  "appointment.rescheduled",
  "appointment.rescheduled.steward",
  "appointment.reminder.day",
  "appointment.reminder.hour",
  "appointment.reminder.hour.steward",
];

describe("steward appointments migration", () => {
  it("locks down every table: RLS on, mfa_assurance restrictive, select-only grants", () => {
    for (const table of TABLES) {
      expect(sql).toContain(`alter table public.${table} enable row level security`);
      expect(sql).toContain(`create policy mfa_assurance on public.${table}`);
      expect(sql).toContain(`revoke all on public.${table} from anon, authenticated`);
      expect(sql).toContain(`grant select on public.${table} to authenticated`);
      // RPC-only writes from day one: no client write grant may appear.
      expect(sql).not.toMatch(new RegExp(`grant (insert|update|delete|all)[^;]*on public\\.${table}[^;]*to authenticated`, "i"));
    }
  });

  it("keeps the double-booking exclusion constraints on both axes", () => {
    expect(sql).toMatch(/member_appointments_steward_no_overlap\s+exclude using gist \(steward_id with =, tstzrange\(starts_at, ends_at\) with &&\)/);
    expect(sql).toMatch(/member_appointments_member_no_overlap\s+exclude using gist \(user_id with =, tstzrange\(starts_at, ends_at\) with &&\)/);
  });

  it("has no narrative column anywhere in the feature — privacy by schema", () => {
    // The design rule: an appointment carries a bounded reason CATEGORY and no
    // free text at all. A note/description/narrative column reappearing in any
    // of these tables is the leak the brief forbids.
    const ddl = sql.split("-- ------------------------------------------------------------ slot engine")[0];
    expect(ddl).toContain("reason_category text not null default 'general'");
    expect(ddl).not.toMatch(/\b(note|notes|description|narrative|details|summary)\s+text/);
  });

  it("adds the eighth topic everywhere the pipeline reads it", () => {
    // The CHECK swap, its executable VALIDATE, the enforcement-point re-emit,
    // and the prefs default all carry 'appointments'.
    expect(sql).toContain("check (kind in ('general', 'deadlines', 'cases', 'forms', 'votes', 'events', 'tasks', 'appointments'))");
    expect(sql).toContain("validate constraint member_notifications_kind_check");
    expect(sql).toContain("if new.kind not in ('deadlines', 'cases', 'forms', 'votes', 'events', 'tasks', 'appointments') then");
    expect(sql).toContain('"appointments": true');
  });

  it("ships every notification copy key in BOTH languages", () => {
    for (const key of COPY_KEYS) {
      expect(sql).toContain(`('${key}', 'en',`);
      expect(sql).toContain(`('${key}', 'es',`);
    }
    // Shoulder rule: no copy row names an appointment type. "grievance" on a
    // lock screen is the disclosure the category-only schema exists to prevent.
    const copyBlock = sql.slice(sql.indexOf("insert into private.notification_copy"));
    expect(copyBlock.toLowerCase()).not.toContain("grievance");
    expect(copyBlock.toLowerCase()).not.toContain("queja");
  });

  it("guards the reminder cron like the dispatch tick and pins it in the contract", () => {
    expect(sql).toContain("pg_available_extensions where name = 'pg_cron'");
    expect(sql).toContain("'appointment-reminders-tick'");
    expect(sql).toContain("for update skip locked");
    expect(contract.cron.some((job) => job.jobname === "appointment-reminders-tick" && job.schedule === "4-54/10 * * * *")).toBe(true);
  });

  it("pins the feature's surface in the db contract", () => {
    // Current truth includes public-site, rewards, invitations, unified
    // messaging, signed email intake, chapter-channel read/poll tables, and
    // the four explicit MI1 organization-boundary tables.
    expectMi1OrganizationRlsContract(contract);
    const sigs = contract.functions.map((entry) => entry.sig);
    for (const name of [
      "public.get_bookable_stewards()",
      "public.get_my_appointments()",
      "public.get_steward_appointments()",
      "public.mark_appointment_outcome(p_id uuid, p_outcome text)",
      "public.set_appointment_windows(p_windows jsonb)",
    ]) {
      expect(sigs).toContain(name);
    }
    expect(sigs.some((sig) => sig.startsWith("public.book_appointment("))).toBe(true);
    expect(sigs.some((sig) => sig.startsWith("public.get_appointment_slots("))).toBe(true);
    expect(sigs.some((sig) => sig.startsWith("public.reschedule_appointment("))).toBe(true);
    for (const [sig, extra] of [
      ["public.cancel_appointment(p_id uuid)", "private.notify_member"],
      ["public.reschedule_appointment(p_id uuid, p_starts_at timestamp with time zone)", "rescheduled_from"],
      ["public.mark_appointment_outcome(p_id uuid, p_outcome text)", "no_show"],
    ]) {
      const entry = contract.functions.find((candidate) => candidate.sig === sig);
      expect(entry, `${sig} must be contracted`).toBeDefined();
      expect(entry.bodyContains).toContain("private.member_has_chapter_role(appt.chapter_id, array['steward'])");
      expect(entry.bodyContains).toContain(extra);
      expect(entry.bodyForbids).toContain("public.member_has_role(");
    }
    // The free-busy write seam stays service-role-only.
    const busy = contract.functions.find((entry) => entry.sig.startsWith("public.set_calendar_busy("));
    expect(busy.exec).toBe("service_role");
  });

  it("keeps calendar tables token-free — the seam stores instants, never credentials", () => {
    const connections = sql.slice(sql.indexOf("create table public.member_calendar_connections"), sql.indexOf("create index member_calendar_busy_steward_idx"));
    expect(connections).not.toMatch(/token|secret|refresh|access_/i);
  });
});

describe("appointments in the outbound dispatcher", () => {
  it("carries bilingual email copy that names no appointment type", () => {
    expect(TEMPLATES.appointments.en.subject).toBeTruthy();
    expect(TEMPLATES.appointments.es.subject).toBeTruthy();
    for (const lang of ["en", "es"]) {
      const text = `${TEMPLATES.appointments[lang].subject} ${TEMPLATES.appointments[lang].body}`.toLowerCase();
      expect(text).not.toContain("grievance");
      expect(text).not.toContain("queja");
    }
    expect(templateFor("appointments", "es")).toEqual(TEMPLATES.appointments.es);
  });

  it("treats appointment pushes as shoulder-sensitive", () => {
    // A lock screen must not reveal that steward time is booked at all.
    expect(PUSH_SENSITIVE_KINDS.has("appointments")).toBe(true);
    const push = pushTemplateFor("appointments", "en");
    expect(push.subject).toBe("Something needs your attention");
  });
});

// SEC-UG-APPOINTMENT-AUTHORIZATION-IGNORES-ORGANIZATION-LEVEL-STEWARD-GRANTS-20260921
describe("appointment steward role-source parity", () => {
  const consolidation = loadMigrationSql("20260925030000_appointment_authorization_consolidation");

  it("unions membership-bounded member_roles stewards with tenant-bounded organization grants", () => {
    const body = codeOnly(fnBody(consolidation, "private.appointment_stewards_for_chapter"));
    // The legacy arm stays in the one function that owns its chapter predicate.
    expect(body).toContain("from private.member_stewards_for_chapter(p_chapter) m");
    expect(body).not.toContain("from public.member_roles r");
    expect(body).toMatch(/\bunion\b/);
    expect(body).toContain("from public.organization_role_grants g");
    expect(body).toContain("c.organization_id = g.organization_id");
    expect(body).toContain("o.status = 'active'");
    expect(body).toContain("om.status = 'active'");
    expect(body).toContain("om.revoked_at is null");
    expect(body).toContain("s.accepting");
    const entry = contract.functions.find(
      (candidate) => candidate.sig === "private.appointment_stewards_for_chapter(p_chapter text)",
    );
    expect(entry.exec).toBe("");
    expect(entry.bodyContains).toContain("from public.organization_role_grants g");
    expect(entry.bodyContains).toContain("from private.member_stewards_for_chapter(p_chapter) m");
  });

  it("leaves no appointment function resolving stewards from member_roles alone", () => {
    const latest = new Map();
    for (const fn of readMigrationFunctions("supabase/migrations")) latest.set(fn.name, fn);
    const leftover = [...latest.values()]
      .filter((fn) => /appointment/.test(fn.name))
      .filter((fn) => {
        const code = codeOnly(fn.source);
        const legacy = /from\s+public\.member_roles\s+\w+/.test(code) && /role\s*=\s*'steward'/.test(code);
        return legacy && !code.includes("public.organization_role_grants")
          && !code.includes("private.appointment_stewards_for_chapter");
      })
      .map((fn) => fn.name)
      .sort();
    expect(leftover).toEqual([]);
  });
});
