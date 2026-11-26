// @vitest-environment node
//
// BUG-UG-FIRST-CUSTOMER-LEFTOVERS-IN-WHAT-EVERY-UNION-GETS-20261122:
// a member profile inserted without names reads as a neutral member (the
// values signup supplies), never a fictional person, and the bargaining
// survey switch's stored label and description name no agreement.
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import pg from "pg";
import { describe, expect, it } from "vitest";
import { assertDisposableProofUrl } from "../scripts/run-required-db-proofs.mjs";
import { settingsStrings } from "../src/lib/i18n/locales/en/settings.js";
import { stripComments } from "./helpers/migration.js";

const MIGRATION = "supabase/migrations/20261123081000_member_profile_names_and_bargaining_switch_neutral.sql";
const DESCRIPTION_MIGRATION = "supabase/migrations/20261125160200_bargaining_switch_description_says_workers.sql";
const migration = readFileSync(new URL(`../${MIGRATION}`, import.meta.url), "utf8");
const code = stripComments(migration);
const SWITCH = "features.engagement_voice.bargaining_survey_template";
// The stored wording is the web's English catalogue wording, so a screen that
// falls back to the stored row says the same thing.
const LABEL = settingsStrings[`settings.def.${SWITCH}.label`];
const DESCRIPTION = settingsStrings[`settings.def.${SWITCH}.description`];
// What would tie the switch to one organization's contract: a numbered
// bargaining unit, a contract year, or the word agreement.
const NAMES_AN_AGREEMENT = /\bUnits?\s+\d|\b(19|20)\d\d\b|agreement/i;

describe("neutral member profile defaults migration (static)", () => {
  it("is one transaction that changes three column defaults and one switch definition's wording, and nothing else", () => {
    expect(migration.trimStart().startsWith("-- BUG-UG-FIRST-CUSTOMER-LEFTOVERS-IN-WHAT-EVERY-UNION-GETS-20261122")).toBe(true);
    expect(migration).toMatch(/\nbegin;\n/);
    expect(migration.trimEnd()).toMatch(/\ncommit;$/);
    expect(code).toContain("alter table public.member_profiles\n  alter column first_name set default 'Member',\n  alter column full_name set default 'Member',\n  alter column initials set default 'M';");
    expect(code.match(/\b(insert|update|delete)\s+(into\s+|from\s+)?(public|private)\.\w+/gi)).toEqual(["update public.platform_setting_definitions"]);
    expect(code).toContain(`where key = '${SWITCH}';`);
    expect(code).toContain(`set label = '${LABEL}',\n       description = '`);
    // This edition's catalogue says "workers"; 20261125160200 stores that
    // description, so the row ends equal to the catalogue (live case below).
    const wordingFix = stripComments(readFileSync(new URL(`../${DESCRIPTION_MIGRATION}`, import.meta.url), "utf8"));
    expect(wordingFix).toContain(`set description = '${DESCRIPTION}'\n where key = '${SWITCH}';`);
    expect(wordingFix.match(/\b(insert|update|delete)\s+(into\s+|from\s+)?(public|private)\.\w+/gi)).toEqual(["update public.platform_setting_definitions"]);
    expect(wordingFix).not.toMatch(NAMES_AN_AGREEMENT);
    expect(code).not.toMatch(/drop |create |grant |revoke /i);
    const wording = code.slice(code.indexOf("update public.platform_setting_definitions"));
    expect(wording).not.toMatch(NAMES_AN_AGREEMENT);
  });
});

const live = process.env.SUPABASE_DB_URL ? describe : describe.skip;

live("neutral member profile defaults on a disposable database", () => {
  it("gives a profile inserted with only its id the signup names, and stores the switch's neutral wording", async () => {
    const db = new pg.Client({ connectionString: assertDisposableProofUrl(process.env.SUPABASE_DB_URL), ssl: false, application_name: "member-profile-neutral-defaults-proof" });
    await db.connect();
    await db.query("begin");
    try {
      const defaults = await db.query(
        "select column_name, column_default, is_nullable from information_schema.columns where table_schema = 'public' and table_name = 'member_profiles' and column_name = any($1) order by column_name",
        [["first_name", "full_name", "initials"]],
      );
      expect(defaults.rows).toEqual([
        { column_name: "first_name", column_default: "'Member'::text", is_nullable: "NO" },
        { column_name: "full_name", column_default: "'Member'::text", is_nullable: "NO" },
        { column_name: "initials", column_default: "'M'::text", is_nullable: "NO" },
      ]);

      // Signup makes the profile; take it away and insert one that names only
      // the id, the way a path that omits the names would.
      const id = randomUUID();
      await db.query("insert into auth.users (id, email) values ($1, $2)", [id, `neutral-defaults-${id}@example.invalid`]);
      const signup = await db.query("select first_name, full_name, initials from public.member_profiles where id = $1", [id]);
      expect(signup.rows).toEqual([{ first_name: "Member", full_name: "Member", initials: "M" }]);
      await db.query("delete from public.member_profiles where id = $1", [id]);
      const bare = await db.query("insert into public.member_profiles (id) values ($1) returning first_name, full_name, initials", [id]);
      expect(bare.rows).toEqual([{ first_name: "Member", full_name: "Member", initials: "M" }]);

      const definition = await db.query("select label, description, default_value from public.platform_setting_definitions where key = $1", [SWITCH]);
      expect(definition.rows).toHaveLength(1);
      expect(definition.rows[0].label).toBe(LABEL);
      expect(definition.rows[0].description).toBe(DESCRIPTION);
      expect(`${definition.rows[0].label} ${definition.rows[0].description}`).not.toMatch(NAMES_AN_AGREEMENT);
      expect(JSON.stringify(definition.rows[0].default_value)).toMatch(/false/);
    } finally {
      await db.query("rollback");
      await db.end();
    }
  }, 120000);
});
