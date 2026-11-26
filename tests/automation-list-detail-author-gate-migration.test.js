// @vitest-environment node
//
// UX-UG-V3-OPENED-AUTOMATION-AUTHORING-TO-STEWARDS-COORDINATORS-ADVISORS-BUT-LEFT-THE-SIX-20260921
//
// The four paged list/detail automation reads enter through the v3 author
// gate and filter rows exactly as mi1_get_automation_workspace does. The live
// steward/admin behavior is proven by
// scripts/verify-automation-shared-intelligence-v3-local.mjs (required DB
// proof lane via tests/automation-shared-intelligence-v3-db.test.js).
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { fnBody, loadMigrationSql, migrationFiles, stripComments } from "./helpers/migration.js";

const FILE = "20260924230200_automation_list_detail_author_gate.sql";
const raw = loadMigrationSql("automation_list_detail_author_gate");
const sql = stripComments(raw);
const squash = (text) => text.replace(/\s+/g, " ").trim();
const contract = JSON.parse(readFileSync(new URL("../scripts/db-contract.json", import.meta.url), "utf8"));
const NAMES = [
  "public.mi1_get_automation_definitions",
  "public.mi1_get_automation_definition",
  "public.mi1_get_automation_runs",
  "public.mi1_get_automation_run",
];

function latestDeclaringMigration(name) {
  const declared = new RegExp(`create\\s+(?:or\\s+replace\\s+)?function\\s+${name.replace(".", "\\.")}\\s*\\(`, "i");
  return [...migrationFiles()].reverse().find((entry) => declared.test(stripComments(entry.sql)));
}

// REQ-UG-HOLD-RELEASE-CALENDAR-SWITCHES-20261112 (#8579) re-declares
// the two run reads with only the release hold of default recipes added; every
// rule below still holds for their live declaration.
const HOLD_FILE = "20261112214700_hold_release_calendar_switches.sql";
const LIVE_FILE = {
  "public.mi1_get_automation_definitions": FILE,
  "public.mi1_get_automation_definition": FILE,
  "public.mi1_get_automation_runs": HOLD_FILE,
  "public.mi1_get_automation_run": HOLD_FILE,
};
const liveRaw = (name) => latestDeclaringMigration(name).sql;

describe("automation list/detail author-gate migration", () => {
  it("is the live declaration of all four reads, after the v3 helpers, in one bounded transaction", () => {
    for (const name of NAMES) expect(latestDeclaringMigration(name)?.name).toBe(LIVE_FILE[name]);
    expect(FILE > "20260911070000_automation_shared_intelligence_v3.sql").toBe(true);
    expect(sql.trimStart().startsWith("begin;")).toBe(true);
    expect(sql.trimEnd().endsWith("commit;")).toBe(true);
    expect(sql).toContain("set local lock_timeout = '5s';");
  });

  it("enters every read through the author gate, never the operator gate or the operator-gated v2 read helper", () => {
    for (const name of NAMES) {
      const body = squash(stripComments(fnBody(liveRaw(name), name)));
      expect(body).toContain("org uuid:=private.automation_v3_require_author();");
      expect(body).not.toContain("cr108_require_operator");
      expect(body).not.toContain("automation_v2_definition_read");
      expect(body).toContain("language plpgsql stable security definer set search_path = ''");
    }
  });

  it("filters definitions through the shared visibility predicate and projects the review state", () => {
    const list = squash(stripComments(fnBody(raw, "public.mi1_get_automation_definitions")));
    expect(list.match(/private\.automation_v3_definition_visible\(d,actor,org\)/g)).toHaveLength(2);
    expect(list).toContain("private.automation_v3_definition_json(d,actor,org) item");
    const detail = squash(stripComments(fnBody(raw, "public.mi1_get_automation_definition")));
    expect(detail).toContain("if d.id is null or not coalesce(private.automation_v3_definition_visible(d,actor,org),false) then raise exception 'definition unavailable' using errcode='42501'");
    expect(detail).toContain("private.automation_v3_definition_json(d,actor,org)");
  });

  it("limits runs to an approver or the run's initiator, including the definition filter and the detail read", () => {
    const list = squash(stripComments(fnBody(liveRaw("public.mi1_get_automation_runs"), "public.mi1_get_automation_runs")));
    expect(list).toContain("approver boolean:=private.automation_v3_actor_is_approver(actor,org)");
    expect(list.match(/\(approver or r\.initiated_by=actor\)/g)).toHaveLength(2);
    expect(list).toContain("and private.automation_v3_definition_visible(d,actor,org)) then raise exception 'definition unavailable' using errcode='42501'");
    const detail = squash(stripComments(fnBody(liveRaw("public.mi1_get_automation_run"), "public.mi1_get_automation_run")));
    expect(detail).toContain("if r.id is null or not (approver or r.initiated_by is not distinct from actor) then raise exception 'run unavailable' using errcode='42501'");
    // Effect and snapshot redaction are unchanged from the v2 body.
    expect(detail).toContain("snapshot:=jsonb_set(snapshot,'{conditions}',(snapshot->'conditions')-'sourceId')||jsonb_build_object('sourceFilterAvailable',false)");
    expect(detail.match(/private\.automation_v2_source_visible\(auth\.uid\(\),org,/g)?.length).toBeGreaterThanOrEqual(6);
  });

  it("keeps the authenticated-only ACL explicit", () => {
    const flat = squash(sql);
    expect(flat).toContain("revoke all on function public.mi1_get_automation_definitions(integer,integer,text,text),public.mi1_get_automation_definition(uuid),public.mi1_get_automation_runs(integer,integer,uuid,text,timestamptz,timestamptz),public.mi1_get_automation_run(uuid,integer,integer) from public,anon,authenticated,service_role;");
    expect(flat).toContain("grant execute on function public.mi1_get_automation_definitions(integer,integer,text,text),public.mi1_get_automation_definition(uuid),public.mi1_get_automation_runs(integer,integer,uuid,text,timestamptz,timestamptz),public.mi1_get_automation_run(uuid,integer,integer) to authenticated;");
  });

  it("re-pins each re-declared signature in the database contract", () => {
    for (const name of NAMES) {
      const entry = contract.functions.find((row) => row.sig.startsWith(`${name}(`));
      expect(entry, name).toMatchObject({ secdef: true, exec: "authenticated" });
      const declaration = fnBody(liveRaw(name), name);
      const prosrc = declaration.slice(declaration.indexOf("$$") + 2, declaration.lastIndexOf("$$"));
      expect(entry.sourceMd5, name).toBe(createHash("md5").update(prosrc).digest("hex"));
      expect(entry.bodyContains).toContain("private.automation_v3_require_author()");
      expect(entry.bodyForbids).toContain("cr108_require_operator");
    }
  });
});
