// @vitest-environment node
//
// UB-VOTE-04 (owner directive 2026-08-08): a recorded ballot choice must be
// unlinkable from the voter even with direct database access — secrecy as
// storage truth, not policy. These pins hold three layers to one contract, on
// the steward-caseload template:
//
//   * the migration's choice store carries NO voter column and NO timestamp,
//     is client-unreachable (revoke all + only the restrictive mfa_assurance
//     policy), and the backfill shuffles heap order BEFORE the votes table is
//     emptied — the delete is the moment the voter→choice link stops existing;
//   * scripts/db-contract.json pins the same shape for verify:db against the
//     live catalog: 79 RLS tables, select policies forbidden on the choices
//     table forever, the new private issuer with no client execute, the old
//     trigger issuer moved to functionsAbsent, and submit_ballot_vote
//     forbidden from ever touching the emptied votes table again;
//   * the client's whole ballot write surface is one definer RPC call, and it
//     never names the anonymous choice store.
//
// The db-contract co-edits land in a PARALLEL workstream. A red contract pin
// here means "that edit has not landed yet"; the fix is landing the contract
// edit to this spec, never weakening the pin.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { submitBallot } from "../src/lib/memberApi.js";
import { latestFnBody, loadMigrationSql, stripComments } from "./helpers/migration.js";
import { expectMi1OrganizationRlsContract } from "./helpers/mi1Contract.js";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const raw = loadMigrationSql("ballot_secrecy_unlinkable_votes");
// Negative pins run against comment-stripped SQL (house discipline): the
// header's prose names exactly the things the statements must not do.
const migration = stripComments(raw);
const contract = JSON.parse(readFileSync(join(repoRoot, "scripts/db-contract.json"), "utf8"));

describe("ballot secrecy migration: the anonymous choice store", () => {
  const tableAt = migration.indexOf("create table public.member_ballot_choices");
  const block = migration.slice(tableAt, migration.indexOf(");", tableAt) + 2);

  it("declares the table", () => {
    expect(tableAt).toBeGreaterThan(-1);
  });

  it("has NO voter column and NO timestamp — unlinkability is storage truth", () => {
    // No user_id to link, and no time axis to correlate against a receipt's
    // issued_at. Physical heap order is the only residual surface, and the
    // shuffled backfill (pinned below) scrambles it for historical rows.
    expect(block).not.toMatch(/user_id/);
    expect(block).not.toMatch(/timestamptz|timestamp|submitted_at|created_at|issued_at|now\(\)|clock_timestamp/);
  });

  it("carries exactly id / ballot_id / option_id / stress_run_id", () => {
    expect(block).toMatch(/id uuid primary key default extensions\.gen_random_uuid\(\)/);
    expect(block).toMatch(/ballot_id text not null references public\.member_ballots\(id\) on delete cascade/);
    expect(block).toMatch(/option_id text not null references public\.member_ballot_options\(id\) on delete restrict/);
    expect(block).toMatch(/stress_run_id uuid/);
    const columns = block
      .slice(block.indexOf("(") + 1, block.lastIndexOf(")"))
      .split(",")
      .map((line) => line.trim())
      .filter(Boolean);
    expect(columns, "a fifth column is a new linkage surface").toHaveLength(4);
  });

  it("marks stress_run_id as the synthetic-cohort marker ONLY (comment covenant, raw text)", () => {
    expect(raw).toContain("Synthetic-cohort marker ONLY");
    expect(raw).toContain("this column must never reference a member");
  });

  it("enables RLS with ONLY the restrictive mfa_assurance policy — deny-all by construction", () => {
    expect(migration).toContain("alter table public.member_ballot_choices enable row level security");
    expect(migration).toMatch(
      /create policy mfa_assurance\s+on public\.member_ballot_choices\s+as restrictive\s+for all to authenticated\s+using \(\(select private\.mfa_satisfied\(\)\)\)\s+with check \(\(select private\.mfa_satisfied\(\)\)\)/,
    );
    // With no permissive policy beside it, the restrictive policy alone grants
    // nothing — and this migration creates no other policy at all.
    expect(migration.match(/create policy/g)).toHaveLength(1);
  });

  it("revokes every table privilege from the client roles and grants none back", () => {
    expect(migration).toContain("revoke all on table public.member_ballot_choices from public, anon, authenticated;");
    expect(migration).not.toMatch(/grant[^;]*\bon\s+(?:table\s+)?public\.member_ballot_choices/i);
  });

  it("backfills SHUFFLED so heap order carries no echo of receipt order", () => {
    const backfillAt = migration.indexOf("insert into public.member_ballot_choices (ballot_id, option_id, stress_run_id)");
    expect(backfillAt).toBeGreaterThan(-1);
    const backfill = migration.slice(backfillAt, migration.indexOf(";", backfillAt) + 1);
    expect(backfill).toContain("from public.member_ballot_votes v");
    expect(backfill).toContain("order by pg_catalog.random()");
  });

  it("empties — does not yet drop — the votes table, and drops its receipt trigger machinery", () => {
    // The table survives, empty, because the deployed client still selects
    // from it at boot; the follow-up migration drops it once the new frontend
    // is live. The DELETE is the destruction of the voter→choice link.
    expect(migration).toContain("delete from public.member_ballot_votes;");
    expect(migration).not.toMatch(/drop table[^;]*member_ballot_votes/i);
    expect(migration).toContain("drop trigger member_ballot_votes_issue_receipt on public.member_ballot_votes;");
    expect(migration).toContain("drop function if exists private.issue_member_ballot_receipt();");
  });

  it("issues any missing receipt and copies every choice BEFORE the link is destroyed", () => {
    const deleteAt = migration.indexOf("delete from public.member_ballot_votes;");
    expect(migration).toContain("perform private.issue_ballot_receipt(pair.ballot_id, pair.user_id);");
    expect(migration.indexOf("perform private.issue_ballot_receipt(pair.ballot_id")).toBeLessThan(deleteAt);
    expect(migration.indexOf("insert into public.member_ballot_choices (ballot_id, option_id, stress_run_id)")).toBeLessThan(deleteAt);
  });
});

