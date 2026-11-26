// @vitest-environment node
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { caseGraphWrappedSource, parseFunctions, readMigrationFunctions } from "../scripts/account-case-graph-inventory.mjs";
import { PROOF_FILES } from "../scripts/run-required-db-proofs.mjs";
import { loadMigrationSql, stripComments } from "./helpers/migration.js";

// SEC-UG-EVENT-CHECKIN-CODE-UNBOUNDED-GUESSES-20260920 (owner ruling
// 2026-09-25): 10 wrong codes per (caller, event), 15 minutes of refusal,
// bound refusal indistinguishable from a wrong code, every lockout audited,
// staff notice on the events desk. These pins read the migration text; the
// live behaviour is tests/event-checkin-code-attempt-bound-db.test.js.
const NAME = "20260925980000_event_checkin_code_attempt_bound";
const sql = loadMigrationSql(NAME);
const code = stripComments(sql);
const predecessorSql = loadMigrationSql("20260901153739_event_organization_isolation");
const contract = JSON.parse(readFileSync("scripts/db-contract.json", "utf8"));
const SIGNATURE = "public.check_in_to_event(p_event_id text, p_code text)";
const PREDECESSOR_WRAPPED_DIGEST = "6bfeba86e1bb8afb89346f6f385d758d4b6d4c05878bedb16eda28de8059b6ed";

function fn(source, name, file = `${NAME}.sql`) {
  const entry = parseFunctions(source, file).find((row) => row.name === name);
  expect(entry, name).toBeTruthy();
  return entry;
}

