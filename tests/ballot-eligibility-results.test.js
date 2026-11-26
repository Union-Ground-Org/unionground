// Ballot eligibility + published results (UB-VOTE-03 / UB-VOTE-02, migration
// 20260809010000). Three layers, same shape as ballot-secrecy.test.js:
//
//   1. Migration text — the eligibility column and the two scoped read
//      policies that replace the org-wide catalog reads. get_ballot_tally's
//      publication gate is pinned against the newest defining migration in
//      the "publication gate" block; the 20260809010000 body is kept only as
//      a labelled historical generation.
//   2. db-contract co-pins — the renamed policies with non-trivial quals, the
//      ballot catalogs OUT of the unconditional-policy allowlist, and the
//      eligibility needle on submit_ballot_vote.
//   3. Client source — the loader attaches per-option results only on closed
//      ballots, and never invents a voter-linked read to do it.
//
// The submit_ballot_vote body pins for this generation live in
// tests/atomic-member-write-rpcs.test.js (which extracts from the newest
// re-create); the choices-count-source generation scan lives in
// tests/ballot-secrecy.test.js. Neither is duplicated here.
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { findMigrationName, fnBody, latestFnBody, loadMigrationSql, migrationFiles, stripComments } from "./helpers/migration.js";
import { localeSource } from "./helpers/locale-sources.js";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const sql = loadMigrationSql("ballot_eligibility_and_results");
const statements = stripComments(sql).replace(/\s+/g, " ").trim();
const contract = JSON.parse(readFileSync(resolve(repoRoot, "scripts/db-contract.json"), "utf8"));
const memberApiSrc = readFileSync(resolve(repoRoot, "src/lib/memberApi.js"), "utf8");
const sessionLoaderSrc = readFileSync(resolve(repoRoot, "src/lib/memberSessionLoader.js"), "utf8");
// English catalogue sources, then the on-demand Spanish ones (barrel plus area modules).
const i18nSrc = localeSource("en") + localeSource("es");

// The LAST migration that re-creates one of these routines is the live
// definition; pins below read that, not the generation the older sections pin.
// latestFnBody scans comment-stripped SQL and honours drops, so a later file
// that only names the routine in a comment or drops it cannot pose as the
// definer. `file` is the newest migration whose executable text carries that
// exact body. migrationFiles() resolves from this module, not the process
// working directory.
const allMigrations = migrationFiles();
const newestBody = (name) => {
  const body = latestFnBody(name);
  const declaring = allMigrations.filter((entry) => stripComments(entry.sql).includes(body));
  if (declaring.length === 0) throw new Error(`${name} has no migration carrying its live body`);
  return { file: declaring[declaring.length - 1].name, body };
};

const ELIGIBILITY = "chapter_id is null or chapter_id = private.current_member_chapter()";

describe("migration: eligibility model (UB-VOTE-03)", () => {
  it("adds a nullable chapter FK to member_ballots — null stays union-wide", () => {
    expect(statements).toContain(
      "alter table public.member_ballots add column chapter_id text references public.chapters(id) on delete set null;",
    );
    // Nullable by construction: any NOT NULL here would instantly re-scope the
    // three live union-wide ballots out from under every member.
    expect(statements).not.toMatch(/chapter_id text[^;]*not null/);
  });

  it("replaces the org-wide ballot read with the eligibility-scoped policy", () => {
    expect(statements).toContain("drop policy member_ballots_read_authenticated on public.member_ballots;");
    expect(statements).toContain("create policy member_ballots_read_eligible on public.member_ballots");
    expect(statements).toContain(`using (${ELIGIBILITY})`);
  });

  it("scopes option reads through the parent ballot — labels must not leak what the ballot row hides", () => {
    expect(statements).toContain("drop policy member_ballot_options_read_authenticated on public.member_ballot_options;");
    expect(statements).toContain("create policy member_ballot_options_read_eligible on public.member_ballot_options");
    const policyAt = statements.indexOf("member_ballot_options_read_eligible");
    const scopeAt = statements.indexOf("b.chapter_id is null or b.chapter_id = private.current_member_chapter()", policyAt);
    expect(scopeAt).toBeGreaterThan(policyAt);
  });

  it("adds no DDL, policy, or grant on member_ballot_choices — eligibility must not create a voter-linkage surface (UB-VOTE-04)", () => {
    // The submit body's anonymous choices INSERT is the one legitimate mention;
    // what may never appear is anything that reshapes the table or opens a
    // read on it.
    expect(statements).not.toMatch(/alter table public\.member_ballot_choices/);
    expect(statements).not.toMatch(/create (unique )?index[^;]*member_ballot_choices/);
    expect(statements).not.toMatch(/create policy[^;]*on public\.member_ballot_choices/);
    expect(statements).not.toMatch(/grant[^;]*on (table )?public\.member_ballot_choices/);
  });
});

