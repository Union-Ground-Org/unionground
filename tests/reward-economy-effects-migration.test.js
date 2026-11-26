import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const file = resolve("supabase/migrations/20260812160000_reward_economy_effects.sql");
const sql = readFileSync(file, "utf8").toLowerCase();
const compact = sql.replace(/\s+/g, " ");
const governanceFile = resolve("supabase/migrations/20260812113000_compass_ai_governance.sql");
const quotaUpgradeFile = resolve("supabase/migrations/20260812161000_compass_ai_reward_quota_upgrade.sql");
const governanceSql = readFileSync(governanceFile, "utf8").toLowerCase();
const quotaUpgradeSql = readFileSync(quotaUpgradeFile, "utf8").toLowerCase();
const compactQuotaUpgrade = quotaUpgradeSql.replace(/\s+/g, " ");
const policyHelperSql = readFileSync(
  resolve("supabase/migrations/20260812232000_reward_effect_policy_helper.sql"),
  "utf8",
).toLowerCase().replace(/\s+/g, " ");

const TWELVE_PERKS = [
  "union-swag",
  "homepage-customize",
  "custom-theme",
  "ai-msg-quota-bump",
  "steward-meeting-invite",
  "create-thread",
  "pizza-party",
  "cross-chapter-cards",
  "im-anyone",
  "priority-wq-slot",
  "wq-boost-2x",
  "experimental-access",
];

describe("reward catalog, effects, and economy migration", () => {
  it("restores the exact twelve stable perk keys and retires legacy starter rows", () => {
    for (const key of TWELVE_PERKS) expect(sql).toContain(`'${key}'`);
    expect(sql).toContain("update public.member_reward_items set active = false");
    expect(sql).toContain("on conflict (key) do update");
    expect(sql).toContain("effect_kind");
    for (const kind of ["fulfillment", "cosmetic", "permission", "weekly_question", "ai_quota", "gated_content"]) {
      expect(sql).toContain(`'${kind}'`);
    }
  });

  it("derives revocable effects from a live server-side grant", () => {
    expect(compact).toContain("create function private.member_reward_effect_enabled(p_user_id uuid, p_effect_key text)");
    expect(compact).toContain("g.status in ('granted', 'shipped', 'delivered')");
    expect(compact).toContain("i.active");
    expect(compact).toContain("create function public.get_member_reward_effects()");
    expect(compact).toContain("where g.user_id = caller");
    expect(sql).toContain("revoke all on function public.get_member_reward_effects() from public, anon");
    expect(sql).toContain("grant execute on function public.get_member_reward_effects() to authenticated");
  });

  it("lets authenticated RLS evaluate only the boolean reward-effect helper", () => {
    expect(policyHelperSql).toContain("grant execute on function private.member_reward_effect_enabled(uuid, text) to authenticated");
    expect(policyHelperSql).toContain("revoke all on function private.member_reward_effect_enabled(uuid, text) from public, anon");
    expect(policyHelperSql).not.toMatch(/grant\s+(select|insert|update|delete|truncate|references|trigger)\b/i);
  });

  it("preserves attained tiers when an admin tunes thresholds", () => {
    expect(sql).toContain("create table public.member_reward_tier_attainment");
    expect(sql).toContain("create trigger member_point_events_preserve_tier");
    expect(compact).toContain("create function public.save_reward_tier(p_tier smallint, p_name text, p_min_points integer)");
    expect(compact).toContain("insert into public.member_reward_tier_attainment");
    expect(compact).toContain("greatest(public.member_reward_tier_attainment.highest_tier, excluded.highest_tier)");
  });

  it("keeps economy writes admin plus MFA, atomic, validated, and append-only audited", () => {
    expect(sql).toContain("create table public.member_reward_economy_revisions");
    expect(compact).toContain("create function private.assert_reward_economy_admin()");
    expect(compact).toContain("public.member_has_role(array['admin'])");
    expect(compact).toContain("private.mfa_satisfied()");
    expect(sql).toContain("create function public.get_admin_reward_economy()");
    expect(sql).toContain("create function public.save_reward_point_rule(");
    expect(sql).toContain("create function public.save_reward_tier(");
    expect(sql).toContain("create function public.save_reward_item(");
    expect(compact).toContain("p_min_tier is null or p_min_tier not between 1 and 5");
    expect(sql).toContain("revoke all on public.member_reward_economy_revisions from public, anon, authenticated");
    expect(sql).toContain("grant select on public.member_reward_economy_revisions to authenticated");
  });

  it("keeps form-template point amounts row-backed", () => {
    expect(compact).toContain("select points from public.form_templates where key = p_template_key");
    expect(sql).toContain("private.form_points");
  });

  it("adds the AI quota perk through a forward-only upgrade of both governed checks", () => {
    expect(compact).toContain("create or replace function private.compass_ai_reward_quota_bonus(p_user_id uuid)");
    expect(compact).toContain("private.member_reward_effect_enabled(p_user_id, 'ai-msg-quota-bump')");

    // Keep the already-recordable governance migration immutable. Databases
    // that applied it before rewards existed converge through 161000 instead
    // of silently retaining its old function bodies.
    expect(governanceSql).not.toContain("compass_ai_reward_quota_bonus");
    expect(compactQuotaUpgrade).toContain("create or replace function public.reserve_compass_ai_request(");
    expect(compactQuotaUpgrade).toContain("create or replace function public.authorize_compass_ai_dispatch(");
    const uses = quotaUpgradeSql.match(/private\.compass_ai_reward_quota_bonus\(p_user_id\)/g) || [];
    expect(uses).toHaveLength(2);
    expect(compactQuotaUpgrade).toContain("least( 200, effective_limit + private.compass_ai_reward_quota_bonus(p_user_id) )");
    expect(quotaUpgradeSql).toContain("recent_global_count >= 200");
    expect(quotaUpgradeSql).not.toMatch(/p_(bonus|quota|reward)/);
  });

  it("backs cross-chapter cards and weekly questions with bounded server workflows", () => {
    expect(compact).toContain("create function public.get_reward_cross_chapter_cards(p_locale text)");
    expect(compact).toContain("r.is_published and r.kind = 'chapter'");
    expect(compact).toContain("private.member_reward_effect_enabled(caller, 'cross-chapter-cards')");
    expect(compact).toContain("create table public.member_weekly_questions");
    expect(compact).toContain("create table public.member_weekly_question_supports");
    expect(compact).toContain("unique (user_id, week_start)");
    expect(compact).toContain("create function public.list_weekly_questions()");
    expect(compact).toContain("create function public.submit_weekly_question(p_body text)");
    expect(compact).toContain("create function public.boost_weekly_question(p_question_id uuid)");
    expect(compact).toContain("private.member_reward_effect_enabled(q.user_id, 'priority-wq-slot')");
    expect(compact).toContain("private.member_reward_effect_enabled(s.user_id, 'wq-boost-2x') then 2");
    expect(compact).toContain("limit 25");
    expect(sql).toContain("revoke all on public.member_weekly_questions from public, anon, authenticated");
    expect(sql).toContain("revoke all on public.member_weekly_question_supports from public, anon, authenticated");
  });
});
