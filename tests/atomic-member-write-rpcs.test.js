// @vitest-environment node
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { findMigrationName, fnBody, loadMigrationSql, stripComments } from "./helpers/migration.js";

// Text pins over the migration. They are a tripwire, not a proof: whether the
// four functions actually exist with these bodies, and whether the sole-writer
// revokes actually landed, can only be answered by pg_proc / information_schema against
// the live database after apply. What lives here is the cheap half — it catches
// an edit that drops the assurance term, widens a signature back to accepting a
// user id, loosens the cross-ballot option check, or re-grants a table write
// the RPCs are supposed to own, and it runs on every commit.
const migrationName = findMigrationName("atomic_member_write_rpcs");
const sql = loadMigrationSql("atomic_member_write_rpcs");
// The sole-writer revokes live in a second migration — the CONTRACT phase of
// an expand/contract rollout (see both files' headers). The RPC migration must
// stay pure-additive so it can be applied ahead of the frontend deploy.
//
// Loaded at module scope, not inside a test: if the CONTRACT-phase file is
// missing, loadMigrationSql throws here and names it, instead of every pin
// below failing as a confusing import error.
const revokesName = findMigrationName("member_write_sole_writer_revokes");
const revokesSql = loadMigrationSql("member_write_sole_writer_revokes");
// submit_ballot_vote was REWRITTEN by the ballot-secrecy migration
// (20260808230000, UB-VOTE-04): votes are FINAL and the choice lands as an
// anonymous member_ballot_choices row. Every pin on the CURRENT ballot
// function body extracts from the newest re-create — 20260809010000, which
// folded chapter eligibility into the ballot lookup (UB-VOTE-03) on top of
// the 20260808235000 stress-run stamp ( finding 5);
// fnBody(sql, ...) still reaches the superseded 20260725 generation, used
// only where the pin documents what the ORIGINAL file said (which never
// changes).
const secrecySql = loadMigrationSql("ballot_eligibility_and_results");

// Comments legitimately name things the statements must NOT do (the header
// spells out the defects, the trailer names the grants deliberately kept), so
// every negative pin runs against executable SQL only, whitespace-collapsed so
// a reflow of a statement cannot break a pin.
const normalise = (text) => stripComments(text).replace(/\s+/g, " ").trim();
const statements = normalise(sql);
const revokeStatements = normalise(revokesSql);

// Executable lines of one function, comments stripped — the same reason the
// file-level `statements` exists. Each body explains in prose exactly what it
// must not do ("reporting member_point_rules would have lied", "submitted_at is
// deliberately NOT bumped"), and a negative pin run over the prose would fail
// on the explanation instead of the code.
function fnStatements(name) {
  return normalise(fnBody(sql, name));
}

// The live ballot function body (ballot-secrecy generation) and its
// comment-stripped, whitespace-collapsed form for negative pins.
const ballotFn = fnBody(secrecySql, "public.submit_ballot_vote(p_ballot_id text, p_option_id text)");
const ballotFnStatements = normalise(ballotFn);

const RPCS = [
  ["public.send_member_message(p_conversation_id uuid, p_body text)", "public.send_member_message(uuid, text)"],
  ["public.create_member_case(", "public.create_member_case(text, date, text, text)"],
  ["public.submit_ballot_vote(p_ballot_id text, p_option_id text)", "public.submit_ballot_vote(text, text)"],
  ["public.submit_survey_response(p_survey_id text, p_option_id text)", "public.submit_survey_response(text, text)"],
];

