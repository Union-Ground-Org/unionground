// handle_new_member has been regenerated repeatedly. The current ship contract
// deliberately creates no fictional member activity, so this pins the NEWEST
// generation and prevents a copied legacy body from resurrecting seeded cases.
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const MIGRATIONS_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "supabase", "migrations");
const SEED_BASES = ["GR-2026-509", "GR-2026-312", "GR-2025-944", "GR-2025-721"];

const generations = readdirSync(MIGRATIONS_DIR)
  .filter((file) => file.endsWith(".sql"))
  .sort()
  .filter((file) => readFileSync(join(MIGRATIONS_DIR, file), "utf8")
    .includes("create or replace function private.handle_new_member"));

describe("the newest handle_new_member generation keeps real accounts empty", () => {
  it("finds at least the 20260730 generation", () => {
    expect(generations.length).toBeGreaterThan(0);
    expect(generations.at(-1) >= "20260730160500").toBe(true);
  });

  it("creates only a profile and an optional valid chapter membership", () => {
    const newest = readFileSync(join(MIGRATIONS_DIR, generations.at(-1)), "utf8");
    expect(newest).toContain("insert into public.member_profiles");
    expect(newest).toContain("insert into public.member_chapter_memberships");
    expect(newest).toContain("not exists (select 1 from public.chapters");
  });

  it("never invents a case, message, notification, progress, or action row", () => {
    const newest = readFileSync(join(MIGRATIONS_DIR, generations.at(-1)), "utf8");
    const start = newest.indexOf("create or replace function private.handle_new_member");
    const end = newest.indexOf("$function$;", start);
    const body = newest.slice(start, end === -1 ? undefined : end);
    for (const table of ["member_cases", "member_messages", "member_notifications", "member_rights_progress", "member_action_log"]) {
      expect(body, `${table} must remain empty for a provisioned account`).not.toContain(table);
    }
    for (const base of SEED_BASES) {
      expect(body, `${base} is SAMPLE-only and must not enter a real account trigger`).not.toContain(base);
    }
  });
});
