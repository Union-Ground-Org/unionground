// @vitest-environment node
import { describe, expect, it } from "vitest";
import { fnBody, loadMigrationSql, stripComments } from "./helpers/migration.js";

const sql = loadMigrationSql("staff_campaign_authoring");
const code = stripComments(sql).replace(/\s+/g, " ");

describe("staff campaign authoring migration (UB-VOTE-01)", () => {
  it("adds an explicit lifecycle, bilingual copy, authorship, and survey eligibility", () => {
    for (const table of ["member_ballots", "member_surveys"]) {
      expect(code).toContain(`alter table public.${table}`);
    }
    expect(code).toMatch(/campaign_state text not null[^;]+draft[^;]+open[^;]+closed/);
    expect(code).toMatch(/member_surveys[^;]+chapter_id text references public\.chapters/);
    expect(code).toContain("add column title_es text");
    expect(code).toContain("add column created_by uuid references auth.users(id) on delete set null");
    expect(code).toContain("add column published_at timestamptz");
    expect(code).toContain("add column closed_at timestamptz");
    expect(code).toContain("add column label_es text");
    expect(code).toMatch(/member_ballots_campaign_state_active_check[^;]+campaign_state = 'open'[^;]+active/);
    expect(code).toMatch(/member_surveys_campaign_state_active_check[^;]+campaign_state = 'open'[^;]+active/);
  });

  it("publishes only four armored RPCs and keeps campaign DML out of the browser", () => {
    for (const [name, signature] of [
      ["get_staff_vote_campaigns", "get_staff_vote_campaigns()"],
      ["save_vote_campaign_draft", "save_vote_campaign_draft(text, text, text, text, text, timestamptz, integer, text, text, jsonb)"],
      ["publish_vote_campaign", "publish_vote_campaign(text, text)"],
      ["close_vote_campaign", "close_vote_campaign(text, text)"],
    ]) {
      const body = fnBody(sql, name);
      expect(body).toContain("security definer");
      expect(body).toContain("set search_path = ''");
      expect(code).toContain(`revoke all on function public.${signature} from public, anon`);
      expect(code).toContain(`grant execute on function public.${signature} to authenticated`);
    }
    expect(code).toContain("revoke insert, update, delete on public.member_ballots, public.member_ballot_options from authenticated");
    expect(code).toContain("revoke insert, update, delete on public.member_surveys, public.member_survey_options from authenticated");
    expect(code).toContain("revoke select on public.member_ballots, public.member_surveys from authenticated");
    const memberCatalogGrant = code.match(/grant select \([^)]+\) on public\.member_ballots to authenticated/)?.[0] || "";
    expect(memberCatalogGrant).toContain("campaign_state");
    expect(memberCatalogGrant).not.toContain("created_by");
  });

  it("derives chapter scope and limits union scope to org-wide admin/president", () => {
    const save = fnBody(sql, "save_vote_campaign_draft");
    expect(save).toContain("private.current_member_chapter()");
    expect(save).toContain("public.member_has_role(array['steward', 'coordinator', 'advisor', 'admin', 'vp'])");
    expect(save).toMatch(/r\.chapter_id is null or r\.chapter_id = caller_chapter/);
    expect(save).toMatch(/p_scope = 'union'[\s\S]+r\.role in \('admin', 'vp'\)[\s\S]+r\.chapter_id is null/);
    expect(save).not.toMatch(/p_chapter_id/);
    expect(save).toContain("p_kind is null or p_kind not in ('ballot', 'pulse')");
    expect(save).toContain("coalesce(pg_catalog.jsonb_typeof(p_options), '') <> 'array'");
  });

  it("makes member reads lifecycle- and eligibility-aware", () => {
    expect(code).toMatch(/member_ballots_read_eligible[\s\S]+campaign_state <> 'draft'/);
    expect(code).toMatch(/member_surveys_read_eligible[\s\S]+campaign_state <> 'draft'/);
    expect(code).toMatch(/member_surveys_read_eligible[\s\S]+chapter_id is null or chapter_id = private\.current_member_chapter\(\)/);
    const survey = fnBody(sql, "submit_survey_response");
    expect(survey).toContain("s.campaign_state = 'open'");
    expect(survey).toContain("s.chapter_id is null or s.chapter_id = private.current_member_chapter()");
    const tally = fnBody(sql, "get_ballot_tally");
    expect(tally).toContain("if ballot.campaign_state = 'closed' then");
    expect(tally).not.toMatch(/ballot\.closes_at <= now\(\)/);
  });

  it("keeps published content immutable and transitions under a row lock", () => {
    const save = fnBody(sql, "save_vote_campaign_draft");
    expect(save).toContain("campaign_state = 'draft'");
    for (const name of ["publish_vote_campaign", "close_vote_campaign"]) {
      const body = fnBody(sql, name);
      expect(body).toContain("for update");
      expect(body).toContain("member_admin_audit");
    }
    for (const action of ["create_campaign", "update_campaign_draft", "publish_campaign", "close_campaign"]) {
      expect(code).toContain(`'${action}'`);
    }
  });

  it("accepts organization role grants in both vote-scope branches after the 20260921 repair", () => {
    const repair = loadMigrationSql("vote_campaign_authority_organization_grants");
    const scope = fnBody(repair, "private.can_manage_vote_scope");
    const save = fnBody(repair, "save_vote_campaign_draft");
    expect(scope).toContain("private.has_organization_role(");
    expect(scope).toContain("private.member_has_chapter_role(");
    expect(scope).toContain("from public.member_roles r");
    expect(scope).toMatch(
      /p_chapter_id is null then[\s\S]+private\.has_organization_role\([\s\S]+current_member_chapter\(\)[\s\S]+private\.member_has_chapter_role\(/,
    );
    expect(save).toContain("private.can_manage_vote_scope(null)");
    expect(save).toContain("private.can_manage_vote_scope(caller_chapter)");
    expect(save).toMatch(
      /\nbegin\n {2}perform private\.lock_case_graph\(array\[auth\.uid\(\)\], array\[\]::uuid\[\]\);\n\ndeclare\n/,
    );
    expect(save).not.toMatch(/exists \(\s*select 1 from public\.member_roles/i);
  });

  it("does not reshape or expose anonymous ballot choices", () => {
    expect(code).not.toMatch(/alter table public\.member_ballot_choices/);
    expect(code).not.toMatch(/create policy[^;]+member_ballot_choices/);
    expect(code).not.toMatch(/grant[^;]+member_ballot_choices/);
    const vote = fnBody(sql, "submit_ballot_vote");
    expect(vote).toContain("insert into public.member_ballot_choices (ballot_id, option_id, stress_run_id)");
    const insertColumns = vote.match(/insert into public\.member_ballot_choices \(([^)]+)\)/)?.[1] || "";
    expect(insertColumns).not.toContain("user_id");
  });
});
