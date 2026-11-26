// @vitest-environment node
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { loadMigrationSql, stripComments } from "./helpers/migration.js";

// Text pins are a tripwire, not a proof: they assert what THIS MIGRATION SAYS,
// not what the database ENDS UP WITH. Current-state truth lives in
// scripts/db-contract.json, checked by `npm run verify:db` (constraint
// existence, convalidated, and the exact pg_get_constraintdef rendering).
// REQ-UG-QUORUM-COMPOSITE-FK-20260725.

const sql = loadMigrationSql("quorum_composite_fk");
// Negative pins run against comment-stripped SQL (house discipline): a comment
// mentioning ON DELETE or GRANT must not satisfy — or trip — a pin about what
// the statements actually do.
const statements = stripComments(sql);
// The ballot half of the invariant moved WITH the choice store: the
// ballot-secrecy migration (20260808230000, UB-VOTE-04) empties
// member_ballot_votes and re-attaches the same option-belongs-to-THIS-ballot
// composite FK to public.member_ballot_choices. The 20260725210000 pins above
// stay — they document what that file SAYS, and its text never changes.
const secrecy = loadMigrationSql("ballot_secrecy_unlinkable_votes");
const contract = JSON.parse(readFileSync(new URL("../scripts/db-contract.json", import.meta.url), "utf8"));
const memberApi = readFileSync(new URL("../src/lib/memberApi.js", import.meta.url), "utf8");