describe("db-contract pins (co-edited by the parallel contract workstream)", () => {
  it("pins every current RLS table, including Compass, public-site, rewards, invitations, and messaging", () => {
    expectMi1OrganizationRlsContract(contract);
  });

  it("forbids select policies on the choices table forever", () => {
    // A per-vote row that any client role could read would put the linkage
    // question back on the table; only get_ballot_tally may aggregate it.
    const entries = contract.policiesForbidden.filter((entry) => entry.table === "member_ballot_choices");
    expect(entries.length).toBeGreaterThan(0);
    expect(
      entries.some((entry) => new RegExp(entry.namePattern).test("member_ballot_choices_select_own")),
      "the pattern must block ANY select policy, member-own included",
    ).toBe(true);
  });

  it("records private.issue_ballot_receipt as a definer with NO client execute", () => {
    const fn = contract.functions.find((entry) => entry.sig.startsWith("private.issue_ballot_receipt("));
    expect(fn).toBeDefined();
    expect(fn.secdef).toBe(true);
    expect(fn.exec ?? "").not.toMatch(/(^|,)(public|anon|authenticated)(,|$)/);
  });

  it("moves the old trigger issuer to functionsAbsent — it may never come back", () => {
    expect(contract.functionsAbsent.some((entry) => entry.sig === "private.issue_member_ballot_receipt()")).toBe(true);
    expect(contract.functions.some((entry) => entry.sig.startsWith("private.issue_member_ballot_receipt("))).toBe(false);
  });

  it("forbids submit_ballot_vote from ever touching the emptied votes table", () => {
    const fn = contract.functions.find((entry) => entry.sig.startsWith("public.submit_ballot_vote("));
    expect(fn).toBeDefined();
    expect(fn.bodyForbids ?? []).toContain("member_ballot_votes");
  });

  it("no longer pins the dropped receipt trigger", () => {
    expect(contract.triggers.some((entry) => entry.name === "member_ballot_votes_issue_receipt")).toBe(false);
  });
});

// Behavioral: the client's whole ballot write surface is ONE definer RPC call.
// A recording fake proves submitBallot never reaches for a table and carries
// the in-transaction receipt (or the refusal) faithfully to the caller.
function recordingClient(rpcResult) {
  const calls = { rpc: [], from: [] };
  return {
    calls,
    rpc: (name, args) => {
      calls.rpc.push([name, args]);
      return Promise.resolve(rpcResult);
    },
    from: (table) => {
      calls.from.push(table);
      throw new Error(`unexpected table read: ${table}`);
    },
  };
}

