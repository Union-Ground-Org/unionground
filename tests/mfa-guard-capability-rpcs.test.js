import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { fnBody, loadMigrationSql, stripComments } from "./helpers/migration.js";

// Text pins are a tripwire, not a proof: they assert what THIS MIGRATION SAYS.
// The live-DB backstop is scripts/db-contract.json — the per-function
// bodyContains needles, the bodyMd5 whole-definition pins (new with this
// batch), and the mfaCoverage sweep (every SECURITY DEFINER RPC reachable by
// authenticated is guarded or exempt), checked by `npm run verify:db`.
// REQ-UG-DEFINER-MFA-AUDIT batch 4 of 4 (capability) — the rollout closes.

const sql = loadMigrationSql("mfa_guard_capability_rpcs");
const workloadSql = loadMigrationSql("workload_intelligence");

// Pins run on code with comments stripped (line, block, and trailing alike)
// so the header and the per-function "Assurance term added" comments cannot
// satisfy a load-bearing assertion. fnBody pins the exact function on its
// argument list: without that a hypothetical <name>_v2 placed earlier in the
// file would be silently matched instead.
const rpcBody = (name) => stripComments(fnBody(sql, name));

// All three capability RPCs are MEMBER RPCs bound to the caller's own rows
// (write-once workload ledger, private Compass guide history, own calendar
// feed token); none is steward-gated, so all take private.mfa_satisfied().
const MEMBER_RPCS = ["submit_workload_log", "save_member_guide_exchange", "revoke_calendar_feed_token"];

// These are non-secret content digests. The first value authenticates the
// historical migration body; the second authenticates the later coordinated
// definition installed by the case-graph wrapper migration.
const CAPABILITY_BODY_DIGESTS = [
  {
    rpc: "save_member_guide_exchange",
    migrationBodyMd5: "73aaad990824307991233352c5a3a574",
    // PIN step-up follows the existing case-graph gate in the newest definition.
    // Previous coordinated body: 8e44019f5906d7ca802a9d6612a11329.
    coordinatedBodyMd5: "a8602e19362c5a64799d7cfc8ede1300",
  },
  {
    rpc: "revoke_calendar_feed_token",
    migrationBodyMd5: "0ec182b554092705a4a255ce9620f781",
    coordinatedBodyMd5: "fa6bce862d68e7614a7e49aadf2ac4ba",
  },
];

function capabilityDigestChainIssues(contract, digests = CAPABILITY_BODY_DIGESTS) {
  const issues = [];
  for (const { rpc, migrationBodyMd5, coordinatedBodyMd5 } of digests) {
    const headerMatch = sql.match(new RegExp(`--   ${rpc}\\s+([0-9a-f]{32})`));
    const entry = contract.functions.find((candidate) => candidate.sig.startsWith(`public.${rpc}(`));
    if (!headerMatch) issues.push(`${rpc}: migration header digest missing`);
    else if (headerMatch[1] !== migrationBodyMd5) issues.push(`${rpc}: migration header digest changed`);
    if (entry?.bodyMd5 !== coordinatedBodyMd5) issues.push(`${rpc}: coordinated contract digest changed`);
  }
  return issues;
}

describe("capability member RPCs force MFA step-up", () => {
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

      it("stays a definer function with an empty search_path (attributes pinned)", () => {
        // Attribute pins only — byte-level body preservation is proven by the
        // md5 chain in the migration header, not by these substrings.
        expect(body).toContain("SECURITY DEFINER");
        expect(body).toContain("SET search_path TO ''");
      });
    });
  }
});

describe("revoke_calendar_feed_token matches its guarded sibling", () => {
  it("keeps the delete scoped to the caller's own token row (body preserved)", () => {
    // The destructive half of the rotate/revoke capability pair: same guard as
    // rotate_calendar_feed_token, still deletes only the caller's row.
    const body = rpcBody("revoke_calendar_feed_token");
    expect(body).toContain("delete from public.member_calendar_feed_tokens where user_id = caller;");
  });
});

