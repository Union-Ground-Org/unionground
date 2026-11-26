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
// redefined by this migration and earlier ones -- the bodies pinned below are
// the current generation only until the next rewrite.

const sql = loadMigrationSql("chapter_model_foundation");
const memberApi = readFileSync(new URL("../src/lib/memberApi.js", import.meta.url), "utf8");
const body = (functionName, source = sql) => fnBody(source, functionName);

describe("chapters reference table", () => {
  it("is read-only reference data for authenticated clients", () => {
    expect(sql).toContain("alter table public.chapters enable row level security");
    expect(sql).toContain("create policy chapters_select_all on public.chapters");
    expect(sql).toContain("revoke all on public.chapters from anon, authenticated");
    expect(sql).toContain("grant select on public.chapters to authenticated");
    expect(sql, "chapters must never be client-writable").not.toMatch(
      /grant [^;]*(insert|update|delete)[^;]*on public\.chapters[^;]*to (anon|authenticated)/i,
    );
  });

  it("seeds the five canon chapters with a single enforced default", () => {
    for (const slug of ["'wor'", "'bos'", "'spr'", "'law'", "'nbd'"]) {
      expect(sql, `${slug} must be seeded`).toContain(slug);
    }
    expect(sql).toContain("create unique index chapters_one_default_idx on public.chapters (is_default) where is_default");
    const defaults = sql.match(/\('\w+', '[^']+', true, \d\)/g) || [];
    expect(defaults, "exactly one seeded default chapter").toHaveLength(1);
    expect(defaults[0]).toContain("'wor'");
  });
});

describe("member_profiles chapter column", () => {
  it("backfills by constant default, never by UPDATE", () => {
    expect(sql).toContain("add column chapter_id text default 'wor'");
    expect(sql, "metadata-only backfill: no data-modifying statement").not.toMatch(
      /update\s+public\.member_profiles\s+set/i,
    );
  });

  it("attaches the FK not valid and defers validation + index to the phased section", () => {
    expect(sql).toContain("add constraint member_profiles_chapter_id_fkey");
    expect(sql).toContain("references public.chapters(id) not valid");
    const phased = sql.slice(sql.indexOf("-- 10. Phase B/C"));
    expect(phased, "VALIDATE must live in the phased apply section").toContain("validate constraint member_profiles_chapter_id_fkey");
    expect(phased, "index must live in the phased apply section").toContain("create index member_profiles_chapter_idx on public.member_profiles(chapter_id)");
  });

  it("locks chapter_id out of the member self-update surface", () => {
    expect(sql).toContain("revoke update on public.member_profiles from authenticated");
    const grantStart = sql.indexOf("grant update (");
    expect(grantStart, "column-scoped self-update grant must exist").toBeGreaterThan(-1);
    const grant = sql.slice(grantStart, sql.indexOf(";", grantStart));
    expect(grant).toContain("on public.member_profiles to authenticated");
    expect(grant, "self-update must exclude the steward-scoping column").not.toContain("chapter_id");
    for (const column of ["first_name", "full_name", "initials", "role_line", "member_since", "language", "notification_prefs"]) {
      expect(grant, `${column} must stay self-writable`).toContain(column);
    }
  });
});

describe("member_roles chapter scope and role model", () => {
  it("adds a nullable chapter scope with the org-wide NULL sentinel", () => {
    expect(sql).toContain(
      "alter table public.member_roles\n  add column chapter_id text references public.chapters(id) on delete set null",
    );
  });

  it("widens the role CHECK to the five-hat superset", () => {
    expect(sql).toContain("drop constraint member_roles_role_check");
    expect(sql).toContain("check (role in ('steward', 'coordinator', 'advisor', 'admin', 'vp'))");
  });

  it("adds no client write path to member_roles", () => {
    expect(sql, "roles must stay service-side only").not.toMatch(
      /grant [^;]*(insert|update|delete)[^;]*on public\.member_roles[^;]*to (anon|authenticated)/i,
    );
  });
});

describe("staff_can_see_user scope helper", () => {
  it("is a pinned-path definer with the legacy-preserving org-wide branch", () => {
    const helper = body("staff_can_see_user");
    expect(helper).toContain("security definer");
    expect(helper).toContain("set search_path = ''");
    expect(helper, "NULL chapter_id must mean org-wide (legacy behavior)").toContain("r.chapter_id is null");
    expect(helper).toContain("r.role = p_role");
    expect(helper).toContain("(select auth.uid())");
  });

  it("resolves cosigner scope through the definer form-owner hop", () => {
    const hop = body("form_owner_in_steward_scope");
    expect(hop).toContain("security definer");
    expect(hop).toContain("set search_path = ''");
    expect(hop).toContain("public.staff_can_see_user(f.user_id, 'steward')");
    expect(hop, "missing form must be indistinguishable from out-of-scope").toContain("coalesce");
    expect(hop).toContain("false)");
  });
});

describe("new-member chapter resolution", () => {
  it("validates the metadata slug against chapters and falls back to the default", () => {
    const fn = body("private.handle_new_member");
    expect(fn).toContain("nullif(new.raw_user_meta_data ->> 'chapter_id', '')");
    expect(fn).toContain("not exists (select 1 from public.chapters where id = member_chapter)");
    expect(fn).toContain("select id into member_chapter from public.chapters where is_default limit 1");
    expect(fn).toContain("insert into public.member_profiles (id, first_name, full_name, initials, chapter_id)");
  });

  it("keeps every prior seed insert intact", () => {
    const fn = body("private.handle_new_member");
    expect(fn).toContain("insert into public.member_notifications");
    expect(fn).toContain("insert into public.member_conversations");
    expect(fn).toContain("insert into public.member_messages");
    expect(fn).toContain("insert into public.member_cases");
    expect(fn).toContain("insert into public.member_rights_progress");
    expect(fn).toContain("insert into public.member_action_log");
    expect(fn).toContain("'seed-tuesday'");
    expect(fn).toContain("'Chapter steward'");
  });
});

describe("steward read policies route through the chapter gate", () => {
  it("recreates all six steward-facing policies on the scope helper", () => {
    for (const [policy, predicate] of [
      ["member_steward_requests_select_steward", "public.staff_can_see_user(user_id, 'steward')"],
      ["member_conversations_select_steward", "public.staff_can_see_user(user_id, 'steward')"],
      ["member_messages_select_steward", "public.staff_can_see_user(user_id, 'steward')"],
      ["member_profiles_select_steward", "public.staff_can_see_user(id, 'steward')"],
      ["member_forms_select_steward", "public.staff_can_see_user(user_id, 'steward')"],
      ["member_form_cosigners_select_steward", "public.form_owner_in_steward_scope(form_id)"],
    ]) {
      expect(sql, `${policy} must be dropped before recreation`).toContain(`drop policy ${policy}`);
      const start = sql.indexOf(`create policy ${policy}`);
      expect(start, `${policy} must be recreated`).toBeGreaterThan(-1);
      const clause = sql.slice(start, sql.indexOf(";", start));
      expect(clause, `${policy} must scope through the helper`).toContain(predicate);
    }
  });

  it("keeps the forms policy status-bounded and the cosigner policy accepted-only", () => {
    const forms = sql.slice(sql.indexOf("create policy member_forms_select_steward"));
    expect(forms.slice(0, forms.indexOf(";"))).toContain("status in ('submitted', 'in_review')");
    const cosigners = sql.slice(sql.indexOf("create policy member_form_cosigners_select_steward"));
    const cosignersClause = cosigners.slice(0, cosigners.indexOf(";"));
    expect(cosignersClause).toContain("status = 'accepted'");
    expect(cosignersClause).toContain("public.form_is_alliance_reviewable(form_id)");
  });

  it("widens no additional tables beyond the original steward surface", () => {
    for (const table of ["member_cases", "member_case_updates", "member_ballot_votes", "member_survey_responses", "member_action_log", "member_notifications", "member_workload_logs"]) {
      expect(sql, `${table} must stay self-scoped`).not.toContain(`create policy ${table}_select_steward`);
    }
    const policySection = sql.slice(sql.indexOf("-- 6. Steward read policies"), sql.indexOf("-- 7. Steward write RPCs"));
    expect(policySection, "policies must not touch identity columns").not.toContain("full_name");
  });
});

describe("steward write RPCs verify target scope", () => {
  it("folds the scope predicate into triage without an existence oracle", () => {
    const triage = body("triage_steward_request");
    expect(triage).toContain("member_has_role(array['steward'])");
    expect(triage).toContain("where id = p_request_id and status = 'requested'");
    expect(triage).toContain("where id = p_request_id and status in ('requested', 'acknowledged')");
    const acknowledgeBranch = triage.slice(triage.indexOf("'acknowledge'"), triage.indexOf("elsif"));
    expect(acknowledgeBranch).toContain("public.staff_can_see_user(user_id, 'steward')");
    const closeBranch = triage.slice(triage.indexOf("elsif"), triage.indexOf("else"));
    expect(closeBranch).toContain("public.staff_can_see_user(user_id, 'steward')");
    expect(triage).toContain("get diagnostics updated = row_count");
  });

  it("scopes the reply lookup and preserves the multiline-safe body", () => {
    const reply = body("send_steward_reply");
    expect(reply).toContain("member_has_role(array['steward'])");
    expect(reply).toContain("public.staff_can_see_user(user_id, 'steward')");
    expect(reply).toContain("chr(10) || pg_catalog.chr(13) || pg_catalog.chr(9)");
    expect(reply).not.toContain("member_action_log");
    expect(reply).not.toContain("full_name");
    expect(reply).toContain("'Chapter steward'");
  });
});

describe("get_steward_chapter_member_count", () => {
  it("is a role-gated definer returning counts only", () => {
    const fn = body("get_steward_chapter_member_count");
    expect(fn).toContain("security definer");
    expect(fn).toContain("set search_path = ''");
    expect(fn).toContain("member_has_role(array['steward'])");
    expect(fn).toContain("errcode = '42501'");
    expect(fn).toContain("count(*)::integer");
    expect(fn, "counts only, never profile columns").not.toContain("full_name");
  });
});

describe("function grants", () => {
  it("revokes then grants every new or changed function", () => {
    for (const fn of [
      "public.staff_can_see_user(uuid, text)",
      "public.form_owner_in_steward_scope(uuid)",
      "public.get_steward_chapter_member_count()",
      "public.triage_steward_request(uuid, text)",
      "public.send_steward_reply(uuid, text)",
    ]) {
      expect(sql).toContain(`revoke all on function ${fn} from public, anon`);
      expect(sql).toContain(`grant execute on function ${fn} to authenticated`);
    }
    expect(sql).toContain("revoke all on function private.handle_new_member() from public, anon, authenticated");
  });
});

describe("client chapter threading", () => {
  it("loads chapters fail-soft and maps the profile chapter", () => {
    expect(memberApi).toContain('client.from("chapters").select("id,name").order("order_index")');
    expect(memberApi).toContain("chapterId: profile.chapter_id || \"\"");
    expect(memberApi).toContain("chapterNameById.get(profile.chapter_id) || profile.chapter_id || \"\"");
  });

  it("prefers the numeric Steward scope count and identifies an estimated fallback", () => {
    const deskStart = memberApi.indexOf("export async function loadStewardDesk");
    const desk = memberApi.slice(deskStart, memberApi.indexOf("export async function triageStewardRequest"));
    const kpis = memberApi.slice(memberApi.indexOf("function stewardDeskKpis("), deskStart);

    expect(desk).toContain('client.rpc("get_steward_chapter_member_count")');
    expect(desk).toContain('{ count: "estimated", head: true }');
    expect(desk).toContain("stewardDeskKpis(kpis, scopedMembers, estimated)");
    expect(desk).toContain("stewardDeskKpis(requests[3], scopedMembers, requests[5])");
    expect(kpis).toContain('const exact = typeof scopedMembers === "number"');
    expect(kpis).toMatch(/const membersCovered = exact \? scopedMembers\s*:\s*softFailed\(estimated, "Member head count"\) \? null : estimated\.count \?\? null/);
    expect(kpis).toContain("!exact && membersCovered !== null ? { membersCoveredIsEstimate: true } : {}");
    expect(kpis.match(/\.\.\.coverage/g)).toHaveLength(2);
  });
});