describe("atomic member write RPCs: the assurance boundary survives the conversion", () => {
  // The single most dangerous thing about this migration. SECURITY DEFINER
  // bypasses RLS, restrictive policies included, so moving a client write into
  // a definer function silently exempts it from mfa_assurance (20260724030000)
  // unless the function re-states the check. Dropping this line from any one of
  // the four reopens that path at aal1 with no other symptom.
  it.each(RPCS)("%s carries the mfa_satisfied guard raising 42501", (marker) => {
    const body = fnBody(sql, marker);
    expect(body).toContain("private.mfa_satisfied()");
    expect(body).toContain("raise exception 'authentication required' using errcode = '42501'");
    expect(body).toContain("caller is null or not private.mfa_satisfied()");
  });

  it("has exactly four assurance terms — one per RPC, none skipped", () => {
    expect(statements.match(/not private\.mfa_satisfied\(\)/g) ?? []).toHaveLength(4);
  });

  it.each(RPCS)("%s is security definer with a pinned empty search_path", (marker) => {
    const body = fnBody(sql, marker);
    expect(body).toContain("security definer");
    expect(body).toContain("set search_path = ''");
  });

  it.each(RPCS)("%s derives the caller from auth.uid(), never from a parameter", (marker) => {
    expect(fnBody(sql, marker)).toMatch(/caller\s+uuid := \(select auth\.uid\(\)\)/);
  });

  it("accepts no user-id parameter in any signature", () => {
    // A p_user_id would let one member write as another the moment the function
    // is definer-owned — there is no RLS left to stop it.
    expect(statements).not.toMatch(/p_user(_id)?\s+uuid/);
  });

  it("revokes from public/anon and grants execute to authenticated for each RPC", () => {
    for (const [, signature] of RPCS) {
      const escaped = signature.replace(/[.()]/g, (ch) => `\\${ch}`);
      expect(statements).toMatch(new RegExp(`revoke all on function ${escaped} from public, anon;`));
      expect(statements).toMatch(new RegExp(`grant execute on function ${escaped} to authenticated;`));
    }
  });
});

describe("atomic member write RPCs: no new point-mint path", () => {
  it("never writes member_point_events and never redefines the award trigger", () => {
    expect(statements).not.toMatch(/insert into public\.member_point_events/);
    expect(statements).not.toContain("function private.award_member_points");
  });

  it("emits the canonical anchored action keys the live trigger already backs", () => {
    expect(ballotFn).toContain("akey := 'vote-' || p_ballot_id");
    expect(fnBody(sql, RPCS[3][0])).toContain("akey := 'survey-' || p_survey_id");
    expect(fnBody(sql, RPCS[1][0])).toContain("akey := 'case-' || ref");
    const message = fnBody(sql, RPCS[0][0]);
    expect(message).toContain("'message-' || p_conversation_id::text || '-'");
    // clock_timestamp, not now(): the trailing digits are what satisfies the
    // trigger's '^message-(.*)-[0-9]+$' anchor, and transaction time would
    // collide for two messages sent in one transaction.
    expect(message).toContain("clock_timestamp(), 'YYYYMMDDHH24MISSUS'");
  });

  it.each(RPCS)("%s reads the awarded total back from the ledger, not from the rules table", (marker) => {
    const body = fnBody(sql, marker);
    expect(body).toContain("from public.member_point_events e");
    expect(body).toContain("where e.user_id = caller and e.action_key = akey");
    // member_point_rules.points is what the member WOULD earn; over the weekly
    // cap (case 3/wk, message 5/wk) the trigger awards nothing and reporting
    // the rule would tell the member they earned points they did not.
    expect(fnStatements(marker)).not.toContain("member_point_rules");
    expect(body).toContain("'awardedPoints', coalesce(awarded, 0)");
  });

  it("logs each action idempotently on the (user_id, action_key) unique", () => {
    for (const [marker] of RPCS) {
      expect(fnBody(sql, marker)).toContain("on conflict (user_id, action_key) do nothing");
    }
  });
});

