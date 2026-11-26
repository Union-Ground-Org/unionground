import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { fnBody } from "./helpers/migration.js";

const file = resolve("supabase/migrations/20260812233000_member_peer_contact_reward.sql");
const sql = readFileSync(file, "utf8").toLowerCase();
const compact = sql.replace(/\s+/g, " ");

describe("im-anyone peer contact reward migration", () => {
  it("derives a non-enumerable own code without storing plaintext codes", () => {
    expect(sql).toContain("create table private.member_peer_contact_secret");
    expect(compact).toContain("extensions.hmac(pg_catalog.convert_to(p_user_id::text");
    expect(compact).toContain("create table public.member_peer_contact_keys");
    expect(compact).toContain("code_digest bytea not null unique");
    expect(sql).not.toMatch(/create table[^;]+\b(?:contact_)?code\s+text/);
    expect(compact).toContain("create function private.member_peer_contact_code(p_user_id uuid)");
  });

  it("keeps tables RPC-only and pins participant-only read policies", () => {
    for (const table of ["member_peer_contact_keys", "member_peer_contact_requests", "member_peer_conversations", "member_peer_messages"]) {
      expect(sql).toContain(`alter table public.${table} enable row level security`);
      expect(sql).toContain(`revoke all on public.${table} from public, anon, authenticated`);
    }
    expect(compact).toContain("requester_id = (select auth.uid()) or recipient_id = (select auth.uid())");
    expect(compact).toContain("user_low = (select auth.uid()) or user_high = (select auth.uid())");
    expect(compact).toContain("exists ( select 1 from public.member_peer_conversations c");
    expect((sql.match(/create policy mfa_assurance on public\.member_peer_/g) || [])).toHaveLength(4);
  });

  it("requires MFA plus a live im-anyone grant on every new request", () => {
    expect(compact).toContain("create function public.request_reward_peer_contact(p_contact_code text)");
    expect(compact).toContain("caller is null or not private.mfa_satisfied()");
    expect(compact).toContain("private.member_reward_effect_enabled(caller, 'im-anyone')");
    expect(compact).toContain("caller_chapter is null or target_chapter is distinct from caller_chapter");
    expect(compact).toContain("extensions.digest( pg_catalog.convert_to(normalized_code, 'utf8'), 'sha256')");
    expect((compact.match(/from public\.member_profiles p where p\.id in \([^)]*\) order by p\.id for share/g) || [])).toHaveLength(2);
  });

  it("uses uniform no-write refusals and enforces both request bounds", () => {
    expect(compact).toContain("performs no write");
    expect(compact).toContain("r.requester_id = caller and r.created_at >= now() - interval '24 hours'");
    expect(compact).toContain("pair requests are limited to one every 14 days");
    expect((sql.match(/'contact request unavailable'/g) || []).length).toBeGreaterThanOrEqual(2);
    expect(sql).not.toContain("member_peer_contact_attempts");
  });

  it("creates messaging only after recipient acceptance and lets accepted threads persist", () => {
    expect(compact).toContain("create function public.respond_reward_peer_contact(p_request_id uuid, p_accept boolean)");
    expect(compact).toContain("where r.id = p_request_id and r.recipient_id = caller and r.status = 'pending'");
    expect(compact).toContain("request_row.chapter_id is distinct from private.current_member_chapter()");
    expect(compact).toContain("p.id = r.requester_id and p.chapter_id = r.chapter_id");
    expect(compact).toContain("insert into public.member_peer_conversations");
    expect(compact).toContain("create function public.send_reward_peer_message(p_conversation_id uuid, p_body text)");
    expect(compact).toContain("pg_catalog.count(*) from public.member_peer_messages m where m.sender_id = caller and m.created_at >= now() - interval '5 minutes'");
    const sendBody = compact.slice(compact.indexOf("create function public.send_reward_peer_message"));
    expect(sendBody).not.toContain("member_reward_effect_enabled(caller, 'im-anyone')");
    expect(compact).toContain("accepted consent survives a later chapter move");
    expect(sql.match(/from public\.member_peer_messages m/g)).toHaveLength(3);
    expect(sql).not.toMatch(/from public\.member_peer_messages m\s+from public\.member_peer_messages m/);
  });

  it("uses a one-way request-to-conversation cascade so account deletion cannot deadlock", () => {
    expect(compact).toContain("created_from_request uuid not null unique references public.member_peer_contact_requests(id) on delete cascade");
    expect(compact).not.toContain("member_peer_contact_requests_conversation_fkey");
    const requestTable = compact.slice(compact.indexOf("create table public.member_peer_contact_requests"), compact.indexOf("create table public.member_peer_conversations"));
    expect(requestTable).not.toContain("conversation_id");
  });

  it("extends the member export with bounded participant-only peer records and one audit path", () => {
    expect(compact).toContain("alter function public.get_member_data_export() rename to member_data_export_without_peer_contact");
    expect(compact).toContain("alter function public.member_data_export_without_peer_contact() set schema private");
    expect(compact).toContain("revoke all on function private.member_data_export_without_peer_contact() from public, anon, authenticated, service_role");
    expect(compact).toContain("create function public.get_member_data_export()");
    expect(compact).toContain("exported := private.member_data_export_without_peer_contact()");
    expect(compact).toContain("r.requester_id = caller or r.recipient_id = caller");
    expect(compact).toContain("c.user_low = caller or c.user_high = caller");
    expect(compact).toContain("m.conversation_id = conversation.id");
    expect(compact).toContain("limit 100");
    expect(compact).toContain("limit 20");
    const exportBody = fnBody(sql, "public.get_member_data_export()");
    for (const forbidden of ["code_digest", "member_peer_contact_code", "auth.users", "member_peer_profile_label"]) {
      expect(exportBody).not.toContain(forbidden);
    }
    expect(exportBody).not.toMatch(/\bemail\b\s*[,)]|\.email\b/);
    expect(exportBody).not.toContain("insert into private.member_account_lifecycle_audit");
  });

  it("exposes only narrow authenticated RPCs", () => {
    for (const signature of [
      "list_reward_peer_contact()",
      "request_reward_peer_contact(text)",
      "respond_reward_peer_contact(uuid, boolean)",
      "send_reward_peer_message(uuid, text)",
    ]) {
      expect(sql).toContain(`revoke all on function public.${signature} from public, anon`);
      expect(sql).toContain(`grant execute on function public.${signature} to authenticated`);
    }
  });

  it("backs experimental-access with active bilingual rows and a fail-closed MFA projection", () => {
    expect(compact).toContain("create table public.member_experimental_content");
    expect(compact).toContain("prompts_en jsonb not null");
    expect(compact).toContain("prompts_es jsonb not null");
    expect(compact).toContain("create function public.list_reward_experimental_content(p_locale text)");
    expect(compact).toContain("caller is null or not private.mfa_satisfied()");
    expect(compact).toContain("not private.member_reward_effect_enabled(caller, 'experimental-access')");
    expect(compact).toContain("where c.active");
    expect(sql).toContain("revoke all on public.member_experimental_content from public, anon, authenticated");
    expect(sql).toContain("revoke all on function public.list_reward_experimental_content(text) from public, anon");
    expect(sql).toContain("grant execute on function public.list_reward_experimental_content(text) to authenticated");
  });
});
