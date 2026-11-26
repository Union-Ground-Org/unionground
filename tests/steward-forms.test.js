// @vitest-environment node
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { fnBody, loadMigrationSql } from "./helpers/migration.js";

// Text pins are a tripwire, not a proof: they assert what THIS MIGRATION SAYS,
// not what the database ENDS UP WITH. A later create-or-replace can supersede
// every guard below and this file stays green. Current-state truth lives in
// scripts/db-contract.json, checked by `npm run verify:db`.
//
// Superseded here: submit_form, approve_form and open_form_as_case, all
// redefined by 20260723112000_member_forms_template_registry_fk; and
// private.form_required_keys(text), DROPPED by 20260724193000_tech_debt_indexes_
// and_cleanup, whose lockstep test was removed rather than left green forever.

const memberApi = readFileSync(new URL("../src/lib/memberApi.js", import.meta.url), "utf8");

// Reads the HARDENING migration, which is what this file has always asserted
// against. Until 2026-07-26 that content sat in a file misleadingly named
// 20260722210000_steward_forms_review.sql; the reconciliation renamed it to
// match its recorded identity and recovered the two genuinely distinct
// migrations (steward_forms_review and steward_forms_review_rpcs) that had
// existed only in production. "steward_forms_review" is now an ambiguous
// prefix, so this pin has to be exact.
const sql = loadMigrationSql("steward_forms_review_hardening");
const body = (functionName) => fnBody(sql, functionName);

describe("steward forms review migration invariants", () => {
  it("widens steward reads to review states only — never drafts or returned re-edits", () => {
    const start = sql.indexOf("create policy member_forms_select_steward");
    expect(start).toBeGreaterThan(-1);
    const policy = sql.slice(start, sql.indexOf(";", start));
    expect(policy).toContain("for select to authenticated");
    expect(policy).toContain("member_has_role(array['steward'])");
    // Pre-mortem HIGH-1: returned rows are live member re-edits. Review
    // MEDIUM: approved rows have no steward read consumer, so exposing them
    // would leak approved FMLA/medical answers chapter-wide. The policy is an
    // explicit allow-list so drafts, returned, approved, and any future
    // status stay member-private unless deliberately listed.
    expect(policy, "steward visibility is an explicit active-review allow-list").toContain(
      "status in ('submitted', 'in_review')"
    );
    expect(policy, "returned rows must never be steward-visible").not.toContain("'returned'");
    expect(policy, "approved rows must never be steward-visible").not.toContain("'approved'");
  });

  it("adds no client write path on member_forms", () => {
    expect(sql).not.toMatch(/grant [^;]*(insert|update|delete)[^;]*on public\.member_forms[^;]*to (anon|authenticated)/i);
  });

  it("caps weekly form points (pre-mortem #2)", () => {
    expect(sql).toContain("set weekly_cap = 3 where action_kind = 'form'");
  });

  it("submit_form reports only actually-credited points (M1)", () => {
    const submit = body("public.submit_form");
    expect(submit).toContain("had_event");
    expect(submit).toContain("case when had_event then 0");
    expect(submit).toContain("set search_path = ''");
  });

  it("submit_form enforces server-side completeness (L3)", () => {
    const submit = body("public.submit_form");
    expect(submit).toContain("private.form_required_keys");
    expect(submit).toContain("form incomplete");
  });

  // DELETED: "keeps the SQL required-key lists in lockstep with formTemplates.js".
  // It pinned the CASE inside private.form_required_keys(text), a function that
  // 20260724193000_tech_debt_indexes_and_cleanup DROPPED — required keys have
  // come from the form_templates registry since
  // 20260724111000_form_templates_lookup_rewrite. The test could only ever go
  // green again, never red, because it read a superseded migration body. The
  // intent survives in two places that are still true: seed fidelity against
  // formTemplates.js in form-templates-registry.test.js, and the live absence of
  // the 1-arg signature in scripts/db-contract.json's functionsAbsent.
});

describe("steward review RPC invariants", () => {
  const fns = ["public.steward_start_review", "public.approve_form", "public.return_form", "public.open_form_as_case"];

  it("gates every review RPC on the steward role with a pinned search_path", () => {
    for (const fn of fns) {
      const b = body(fn);
      expect(b, `${fn} role gate`).toContain("member_has_role(array['steward'])");
      expect(b, `${fn} pinned path`).toContain("set search_path = ''");
    }
  });

  it("blocks self-review in every review RPC", () => {
    for (const fn of fns) {
      expect(body(fn), `${fn} self-review guard`).toMatch(/user_id (<>|=) caller/);
    }
  });

  it("keeps steward RPCs out of the point economy", () => {
    for (const fn of fns) {
      expect(body(fn), `${fn} must not mint`).not.toContain("member_action_log");
    }
  });

  it("requires and bounds the return note, and survives the active-draft collision", () => {
    const ret = body("public.return_form");
    expect(ret).toContain("return note must be between 1 and 4000 characters");
    expect(ret).toContain("when unique_violation");
  });

  it("opens cases only from approved grievance forms, exactly once", () => {
    const open = body("public.open_form_as_case");
    expect(open).toContain("'approved'");
    expect(open).toContain("('grievance', 'alliance_grievance')");
    expect(open).toContain("case_id is not null");
  });

  it("derives the case reference from a server-generated uuid, never the member-visible form id (pre-mortem #3)", () => {
    const open = body("public.open_form_as_case");
    expect(open).toContain("extensions.gen_random_uuid()");
    expect(open, "form id is member-readable, so a derived reference is forgeable").not.toContain("rec.id::text");
    expect(open).toContain("(new_case::text, '-', ''), 1, 8)");
  });

  it("approve-and-open composes the two guarded RPCs in one transaction (review HIGH-1)", () => {
    const combo = body("public.approve_and_open_case");
    expect(combo).toContain("perform public.approve_form(p_form_id, p_note)");
    expect(combo).toContain("return public.open_form_as_case(p_form_id)");
    expect(combo, "combo must not mint either").not.toContain("member_action_log");
    expect(sql).toContain("grant execute on function public.approve_and_open_case(uuid, text) to authenticated");
  });
});

describe("steward desk forms inbox hygiene", () => {
  it("reads only non-draft review states and no identity/presence columns", () => {
    // UB-DESK-01: the inbox reads through the list_steward_forms pager whose
    // SQL pins status to the reviewable pair (submitted/in_review) — see
    // tests/steward-desk-paging-migration.test.js for the server-side pin.
    expect(memberApi).toContain('client.rpc("list_steward_forms"');
    const deskStart = memberApi.indexOf("export async function loadStewardDesk");
    const desk = memberApi.slice(deskStart);
    expect(desk, "inbox must never read review_note or reviewed_by").not.toContain("reviewed_by");
    expect(desk).not.toContain("review_note");
  });
});