describe("event check-in code attempt bound migration", () => {
  it("runs as one forward-only transaction after the bodies it supersedes", () => {
    expect(code).toMatch(/^\s*begin;/);
    expect(code).toMatch(/commit;\s*$/);
    expect(NAME > "20260901153739_event_organization_isolation").toBe(true);
    expect(NAME > "20260907151000_account_deletion_finalization_reconciliation").toBe(true);
    expect(NAME > "20260812170000_chapter_scoped_events").toBe(true);
  });

  it("admits only the reviewed 20260907151000 wrap of the 20260901153739 body as its predecessor", () => {
    const inner = fn(predecessorSql, "public.check_in_to_event", "20260901153739.sql");
    expect(createHash("sha256").update(inner.source).digest("hex"))
      .toBe("ef911d266401385813f4d2db0d79fd4eee108b05d8accbc4f55f26cdf5ba7c56");
    expect(createHash("sha256").update(caseGraphWrappedSource(inner.source)).digest("hex"))
      .toBe(PREDECESSOR_WRAPPED_DIGEST);
    expect(sql).toContain(`if digest is distinct from '${PREDECESSOR_WRAPPED_DIGEST}' then`);
    expect(sql).toContain("raise exception 'unreviewed check_in_to_event predecessor: %', digest");
  });

  it("keeps the installation lock wrapper as the first statement of the replaced body", () => {
    expect(fn(sql, "public.check_in_to_event").source).toMatch(
      /^\nbegin\n {2}perform private\.lock_case_graph\(array\[auth\.uid\(\)\], array\[\]::uuid\[\]\);\n\ndeclare\n/,
    );
  });

  it("keeps every guard the reviewed body had, in order, ahead of the code comparison", () => {
    const source = stripComments(fn(sql, "public.check_in_to_event").source);
    const order = [
      "if caller is null or not private.mfa_satisfied() then",
      "private.member_can_access_event_scope(",
      "for share;",
      "raise exception 'event not found' using errcode = '22023';",
      "if ev.cancelled_at is not null then",
      "detail = 'event_cancelled'",
      "ev.starts_at - interval '2 hours'",
      "ev.starts_at + interval '4 hours'",
      "now_at := private.event_checkin_clock();",
      "if prior_locked_until is not null and now_at < prior_locked_until then",
      "pg_catalog.upper(pg_catalog.btrim(coalesce(p_code, ''))) <> pg_catalog.upper(ev.check_in_code)",
      "insert into public.member_event_checkins (event_id, user_id)",
      "insert into public.member_action_log (user_id, action_key, action_kind)",
    ];
    let last = -1;
    for (const needle of order) {
      const at = source.indexOf(needle);
      expect(at, needle).toBeGreaterThan(last);
      last = at;
    }
    expect(source).not.toMatch(/if caller is null then/);
  });

  it("bounds wrong codes at 10 per (caller, event) and refuses for 15 minutes after the tenth", () => {
    const source = stripComments(fn(sql, "public.check_in_to_event").source);
    expect(source).toContain("case when wrong_count >= 10 then now_at + interval '15 minutes' end");
    expect(source).toContain("if wrong_count >= 10 then");
    expect(source).toContain("when prior_wrong is null or prior_locked_until is not null then 1");
    expect(source).toContain("else prior_wrong + 1");
    expect(source).toContain("on conflict (event_id, user_id) do update");
    expect(code).toContain("check (wrong_attempts between 0 and 10)");
    expect(code).toContain("primary key (event_id, user_id)");
  });

  it("returns one refusal payload for a wrong code and for a lockout, and never raises for either", () => {
    const source = stripComments(fn(sql, "public.check_in_to_event").source);
    expect(source).toMatch(/refusal constant jsonb := pg_catalog\.jsonb_build_object\(\s*'checkedIn', false,\s*'refused', true,\s*'code', '22023',\s*'message', 'invalid check-in code'\s*\)/);
    expect(source.match(/return refusal;/g)).toHaveLength(2);
    expect(source).not.toContain("raise exception 'invalid check-in code'");
    expect(stripComments(fn(predecessorSql, "public.check_in_to_event", "20260901153739.sql").source))
      .toContain("raise exception 'invalid check-in code' using errcode = '22023';");
  });

  it("records the refusal before returning it and writes no check-in or point award for a refused caller", () => {
    const source = stripComments(fn(sql, "public.check_in_to_event").source);
    const record = source.indexOf("insert into private.member_event_checkin_attempts");
    const firstReturn = source.indexOf("return refusal;");
    const secondReturn = source.indexOf("return refusal;", firstReturn + 1);
    expect(record).toBeGreaterThan(firstReturn);
    expect(record).toBeLessThan(secondReturn);
    expect(source.indexOf("insert into public.member_event_checkins")).toBeGreaterThan(secondReturn);
    expect(source.indexOf("insert into public.member_action_log")).toBeGreaterThan(secondReturn);
    expect(source).toContain("delete from private.member_event_checkin_attempts");
  });

  it("audits each lockout as one member_admin_audit row naming the event and the caller, never a code", () => {
    const source = stripComments(fn(sql, "public.check_in_to_event").source);
    const audit = source.slice(source.indexOf("if wrong_count >= 10 then"), source.indexOf("end if;", source.indexOf("if wrong_count >= 10 then")));
    expect(audit).toContain("insert into public.member_admin_audit (actor, action, target_user, detail)");
    expect(audit).toContain("values (caller, 'event_checkin_lockout', caller, pg_catalog.jsonb_build_object(");
    expect(audit).toContain("'eventId', p_event_id");
    expect(audit).toContain("'lockedUntil', now_at + interval '15 minutes'");
    expect(audit).not.toContain("p_code");
    expect(audit).not.toContain("check_in_code");
    expect(code).toContain("'grant_chapter_membership', 'revoke_chapter_membership',\n    'event_checkin_lockout'");
    expect(code).toContain("alter table public.member_admin_audit drop constraint if exists member_admin_audit_action_check;");
  });

  it("gives the events desk the 24-hour lockout count per event without changing its gate or scope", () => {
    const source = stripComments(fn(sql, "public.get_admin_events").source);
    const previous = stripComments(fn(loadMigrationSql("20260812170000_chapter_scoped_events"), "public.get_admin_events", "20260812170000.sql").source);
    expect(source).toContain("'checkinLockouts24h', coalesce(l.n, 0)");
    expect(source).toContain("where a.action = 'event_checkin_lockout'");
    expect(source).toContain("and a.created_at >= now() - interval '24 hours'");
    for (const needle of [
      "if caller is null or not private.member_can_manage_events() then",
      "caller_chapter := private.current_member_chapter();",
      "where e.chapter_id = caller_chapter",
      "'rsvpCount', coalesce(r.n, 0), 'checkinCount', coalesce(k.n, 0)",
      "join public.chapters c on c.id = e.chapter_id",
    ]) {
      expect(source).toContain(needle);
      expect(previous).toContain(needle);
    }
    expect(previous).not.toContain("checkinLockouts24h");
  });

  it("keeps the attempt table, the clock override and the clock helper away from member roles", () => {
    expect(code).toContain("revoke all on table private.member_event_checkin_attempts from public, anon, authenticated, service_role;");
    expect(code).toContain("alter table private.member_event_checkin_attempts force row level security;");
    expect(code).toContain("values ('private', 'member_event_checkin_attempts', 'user_id', 'cascade',");
    expect(code).toContain("'excluded_with_reason', 'auth_user_fk',");
    expect(code).toContain("if exists (select 1 from private.account_lifecycle_unmanaged_export_fks()) then");
    expect(code).toContain("revoke all on table private.event_checkin_clock_override from public, anon, authenticated, service_role;");
    expect(code).toContain("revoke all on function public.set_event_checkin_clock_override(timestamptz) from public, anon, authenticated;");
    expect(code).toContain("grant execute on function public.set_event_checkin_clock_override(timestamptz) to service_role;");
    const setter = stripComments(fn(sql, "public.set_event_checkin_clock_override").source);
    expect(setter).toContain("raise exception 'service role required' using errcode = '42501';");
    expect(setter).toContain("delete from private.event_checkin_clock_override;");
    expect(setter).toContain("on conflict (singleton) do update");
    expect(code).toContain("revoke all on function private.event_checkin_clock() from public, anon, authenticated;");
    for (const table of ["private.member_event_checkin_attempts", "private.event_checkin_clock_override"]) {
      for (const role of ["anon", "authenticated", "service_role"]) {
        expect(contract.tableGrants).toContainEqual({ table, role, privileges: "" });
      }
    }
    expect(stripComments(fn(sql, "private.event_checkin_clock").source))
      .toContain("coalesce((select o.now_at from private.event_checkin_clock_override o where o.singleton), now())");
  });

  it("joins the attempt table to the account case graph with the reviewed trigger pair", () => {
    expect(code).toContain("create trigger a00_case_graph_lock before insert or update or delete on private.member_event_checkin_attempts\nfor each statement execute function private.lock_case_graph_statement();");
    expect(code).toContain("create trigger z99_case_graph_keys before insert or update or delete on private.member_event_checkin_attempts\nfor each row execute function private.lock_case_graph_row_keys('{user_id}', '');");
    expect(code).toContain("table_name = 'member_event_checkin_attempts'");
    expect(code).toContain("select 1 from private.account_lifecycle_referential_action_trigger_issues()");
  });

  it("re-derives the live source digest from the replaced body and pins it", () => {
    const entry = fn(sql, "public.check_in_to_event");
    expect(createHash("sha256").update(entry.source).digest("hex")).toBe(entry.sourceSha256);
    expect(sql).toContain(`if digest is distinct from '${entry.sourceSha256}' then\n    raise exception 'check_in_to_event source hash drifted: %', digest`);
  });

  it("describes the bound in the contract and registers the live proof with its floor", () => {
    const entry = contract.functions.find((item) => item.sig === SIGNATURE);
    expect(entry).toMatchObject({ secdef: true, exec: "authenticated,service_role" });
    for (const needle of [
      "perform private.lock_case_graph(array[auth.uid()], array[]::uuid[]);",
      "now_at := private.event_checkin_clock();",
      "private.organization_limit(checkin_org, 'limits.security.event_checkin_wrong_codes')",
      "private.organization_limit(checkin_org, 'limits.security.event_checkin_lock_minutes')",
      "'event_checkin_lockout'",
      "'message', 'invalid check-in code'",
    ]) expect(entry.bodyContains).toContain(needle);
    const current = readMigrationFunctions("supabase/migrations")
      .find((item) => item.name === "public.check_in_to_event").source;
    for (const needle of entry.bodyContains) expect(current).toContain(needle);
    expect(entry.bodyMd5).toMatch(/^[0-9a-f]{32}$/);
    expect(entry.note).toContain("organization-adjustable failure threshold");
    const desk = contract.functions.find((item) => item.sig === "public.get_admin_events()");
    expect(desk.bodyContains).toContain("'checkinLockouts24h', coalesce(l.n, 0)");
    const clock = contract.functions.find((item) => item.sig === "private.event_checkin_clock()");
    expect(clock).toMatchObject({ secdef: true, exec: "service_role" });
    const setter = contract.functions.find((item) => item.sig === "public.set_event_checkin_clock_override(p_now_at timestamp with time zone)");
    expect(setter).toMatchObject({ secdef: true, exec: "service_role" });
    expect(PROOF_FILES).toContain("tests/event-checkin-code-attempt-bound-db.test.js");
  });

  it("changes exactly the four routines it names", () => {
    expect(parseFunctions(sql, `${NAME}.sql`).map((entry) => entry.name))
      .toEqual(["public.set_event_checkin_clock_override", "private.event_checkin_clock", "public.check_in_to_event", "public.get_admin_events"]);
    expect(code).not.toMatch(/\bdrop function\b/i);
    expect(code).not.toMatch(/\bcreate policy\b/i);
    expect(code).not.toContain("request_event_checkin_token");
    expect(code).not.toContain("scan_event_checkin");
  });
});

