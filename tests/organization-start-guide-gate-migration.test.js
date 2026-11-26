// @vitest-environment node
// BUG-UG-START-GUIDE-READ-TAKES-LIFECYCLE-GATE-20261107 (#7366): the
// staff desk's org-start guide read took the global lifecycle gate on every
// load. It now reads before the gate and takes it only on the one-time latch.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { inventoryIssues, readMigrationFunctions, reviewedForeignKeys, reviewedGraph, reviewedPreGateRead } from "../scripts/account-case-graph-inventory.mjs";
import { PROOF_FILES } from "../scripts/run-required-db-proofs.mjs";
import { fnBody, latestFnBody, loadMigrationSql, stripComments } from "./helpers/migration.js";

const MIGRATION = "20261106228000_start_guide_reads_before_lifecycle_gate";
const SIGNATURE = "public.get_organization_start_guide()";
const NAME = "public.get_organization_start_guide";
const GATE = "perform private.lock_case_graph(array[(select auth.uid())], array[]::uuid[]);";
const ROLE_CHECK = "private.has_organization_role(org, array['steward','coordinator','advisor','admin','vp'])";
const STATE_READ = "select * into state_row from private.organization_start_guide_state s where s.organization_id = org;";
const MILESTONES = "milestones := private.organization_start_milestones(org);";
const LATCH = "insert into private.organization_start_guide_state as s (organization_id, live_at, updated_at)";

const raw = loadMigrationSql(MIGRATION);
const sql = stripComments(raw);
const body = fnBody(sql, SIGNATURE);
const previous = fnBody(stripComments(loadMigrationSql("20261029150000_organization_start_guide")), SIGNATURE);
const at = (text) => body.indexOf(text);
const occurrences = (text) => body.split(text).length - 1;

