import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const MIGRATION = "20260917144000_casework_macros_case_note_mentions.sql";
const sql = readFileSync(join(ROOT, "supabase", "migrations", MIGRATION), "utf8");

// The source of every claim below: these are the RPCs the coordinator console
// calls, and the properties that make them safe to call in a batch.
const RPCS = [
  "casework_save_macro",
  "casework_list_macros",
  "casework_apply_macro",
  "casework_add_case_note",
  "list_case_note_mention_candidates",
];

describe("casework macros and case note mentions", () => {
  it("ships as one centrally named additive migration with the house preamble", () => {
    const matches = readdirSync(join(ROOT, "supabase", "migrations"))
      .filter((name) => name.includes("casework_macros_case_note_mentions"));
    expect(matches).toEqual([MIGRATION]);
    expect(sql.trimStart().startsWith("--")).toBe(true);
    expect(sql).toContain("set local lock_timeout");
    expect(sql).toContain("set local statement_timeout");
    expect(sql.trimEnd().endsWith("commit;")).toBe(true);
    expect(sql).toContain("notify pgrst, 'reload schema';");
  });

  it("locks the macro table deny-by-default with MFA and read-only grants", () => {
    expect(sql).toContain("create table public.casework_macros");
    expect(sql).toContain("alter table public.casework_macros enable row level security");
    expect(sql).toMatch(/create policy mfa_assurance on public\.casework_macros\s+as restrictive/);
    expect(sql).toMatch(/revoke all on table public\.casework_macros from public, anon, authenticated/);
    expect(sql).toMatch(/grant select on table public\.casework_macros to authenticated/);
    // Writes go through the RPCs, never straight at the table.
    expect(sql).not.toMatch(/grant [^;]*(insert|update|delete)[^;]*on table public\.casework_macros/i);
    for (const policy of ["casework_macros_staff_read", "casework_macros_admin_insert", "casework_macros_admin_update", "casework_macros_admin_delete", "mfa_assurance"]) {
      const comment = new RegExp(`comment on policy ${policy} on public\\.casework_macros\\s+is\\s+'([^']{20,})'`, "i");
      expect(sql, `${policy} needs an explaining comment`).toMatch(comment);
    }
  });

  it("validates macro actions in an immutable function because a CHECK cannot hold a subquery", () => {
    expect(sql).toMatch(/function private\.casework_macro_actions_valid\(p_actions jsonb\)[\s\S]*?immutable/);
    expect(sql).toContain("casework_macros_actions_shaped");
    for (const kind of ["advance_step", "set_status", "assign", "add_note", "add_alert"]) {
      expect(sql).toContain(`'${kind}'`);
    }
  });

  it("gates every new RPC on MFA and grants execute to authenticated only", () => {
    for (const rpc of RPCS) {
      expect(sql).toContain(`function public.${rpc}(`);
      expect(sql).toMatch(new RegExp(`function public\\.${rpc}\\([\\s\\S]*?security definer\\s+set search_path = ''`, "i"));
      expect(sql).toMatch(new RegExp(`revoke all on function public\\.${rpc}\\(`, "i"));
      expect(sql).toMatch(new RegExp(`grant execute on function public\\.${rpc}\\(`, "i"));
      expect(sql).not.toMatch(new RegExp(`grant execute on function public\\.${rpc}\\([^)]*\\) to [^;]*anon`, "i"));
    }
    expect(sql.match(/perform private\.casework_require_mfa\(\);/g)?.length).toBeGreaterThanOrEqual(3);
  });

  it("applies each macro action through an existing audited routine, never a raw case update", () => {
    const start = sql.indexOf("function public.casework_apply_macro(");
    const body = sql.slice(start, sql.indexOf("$macro$;", start));
    for (const routine of [
      "public.casework_advance_step(",
      "public.casework_bulk_update_cases(",
      "public.assign_member_case(",
      "public.coordinator_add_case_note(",
    ]) expect(body, `${routine} must be the path for its action kind`).toContain(routine);
    expect(body).not.toMatch(/update\s+public\.member_cases\b/i);
    // One audit row per action per case, plus the replay guard that makes a
    // re-submitted batch a no-op rather than a second set of side effects.
    expect(body).toContain("insert into public.casework_audit_events");
    expect(body).toContain("'macro_applied'");
    expect(body).toContain("pg_catalog.md5(");
    expect(body).toContain("'operationId'");
    expect(body).toContain("v_skipped");
    // The batch bound matches the client's SELECTION_LIMIT.
    expect(body).toContain("not between 1 and 100");
  });

  it("refuses a mention the author may not address and blocks member-written mentions", () => {
    expect(sql).toContain("alter table public.member_case_updates");
    expect(sql).toContain("mentioned_user_ids uuid[] not null default '{}'::uuid[]");
    expect(sql).toContain("member_case_updates_mentions_bounded");
    // The member-facing insert policy is narrowed so a member cannot post a
    // note that notifies staff it names.
    expect(sql).toMatch(/create policy member_case_updates_insert_own[\s\S]*?mentioned_user_ids = '\{\}'::uuid\[\]/);
    expect(sql).toMatch(/comment on policy member_case_updates_insert_own on public\.member_case_updates\s+is\s+'[^']{20,}'/i);
    const start = sql.indexOf("function public.casework_add_case_note(");
    const body = sql.slice(start, sql.indexOf("$note$;", start));
    expect(body).toContain("23514");
    expect(body).toContain("private.notify_member(");
    expect(body).toContain("'case.note.mention'");
    expect(body).toContain("'note_mentioned'");
  });

  it("ships EN and ES notification copy for the mention, disclosing no case detail", () => {
    const copy = sql.slice(sql.indexOf("private.notification_copy"));
    for (const lang of ["'en'", "'es'"]) expect(copy).toContain(lang);
    expect(copy).toMatch(/mentioned you on a case note/i);
    expect(copy).toMatch(/te mencionó en una nota de caso/i);
    // Shoulder-surfing rule: the body sends the reader to the console, it does
    // not repeat the note, the member, or the case reference.
    expect(copy).not.toMatch(/\{(body|reference|case|member)\}/i);
  });

  it("keeps the timeline RPC invoker-scoped so RLS decides whether a mention resolves", () => {
    const start = sql.indexOf("create function public.list_case_latest_updates(");
    const body = sql.slice(start, sql.indexOf("$updates$;", start));
    expect(body).toContain("security invoker");
    expect(body).not.toContain("security definer");
    expect(body).toContain("from public.member_profiles p");
    expect(body).toContain("'[]'::jsonb");
    expect(sql).toMatch(/revoke all on function public\.list_case_latest_updates\(uuid\[\], integer\) from public, anon/);
  });

  it("carries no credentials, tenant data, or seeded organizations", () => {
    // The only service_role mention is the grant list this migration carries
    // forward verbatim when it recreates list_case_latest_updates; nothing new
    // is handed to it.
    expect(sql.match(/service_role/gi)).toEqual(["service_role"]);
    expect(sql).toContain("grant execute on function public.list_case_latest_updates(uuid[], integer) to authenticated, service_role;");
    expect(sql).not.toMatch(/supabase_url|supabase_key|project_ref/i);
    expect(sql).not.toMatch(/insert\s+into\s+public\.(organizations|chapters|member_profiles)/i);
    expect(sql).not.toMatch(/[\w.+-]+@[\w-]+\.[a-z]{2,}/i);
  });
});
