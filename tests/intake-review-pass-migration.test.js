// @vitest-environment node
// REQ-UG-INTAKE-QUEUE-SEND-INVITATION-FROM-ROW-20261118 (owner
// option b): offline pins on what the pass migration says. The live proof is
// tests/intake-review-pass-db.test.js; the live catalog is
// scripts/db-contract.json.
import { readFileSync, readdirSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parseFunctions } from "../scripts/account-case-graph-inventory.mjs";
import { withoutRowsPickedOnce } from "./helpers/bounded-cleanup.js";

const DIR = new URL("../supabase/migrations/", import.meta.url);
const FILES = readdirSync(DIR).filter((name) => name.endsWith("_intake_review_pass_invite_request.sql"));
const SQL = readFileSync(new URL(FILES[0], DIR), "utf8");

function body(name) {
  const plain = SQL.indexOf(`create function ${name}(`);
  const start = plain >= 0 ? plain : SQL.indexOf(`create or replace function ${name}(`);
  expect(start, name).toBeGreaterThanOrEqual(0);
  return SQL.slice(start, SQL.indexOf("\n$function$;", start));
}

const OPERATOR_FUNCTIONS = [
  ["public.search_intake_pass_organizations", "uuid, uuid, text"],
  ["public.pass_intake_invite_request", "uuid, uuid, uuid, uuid"],
  ["public.list_intake_request_passes", "uuid, uuid, uuid[]"],
];