describe("org-start guide reads before the lifecycle gate", () => {
  it("is the live definition of the guide read", () => {
    expect(latestFnBody(SIGNATURE)).toBe(body);
  });

  it("no longer opens with the gate and takes it once, only on the latch path", () => {
    const firstStatement = body.slice(body.indexOf("\nbegin\n") + "\nbegin\n".length).trimStart();
    expect(previous.slice(previous.indexOf("\nbegin\n") + "\nbegin\n".length).trimStart().startsWith(GATE)).toBe(true);
    expect(firstStatement.startsWith(GATE)).toBe(false);
    expect(occurrences(GATE)).toBe(1);
    const gateAt = at(GATE);
    // Hidden, off and done answers, and the first milestone read, come before it.
    expect(at("return pg_catalog.jsonb_build_object('state', 'hidden');")).toBeLessThan(gateAt);
    expect(at("return pg_catalog.jsonb_build_object('state', 'off', 'organizationId', org);")).toBeLessThan(gateAt);
    expect(at("'state', 'done'")).toBeLessThan(gateAt);
    expect(at(MILESTONES)).toBeLessThan(gateAt);
    const allDone = body.lastIndexOf("if private.organization_start_all_done(milestones) then", gateAt);
    expect(allDone).toBeGreaterThan(at(MILESTONES));
    expect(body.slice(allDone, gateAt).replace(/\s+/g, " ")).toBe("if private.organization_start_all_done(milestones) then ");
  });

  it("re-reads the role, the state row and the milestones under the gate before the one write", () => {
    const gateAt = at(GATE);
    const latchAt = at(LATCH);
    const underGate = body.slice(gateAt, latchAt);
    expect(underGate).toContain(ROLE_CHECK);
    expect(underGate).toContain(STATE_READ);
    expect(underGate).toContain("if state_row.celebrated_at is not null then");
    expect(underGate).toContain("if state_row.live_at is null then");
    expect(underGate).toContain(MILESTONES);
    expect(underGate).toContain("if private.organization_start_all_done(milestones) then");
    expect(occurrences(STATE_READ)).toBe(2);
    expect(occurrences(MILESTONES)).toBe(2);
    expect(latchAt).toBeGreaterThan(gateAt);
    expect(body).toContain("set live_at = coalesce(s.live_at, excluded.live_at), updated_at = pg_catalog.now()");
  });

  it("writes only the latch, after the gate, and locks no row before it", () => {
    const writes = [...body.matchAll(/\b(insert\s+into|update|delete\s+from|merge\s+into)\s+\w+\.\w+/gi)].map((match) => match[0]);
    expect(writes).toEqual(["insert into private.organization_start_guide_state"]);
    expect(body).not.toMatch(/\bfor\s+(update|share|no key update|key share)\b/i);
    expect(body).not.toMatch(/\bpg_(try_)?advisory_/i);
  });

  it("keeps the visibility rules, the response shape and the boundary of the previous body", () => {
    for (const pin of [
      "language plpgsql",
      "volatile",
      "security definer",
      "set search_path = ''",
      "if caller is null then",
      "if org is null or not " + ROLE_CHECK + " then",
      "private.organization_feature_enabled(org, 'features.guidance_onboarding.org_start_guide')",
      "is_admin := private.has_organization_role(org, array['admin']);",
      "can_name := private.has_organization_role(org, array['admin','vp']);",
      "'members', case when can_name then private.organization_start_members(org) else '[]'::jsonb end,",
      "'people', private.organization_start_people(org),",
      "order by (g.user_id = caller), g.granted_at, g.user_id",
    ]) {
      expect(previous, pin).toContain(pin);
      expect(body, pin).toContain(pin);
    }
    // Past the latch the active answer is byte-identical to the previous body.
    const tail = (text) => text.slice(text.indexOf("if state_row.live_at is not null then\n    return"));
    expect(tail(body)).toBe(tail(previous));
  });

  it("changes no table, trigger, index or grant", () => {
    expect(sql).not.toMatch(/(?:create|alter|drop)\s+(?:table|index|trigger|policy)/i);
    expect(sql.match(/create or replace function/gi)).toHaveLength(1);
    expect(sql).toContain(`revoke all on function ${SIGNATURE} from public, anon, authenticated, service_role;`);
    expect(sql).toContain(`grant execute on function ${SIGNATURE} to authenticated;`);
    expect(sql.match(/\bgrant\b/gi)).toHaveLength(1);
  });

  it("admits the reads before the gate only for this exact installed source", () => {
    const start = raw.indexOf("as $function$") + "as $function$".length;
    const source = raw.slice(start, raw.indexOf("$function$;", start));
    expect(reviewedGraph.pre_gate_reads[NAME].reason).toContain("#7366");
    expect(reviewedPreGateRead({ name: NAME, source })).toBe(true);
    for (const changed of [
      source.replace(GATE, "null;"),
      source.replace("insert into private.organization_start_guide_state as s", "update private.organization_start_guide_state as s"),
      `${source} `,
    ]) expect(reviewedPreGateRead({ name: NAME, source: changed })).toBe(false);
    expect(reviewedPreGateRead({ name: "public.mark_organization_start_switches_reviewed", source })).toBe(false);
  });

  it("passes the static writer inventory only through that pin", () => {
    const functions = readMigrationFunctions("supabase/migrations");
    const wrappers = readFileSync("supabase/migrations/20260907151000_account_deletion_finalization_reconciliation.sql", "utf8");
    const issuesFor = (list) => inventoryIssues(list, wrappers, reviewedGraph.exceptions, reviewedForeignKeys.foreign_keys)
      .filter((issue) => issue.endsWith(`: ${NAME}`));
    expect(issuesFor(functions)).toEqual([]);
    const edited = functions.map((f) => (f.name === NAME ? { ...f, source: `${f.source} ` } : f));
    expect(issuesFor(edited)).toContain(`missing first helper: ${NAME}`);
  });

  it("keeps the live two-session proof in the required DB proof lane", () => {
    const live = readFileSync(new URL("./organization-start-guide-db.test.js", import.meta.url), "utf8");
    expect(PROOF_FILES).toContain("tests/organization-start-guide-db.test.js");
    expect(live).toContain("organization start guide beside a held lifecycle gate");
    expect(live).toContain("select private.lock_case_graph(array[]::uuid[], array[]::uuid[])");
    expect(live).toContain('expect(latch.code, latch.message).toBe("55P03");');
    expect(live).not.toMatch(/\b(it|describe)\.(only|todo)\(/);
  });
});