// BUG-UG-WEB-EVENT-CHECKIN-REFUSALS-ENGLISH-ONLY-20261003: the
// check-in refusals carried no translatable token.
describe("20261008080800 event check-in refusal tokens", () => {
  const tokens = loadMigrationSql("20261008080800_event_checkin_refusal_tokens");
  const checkIn = stripComments(fn(tokens, "public.check_in_to_event").source);
  const codeRequest = stripComments(fn(tokens, "public.request_event_checkin_token").source);

  it("tokens both window refusals and the one wrong-code-or-lockout payload", () => {
    expect(checkIn).toContain("raise exception 'check-in is only open around the event start time' using errcode = '22023', detail = 'checkin_not_open';");
    expect(codeRequest).toContain("raise exception 'check-in codes are only available around the event start time' using errcode = '22023', detail = 'checkin_not_open';");
    expect(checkIn).toMatch(/refusal constant jsonb := pg_catalog\.jsonb_build_object\(\s*'checkedIn', false,\s*'refused', true,\s*'code', '22023',\s*'message', 'invalid check-in code',\s*'token', 'checkin_code_invalid'\s*\)/);
    // Wrong code and lockout still return the same literal.
    expect(checkIn.match(/return refusal;/g)).toHaveLength(2);
  });

  it("replaces only the reviewed predecessors and is the latest definition of both", () => {
    expect(tokens).toContain("if check_in is distinct from 'd5848b4dcc7309bb82f221fbb5eac585' then");
    expect(tokens).toContain("if code_request is distinct from '1f4205811559460b7b969fda83461a22' then");
    const latest = readMigrationFunctions("supabase/migrations");
    expect(latest.find((item) => item.name === "public.check_in_to_event").source).toContain("'token', 'checkin_code_invalid'");
    expect(latest.find((item) => item.name === "public.request_event_checkin_token").source).toContain("detail = 'checkin_not_open'");
  });
});
