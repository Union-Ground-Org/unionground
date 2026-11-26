import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const sql = readFileSync(resolve("supabase/migrations/20260810153000_member_report_preferences.sql"), "utf8").toLowerCase();

describe("member report preferences migration", () => {
  it("stores one self-owned bounded layout", () => {
    expect(sql).toContain("create table public.member_report_preferences");
    expect(sql).toContain("user_id uuid primary key");
    expect(sql).toContain("jsonb_array_length(config->'order') <= 50");
    expect(sql).toContain("jsonb_array_length(config->'custom') <= 25");
  });

  it("exposes only self-scoped definer reads and writes", () => {
    expect(sql).toContain("create function public.get_my_report_preferences()");
    expect(sql).toContain("create function public.save_my_report_preferences(p_config jsonb)");
    expect(sql).toContain("user_id = caller");
    expect(sql).toContain("on conflict (user_id) do update");
    expect(sql).toContain("private.mfa_satisfied()");
  });
});