// Historical generation only. get_ballot_tally was re-created after
// 20260809010000 (20260812140000, 20260924160000, 20260925030300), so these
// pins describe what that file shipped, not what Postgres runs. The live gate
// is pinned in the "publication gate" block below.
describe("migration (historical 20260809010000, superseded): published results (UB-VOTE-02)", () => {
  const tallyFn = fnBody(sql, "public.get_ballot_tally(p_ballot_id text)");
  const tallyStatements = stripComments(tallyFn).replace(/\s+/g, " ").trim();

  it("(historical) is not the live get_ballot_tally definition", () => {
    const live = newestBody("get_ballot_tally");
    expect(live.file > findMigrationName("ballot_eligibility_and_results")).toBe(true);
    expect(live.body).not.toBe(stripComments(tallyFn));
  });

  it("(historical) emitted the per-option breakdown once closed by flag OR by time — never while voting is open", () => {
    expect(tallyStatements).toContain("if (not ballot.active) or ballot.closes_at <= now() then");
    // The old inactive-only gate must be gone: nothing flips active=false at
    // close, so that gate alone starved the member client forever.
    expect(tallyStatements).not.toMatch(/if not ballot\.active then/);
  });

  it("(historical) applied the chapter eligibility predicate to the tally lookup — no turnout oracle for hidden ballots", () => {
    expect(tallyStatements).toContain(ELIGIBILITY);
  });

  it("(historical) counted choices under the definer/search_path armor", () => {
    expect(tallyStatements).toContain("from public.member_ballot_choices where ballot_id = ballot.id;");
    expect(tallyFn).toContain("security definer");
    expect(tallyFn).toContain("set search_path = ''");
  });
});

describe("db-contract co-pins", () => {
  it("pins both eligibility policies with non-trivial quals and drops the org-wide names", () => {
    const ballots = contract.policies.find((entry) => entry.table === "member_ballots" && entry.cmd === "r");
    const options = contract.policies.find((entry) => entry.table === "member_ballot_options" && entry.cmd === "r");
    // Since SEC-UG-CROSS-TENANT-VOTE-CAMPAIGNS-20260920 the chapter
    // eligibility (and the owning organization) lives in
    // private.can_read_vote_campaign, which the database contract pins.
    expect(ballots.name).toBe("member_ballots_read_eligible");
    expect(ballots.qual).toContain("private.can_read_vote_campaign(organization_id, chapter_id)");
    expect(options.name).toBe("member_ballot_options_read_eligible");
    expect(options.qual).toContain("private.can_read_vote_campaign(b.organization_id, b.chapter_id)");
    const reader = contract.functions.find((entry) => entry.sig.startsWith("private.can_read_vote_campaign("));
    expect(reader.bodyContains).toContain("p_chapter_id = private.current_member_chapter()");
    const names = JSON.stringify(contract.policies);
    expect(names).not.toContain("member_ballots_read_authenticated");
    expect(names).not.toContain("member_ballot_options_read_authenticated");
  });

  it("removes the two ballot catalogs from the unconditional-policy allowlist", () => {
    const allowlist = contract.policyCoverage.unconditionalPolicyAllowlist;
    expect(allowlist).not.toContain("member_ballots.member_ballots_read_authenticated");
    expect(allowlist).not.toContain("member_ballot_options.member_ballot_options_read_authenticated");
    expect(allowlist.some((entry) => entry.startsWith("member_ballots."))).toBe(false);
    expect(allowlist.some((entry) => entry.startsWith("member_ballot_options."))).toBe(false);
  });

  it("needles the eligibility predicate into the submit_ballot_vote body pin", () => {
    const fn = contract.functions.find((entry) => entry.sig.startsWith("public.submit_ballot_vote("));
    expect(fn.bodyContains).toContain("private.can_read_vote_campaign(b.organization_id, b.chapter_id)");
  });
});