describe("current-generation readers and mixers (20260808235000 + 20260809000000)", () => {
  // sol  round-2 finding 3: without pins on the CURRENT re-creates, a
  // later migration could quietly point a total back at receipts (which
  // cascade away with deleted accounts) or drop the mixers, and every green
  // pin here would stay green. Extract each function from the migration that
  // last re-created it.
  const hardening = stripComments(loadMigrationSql("ballot_secrecy_hardening"));
  const cadence = stripComments(loadMigrationSql("ballot_secrecy_mix_cadence"));
  const vacuumThreshold = stripComments(loadMigrationSql("ballot_choices_vacuum_threshold"));

  // sol  round-3 finding 3: a hardcoded source migration would stay green
  // while a LATER migration re-created a reader against receipts. Scan the
  // whole migration directory and pin against the newest file that re-creates
  // each function — the pin follows the current generation automatically.
  it("every vote total counts anonymous choices, never receipts — in the NEWEST generation of each reader", () => {
    for (const name of ["public.get_ballot_tally", "public.get_vp_overview", "public.get_advisor_overview"]) {
      const body = latestFnBody(name);
      const counts = body.match(/count\(\*\)[\s\S]{0,80}?from public\.member_ballot_(choices|receipts)\s+where ballot_id/g) || [];
      expect(counts.length, `${name} has a ballot count`).toBeGreaterThan(0);
      for (const c of counts) {
        expect(c).toContain("member_ballot_choices");
      }
    }
  });

  it("keeps the nightly full mix and the five-minute targeted mix, both revoked from clients", () => {
    expect(hardening).toContain("update public.member_ballot_choices set ballot_id = ballot_id");
    expect(hardening).toContain("'ballot-choices-mix',");
    expect(hardening).toContain(
      "revoke all on function private.mix_member_ballot_choices() from public, anon, authenticated, service_role;",
    );
    expect(cadence).toContain("where c.xmin::text in (");
    expect(cadence).toContain("select r.xmin::text from public.member_ballot_receipts r)");
    expect(cadence).toContain("'ballot-choices-mix-recent',");
    expect(cadence).toContain(
      "revoke all on function private.mix_recent_ballot_choices() from public, anon, authenticated, service_role;",
    );
  });

  it("runs effectively-continuous autovacuum on the choices table so dead pre-mix versions die fast", () => {
    expect(cadence).toContain("autovacuum_vacuum_scale_factor = 0.0");
    // Threshold tightened 50 -> 1 by 20260809001000 (: a
    // 1-49 row tail batch would otherwise sit under the trigger).
    expect(vacuumThreshold).toContain("autovacuum_vacuum_threshold = 1");
  });

  it("pins both mixer functions and cron jobs in the db contract", () => {
    const sigs = contract.functions.map((f) => f.sig);
    expect(sigs).toContain("private.mix_member_ballot_choices()");
    expect(sigs).toContain("private.mix_recent_ballot_choices()");
    const jobs = contract.cron.map((j) => j.jobname);
    expect(jobs).toContain("ballot-choices-mix");
    expect(jobs).toContain("ballot-choices-mix-recent");
  });
});

describe("submitBallot client behavior", () => {
  it("submits through the RPC alone and returns the transaction's receiptCode", async () => {
    const client = recordingClient({ data: { receiptCode: "abcd1234", awardedPoints: 20 }, error: null });
    const receipt = await submitBallot(client, "ballot-1", "option-2");
    expect(client.calls.rpc).toEqual([["submit_ballot_vote", { p_ballot_id: "ballot-1", p_option_id: "option-2" }]]);
    expect(client.calls.from).toEqual([]);
    expect(receipt).toBe("abcd1234");
  });

  it("normalises a missing receipt to '' — never null — for the toast gate", async () => {
    const client = recordingClient({ data: null, error: null });
    await expect(submitBallot(client, "b", "o")).resolves.toBe("");
  });

  it("surfaces the already-recorded refusal as a thrown error, never a silent success", async () => {
    const client = recordingClient({ data: null, error: { message: "your vote is already recorded" } });
    await expect(submitBallot(client, "b", "o")).rejects.toThrow();
  });

  it("the client never queries the anonymous choice store", () => {
    // Quoted-literal form: a comment may EXPLAIN the choice store (memberApi's
    // ballot loader does), but no client code may name it as a table.
    const memberApi = readFileSync(join(repoRoot, "src/lib/memberApi.js"), "utf8");
    expect(memberApi).not.toMatch(/["'`]member_ballot_choices["'`]/);
    expect(memberApi).not.toContain('from("member_ballot_choices")');
  });
});
