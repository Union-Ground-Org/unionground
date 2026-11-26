// @vitest-environment node
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { helperFirst, parseFunctions } from "../scripts/account-case-graph-inventory.mjs";
import { PROOF_FILES } from "../scripts/run-required-db-proofs.mjs";
import { ENGAGEMENT_EVENT_TAXONOMY } from "../src/features/analytics/contract.js";
import { loadMigrationSql, stripComments } from "./helpers/migration.js";

// OPS-UG-ANALYTICS-READ-SIDE-SHIPPED-BUT-NOTHING-IN-PRODUCTION-WRITES-ORGANIZATION-ENGAGEMENT-EVENTS-20260921
// ( AUTHENTICATED PAGE-VIEW PRODUCER). These pins read
// the migration text; the live behaviour is
// tests/organization-page-view-producer-db.test.js.
const NAME = "20260925991000_organization_page_view_producer";
const sql = loadMigrationSql(NAME);
const code = stripComments(sql);
const predecessorSql = loadMigrationSql("20260925160000_analytics_export_server_derived_counts");
const contract = JSON.parse(readFileSync("scripts/db-contract.json", "utf8"));
const READER = "public.get_organization_analytics_snapshot";
const PRODUCER = "public.record_workspace_page_view";
const PREDECESSOR_DIGEST = "1b0cbbebdd6612892dfca222e12b6a44dd40b34d2e348d9178a75822ea1b351c";

function fn(source, name, file = `${NAME}.sql`) {
  const entry = parseFunctions(source, file).find((row) => row.name === name);
  expect(entry, name).toBeTruthy();
  return entry;
}

function inOrder(source, needles) {
  let last = -1;
  for (const needle of needles) {
    const at = source.indexOf(needle);
    expect(at, needle).toBeGreaterThan(last);
    last = at;
  }
}