describe("atomic member write RPCs: the three live defects", () => {
  it("refuses an option that belongs to a different ballot (quorum inflation)", () => {
    expect(ballotFn).toContain("from public.member_ballot_options o");
    expect(ballotFn).toContain("where o.id = p_option_id and o.ballot_id = p_ballot_id");
    expect(ballotFn).toContain("raise exception 'invalid option for this ballot'");
  });

  it("refuses an option that belongs to a different pulse", () => {
    const survey = fnBody(sql, RPCS[3][0]);
    expect(survey).toContain("from public.member_survey_options o");
    expect(survey).toContain("where o.id = p_option_id and o.survey_id = p_survey_id");
    expect(survey).toContain("raise exception 'invalid option for this pulse'");
  });

  it("refuses a vote after the ballot closes", () => {
    expect(ballotFn).toContain("not ballot.active or ballot.closes_at <= now()");
    expect(ballotFn).toContain("raise exception 'this ballot is closed'");
  });

  it("refuses an answer after the pulse closes", () => {
    const survey = fnBody(sql, RPCS[3][0]);
    expect(survey).toContain("not survey.active or survey.closes_at <= now()");
    expect(survey).toContain("raise exception 'this pulse is closed'");
  });

  it("derives the sender name server-side instead of trusting the client", () => {
    const message = fnBody(sql, RPCS[0][0]);
    expect(statements, "sender_name must not be a parameter").not.toMatch(/p_sender_name/);
    expect(message).toContain("select p.full_name into sender from public.member_profiles p where p.id = caller");
    expect(message).toContain("coalesce(nullif(pg_catalog.btrim(coalesce(sender, '')), ''), 'Member')");
    expect(message).toContain("'member'");
  });

  it("keeps the conversation touch inside the same transaction as the message", () => {
    const message = fnBody(sql, RPCS[0][0]);
    expect(message).toContain("insert into public.member_messages");
    expect(message).toContain("update public.member_conversations set updated_at = now()");
    expect(message).toContain("for update");
  });
});

