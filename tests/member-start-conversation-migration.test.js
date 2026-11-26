// @vitest-environment node
import { describe, expect, it } from "vitest";
import { fnBody, loadMigrationSql } from "./helpers/migration.js";

const sql = loadMigrationSql("20260810220000_member_start_conversation.sql");
const body = fnBody(sql, "start_member_conversation");

describe("UB-MSG-03 first direct conversation", () => {
  it("requires MFA and bounds the first message without truncation", () => {
    expect(body).toContain("private.mfa_satisfied()");
    expect(body).toContain("char_length(clean_body) not between 1 and 4000");
    expect(body).toContain("errcode = '22023'");
  });

  it("serializes by caller and refuses a second thread without probing another member", () => {
    expect(body).toContain("pg_advisory_xact_lock");
    expect(body).toContain("where c.user_id = caller");
    expect(body).not.toMatch(/p_user|p_conversation/);
  });

  it("creates the shell and first message atomically through the existing sole writer", () => {
    expect(body).toContain("insert into public.member_conversations");
    expect(body).toContain("public.send_member_message(conversation_id, clean_body)");
    expect(body).toContain("'conversationId', conversation_id");
  });

  it("restores no direct table privileges", () => {
    expect(sql).toContain("revoke all on function public.start_member_conversation(text) from public, anon");
    expect(sql).toContain("grant execute on function public.start_member_conversation(text) to authenticated");
    expect(sql).not.toMatch(/grant (insert|update|delete)[^;]*member_(conversations|messages)/i);
  });
});
