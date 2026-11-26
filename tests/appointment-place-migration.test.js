import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const sql = fs.readFileSync(path.resolve("supabase/migrations/20260810143000_appointment_place.sql"), "utf8").toLowerCase();

describe("appointment place migration", () => {
  it("adds a bounded nullable historical column and requires place at booking", () => {
    expect(sql).toContain("add column place text");
    expect(sql).toContain("char_length(place) between 1 and 300");
    expect(sql).toContain("p_place text");
    expect(sql).toContain("clean_place text := btrim(p_place)");
    expect(sql).toContain("grant execute on function public.book_appointment(text, integer, timestamptz, text, uuid, text) to authenticated");
    expect(sql).toContain("revoke all on function public.book_appointment_without_place_legacy");
  });

  it("carries place through rescheduling and every participant read model", () => {
    expect(sql).toContain("carry_rescheduled_appointment_place");
    expect(sql).toContain("select a.place into new.place");
    expect(sql.match(/jsonb_build_object\('place', a\.place\)/g)).toHaveLength(3);
    expect(sql).toContain("a.place, old.total_count");
  });

  it("keeps wrappers definer-scoped and revokes their public execution", () => {
    expect(sql.match(/security definer/g)?.length).toBeGreaterThanOrEqual(5);
    expect(sql).toContain("revoke all on function public.get_my_appointments() from public, anon");
    expect(sql).toContain("revoke all on function public.get_steward_appointments() from public, anon");
  });
});