describe("organization page-view producer migration", () => {
  it("runs as one forward-only transaction after the reader body it rebuilds", () => {
    expect(code).toMatch(/^\s*begin;/);
    expect(code).toMatch(/commit;\s*$/);
    expect(NAME > "20260925160000_analytics_export_server_derived_counts").toBe(true);
    expect(NAME > "20260822020000_mi1_w1_feature_persistence").toBe(true);
    expect(code).toContain("notify pgrst, 'reload schema';");
  });

  it("admits only the 20260925160000 reader body as its predecessor", () => {
    const predecessor = fn(predecessorSql, READER, "20260925160000.sql");
    expect(createHash("sha256").update(predecessor.source).digest("hex")).toBe(PREDECESSOR_DIGEST);
    expect(sql).toContain(`if digest is distinct from '${PREDECESSOR_DIGEST}' then`);
    expect(sql).toContain("raise exception 'unreviewed get_organization_analytics_snapshot predecessor: %', digest");
  });

  it("admits page_view as an engagement event type and indexes the per-person minute bound", () => {
    expect(code).toContain("drop constraint organization_engagement_events_event_type_check;");
    expect(code).toMatch(/add constraint organization_engagement_events_event_type_check check \(event_type in \(\s*'meeting_check_in', 'qa_contribution', 'poll_vote', 'survey_response',\s*'event_rsvp', 'authorized_contact', 'page_view'\s*\)\);/);
    expect(code).toMatch(/create index organization_engagement_events_page_view_rate_idx\s+on public\.organization_engagement_events \(user_id, occurred_at\)\s+where event_type = 'page_view';/);
    // The score weights never include page views, so they cannot inflate a member's score.
    expect(Object.keys(ENGAGEMENT_EVENT_TAXONOMY)).not.toContain("page_view");
  });

  it("builds the producer as an authenticated, organization-scoped, bounded, idempotent writer behind the case-graph gate", () => {
    const producer = fn(sql, PRODUCER);
    expect(helperFirst(producer.source)).toBe(true);
    const source = stripComments(producer.source);
    inOrder(source, [
      "org uuid := private.engagement_selected_organization();",
      "if caller is null or org is null or not private.is_organization_member(org) then",
      "if p_organization_id is not null and p_organization_id is distinct from org then",
      "raise exception 'not authorized' using errcode = '42501';",
      "or pg_catalog.char_length(page_key) > 100",
      "or page_key !~ '^/[A-Za-z0-9/_.:-]*$' then",
      "raise exception 'invalid page key' using errcode = '22023';",
      "and private.has_organization_role(org, array[p_hat]) then",
      "and e.occurred_at >= moment - interval '1 minute';",
      "if recent >= 30 then",
      "return pg_catalog.jsonb_build_object('recorded', false, 'refusal', 'rate-limited');",
      "insert into public.organization_engagement_events",
      "'page_view', page_key || '|' || minute_key, moment)",
      "on conflict (organization_id, user_id, event_type, source_id) do nothing;",
      "if inserted then",
      "insert into public.organization_page_views (organization_id, path, hat, day, view_count)",
      "set view_count = public.organization_page_views.view_count + 1;",
      "return pg_catalog.jsonb_build_object('recorded', inserted);",
    ]);
    // No PII beyond the acting user id and the page key travels in.
    expect(source).not.toMatch(/email|ip_address|user_agent|display_name/i);
    expect(code).toMatch(/revoke all on function public\.record_workspace_page_view\(text, text, uuid\)\s+from public, anon, authenticated, service_role;/);
    expect(code).toContain("grant execute on function public.record_workspace_page_view(text, text, uuid) to authenticated;");
  });

  it("rebuilds the reader with floor-safe usageViews, complement-gated usage windows and page views kept out of engagement counts", () => {
    const reader = fn(sql, READER);
    expect(helperFirst(reader.source)).toBe(true);
    const source = stripComments(reader.source);
    const before = stripComments(fn(predecessorSql, READER, "20260925160000.sql").source);
    expect(source).not.toContain("'usageViews', '[]'::jsonb");
    expect(source).not.toContain("'dau', null");
    expect(source).not.toContain("'wau', null");
    inOrder(source, [
      "'usageViews', coalesce((",
      "from public.organization_page_views v",
      "and v.view_count >= privacy_threshold",
      "where e.organization_id = org and e.event_type = 'page_view'",
      "and pg_catalog.split_part(e.source_id, '|', 1) = v.path",
      "        ) >= privacy_threshold\n    ), '[]'::jsonb),",
      "'usageWindows', (",
      "'dau', case when windows.dau_ok then (pg_catalog.floor(windows.dau / 5.0) * 5)::integer else null end,",
      "'wau', case when windows.wau_ok then (pg_catalog.floor(windows.wau / 5.0) * 5)::integer else null end,",
      "'mau', case when windows.mau_ok then (pg_catalog.floor(windows.mau / 5.0) * 5)::integer else null end,",
      "when gated.wau_ok then gated.mau - gated.wau >= privacy_threshold",
      "when gated.dau_ok then gated.mau - gated.dau >= privacy_threshold",
      "and (counted.dau < privacy_threshold or counted.wau - counted.dau >= privacy_threshold) as wau_ok",
      "filter (where occurred_at >= generated - interval '1 day') as dau",
      "filter (where occurred_at >= generated - interval '7 days') as wau",
      "filter (where occurred_at >= generated - interval '30 days') as mau",
    ]);
    expect(source).toContain("and e.event_type <> 'page_view'\n          and e.occurred_at >= generated - interval '180 days'\n        group by e.chapter_id, e.event_type");
    // Everything the predecessor published outside the usage section is kept verbatim.
    for (const kept of [
      "'analytics_snapshot_read'",
      "'entityId', snapshot_id, 'rowCount', published_rows, 'suppressedCount', withheld_rows",
      "from public.meeting_attendance ma",
      "join public.meeting_attendance ma on ma.record_id = r.id",
      "where p.organization_id = org and p.last_seen_at >= generated - interval '30 days'",
      "'attendanceCohorts', pg_catalog.jsonb_build_object(",
    ]) {
      expect(before).toContain(kept);
      expect(source).toContain(kept);
    }
    expect(code).toMatch(/revoke all on function public\.get_organization_analytics_snapshot\(\)\s+from public, anon, authenticated, service_role;/);
    expect(code).toContain("grant execute on function public.get_organization_analytics_snapshot() to authenticated;");
  });

  it("pins the new objects in the contract and registers the live proof with its case floor", () => {
    const functions = Object.fromEntries(contract.functions.map((entry) => [entry.sig, entry]));
    expect(functions["public.record_workspace_page_view(p_page text, p_hat text, p_organization_id uuid)"]).toMatchObject({ secdef: true, exec: "authenticated" });
    expect(functions["public.get_organization_analytics_snapshot()"].bodyContains).toContain("'usageViews', coalesce((");
    expect(contract.indexes).toContainEqual(expect.objectContaining({
      table: "organization_engagement_events",
      name: "organization_engagement_events_page_view_rate_idx",
    }));
    const eventType = contract.constraints.find((entry) => entry.table === "organization_engagement_events" && entry.name === "organization_engagement_events_event_type_check");
    expect(eventType).toMatchObject({ convalidated: true });
    expect(eventType.defContains).toContain("'page_view'");
    expect(PROOF_FILES).toContain("tests/organization-page-view-producer-db.test.js");
  });
});