describe("db-contract closes the coverage ratchet after batch 4", () => {
  const contract = JSON.parse(readFileSync(resolve(process.cwd(), "scripts/db-contract.json"), "utf8"));
  const cov = contract.mfaCoverage;

  it("no longer exempts OR defers the three now-guarded capability RPCs", () => {
    // They are covered by the guard, so they must not appear on either escape
    // list — otherwise a future guard removal would be silently tolerated.
    for (const rpc of MEMBER_RPCS) {
      expect(Object.keys(cov.exempt)).not.toContain(rpc);
      expect(Object.keys(cov.pending || {})).not.toContain(rpc);
    }
  });

  it("pins the pending ratchet EXACTLY EMPTY — the staged rollout is closed", () => {
    // Any future pending entry must arrive with a deliberate edit to this test
    // and a scheduled batch, not just a self-authored contract line.
    expect(Object.keys(cov.pending || {})).toEqual([]);
  });

  it("pins the full guard shape as bodyContains needles on each capability RPC", () => {
    // The bare term "private.mfa_satisfied()" is satisfiable by a neutered
    // guard (or->and flip, dead conjunct, value-ignored perform). The needle
    // must be the whole guard line, plus the errcode to catch dead-raise
    // removal (batch-3 review, HIGH->MED adjudicated).
    for (const rpc of MEMBER_RPCS) {
      const entry = contract.functions.find((f) => f.sig.startsWith(`public.${rpc}(`));
      expect(entry, `${rpc} must have a contract entry`).toBeTruthy();
      expect(entry.bodyContains, `${rpc} must pin the guard shape`)
        .toContain("if caller is null or not private.mfa_satisfied() then");
      expect(entry.bodyContains, `${rpc} must pin the raise`)
        .toContain("using errcode = '42501'");
    }
  });

  it("pins the historical and coordinated function-body digest chain", () => {
    // The header md5s were computed AT GENERATION TIME from the server-side
    // spliced definitions; verify:db compares the contract value against the
    // LIVE pg_get_functiondef. Keeping both stages in one typed fixture makes
    // either historical or coordinated source drift fail explicitly.
    expect(capabilityDigestChainIssues(contract)).toEqual([]);
  });

  it("fails the digest chain when a reviewed function-body pin changes", () => {
    const changed = CAPABILITY_BODY_DIGESTS.map((digest, index) => index === 0
      ? { ...digest, coordinatedBodyMd5: `0${digest.coordinatedBodyMd5.slice(1)}` }
      : digest);
    expect(capabilityDigestChainIssues(contract, changed)).toContain(
      "save_member_guide_exchange: coordinated contract digest changed",
    );
  });

  it("keeps the shipped workload guard migration immutable and pins its later forward emitter", () => {
    expect(sql.match(/-- {3}submit_workload_log\s+([0-9a-f]{32})/)?.[1])
      .toBe("1467b7ea19cf661541f16e5f8b96decc");
    expect(stripComments(fnBody(workloadSql, "submit_workload_log")))
      .toContain("perform private.notify_workload_event(caller, 'receipt', rcode);");
    const entry = contract.functions.find((f) => f.sig.startsWith("public.submit_workload_log("));
    // Includes the later source-pinned case-graph entry block and the
    // workload_daily_limit DETAIL token (20261005170000).
    expect(entry?.bodyMd5).toBe("2da59264c6d95d1b57fab4478d0058d5");
  });

  it("md5-pins every RPC the four audit batches touched, not just this batch", () => {
    // The bodyMd5 facility landed with batch 4 but covers the whole audit:
    // all thirteen definer RPCs across events/forms/cosign/capability.
    const pinned = [
      "check_in_to_event", "request_event_checkin_token", "rsvp_to_event",
      "submit_form", "save_form_draft", "approve_and_open_case",
      "invite_cosigner", "respond_to_cosign", "withdraw_cosign", "cosign_invite_preview",
      ...MEMBER_RPCS,
    ];
    for (const rpc of pinned) {
      const entry = contract.functions.find((f) => f.sig.startsWith(`public.${rpc}(`));
      expect(entry?.bodyMd5, `${rpc} must carry a bodyMd5 pin`).toMatch(/^[0-9a-f]{32}$/);
    }
  });

  it("pins the keystone private.mfa_satisfied() — the callee every guard delegates to", () => {
    // Batch-4 review, HIGH: a `select true` replacement of the keystone left
    // every caller-side pin green while disabling MFA step-up platform-wide
    // (the restrictive mfa_assurance policy calls the same function). The
    // whole-body md5 plus the polarity needle close that one silent path.
    const entry = contract.functions.find((f) => f.sig === "private.mfa_satisfied()");
    expect(entry, "keystone entry must exist").toBeTruthy();
    expect(entry.bodyMd5).toMatch(/^[0-9a-f]{32}$/);
    expect(entry.bodyContains).toContain("else not private.member_mfa_required(claims.user_id) and not exists (");
    expect(entry.bodyContains).toContain("factor.status = 'verified'");
    expect(entry.bodyContains).toContain("factor.factor_type = 'totp'");
  });

  it("pins rotate_calendar_feed_token the same way as its revoke sibling", () => {
    // Review INFO: the already-guarded sibling had neither needles nor md5 —
    // contract asymmetry, not a hole (the term sweep still covers it). Closed.
    const entry = contract.functions.find((f) => f.sig.startsWith("public.rotate_calendar_feed_token("));
    expect(entry, "rotate entry must exist").toBeTruthy();
    expect(entry.bodyContains).toContain("if caller is null or not private.mfa_satisfied() then");
    expect(entry.bodyMd5).toMatch(/^[0-9a-f]{32}$/);
  });
});
