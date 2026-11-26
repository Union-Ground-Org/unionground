import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { fnBody, loadMigrationSql, stripComments } from "./helpers/migration.js";

// Text pins are a tripwire, not a proof: they assert what THIS MIGRATION SAYS.
// The live-DB backstop is scripts/db-contract.json — both the per-function
// bodyContains "private.mfa_satisfied()" needles AND the mfaCoverage sweep
// (every SECURITY DEFINER RPC reachable by authenticated is guarded or exempt),
// checked by `npm run verify:db`. REQ-UG-DEFINER-MFA-AUDIT batch 1 of 4.

const sql = loadMigrationSql("mfa_guard_event_rpcs");

// Pins run on code with comments stripped (line, block, and trailing alike) so
// the header and the per-function "Assurance term added" comments cannot
// satisfy a load-bearing assertion.
const rpcBody = (name) => stripComments(fnBody(sql, name));

const RPCS = ["check_in_to_event", "request_event_checkin_token", "rsvp_to_event"];

describe("event member RPCs force MFA step-up", () => {
  for (const rpc of RPCS) {
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

describe("db-contract records the coverage backstop for batch 1", () => {
  const contract = JSON.parse(readFileSync(resolve(process.cwd(), "scripts/db-contract.json"), "utf8"));
  const cov = contract.mfaCoverage;

  it("defines an mfaCoverage sweep with the two accepted term needles", () => {
    expect(cov, "mfaCoverage must exist").toBeTruthy();
    expect(cov.termNeedles).toContain("mfa_satisfied");
    expect(cov.termNeedles).toContain("member_has_role");
  });

  it("does NOT exempt or defer the three now-guarded event RPCs", () => {
    // They are covered by the guard, so they must not appear on either escape
    // list — otherwise a future guard removal would be silently tolerated.
    for (const rpc of RPCS) {
      expect(Object.keys(cov.exempt)).not.toContain(rpc);
      expect(Object.keys(cov.pending || {})).not.toContain(rpc);
    }
  });

  it("keeps the public /verify endpoint exempt (never MFA-gated)", () => {
    expect(Object.keys(cov.exempt)).toContain("verify_ballot_receipt");
  });

  it("no longer defers the capability trio — batch 4 drained the ratchet", () => {
    // The snapshot shrank as batches landed: batch 2 (forms), batch 3
    // (cosign), batch 4 (capability). Batch 4's test pins the list EXACTLY
    // EMPTY; older pins assert their names cannot re-enroll.
    const pending = Object.keys(cov.pending || {});
    for (const rpc of [
      "submit_workload_log", "save_member_guide_exchange", "revoke_calendar_feed_token",
    ]) {
      expect(pending, `${rpc} is guarded (batch 4) and must not be re-deferred`).not.toContain(rpc);
    }
  });
});