describe("quorum composite FK migration", () => {
  it("adds the UNIQUE targets the composite FKs need (options PKs are single-column)", () => {
    expect(sql).toContain("add constraint member_ballot_options_id_ballot_id_key unique (id, ballot_id)");
    expect(sql).toContain("add constraint member_survey_options_id_survey_id_key unique (id, survey_id)");
  });

  it("attaches both composite FKs not valid, then validates each by name", () => {
    expect(sql).toContain("add constraint member_ballot_votes_option_in_ballot_fkey");
    expect(sql).toContain("foreign key (option_id, ballot_id) references public.member_ballot_options(id, ballot_id)");
    expect(sql).toContain("validate constraint member_ballot_votes_option_in_ballot_fkey");
    expect(sql).toContain("add constraint member_survey_responses_option_in_survey_fkey");
    expect(sql).toContain("foreign key (option_id, survey_id) references public.member_survey_options(id, survey_id)");
    expect(sql).toContain("validate constraint member_survey_responses_option_in_survey_fkey");
    expect(sql.match(/not valid/g), "both FKs attach phased").toHaveLength(2);
  });

  it("refuses loudly on poisoned rows before constraining", () => {
    expect(sql).toContain("pair an option from another ballot");
    expect(sql).toContain("pair an option from another survey");
    expect(sql).toContain("o.ballot_id <> v.ballot_id");
    expect(sql).toContain("o.survey_id <> r.survey_id");
  });

  it("adds the invariant and nothing else: no drops, no grants, no function bodies", () => {
    expect(statements).not.toMatch(/drop constraint/i);
    expect(statements).not.toMatch(/^\s*(grant|revoke)\s/im);
    expect(statements).not.toMatch(/create (or replace )?function/i);
    expect(statements, "existing RESTRICT/CASCADE delete semantics stay with the original FKs").not.toMatch(/on delete/i);
  });

  it("records all four new constraints in the db contract, validated", () => {
    const byName = new Map(contract.constraints.map((entry) => [entry.name, entry]));
    for (const [name, needle] of [
      ["member_ballot_options_id_ballot_id_key", "UNIQUE (id, ballot_id)"],
      ["member_ballot_votes_option_in_ballot_fkey", "FOREIGN KEY (option_id, ballot_id) REFERENCES member_ballot_options(id, ballot_id)"],
      ["member_survey_options_id_survey_id_key", "UNIQUE (id, survey_id)"],
      ["member_survey_responses_option_in_survey_fkey", "FOREIGN KEY (option_id, survey_id) REFERENCES member_survey_options(id, survey_id)"],
    ]) {
      const entry = byName.get(name);
      expect(entry, `${name} must be in contract.constraints`).toBeTruthy();
      expect(entry.convalidated, `${name} must assert convalidated — NOT VALID forever would be invisible in SQL text`).toBe(true);
      expect(entry.defContains, `${name} needle`).toContain(needle);
    }
  });

  // Suffix-append guard (quorum-FK review, CONFIRMED): the composite-FK
  // needles end at the referenced column list, so a re-created composite FK
  // with an appended ON DELETE CASCADE would stay green by substring match.
  // That append is only harmful if the single-column RESTRICT FKs stop
  // blocking option deletes first — so the delete semantics of all four
  // original FKs are pinned in the contract, ON DELETE tails included.
  it("pins the pre-existing single-column FKs' delete semantics in the contract", () => {
    const byName = new Map(contract.constraints.map((entry) => [entry.name, entry]));
    for (const [name, needle] of [
      ["member_ballot_votes_ballot_id_fkey", "FOREIGN KEY (ballot_id) REFERENCES member_ballots(id) ON DELETE CASCADE"],
      ["member_ballot_votes_option_id_fkey", "FOREIGN KEY (option_id) REFERENCES member_ballot_options(id) ON DELETE RESTRICT"],
      ["member_survey_responses_survey_id_fkey", "FOREIGN KEY (survey_id) REFERENCES member_surveys(id) ON DELETE CASCADE"],
      ["member_survey_responses_option_id_fkey", "FOREIGN KEY (option_id) REFERENCES member_survey_options(id) ON DELETE RESTRICT"],
    ]) {
      const entry = byName.get(name);
      expect(entry, `${name} must be in contract.constraints`).toBeTruthy();
      expect(entry.convalidated, `${name} convalidated`).toBe(true);
      expect(entry.defContains, `${name} must pin the ON DELETE action, not just the column pair`).toContain(needle);
    }
  });

  // The composite FK is a SECOND PostgREST relationship between the votes and
  // options tables; an embed across that pair now fails at runtime (PGRST201)
  // unless disambiguated. The guard scans every supabase-js-bearing source
  // tree, quote-agnostically: the ONLY embed of each options table anywhere in
  // src/, api/ and scripts/ must be the sanctioned parent one (ballots →
  // options, surveys → options), which the positive pins identify exactly.
  it("repo-wide, options tables are embedded exactly once — from their parent, never from votes", () => {
    const root = fileURLToPath(new URL("..", import.meta.url));
    const files = [];
    const walk = (dir) => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        if (entry.name === "node_modules" || entry.name.startsWith(".")) continue;
        const full = join(dir, entry.name);
        if (entry.isDirectory()) walk(full);
        else if (/\.(js|jsx|mjs|ts|tsx)$/.test(entry.name)) files.push(full);
      }
    };
    for (const dir of ["src", "api", "scripts"]) walk(join(root, dir));
    const sources = files.map((file) => readFileSync(file, "utf8")).join("\n");
    expect(sources.match(/member_ballot_options\(/g) ?? [], "one sanctioned ballots→options embed").toHaveLength(1);
    expect(sources.match(/member_survey_options\(/g) ?? [], "one sanctioned surveys→options embed").toHaveLength(1);
    // Parent and option fields are explicit because campaign authorship is an
    // audit-only field: a wildcard parent read would turn a harmless schema
    // addition into member-visible metadata. Keep the one sanctioned embed,
    // but pin it to the same column-scoped catalog grant as the migration.
    expect(memberApi).toContain('client.from("member_ballots").select("id,title,title_es,body,body_es,closes_at,active,order_index,quorum_target,chapter_id,campaign_state,published_at,closed_at,member_ballot_options(id,ballot_id,label,label_es,order_index)")');
    expect(memberApi).toContain('client.from("member_surveys").select("id,title,title_es,body,body_es,closes_at,active,order_index,chapter_id,campaign_state,published_at,closed_at,member_survey_options(id,survey_id,label,label_es,order_index)")');
    // Ballot secrecy (20260808230000): the votes table is emptied and headed
    // for the follow-up drop, so the client reads NEITHER ballot storage table
    // any more — participation renders from get_member_dashboard/receipts and
    // the write path is the submit_ballot_vote RPC alone. The old sanctioned
    // `member_ballot_votes` read is GONE from the set.
    expect(memberApi).not.toContain("member_ballot_votes");
    // Quoted-literal form: memberApi's ballot loader comment legitimately
    // EXPLAINS the choice store; no client code may name it as a table.
    expect(memberApi, "the anonymous choice store is server-only").not.toMatch(/["'`]member_ballot_choices["'`]/);
    expect(memberApi).toContain('client.from("member_survey_responses").select("survey_id,option_id")');
  });

  it("re-attaches the same cross-ballot invariant to the anonymous choice store", () => {
    expect(secrecy).toContain("add constraint member_ballot_choices_option_in_ballot_fkey");
    expect(secrecy).toContain("foreign key (option_id, ballot_id) references public.member_ballot_options(id, ballot_id)");
    // The composite target UNIQUE (id, ballot_id) added by THIS migration is
    // what the new FK references — the choices table needs no fresh target.
    expect(secrecy).toContain("create index member_ballot_choices_ballot_option_idx");
    expect(secrecy).toContain("on public.member_ballot_choices (ballot_id, option_id)");
  });
});