describe("atomic member write RPCs: error surfaces", () => {
  it("collapses missing and not-yours conversations into ONE error", () => {
    const message = fnBody(sql, RPCS[0][0]);
    expect(message).toContain("if not found or conv.user_id <> caller then");
    expect(message).toContain("raise exception 'conversation not found'");
    // Conversations are member-private, so a distinct "not yours" would confirm
    // that some other member holds a thread with a guessed uuid.
    expect(fnStatements(RPCS[0][0])).not.toMatch(/not your|belongs to another/i);
    expect(message.match(/raise exception 'conversation/g) ?? []).toHaveLength(1);
  });

  it("keeps ballot not-found and closed distinguishable on purpose", () => {
    // member_ballots is org-readable to every authenticated member and
    // get_ballot_tally already draws the same distinction, so this discloses
    // nothing a plain SELECT does not.
    expect(ballotFn).toContain("raise exception 'ballot not found'");
    expect(ballotFn).toContain("raise exception 'this ballot is closed'");
  });

  it("validates the case fields by raising, never by truncating", () => {
    const kase = fnBody(sql, RPCS[1][0]);
    expect(kase).toContain("case title too long (200 characters max)");
    expect(kase).toContain("contract articles too long (500 characters max)");
    expect(kase).toContain("case title is required");
    expect(kase).toContain("deadline out of range");
    expect(kase, "no silent clipping of a member's account of an incident").not.toMatch(/pg_catalog\.left\(|substr\(clean_/);
  });

  it("pins the case types to the exact six the intake form offers", async () => {
    // The intake form's options come from CASE_TYPES in the shared case fields
    // (REQ-UG-STEWARD-CASEWORK-GAPS-20261030), which the member's form
    // and the steward's "Open a case for a member" form both render. The list
    // lives in src/lib/caseRowLine.js since, which also labels case rows.
    const fields = readFileSync(new URL("../src/lib/caseRowLine.js", import.meta.url), "utf8");
    const offered = JSON.parse(/export const CASE_TYPES = (\[[^\]]+\]);/.exec(fields)[1]);
    expect(offered).toEqual(["Discipline", "Scheduling", "Telework", "Safety", "Pay", "Other"]);
    const intake = readFileSync(new URL("../supabase/migrations/20261030204500_steward_case_intake.sql", import.meta.url), "utf8");
    expect(intake).toContain("p_case_type not in ('Discipline', 'Scheduling', 'Telework', 'Safety', 'Pay', 'Other')");
    const kase = fnBody(sql, RPCS[1][0]);
    expect(kase).toContain("p_case_type not in ('Discipline', 'Scheduling', 'Telework', 'Safety', 'Pay', 'Other')");
    expect(kase).toContain("raise exception 'invalid case type'");
  });
});

describe("atomic member write RPCs: server-allocated case reference", () => {
  it("takes no reference from the client and generates one from a CSPRNG", () => {
    expect(statements, "a client-chosen reference could pre-block a filing").not.toMatch(/p_reference/);
    expect(statements).toContain("create or replace function private.member_case_suffix()");
    expect(statements).toContain("extensions.gen_random_bytes(3)");
    expect(statements).toContain("revoke all on function private.member_case_suffix() from public, anon, authenticated;");
    const kase = fnBody(sql, RPCS[1][0]);
    expect(kase).toContain("ref := 'GR-' || pg_catalog.to_char(now(), 'YYYY') || '-' || private.member_case_suffix()");
  });

  it("retries a colliding reference a bounded number of times", () => {
    const kase = fnBody(sql, RPCS[1][0]);
    expect(kase).toContain("exception when unique_violation then");
    expect(kase).toContain("if attempts >= 5 then");
    expect(kase).toContain("raise exception 'could not allocate a case reference' using errcode = '23505'");
  });

  it("keeps the suffix helper volatile so the retry loop can terminate", () => {
    const suffix = fnBody(sql, "private.member_case_suffix()");
    expect(suffix).toContain("volatile");
    expect(suffix).toContain("set search_path = ''");
  });
});

describe("submit_ballot_vote (ballot-secrecy generation): guards survive the rewrite", () => {
  // The 20260808230000 rewrite replaces the whole function body, so every
  // guard the it.each pins above prove for the SUPERSEDED generation must be
  // re-proven against the body that is actually live.
  it("carries the mfa_satisfied guard raising 42501", () => {
    expect(ballotFn).toContain("caller is null or not private.mfa_satisfied()");
    expect(ballotFn).toContain("raise exception 'authentication required' using errcode = '42501'");
  });

  it("is security definer with a pinned empty search_path and an auth.uid() caller", () => {
    expect(ballotFn).toContain("security definer");
    expect(ballotFn).toContain("set search_path = ''");
    expect(ballotFn).toMatch(/caller\s+uuid := \(select auth\.uid\(\)\)/);
    expect(ballotFnStatements, "no caller-supplied user id").not.toMatch(/p_user(_id)?\s+uuid/);
  });

  it("folds chapter eligibility into the ballot lookup, before every other guard (UB-VOTE-03)", () => {
    // The eligibility predicate lives in the same WHERE as the existence
    // check, so an out-of-chapter ballot raises the not-found error — never a
    // distinct "not eligible" oracle — and it mirrors the read policy
    // (member_ballots_read_eligible) exactly: what a member cannot read they
    // cannot vote in, and vice versa.
    expect(ballotFnStatements).toContain(
      "where b.id = p_ballot_id and (b.chapter_id is null or b.chapter_id = private.current_member_chapter());",
    );
    const lookupAt = ballotFnStatements.indexOf("b.chapter_id is null or b.chapter_id = private.current_member_chapter()");
    const receiptAt = ballotFnStatements.indexOf("code := private.issue_ballot_receipt(p_ballot_id, caller)");
    expect(lookupAt).toBeGreaterThan(-1);
    expect(receiptAt).toBeGreaterThan(lookupAt);
    expect(ballotFnStatements, "no separate eligibility error message").not.toMatch(/not eligible/);
  });
});

describe("submit_ballot_vote (ballot-secrecy generation): final votes, anonymous storage", () => {
  it("refuses a second submission — votes are FINAL now that storage is unlinkable", () => {
    expect(ballotFn).toContain("code := private.issue_ballot_receipt(p_ballot_id, caller)");
    expect(ballotFn).toContain("if code is null then");
    expect(ballotFn).toContain("raise exception 'your vote is already recorded' using errcode = '22023'");
  });

  it("orders receipt issuance before the choice insert before the action log", () => {
    // The receipt insert is the one-vote serialization point: only a fresh
    // receipt may be followed by a choice row, and only a logged action reads
    // the award back.
    const receiptAt = ballotFnStatements.indexOf("code := private.issue_ballot_receipt(p_ballot_id, caller)");
    const choiceAt = ballotFnStatements.indexOf("insert into public.member_ballot_choices");
    const logAt = ballotFnStatements.indexOf("insert into public.member_action_log");
    expect(receiptAt).toBeGreaterThan(-1);
    expect(choiceAt).toBeGreaterThan(receiptAt);
    expect(logAt).toBeGreaterThan(choiceAt);
  });

  it("stores the choice with no voter and no timestamp — the only extra column is the stress-run sweep stamp", () => {
    // stress_run_id is a run marker for synthetic-cohort removal, not a voter
    // reference: real members are never in private.member_stress_ledger, so
    // the scalar subquery stamps them null (20260808235000, sol /5).
    expect(ballotFnStatements).toContain(
      "insert into public.member_ballot_choices (ballot_id, option_id, stress_run_id) values (p_ballot_id, p_option_id, (select l.run_id from private.member_stress_ledger l where l.user_id = caller limit 1));",
    );
    expect(ballotFnStatements).not.toMatch(/member_ballot_choices \([^)]*user_id/);
  });

  it("never upserts, never updates a prior choice, never touches the emptied votes table", () => {
    expect(ballotFnStatements).not.toContain("on conflict (ballot_id, user_id) do update");
    expect(ballotFnStatements).not.toMatch(/do update/);
    expect(ballotFnStatements).not.toContain("member_ballot_votes");
  });

  it("returns the receipt from issuance — always non-empty — plus the award read-back", () => {
    expect(ballotFn).toContain("'receiptCode', code");
    expect(ballotFn).toContain("'awardedPoints', coalesce(awarded, 0)");
    expect(ballotFn).toContain("on conflict (user_id, action_key) do nothing");
  });
});

describe("sole-writer revokes: expand/contract split", () => {
  it("keeps the RPC migration pure-additive (the EXPAND phase)", () => {
    // The RPC migration is applied to prod BEFORE the frontend deploy, while
    // old bundles still direct-table write. Any table revoke or grant here
    // would break those clients mid-rollout — the whole reason the revokes
    // moved to their own CONTRACT-phase migration. Broad verb-blind form (the
    // same shape as the member_action_log pin): a narrow verb alternation is
    // trivially escaped by `revoke select`, comma-lists led by an unlisted
    // verb, `ON TABLE` syntax, or uppercase SQL.
    expect(statements).not.toMatch(/revoke[^;]*\bon\s+(?:table\s+)?public\.member_[a-z_]+/i);
    expect(statements).not.toMatch(/grant[^;]*\bon\s+(?:table\s+)?public\.member_[a-z_]+\s+to\b/i);
  });

  it("orders the contract phase strictly after the expand phase", () => {
    // FILE-order pin only: it proves the timestamps sort correctly, NOT that
    // any given database applied them in that order or with that gap — MCP
    // apply_migration stamps its own versions, so the apply-order guarantee
    // lives in the contract migration's to_regprocedure precondition guard,
    // pinned below.
    expect(revokesName > migrationName).toBe(true);
    expect(revokeStatements).toMatch(/to_regprocedure\('public\.send_member_message\(uuid, text\)'\) is null/);
    expect(revokeStatements).toContain("raise exception 'apply 20260725000000_atomic_member_write_rpcs (EXPAND phase) first'");
  });

  it.each([
    "revoke insert on public.member_messages from authenticated;",
    "revoke insert, update on public.member_conversations from authenticated;",
    "revoke insert on public.member_cases from authenticated;",
    "revoke insert, update on public.member_ballot_votes from authenticated;",
    "revoke insert, update on public.member_survey_responses from authenticated;",
  ])("contract phase revokes %s", (line) => {
    expect(revokeStatements).toContain(line);
  });

  it("keeps member_action_log client-writable in both phases", () => {
    // saveRightsProgress and requestSteward are deliberately unconverted and
    // still call logAction. The award trigger's prefix anchoring is the defense
    // there, not the grant.
    expect(statements).not.toMatch(/revoke[^;]*on public\.member_action_log/);
    expect(revokeStatements).not.toMatch(/revoke[^;]*on public\.member_action_log/);
  });

  it("column-scopes the UPDATE paths that are still client-owned", () => {
    // Supabase's platform default privileges grant authenticated table-wide
    // UPDATE at CREATE TABLE, so the table bit is revoked and exactly the
    // columns the two surviving client callers write are regranted:
    // markConversationRead -> read_at; updateMemberCase -> status/step/deadline.
    // A table-wide UPDATE would let a member PATCH-forge sender_kind='steward'
    // or overwrite a case's CSPRNG reference after a legit write.
    expect(revokeStatements).toMatch(/revoke update on public\.member_messages from authenticated;/);
    expect(revokeStatements).toMatch(/grant\s+update \(read_at\) on public\.member_messages to authenticated;/);
    expect(revokeStatements).toMatch(/revoke update on public\.member_cases from authenticated;/);
    expect(revokeStatements).toMatch(/grant\s+update \(status, step, deadline\) on public\.member_cases to authenticated;/);
  });

  it("grants no new table reachability beyond narrowing two UPDATE grants", () => {
    // Across BOTH phases, the ONLY `grant ... on public.member_* to ...`
    // statements are the two column-scoped UPDATE regrants that replace
    // Supabase's table-wide default (each preceded by `revoke update ... from
    // authenticated`) — a net reduction, never a new insert/delete/select
    // surface. The collector is deliberately broad (verb-blind, ON TABLE
    // tolerant, case-insensitive, any grantee shape): a collector that
    // under-matches under-collects, and an exact-set pin over an
    // under-collected list silently passes on the grant it missed.
    const tableGrants = (statements + " " + revokeStatements).match(/grant[^;]*\bon\s+(?:table\s+)?public\.member_[a-z_]+\s+to\b[^;]*;/gi) ?? [];
    const norm = tableGrants.map((g) => g.replace(/\s+/g, " "));
    expect(norm.sort()).toEqual(
      [
        "grant update (read_at) on public.member_messages to authenticated;",
        "grant update (status, step, deadline) on public.member_cases to authenticated;",
      ].sort()
    );
    // each is a column-scoped UPDATE only — no unqualified verb, no all/insert/delete/select
    for (const g of norm) {
      expect(g).toMatch(/grant update \([a-z_, ]+\) on/);
    }
  });
});

describe("atomic member write RPCs: migration hygiene (both phases)", () => {
  it("bounds the lock wait like every other migration in this repo", () => {
    expect(sql).toContain("set local lock_timeout = '5s'");
    expect(revokesSql).toContain("set local lock_timeout = '5s'");
  });

  it("carries the reference tag", () => {
    expect(sql).toContain("REQ-UG-ATOMIC-MEMBER-WRITES-20260725");
    expect(revokesSql).toContain("REQ-UG-ATOMIC-MEMBER-WRITES-20260725");
  });

  it("ends by reloading the PostgREST schema cache", () => {
    for (const text of [statements, revokeStatements]) {
      const trimmed = text.replace(/\s+$/, "");
      expect(trimmed.endsWith("notify pgrst, 'reload schema';")).toBe(true);
    }
  });

  it("touches no table, policy, or column", () => {
    expect(statements).not.toMatch(/alter table|drop table|drop policy|drop column|drop trigger|create table/);
    expect(revokeStatements).not.toMatch(/alter table|drop table|drop policy|drop column|drop trigger|create table/);
  });
});
