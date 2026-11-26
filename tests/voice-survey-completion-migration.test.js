import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const sql = readFileSync("supabase/migrations/20260828220000_mi1_voice_survey_completion.sql", "utf8").toLowerCase();

function body(signature, nextMarker) {
  const start = sql.indexOf(signature);
  const end = sql.indexOf(nextMarker, start + signature.length);
  expect(start).toBeGreaterThanOrEqual(0);
  expect(end).toBeGreaterThan(start);
  return sql.slice(start, end);
}

describe("MI1 Voice survey completion migration", () => {
  it("extends the current organization survey engine and retains donor provenance", () => {
    expect(sql).toContain("donor-baseline-20260721");
    expect(sql).toContain("alter table public.organization_survey_questions");
    expect(sql).not.toContain("create table public.voice_surveys");
    expect(sql).toContain("client_key");
    expect(sql).toContain("section_title");
    expect(sql).toContain("create function public.get_organization_survey_draft");
  });

  it("persists only same-survey branches to earlier selectable questions", () => {
    expect(sql).toContain("organization_survey_questions_branch_same_survey_fk");
    const replace = body(
      "create or replace function private.mi1_w2_replace_survey_questions",
      "create or replace function private.mi1_w2_project_survey",
    );
    expect(replace).toContain("parent.survey_id = p_survey");
    expect(replace).toContain("parent.sort_index < child.sort_index");
    expect(replace).toContain("branch parent must be an earlier selectable question");
    expect(replace).toContain("'text', 'paragraph', 'radio', 'checkbox', 'dropdown', 'scale', 'rating', 'yes_no'");
  });

  it("validates response types and removes answers hidden by branch state", () => {
    const response = body(
      "create or replace function private.mi1_w2_upsert_survey_session",
      "create or replace function public.export_organization_survey_results",
    );
    expect(response).toContain("delete from public.organization_survey_answers");
    expect(response).toContain("answer is not an available option");
    expect(response).toContain("invalid multiple-choice answer");
    expect(response).toContain("count(distinct selected #>> '{}')");
    expect(response).toContain("required survey questions are missing");
    expect(response).toContain("survey.chapter_id is not null");
  });

  it("keeps report and raw-export output withheld below the configured floor", () => {
    const exported = body(
      "create or replace function public.export_organization_survey_results",
      "alter table public.member_weekly_questions",
    );
    expect(exported).toContain("public.get_organization_survey_report(survey.id)");
    expect(exported).toContain("if not coalesce((report ->> 'available')::boolean, false)");
    expect(exported).toContain("'responses', '[]'::jsonb");
    expect(sql).toContain("privacy floor must be between 3 and 50");
  });

  it("ships the weekly answer-option, editorial, and survey-publication lifecycle", () => {
    expect(sql).toContain("editorial_state in ('submitted', 'reserved', 'published', 'archived')");
    expect(sql).toContain("create function public.submit_weekly_poll_question");
    expect(sql).toContain("create function public.list_weekly_question_editorial");
    expect(sql).toContain("create function public.review_weekly_poll_question");
    expect(sql).toContain("create function public.publish_weekly_poll_question");
    expect(sql).toContain("insert into public.organization_surveys");
    expect(sql).toContain("on conflict (user_id, week_start) do nothing");
    expect(sql).toContain("order by priority desc, score desc, q.created_at, q.id\n      limit 25");
    expect(sql).toContain("answer options must be unique");
    expect(sql).toContain("regexp_replace(coalesce(p_body, ''), '[[:cntrl:]]', ' ', 'g')");
    expect(sql).toContain("clean_options := clean_options || pg_catalog.jsonb_build_array(option_value)");
    expect(sql).toContain("on delete restrict");
    expect(sql).toContain("grant execute on function public.publish_weekly_poll_question(uuid, integer) to authenticated");
  });
});
