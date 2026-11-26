// @vitest-environment node
import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const sql = readFileSync(new URL("../supabase/migrations/20260907122000_retire_dormant_channel_controls.sql", import.meta.url), "utf8");

describe("ENC messaging seed lock ordering", () => {
  it("wraps the exact post-ENC body without rewriting its ticket or envelope behavior", () => {
    expect(sql).toContain("('private.demo_seed_apply_casework(text, uuid)', '0695c634148d2df9e6e9c40ff4333bbb')");
    expect(sql).toContain("pg_catalog.md5(source) is distinct from item.source_md5");
    expect(sql).toContain("raise exception 'messaging entry source changed: %', item.signature");
    expect(sql).toContain("chr(10) || 'begin' || chr(10) || '  perform private.lock_message_lifecycle();' || chr(10)");
    expect(sql).toContain("definition := pg_catalog.replace(definition, source, replacement)");
    expect(sql).toContain("execute definition;");
    expect(existsSync(new URL("../supabase/migrations/20260907100000_sensitive_seed_message_lock_order.sql", import.meta.url))).toBe(false);
  });
});
