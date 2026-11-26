// @vitest-environment node
import { describe, expect, it } from "vitest";
import { fnBody, loadMigrationSql, stripComments } from "./helpers/migration.js";

const sql = loadMigrationSql("20260826154000_mi1_qa_delivery_repairs");

function body(name) {
  return stripComments(fnBody(sql, name));
}

describe("CR-018 Q&A delivery repairs", () => {
  it("projects ownership without disclosing author identifiers", () => {
    const projector = body("private.mi1_qa_project_question");
    expect(projector).toContain("'authoredByMe', q.author_user_id = p_actor");
    expect(projector).toContain("'authoredByMe', r.author_user_id = p_actor");
    expect(projector).not.toContain("'authorId'");
    expect(projector).toContain("limited.deleted_at is null");
    expect(projector).toContain("limit 100");
  });

  it("toggles accepted answers and audits both transitions", () => {
    const accept = body("public.accept_member_qa_answer");
    expect(accept).toContain("question.accepted_reply_id is not distinct from reply.id");
    expect(accept).toContain("'qa_answer_unaccepted'");
    expect(accept).toContain("'qa_answer_accepted'");
    expect(accept).toContain("reply.kind is distinct from 'official'");
    expect(accept).toContain("question.author_user_id is distinct from (select auth.uid())");
    expect(accept).toContain("private.mi1_qa_is_officer(question.organization_id, question.chapter_id)");
  });

  it("keeps the repaired definer private except for authenticated execution", () => {
    const code = stripComments(sql);
    expect(body("private.mi1_qa_project_question")).toContain("set search_path = ''");
    expect(body("public.accept_member_qa_answer")).toContain("set search_path = ''");
    expect(code).toContain("revoke all on function private.mi1_qa_project_question(uuid, uuid)");
    expect(code).toContain("revoke all on function public.accept_member_qa_answer(uuid, uuid) from public, anon");
    expect(code).toContain("grant execute on function public.accept_member_qa_answer(uuid, uuid) to authenticated");
  });
});
