// @vitest-environment node
//
// PERF-UG-ENGAGEMENT-STAFF-GATE-RUNS-THE-WHOLE-SNAPSHOT-20260920
//
// Three server routes — Compass poll drafting, Compass message briefing and the
// engagement delivery status probe — asked "is this caller staff?" by calling
// public.get_staff_engagement_snapshot and throwing the answer away. That
// projection aggregates every survey with its deliveries, tasks, reviews and
// questions, the live polls, the workspace actions and the saved briefings, so
// the gate cost the whole staff dashboard before any real work began.
//
// 20260925620800 publishes the predicate those routes actually need. These pins
// hold both halves in place: the RPC must stay a predicate (no projection), and
// no server route may go back to the snapshot for an authorization answer.
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { fnBody, loadMigrationSql, stripComments } from "./helpers/migration.js";

const apiDir = resolve(dirname(fileURLToPath(import.meta.url)), "../api");
const sql = stripComments(loadMigrationSql("20260925620800_engagement_staff_gate_rpc")).toLowerCase();
const gate = fnBody(sql, "public.authorize_engagement_staff");

describe("the engagement staff gate is a predicate, not a projection", () => {
  it("answers authorization through private.engagement_require_staff and reads no engagement row", () => {
    expect(gate).toContain("returns boolean");
    expect(gate).toContain("security definer");
    expect(gate).toContain("set search_path = ''");
    expect(gate).toContain("perform private.engagement_require_staff(private.engagement_selected_organization())");
    expect(gate).toContain("return true;");
    // The defect being fixed is exactly "the gate builds a projection first".
    // `select` is matched as a word so private.engagement_selected_organization
    // does not read as a query.
    for (const forbidden of [/jsonb_build_object/, /jsonb_agg/, /\bselect\b/, /from public\./]) {
      expect(gate, `the gate must not ${forbidden}`).not.toMatch(forbidden);
    }
  });

  it("is reachable by authenticated only, never by anon or the service role", () => {
    expect(sql).toContain(
      "revoke all on function public.authorize_engagement_staff() from public, anon, authenticated, service_role;",
    );
    expect(sql).toContain("grant execute on function public.authorize_engagement_staff() to authenticated;");
    expect(sql).not.toMatch(/grant\s+execute\s+on\s+function\s+public\.authorize_engagement_staff\(\)\s+to\s+[^;]*(anon|service_role)/);
  });

  it("leaves the staff snapshot itself alone — the operations page still reads it", () => {
    expect(sql).not.toContain("get_staff_engagement_snapshot");
    expect(readFileSync(resolve(apiDir, "../src/features/engagement/api.js"), "utf8"))
      .toContain('rpc(client, "get_staff_engagement_snapshot"');
  });
});

describe("no server route buys authorization with the staff snapshot", () => {
  it.each([
    ["guide.js", ["poll_draft", "message_briefing"]],
    ["engagement-delivery.js", ["status"]],
  ])("api/%s gates %s on the predicate", (file, _modes) => {
    const source = readFileSync(join(apiDir, file), "utf8");
    expect(source).toContain('"authorize_engagement_staff"');
    expect(source, "an authorization check must not build the staff snapshot")
      .not.toContain("get_staff_engagement_snapshot");
  });
});
