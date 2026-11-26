// @vitest-environment node
// REQ-UG-EVENTS-RSVP-CHECK-IN-AND-VISIBILITY-20261030: static shape of
// the RSVP switch and staff-only draft migration.
import { describe, expect, it } from "vitest";
import { fnBody, loadMigrationSql, migrationFiles, stripComments } from "./helpers/migration.js";

const NAME = "20261030203101_event_staff_drafts_and_rsvp_switch";
const sql = loadMigrationSql(NAME);
const code = stripComments(sql);

describe("event RSVP switch and staff-only drafts migration", () => {
  it("runs in one bounded transaction", () => {
    expect(code).toMatch(/^\s*begin;\s*set local lock_timeout = '5s';\s*set local statement_timeout = '60s';/);
    expect(code.trim().endsWith("commit;")).toBe(true);
  });

  it("keeps every existing event collecting RSVPs and lets members read the switch", () => {
    expect(code).toContain("add column if not exists rsvp_open boolean not null default true");
    expect(code).toContain("grant select (rsvp_open) on public.member_events to authenticated;");
  });

  it("refuses only a new going answer while RSVPs are off, on every writer", () => {
    const guard = fnBody(sql, "private.member_event_rsvp_open_guard");
    expect(guard).toContain("new.status = 'going'");
    expect(guard).toContain("tg_op = 'INSERT' or old.status is distinct from 'going'");
    expect(guard).toContain("not e.rsvp_open");
    // A replayed "going" already on record passes.
    expect(guard).toContain("r.event_id = new.event_id and r.user_id = new.user_id and r.status = 'going'");
    expect(guard).toContain("detail = 'rsvp_closed'");
    expect(guard).toContain("set search_path = ''");
    expect(code).toContain("before insert or update of status on public.member_event_rsvps");
    expect(code).toContain("revoke all on function private.member_event_rsvp_open_guard() from public, anon, authenticated, service_role;");
    // The new trigger and its function are recorded in the reviewed inventory.
    expect(code).toContain("object_name = 'm50_rsvp_open_guard'");
    expect(code).toContain("object_name = 'member_event_rsvp_open_guard()'");
    expect(code).toContain("private.account_lifecycle_referential_action_trigger_issues()");
  });

  it("gates the switch like the agenda: staff, two-step, own chapter, audited", () => {
    const body = fnBody(sql, "public.set_member_event_rsvp_open");
    expect(body).toContain("security definer");
    expect(body).toContain("perform private.lock_case_graph(array[auth.uid()], array[]::uuid[]);");
    expect(body).toContain("not private.mfa_satisfied() or not private.member_can_manage_events()");
    expect(body).toContain("where id = p_id and chapter_id = caller_chapter");
    expect(body).toContain("'update_event'");
    expect(body).toContain("pg_catalog.jsonb_build_array('rsvp_open')");
  });

  it("creates an event with RSVPs off inside the create's own transaction", () => {
    const body = fnBody(sql, "public.create_member_event_with_rsvp");
    expect(body).toContain("security definer");
    expect(body).toContain("set search_path = ''");
    expect(body).toContain("perform private.lock_case_graph(array[auth.uid()], array[]::uuid[]);");
    expect(body).toContain("not private.mfa_satisfied()");
    expect(body).toContain("created := public.create_member_event_model(");
    expect(body).toContain("where chapter_id = caller_chapter");
    expect(body).toContain("pg_catalog.jsonb_array_elements_text(created -> 'occurrenceIds')");
    expect(body.indexOf("create_member_event_model(")).toBeLessThan(body.indexOf("set rsvp_open = false"));
  });

  it("refuses draft dates that are not ISO strings", () => {
    expect(fnBody(sql, "public.save_member_event_draft")).toContain("f.key in ('startsAt', 'endsAt', 'eventDate')");
  });

  it("re-emits get_admin_events from its predecessor with only rsvpOpen added", () => {
    const predecessor = [...migrationFiles()].reverse().find((migration) => migration.name < `${NAME}.sql`
      && /function\s+public\.get_admin_events\s*\(/i.test(migration.sql));
    const before = fnBody(predecessor.sql, "public.get_admin_events");
    const after = fnBody(sql, "public.get_admin_events");
    expect(after.replace("      'rsvpOpen', e.rsvp_open,\n", "")).toBe(before);
  });

  it("keeps drafts out of member_events in a private table no client role can reach", () => {
    expect(code).toContain("create table private.member_event_drafts");
    expect(code).toContain("revoke all on table private.member_event_drafts from public, anon, authenticated, service_role;");
    expect(code).not.toMatch(/\breferences\b/i);
    expect(code).not.toMatch(/grant [^;]* on (table )?private\.member_event_drafts/i);
    expect(code).not.toMatch(/insert into public\.member_events/i);
  });

  it("gates every draft function on staff, two-step and the caller's chapter", () => {
    const gate = fnBody(sql, "private.member_event_draft_chapter");
    expect(gate).toContain("not private.mfa_satisfied() or not private.member_can_manage_events()");
    expect(gate).toContain("private.current_member_chapter()");
    for (const name of ["public.list_member_event_drafts", "public.save_member_event_draft", "public.delete_member_event_draft"]) {
      const body = fnBody(sql, name);
      expect(body).toContain("security definer");
      expect(body).toContain("set search_path = ''");
      expect(body).toContain("private.member_event_draft_chapter()");
      expect(body).toContain("caller_chapter");
    }
    const save = fnBody(sql, "public.save_member_event_draft");
    expect(save).toContain("'isPublicAcrossAgencies', 'rsvpOpen'");
    expect(save).toContain(">= 100");
    for (const signature of ["create_member_event_with_rsvp(text, text, timestamptz, text, text, text, boolean, boolean, text, date, timestamptz, integer, text, boolean)", "list_member_event_drafts()", "save_member_event_draft(uuid, jsonb)", "delete_member_event_draft(uuid)", "set_member_event_rsvp_open(text, boolean)"]) {
      expect(code).toContain(`revoke all on function public.${signature} from public, anon, authenticated, service_role;`);
      expect(code).toContain(`grant execute on function public.${signature} to authenticated;`);
    }
  });
});
