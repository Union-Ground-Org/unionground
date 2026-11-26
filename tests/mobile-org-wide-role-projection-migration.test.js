// @vitest-environment node
import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { stripComments } from "./helpers/migration.js";

const root = resolve(import.meta.dirname, "..");
const migrationDir = resolve(root, "supabase/migrations");
const source = readdirSync(migrationDir)
  .filter((name) => name.endsWith(".sql"))
  .sort()
  .map((name) => readFileSync(resolve(migrationDir, name), "utf8"))
  .join("\n");

function latestFunctionBody(name) {
  const declaration = new RegExp(`create(?: or replace)? function public\\.${name}\\(\\)`, "gi");
  const matches = [...source.matchAll(declaration)];
  const start = matches.at(-1)?.index ?? -1;
  expect(start, `${name} must be defined`).toBeGreaterThanOrEqual(0);
  const end = source.indexOf("$function$;", start);
  expect(end, `${name} must have a complete SQL body`).toBeGreaterThan(start);
  return stripComments(source.slice(start, end)).replace(/\s+/g, " ").toLowerCase();
}

describe("mobile organization-wide staff role projection", () => {
  it("projects organization-wide roles alongside chapter-scoped roles for each active membership", () => {
    const body = latestFunctionBody("get_my_chapter_memberships");

    expect(body).toContain("from public.member_role_chapters rc");
    expect(body).toContain("from public.member_roles r");
    expect(body).toContain("r.chapter_id is null");
    expect(body).toContain("r.user_id = m.user_id");
  });
});
