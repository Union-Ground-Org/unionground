import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { fnBody, loadMigrationSql, stripComments } from "./helpers/migration.js";

// Text pins are a tripwire, not a proof: they assert what THIS MIGRATION SAYS.
// The live-DB backstop is scripts/db-contract.json — both the per-function
// bodyContains needles AND the mfaCoverage sweep (every SECURITY DEFINER RPC
// reachable by authenticated is guarded or exempt), checked by `npm run
// verify:db`. REQ-UG-DEFINER-MFA-AUDIT batch 2 of 4 (forms).

const sql = loadMigrationSql("mfa_guard_form_rpcs");

// Pins run on code with comments stripped (line, block, and trailing alike) so
// the header and the per-function "Assurance term added" comments cannot
// satisfy a load-bearing assertion.
// (approve_and_open_case's comment names both member_has_role and mfa_satisfied;
// stripping guarantees the term assertions below match real code, not prose.)
const rpcBody = (name) => stripComments(fnBody(sql, name));

// The two MEMBER action RPCs: augment the existing bare caller guard with the
// member-style term private.mfa_satisfied().
const MEMBER_RPCS = ["submit_form", "save_form_draft"];

describe("forms member RPCs force MFA step-up", () => {
  for (const rpc of MEMBER_RPCS) {
    describe(rpc, () => {
      const body = rpcBody(rpc);

      it("combines the assurance term into the existing caller guard", () => {
        expect(body).toMatch(/if caller is null or not private\.mfa_satisfied\(\) then/);
        expect(body).toContain("using errcode = '42501'");
      });

      it("leaves no bare 'if caller is null then' guard behind", () => {
        // The combined form does not match this; a leftover bare guard would.
        expect(body).not.toMatch(/if caller is null then/);
      });

      it("stays a definer function with an empty search_path (body preserved)", () => {
        expect(body).toContain("SECURITY DEFINER");
        expect(body).toContain("SET search_path TO ''");
      });
    });
  }
});

describe("approve_and_open_case makes the steward+MFA gate explicit", () => {
  const body = rpcBody("approve_and_open_case");

  it("gates on member_has_role(['steward']) at the entry point", () => {
    // member_has_role() AND-s private.mfa_satisfied() before the role lookup, so
    // this single term enforces the steward hat AND forces MFA step-up — matching
    // its callees approve_form / open_form_as_case rather than the member style.
    expect(body).toMatch(/if caller is null or not public\.member_has_role\(array\['steward'\]\) then/);
    expect(body).toContain("using errcode = '42501'");
  });

  it("still delegates to the two steward-gated RPCs (body preserved)", () => {
    expect(body).toContain("perform public.approve_form(p_form_id, p_note)");
    expect(body).toContain("return public.open_form_as_case(p_form_id)");
  });

  it("stays a definer function with an empty search_path", () => {
    expect(body).toContain("SECURITY DEFINER");
    expect(body).toContain("SET search_path TO ''");
  });
});

describe("db-contract records the coverage backstop after batch 2", () => {
  const contract = JSON.parse(readFileSync(resolve(process.cwd(), "scripts/db-contract.json"), "utf8"));
  const cov = contract.mfaCoverage;

  it("defines an mfaCoverage sweep with the two accepted term needles", () => {
    expect(cov, "mfaCoverage must exist").toBeTruthy();
    expect(cov.termNeedles).toContain("mfa_satisfied");
    expect(cov.termNeedles).toContain("member_has_role");
  });

  it("no longer exempts OR defers the three now-guarded forms RPCs", () => {
    // They are covered by the guard, so they must not appear on either escape
    // list — otherwise a future guard removal would be silently tolerated.
    for (const rpc of ["submit_form", "save_form_draft", "approve_and_open_case"]) {
      expect(Object.keys(cov.exempt)).not.toContain(rpc);
      expect(Object.keys(cov.pending || {})).not.toContain(rpc);
    }
  });

  it("keeps the public /verify endpoint exempt (never MFA-gated)", () => {
    expect(Object.keys(cov.exempt)).toContain("verify_ballot_receipt");
  });

  it("no longer defers the capability trio — batch 4 drained the ratchet", () => {
    // The newest batch's test owns the exact-set assertion (batch 4 pins the
    // list EXACTLY EMPTY); older pins assert their names cannot re-enroll.
    const pending = Object.keys(cov.pending || {});
    for (const rpc of [
      "submit_workload_log", "save_member_guide_exchange", "revoke_calendar_feed_token",
    ]) {
      expect(pending, `${rpc} is guarded (batch 4) and must not be re-deferred`).not.toContain(rpc);
    }
  });
});