describe("intake review pass migration", () => {
  it("checks every restated installed predecessor before changing the schema", () => {
    const guardStart = SQL.indexOf("do $predecessors$");
    expect(guardStart).toBeGreaterThanOrEqual(0);
    expect(guardStart).toBeLessThan(SQL.indexOf("alter table public.member_requests"));
    const guard = SQL.slice(guardStart, SQL.indexOf("$predecessors$;", guardStart));
    for (const signature of ["public.stop_public_interest(text,text,text,text,text,text)", "public.confirm_public_interest_stop(text,text)", "private.member_request_json(public.member_requests)"]) {
      expect(guard).toContain(`('${signature}', '`);
    }
    expect(guard).toContain("pg_catalog.md5(pg_catalog.pg_get_functiondef(entry.signature::regprocedure))");
    expect(guard).toContain("is distinct from entry.definition_md5");
    expect(guard).toContain("errcode='55000'");
  });

  it("preserves the newest immediate-stop body except for the gate and picked-once cleanup", () => {
    const name = "public.stop_public_interest";
    const predecessors = readdirSync(DIR).filter((file) => file.endsWith(".sql") && file < FILES[0]).sort();
    const previous = predecessors.flatMap((file) => parseFunctions(readFileSync(new URL(file, DIR), "utf8")).filter((fn) => fn.name === name)).at(-1);
    expect(previous, "newest immediate stop predecessor").toBeDefined();
    const guarded = parseFunctions(SQL).find((fn) => fn.name === name)?.source;
    expect(guarded, "the immediate stop is restated").toBeTypeOf("string");
    const gate = "    perform private.lock_case_graph(array[]::uuid[], array[]::uuid[]);\n";
    expect(guarded.split(gate)).toHaveLength(2);
    expect(withoutRowsPickedOnce(guarded.replace(gate, ""))).toBe(withoutRowsPickedOnce(previous.source));
    expect(guarded).toContain("with picked as materialized (");
    expect(guarded).toContain("where stale.ctid in (select picked.row_key from picked)");
    expect(guarded.indexOf(gate)).toBeLessThan(guarded.indexOf("perform pg_catalog.pg_advisory_xact_lock"));
    expect(SQL).toContain("grant execute on function public.stop_public_interest(text, text, text, text, text, text)\n  to service_role;");
  });

  it("preserves Main's whole stop-confirmation body with the gate after token validation", () => {
    const prior = readFileSync(new URL("20261113123500_bounded_cleanups_pick_rows_once.sql", DIR), "utf8");
    const name = "public.confirm_public_interest_stop";
    const original = parseFunctions(prior).find((fn) => fn.name === name).source;
    const guarded = parseFunctions(SQL).find((fn) => fn.name === name).source;
    const gate = "  perform private.lock_case_graph(array[]::uuid[], array[]::uuid[]);\n";
    expect(guarded.split(gate)).toHaveLength(2);
    expect(guarded.replace(gate, "")).toBe(original);
    expect(guarded.indexOf(gate)).toBeGreaterThan(guarded.indexOf("if pending_row.expires_at <= moment then"));
    expect(guarded.indexOf(gate)).toBeLessThan(guarded.indexOf("perform pg_catalog.pg_advisory_xact_lock"));
  });

  it("is one file, in one transaction", () => {
    expect(FILES).toHaveLength(1);
    expect(SQL).toMatch(/^begin;$/m);
    expect(SQL).toContain("begin;\nset local lock_timeout = '5s';\nset local statement_timeout = '120s';");
    expect(SQL.trimEnd().endsWith("commit;")).toBe(true);
  });

  it("checks the service role and then an intake_review operator in every operator function, executable by the service role only", () => {
    for (const [name, args] of OPERATOR_FUNCTIONS) {
      const text = body(name);
      expect(text, name).toContain("auth.jwt() ->> 'role'), '') <> 'service_role'");
      expect(text.indexOf("intake_review_require_operator"), name).toBeGreaterThan(text.indexOf("service_role"));
      expect(SQL).toContain(`revoke all on function ${name}(${args}) from public, anon, authenticated, service_role;`);
      expect(SQL).toContain(`grant execute on function ${name}(${args}) to service_role;`);
    }
  });

  it("passes only an invite request with no organization, refuses a stopped address and creates no account, organization or invitation", () => {
    const text = body("public.pass_intake_invite_request");
    expect(text).toContain("where id = p_id and organization_id is null\n  for update;");
    expect(text).toContain("current_row.source <> 'request-invite'");
    expect(text).toContain("private.public_interest_suppression_scope(request_email)");
    expect(text.indexOf("pg_advisory_xact_lock")).toBeLessThan(text.indexOf("for update;"));
    expect(text).toContain("current_row.email is distinct from request_email");
    expect(body("public.confirm_public_interest_stop")).toContain(
      "derived_suppression_scope_hash := private.public_interest_suppression_scope(pending_row.normalized_email);\n  perform private.lock_case_graph(array[]::uuid[], array[]::uuid[]);\n  perform pg_catalog.pg_advisory_xact_lock(");
    expect(text).toContain("'refusal', 'stopped'");
    expect(text).toContain("o.status = 'active'");
    expect(text).toContain("'refusal', 'no-administrator'");
    expect(text).toContain("'invitation_suggestion', null");
    for (const forbidden of ["insert into public.member_invitations", "create_member_invitation", "insert into public.organizations",
      "insert into auth.users", "insert into public.organization_memberships", "insert into public.organization_role_grants"]) {
      expect(text).not.toContain(forbidden);
    }
    // Idempotent per request and organization, before anything is written.
    expect(text.indexOf("r.intake_submission_id = p_id and r.organization_id = p_organization_id"))
      .toBeLessThan(text.indexOf("insert into public.member_requests"));
    expect(SQL).toContain("on public.member_requests (intake_submission_id, organization_id)\n  where intake_submission_id is not null;");
  });

  it("audits each pass without the person's details", () => {
    expect(SQL).toContain("check (action in ('operator_granted', 'operator_revoked', 'list', 'export', 'status', 'note', 'pass'))");
    expect(body("public.pass_intake_invite_request")).toContain(
      "insert into private.intake_review_events\n    (action, actor_user_id, submission_id, organization_id, member_request_id, from_status, to_status)");
    expect(body("private.intake_pass_json")).not.toMatch(/invitee_|note/);
  });

  it("keeps a member's suggestion bound to its member and lets a stop delete a passed-on one", () => {
    expect(SQL).toContain("(intake_submission_id is null and requester_user_id is not null)");
    expect(SQL).toContain("references public.public_interest_submissions(id) on update cascade on delete cascade");
    expect(body("private.member_request_json")).toContain("'fromIntake', p_row.intake_submission_id is not null");
  });

  it("bounds the organization search and the passes read", () => {
    expect(body("public.search_intake_pass_organizations")).toContain("pg_catalog.char_length(prefix) not between 2 and 120");
    expect(body("public.search_intake_pass_organizations")).toContain("limit 20");
    expect(body("public.list_intake_request_passes")).toContain("pg_catalog.cardinality(p_ids) not between 1 and 100");
  });

  it("does not replace the queue's shared row, kind, filter or summary functions", () => {
    for (const name of ["private.intake_review_kind", "private.intake_review_row", "private.intake_review_filters", "public.intake_request_summary"]) {
      expect(SQL).not.toContain(`function ${name}(`);
    }
  });
});
