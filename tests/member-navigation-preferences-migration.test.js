// @vitest-environment node
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { fnBody, loadMigrationSql, stripComments } from "./helpers/migration.js";

const sql = stripComments(loadMigrationSql("member_navigation_preferences"));
const flatSql = sql.replace(/\s+/g, " ");
const executeFixSql = stripComments(loadMigrationSql("member_preference_check_execute")).replace(/\s+/g, " ");
const helper = fnBody(sql, "private.valid_member_preference_keys");
const contract = JSON.parse(readFileSync(new URL("../scripts/db-contract.json", import.meta.url), "utf8"));

describe("member navigation preference persistence", () => {
  it("adds two non-null empty-array profile preferences with named checks", () => {
    expect(sql).toContain("add column shortcut_keys text[] not null default '{}'::text[]");
    expect(sql).toContain("add column work_widget_order text[] not null default '{}'::text[]");
    expect(sql).toContain("constraint member_profiles_shortcut_keys_valid");
    expect(sql).toContain("constraint member_profiles_work_widget_order_valid");
  });

  it("bounds, deduplicates, and allowlists both arrays in the database", () => {
    expect(helper).toContain("cardinality(p_value) <= p_max");
    expect(helper).toContain("array_position(p_value, null) is null");
    expect(helper).toContain("p_value <@ p_allowed");
    expect(helper).toContain("count(distinct key)");
    expect(sql).toContain("'today','numbers','voting','rights','cases','messages','events','rewards','forms','appointments','workload','voice','hub','search','settings','compass'");
    expect(sql).toContain("'messages','appointments','cases','forms','workload','numbers'");
    expect(flatSql).toMatch(/member_profiles_shortcut_keys_valid check \( private\.valid_member_preference_keys\(.+?, 6 \) \)/);
    expect(flatSql).toMatch(/member_profiles_work_widget_order_valid check \( private\.valid_member_preference_keys\(.+?, 6 \) \)/);
  });

  it("keeps writes column-scoped and exposes only the pure check helper", () => {
    expect(flatSql).toContain("grant update (shortcut_keys, work_widget_order) on table public.member_profiles to authenticated");
    expect(sql).not.toMatch(/grant update on (table )?public\.member_profiles/i);
    expect(flatSql).toContain("revoke all on function private.valid_member_preference_keys(text[], text[], integer) from public, anon, authenticated, service_role");
    expect(executeFixSql).toContain("grant execute on function private.valid_member_preference_keys(text[], text[], integer) to authenticated, service_role");
    expect(executeFixSql).not.toMatch(/\bto\s+(public|anon)\b/i);
    expect(sql).not.toMatch(/create policy/i);
  });

  it("registers the helper, both checks, and the widened self-update column contract", () => {
    expect(contract.functions).toContainEqual(expect.objectContaining({
      sig: "private.valid_member_preference_keys(p_value text[], p_allowed text[], p_max integer)",
      secdef: false,
      exec: "authenticated,service_role",
      bodyContains: expect.arrayContaining(["array_position(p_value, null) is null"]),
    }));
    expect(contract.constraints).toContainEqual(expect.objectContaining({
      table: "member_profiles",
      name: "member_profiles_shortcut_keys_valid",
    }));
    expect(contract.constraints).toContainEqual(expect.objectContaining({
      table: "member_profiles",
      name: "member_profiles_work_widget_order_valid",
    }));
    const grant = contract.columnGrants.find((entry) => entry.table === "public.member_profiles" && entry.role === "authenticated" && entry.privilege === "UPDATE");
    expect(grant.columns.split(",")).toEqual(expect.arrayContaining(["shortcut_keys", "work_widget_order"]));
  });
});