describe("publication gate (BUG-UG-BALLOT-RESULTS-NEVER-PUBLISH-AT-CLOSE-20260920)", () => {
  const newestTally = newestBody("get_ballot_tally");
  const newestSweep = newestBody("private.ballot_notice_sweep");
  const newestSubmit = newestBody("submit_ballot_vote");
  const tallyCode = stripComments(newestTally.body).replace(/\s+/g, " ").trim();
  const sweepCode = stripComments(newestSweep.body).replace(/\s+/g, " ").trim();
  const submitCode = stripComments(newestSubmit.body).replace(/\s+/g, " ").trim();

  it("keeps both live routines at or after the publication-gate repair", () => {
    expect(newestTally.file > "20260812140000_staff_campaign_authoring.sql").toBe(true);
    expect(newestSweep.file > "20260809020000_notifications_wave.sql").toBe(true);
    const publicationGate = findMigrationName("ballot_results_publication_gate");
    expect(newestTally.file >= publicationGate).toBe(true);
    expect(newestSweep.file >= publicationGate).toBe(true);
  });

  it("makes get_ballot_tally's counts branch the literal complement of submit_ballot_vote's refusal", () => {
    // Vote admission refuses exactly here ...
    expect(submitCode).toContain(
      "if not ballot.active or ballot.closes_at <= now() then raise exception 'this ballot is closed' using errcode = '22023';",
    );
    // ... so readability of the counts starts at the same predicate.
    expect(tallyCode).toContain("if not ballot.active or ballot.closes_at <= now() then");
    // The staff-only state must gate nothing: it is written by nothing but
    // close_vote_campaign, which is exactly the indefinite stall this repairs.
    expect(tallyCode).not.toContain("campaign_state = 'closed'");
  });

  it("keeps the tally's draft filter and owner-bounded eligibility untouched by the gate change", () => {
    expect(tallyCode).toContain("campaign_state <> 'draft'");
    // SEC-UG-CROSS-TENANT-VOTE-CAMPAIGNS-20260920 (20260924160000) moved the
    // chapter eligibility into the owner-bounded reader; the gate re-creation
    // must carry that bound, not the older chapter-only predicate.
    expect(tallyCode).toContain("private.can_read_vote_campaign(organization_id, chapter_id)");
    expect(tallyCode).not.toContain(ELIGIBILITY);
    expect(tallyCode).toContain("from public.member_ballot_choices where ballot_id = ballot.id;");
    expect(newestTally.body).toMatch(/security\s+definer/i);
    expect(newestTally.body).toMatch(/set\s+search_path\s+(?:=|to)\s+''/i);
  });

  // option_counts is assigned exactly once, inside the publication branch,
  // and the draft filter and owner-bounded read run before that branch.
  const PUBLICATION_GATE = "if not ballot.active or ballot.closes_at <= now() then";
  const countsOnlyBehindGate = (code) => {
    const gateAt = code.indexOf(PUBLICATION_GATE);
    const assigns = [...code.matchAll(/\binto option_counts\b/g)].map((match) => match.index);
    const endIfAt = gateAt === -1 ? -1 : code.indexOf("end if;", gateAt);
    return gateAt > -1
      && assigns.length === 1
      && assigns[0] > gateAt
      && assigns[0] < endIfAt
      && code.indexOf("campaign_state <> 'draft'") > -1
      && code.indexOf("campaign_state <> 'draft'") < gateAt
      && code.indexOf("private.can_read_vote_campaign(organization_id, chapter_id)") > -1
      && code.indexOf("private.can_read_vote_campaign(organization_id, chapter_id)") < gateAt;
  };

  it("populates option_counts only inside the publication branch of the live body", () => {
    expect(countsOnlyBehindGate(tallyCode)).toBe(true);
  });

  it("rejects bodies that publish counts through another branch or before the gate", () => {
    const staffClosed = stripComments(fnBody(loadMigrationSql("staff_campaign_authoring"), "public.get_ballot_tally(p_ballot_id text)"))
      .replace(/\s+/g, " ").trim();
    expect(staffClosed).toContain("if ballot.campaign_state = 'closed' then");
    expect(countsOnlyBehindGate(staffClosed)).toBe(false);

    const ungated = tallyCode.replace(PUBLICATION_GATE, "if true then");
    expect(ungated).not.toBe(tallyCode);
    expect(countsOnlyBehindGate(ungated)).toBe(false);

    const early = tallyCode.replace(
      "select count(*) into total",
      "select '[]'::jsonb into option_counts; select count(*) into total",
    );
    expect(early).not.toBe(tallyCode);
    expect(countsOnlyBehindGate(early)).toBe(false);
  });

  it("excludes drafts from the results sweep so a draft never announces or consumes the notice", () => {
    const resultsLoop = sweepCode.slice(sweepCode.indexOf("results_notice_sent_at is null"));
    expect(resultsLoop).toContain("bl.campaign_state <> 'draft'");
    expect(resultsLoop).toContain("(not bl.active or bl.closes_at <= now())");
    // The sweep may only notice ballots the tally actually reads: same draft
    // filter, same complement predicate.
    expect(resultsLoop).not.toContain("vote.opened");
  });

  // DOCS-UG-BALLOT-NOTICE-SWEEP-STALE-TALLY-COMMENT-20260921: the results
  // loop's comment names the tally gate the notice relies on. Read it from the
  // migration that carries the live sweep and hold every gate it claims
  // against the live tally's counts predicate, so a later tally change cannot
  // leave the comment describing a gate that no longer exists.
  const resultsNoticeComment = (sql) => {
    const lines = fnBody(sql, "private.ballot_notice_sweep()").split("\n");
    let at = lines.findIndex((line) => line.includes("results_notice_sent_at is null"));
    while (at > 0 && !/^\s*for b in\s*$/.test(lines[at])) at -= 1;
    const comment = [];
    for (let index = at - 1; index >= 0 && /^\s*--/.test(lines[index]); index -= 1) {
      comment.unshift(lines[index].replace(/^\s*--\s?/, ""));
    }
    return comment.join(" ").replace(/\s+/g, " ").trim();
  };
  const tallyCountsGate = (code) => code.match(/\bif ([^;]+?) then select coalesce\(pg_catalog\.jsonb_agg\(/)?.[1] ?? "";
  const unimplementedGateClaims = (text, gate) => [
    ...(/\binactive\b/i.test(text) && !gate.includes("not ballot.active") ? ["inactive"] : []),
    ...(/\bcloses_at passed\b/i.test(text) && !gate.includes("ballot.closes_at <= now()") ? ["closes_at passed"] : []),
  ];

  it("keeps the results-notice comment and contract note to the gate the live tally implements", () => {
    const liveSweepSql = allMigrations.find((entry) => entry.name === newestSweep.file).sql;
    const comment = resultsNoticeComment(liveSweepSql);
    const gate = tallyCountsGate(tallyCode);
    expect(comment).toContain("get_ballot_tally");
    expect(gate, "live get_ballot_tally has no counts branch to compare against").not.toBe("");
    expect(unimplementedGateClaims(comment, gate)).toEqual([]);
    const sweepNote = contract.functions.find((entry) => entry.sig === "private.ballot_notice_sweep()").note;
    expect(unimplementedGateClaims(sweepNote, gate)).toEqual([]);
  });

  it("flags the stale pairing the record found: the 20260809020000 comment over the staff-closed tally", () => {
    const staleComment = resultsNoticeComment(loadMigrationSql("notifications_wave"));
    const staffClosedGate = tallyCountsGate(
      stripComments(fnBody(loadMigrationSql("staff_campaign_authoring"), "public.get_ballot_tally(p_ballot_id text)"))
        .replace(/\s+/g, " ").trim(),
    );
    expect(staleComment).toContain("inactive OR closes_at passed");
    expect(staffClosedGate).toBe("ballot.campaign_state = 'closed'");
    expect(unimplementedGateClaims(staleComment, staffClosedGate)).toEqual(["inactive", "closes_at passed"]);
  });

  it("clears stale results_notice_sent_at on remaining drafts so a later real close can still notify", () => {
    const gateSql = stripComments(loadMigrationSql("ballot_results_publication_gate")).replace(/\s+/g, " ");
    expect(gateSql).toContain("campaign_state = 'draft'");
    expect(gateSql).toContain("set results_notice_sent_at = null");
  });

  it("re-arms elapsed published open campaigns so the first readable tally still notifies", () => {
    const gateSql = stripComments(loadMigrationSql("ballot_results_publication_gate")).replace(/\s+/g, " ");
    expect(gateSql).toContain("campaign_state = 'open'");
    expect(gateSql).toContain("published_at is not null");
    expect(gateSql).toContain("closes_at <= now()");
  });

  it("updates the staff-campaign rollback-only proof to expect clock publication", () => {
    const proof = readFileSync(resolve(repoRoot, "scripts/verify-staff-campaign-authoring.sql"), "utf8");
    const proofCode = stripComments(proof).replace(/\s+/g, " ");
    expect(proofCode).toContain("if not ballot.active or ballot.closes_at <= now() then");
    expect(proofCode).toContain("elapsed open ballot did not publish option totals");
    expect(proof).not.toContain("elapsed open ballot released results before explicit close");
    expect(proof).not.toContain("that alone must not");
  });

  it("carries the case-graph lock across the sweep re-creation (account-deletion wrap, 20260907151000)", () => {
    expect(sweepCode).toContain("perform private.lock_case_graph(array[auth.uid()], array[]::uuid[]);");
  });

  it("co-pins the new gate in the db contract, positive and negative", () => {
    const tally = contract.functions.find((entry) => entry.sig === "public.get_ballot_tally(p_ballot_id text)");
    expect(tally.bodyContains).toContain("not ballot.active or ballot.closes_at <= now()");
    expect(tally.bodyContains).toContain("campaign_state <> 'draft'");
    expect(tally.bodyForbids).toContain("ballot.campaign_state = 'closed'");
    expect(tally.bodyContains).toContain("private.can_read_vote_campaign(organization_id, chapter_id)");
    const sweep = contract.functions.find((entry) => entry.sig === "private.ballot_notice_sweep()");
    expect(sweep.bodyContains).toContain("bl.campaign_state <> 'draft'");
  });

  it("states the member copy in both locales as publishing when voting closes, not on a staff action", () => {
    // English block.
    expect(i18nSrc).toContain("Results publish to every eligible worker when voting closes");
    expect(i18nSrc).toContain("at the scheduled closing time or when staff close the ballot");
    expect(i18nSrc).toContain("Results publish when voting closes");
    // Spanish block.
    expect(i18nSrc).toContain("Los resultados se publican a todos los trabajadores elegibles al cerrar la votación");
    expect(i18nSrc).toContain("ya sea al pasar la hora programada o si el personal cierra la boleta antes");
    expect(i18nSrc).toContain("Los resultados se publican al cerrar la votación");
    // The old hedged copy is gone from both locales.
    expect(i18nSrc).not.toContain("within 24 hours of polls closing");
    expect(i18nSrc).not.toContain("dentro de las 24 horas del cierre");
    expect(i18nSrc).not.toContain("the moment a ballot's closing time passes");
  });
});

describe("client: results reach the member only after close", () => {
  it("treats the server's options emission as the publication decision, and folds it into closure truth", () => {
    // get_ballot_tally emits options only for closed ballots on database
    // time, so the array's presence is authoritative — no local clock gate in
    // front of it, and a shipped array closes the item even when this
    // device's clock lags ( finding 4).
    expect(memberApiSrc).toMatch(/const results = Array\.isArray\(tally\?\.options\) \? tally\.options\.map/);
    expect(memberApiSrc).toMatch(/const closed = ballot\.active === false \|\| Boolean\(results\) \|\| isClosed\(ballot\.closes_at\);/);
  });

  it("fetches every ballot state — flag-closed ballots must reach their results (sol #728 finding 3)", () => {
    expect(memberApiSrc).not.toMatch(/member_ballots[^\n]*\.eq\("active", true\)/);
  });

  it("still never reads the anonymous choices table from the client", () => {
    // Same guard ballot-secrecy.test.js carries for the loader: results come
    // from get_ballot_tally's aggregate, never a per-row read.
    expect(memberApiSrc).not.toMatch(/from\(\s*["']member_ballot_choices["']/);
  });

  it("ships closes_at through as closesAt so close context renders without a second read", () => {
    expect(memberApiSrc).toContain("closesAt: ballot.closes_at,");
  });

  it("refetches member_ballots and get_ballot_tally when the clock gate opens or a votes notice arrives", () => {
    expect(sessionLoaderSrc).toContain("armBallotPublicationWatch");
    expect(sessionLoaderSrc).toContain("table:member_ballots");
    expect(sessionLoaderSrc).toContain("rpc:get_ballot_tally");
    expect(sessionLoaderSrc).toContain("row.kind === \"votes\"");
  });
});
