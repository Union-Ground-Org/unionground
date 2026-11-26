// @vitest-environment node
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { fnBody, loadMigrationSql } from "./helpers/migration.js";

// Text pins are a tripwire, not a proof: they assert what THIS MIGRATION SAYS,
// not what the database ENDS UP WITH. A later create-or-replace can supersede
// every guard below and this file stays green. Current-state truth lives in
// scripts/db-contract.json, checked by `npm run verify:db`.
//
// Superseded here: send_steward_reply and triage_steward_request, both
// redefined by 20260722002517_allow_multiline_steward_bodies and again by
// 20260723040000_chapter_model_foundation.

const sql = loadMigrationSql("steward_roles_triage_and_broadcast_authoring");
const memberApi = readFileSync(new URL("../src/lib/memberApi.js", import.meta.url), "utf8");
const body = (functionName, source = sql) => fnBody(source, functionName);

describe("steward migration security invariants", () => {
  it("keeps member_roles service-side only", () => {
    expect(sql).toContain("alter table public.member_roles enable row level security");
    expect(sql).toContain("revoke all on public.member_roles from anon, authenticated");
    expect(sql).toContain("grant select on public.member_roles to authenticated");
    expect(sql, "roles must never be client-writable").not.toMatch(
      /grant [^;]*(insert|update|delete)[^;]*on public\.member_roles[^;]*to (anon|authenticated)/i,
    );
  });

  it("hardens the role helper as a pinned-path definer", () => {
    const helper = body("member_has_role");
    expect(helper).toContain("security definer");
    expect(helper).toContain("set search_path = ''");
  });

  it("guards every steward RPC with the role check", () => {
    for (const fn of ["triage_steward_request", "send_steward_reply", "publish_member_broadcast", "retract_member_broadcast", "get_broadcast_read_counts"]) {
      expect(body(fn), `${fn} must check the steward role`).toContain("member_has_role(array['steward'])");
      expect(body(fn), `${fn} must pin search_path`).toContain("set search_path = ''");
    }
  });

  it("keeps steward replies out of the point economy and off the profile name", () => {
    const reply = body("send_steward_reply");
    expect(reply).not.toContain("member_action_log");
    expect(reply).not.toContain("full_name");
    expect(reply).toContain("'Chapter steward'");
  });

  it("rate-caps and validates broadcast publishing", () => {
    const publish = body("publish_member_broadcast");
    expect(publish).toContain("broadcast limit reached");
    expect(publish).toContain("interval '24 hours'");
    expect(publish).toContain("char_length(clean_title) > 120");
    expect(publish).toContain("char_length(clean_body) > 4000");
    expect(publish).toContain("'Chapter steward'");
    expect(publish).not.toContain("full_name");
  });

  it("makes triage a forward-only conditional update", () => {
    const triage = body("triage_steward_request");
    expect(triage).toContain("where id = p_request_id and status = 'requested'");
    expect(triage).toContain("where id = p_request_id and status in ('requested', 'acknowledged')");
    expect(triage).toContain("get diagnostics updated = row_count");
    expect(sql, "no client update path on steward requests").not.toMatch(
      /grant [^;]*(update|delete)[^;]*on public\.member_steward_requests[^;]*to (anon|authenticated)/i,
    );
  });

  it("widens steward reads on exactly four tables", () => {
    const policies = sql.match(/create policy (\w+_select_steward)/g) || [];
    expect(policies.sort()).toEqual([
      "create policy member_conversations_select_steward",
      "create policy member_messages_select_steward",
      "create policy member_profiles_select_steward",
      "create policy member_steward_requests_select_steward",
    ]);
    for (const table of ["member_cases", "member_case_updates", "member_ballot_votes", "member_ballot_receipts", "member_point_events", "member_survey_responses", "member_guide_messages", "member_action_log"]) {
      expect(sql, `${table} must stay self-scoped`).not.toContain(`create policy ${table}_select_steward`);
    }
  });

  it("hides the triaging steward identity from member reads", () => {
    expect(sql).toContain("revoke select on public.member_steward_requests from authenticated");
    expect(sql).toContain("grant select (id, user_id, lesson_id, status, created_at, acknowledged_at, closed_at) on public.member_steward_requests to authenticated");
  });

  it("returns broadcast engagement as counts only, never reader identities", () => {
    const counts = body("get_broadcast_read_counts");
    expect(counts).not.toContain("user_id");
    expect(counts).toContain("readCount");
  });

  it("accepts CRLF textarea bodies in the corrected reply and publish RPCs", () => {
    const corrective = loadMigrationSql("allow_multiline_steward_bodies");
    const strippedSet = "chr(10) || pg_catalog.chr(13) || pg_catalog.chr(9)";
    const replyBody = corrective.slice(corrective.indexOf("send_steward_reply"), corrective.indexOf("publish_member_broadcast"));
    const publishBody = corrective.slice(corrective.indexOf("create or replace function public.publish_member_broadcast"));
    expect(replyBody, "reply strips CR before the control-char reject").toContain(strippedSet);
    expect(publishBody, "publish strips CR before the control-char reject").toContain(strippedSet);
    expect(replyBody).not.toContain("member_action_log");
    expect(replyBody).toContain("member_has_role(array['steward'])");
    expect(publishBody).toContain("member_has_role(array['steward'])");
    expect(publishBody).toContain("broadcast limit reached");
  });

  it("keeps broadcast writes definer-only", () => {
    expect(sql, "no client insert path on broadcasts").not.toMatch(
      /grant [^;]*(insert|update|delete)[^;]*on public\.member_broadcasts[^;]*to (anon|authenticated)/i,
    );
  });
});

describe("member surface stays self-scoped despite steward policies", () => {
  it("filters every widened table explicitly in loadMemberApp", () => {
    expect(memberApi).toContain('client.from("member_profiles").select("*").eq("id", user.id).single()');
    expect(memberApi).toContain('client.from("member_conversations").select("*").eq("user_id", user.id)');
    expect(memberApi).toContain('client.from("member_messages").select("*").eq("user_id", user.id)');
    expect(memberApi).toContain('client.from("member_steward_requests").select("id,lesson_id,status,created_at").eq("user_id", user.id)');
    expect(memberApi).toContain('client.from("member_broadcast_receipts").select("broadcast_id,read_at").eq("user_id", user.id)');
  });

  it("bounds the member broadcast feed and hides retracted rows", () => {
    expect(memberApi).toContain('.is("retracted_at", null).order("published_at", { ascending: false }).limit(50)');
  });

  it("keeps the steward desk off presence and identity columns", () => {
    const deskStart = memberApi.indexOf("export async function loadStewardDesk");
    expect(deskStart).toBeGreaterThan(-1);
    const desk = memberApi.slice(deskStart);
    expect(desk).not.toContain("read_at");
    expect(desk).not.toContain("handled_by");
    expect(desk).not.toContain("created_by");
  });
});
