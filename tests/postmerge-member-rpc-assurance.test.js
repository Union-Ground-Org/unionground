// @vitest-environment node
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { fnBody, latestFnBody, loadMigrationSql, migrationNames, stripComments } from "./helpers/migration.js";

const MIGRATION = "20260813204500_postmerge_member_rpc_assurance.sql";
const source = loadMigrationSql(MIGRATION);
const sql = stripComments(source).toLowerCase().replace(/\s+/g, " ");
const body = fnBody(source, "public.get_member_rewards_summary").toLowerCase().replace(/\s+/g, " ");
const contract = JSON.parse(readFileSync(resolve(import.meta.dirname, "../scripts/db-contract.json"), "utf8"));

describe("post-merge member RPC assurance", () => {
  it("uses a unique migration version", () => {
    expect(migrationNames().filter((name) => name.endsWith("_postmerge_member_rpc_assurance.sql"))).toEqual([MIGRATION]);
  });

  it("restores only the caller's rewards summary through a locked definer", () => {
    expect(body).toContain("security definer");
    expect(body).toContain("set search_path = ''");
    expect(body).toContain("caller uuid := (select auth.uid())");
    expect(body).toContain("from public.member_point_events where user_id = caller");
    expect(body).toContain("private.member_tier_of(caller)");
    expect(body).toContain("from public.member_action_log where user_id = caller");
    expect(body).toContain("where user_id = caller and occurred_at >= year_start");
    expect(body).not.toMatch(/p_(user|member)/);
  });

  it("keeps anonymous execution revoked and pins the live contract", () => {
    expect(sql).toContain("revoke all on function public.get_member_rewards_summary() from public, anon, authenticated");
    expect(sql).toContain("grant execute on function public.get_member_rewards_summary() to authenticated");
    expect(sql).toContain("grant execute on function public.get_member_rewards_summary() to service_role");
    const entry = contract.functions.find((item) => item.sig === "public.get_member_rewards_summary()");
    // The live function needs definer access only for the caller's referral count.
    const installed = latestFnBody("public.get_member_rewards_summary").toLowerCase().replace(/\s+/g, " ");
    expect(entry).toMatchObject({ secdef: true, exec: "authenticated,service_role" });
    expect(installed).toContain("security definer set search_path = ''");
    expect(installed).toContain("'totalpoints', 0");
    expect(installed).toContain("'retired', true");
    expect(installed).toContain("select pg_catalog.count(*) from private.member_referrals r where r.referrer_user_id = (select auth.uid())");
    expect(installed).toContain("where (select auth.uid()) is not null");
    expect(installed.match(/\bfrom (?:private|public)\.\w+/g)).toEqual(["from private.member_referrals"]);
    expect(installed).not.toMatch(/\bp_(user|member|referrer)\b/);
    expect(entry.bodyContains).toContain("'totalpoints', 0");
    expect(entry.bodyContains).toContain("'retired', true");
    expect(contract.mfaCoverage.exempt.get_member_rewards_summary).toContain("parameterless");
    expect(contract.mfaCoverage.exempt.get_member_rewards_summary).toContain("auth.uid()");
  });
});
