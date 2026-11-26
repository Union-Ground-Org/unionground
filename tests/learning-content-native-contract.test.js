// @vitest-environment node
// REQ-UG-QUOTES-MINI-LESSONS-20260928: both clients enforce the same
// governed learning-content limits as the server. The native iPhone/Android
// model re-exports the web client's shared pure model, both are checked
// against the numbers in the governing migration, and both clients call only
// the RPCs that migration defines.
import { readFileSync, readdirSync } from "node:fs";
import { describe, expect, it } from "vitest";

import * as web from "../src/features/learningContent/model.js";
import * as native from "../apps/mobile/src/lib/learningContentModel.ts";

const migrationName = readdirSync("supabase/migrations").find((name) => name.endsWith("_governed_learning_content.sql"));
const migration = migrationName ? readFileSync(`supabase/migrations/${migrationName}`, "utf8") : "";

function sqlNumber(pattern) {
  const match = migration.match(pattern);
  if (!match) throw new Error(`migration pattern not found: ${pattern}`);
  return Number(match[1]);
}

const draft = (patch = {}) => ({ ...web.emptyLearningDraft({ kind: "quote", locale: "es" }), title: "Título", body: "Texto", ...patch });

describe("one limit table for web, native and the server", () => {
  it("native uses the shared model itself, not a copy", () => {
    expect(native.LEARNING_LIMITS).toBe(web.LEARNING_LIMITS);
    expect(native.validateLearningItem).toBe(web.validateLearningItem);
    expect(native.normalizeLearningItem).toBe(web.normalizeLearningItem);
    expect(native.orderLearningItems).toBe(web.orderLearningItems);
    expect(native.pickLearningItem).toBe(web.pickLearningItem);
    expect(native.learningHomeRequest).toBe(web.learningHomeRequest);
  });

  it("matches every limit the migration enforces", () => {
    expect(migrationName).toBeTruthy();
    const limits = web.LEARNING_LIMITS;
    expect(limits.title).toBe(sqlNumber(/when 'title' then (\d+)/));
    expect(limits.body.quote).toBe(sqlNumber(/p->>'kind'='quote' then (\d+)/));
    expect(limits.body.mini_lesson).toBe(sqlNumber(/p->>'kind'='quote' then \d+ else (\d+) end/));
    expect(limits.attribution).toBe(sqlNumber(/when 'attribution' then (\d+)/));
    expect(limits.tone).toBe(sqlNumber(/when 'tone' then (\d+)/));
    expect(limits.learning_outcome).toBe(sqlNumber(/when 'learning_outcome' then (\d+)/));
    const other = sqlNumber(/when 'learning_outcome' then \d+ else (\d+) end/);
    for (const field of ["source", "rights_note", "review_note", "direction"]) expect(limits[field]).toBe(other);
    expect([limits.bulletCount, limits.bullet]).toEqual([sqlNumber(/p->'bullets',(\d+),\d+/), sqlNumber(/p->'bullets',\d+,(\d+)/)]);
    expect([limits.topicCount, limits.topic]).toEqual([sqlNumber(/p->'topics',(\d+),\d+/), sqlNumber(/p->'topics',\d+,(\d+)/)]);
    expect(limits.priorityMax).toBe(sqlNumber(/\(p->>'priority'\)::int > (\d+)/));
    expect(limits.payloadBytes).toBe(sqlNumber(/octet_length\(p::text\) > (\d+)/));
    expect(limits.selectedIds).toBe(sqlNumber(/cardinality\(p_selected_ids\)>(\d+)/));
    expect(web.LEARNING_PAGE_SIZE.home).toBe(sqlNumber(/p_limit not between 1 and (\d+)/));
    expect(web.LEARNING_MAX_OFFSET).toBe(sqlNumber(/p_offset>(\d+)/));
    expect(web.LEARNING_PAGE_SIZE.workspace + 1).toBe(sqlNumber(/limit (\d+) offset p_offset/));
  });

  it("refuses N+1 code points exactly where both clients' editors refuse them", () => {
    const cases = [
      ["title", web.LEARNING_LIMITS.title],
      ["attribution", web.LEARNING_LIMITS.attribution],
      ["source", web.LEARNING_LIMITS.source],
      ["rights_note", web.LEARNING_LIMITS.rights_note],
      ["review_note", web.LEARNING_LIMITS.review_note],
      ["direction", web.LEARNING_LIMITS.direction],
      ["tone", web.LEARNING_LIMITS.tone],
      ["learning_outcome", web.LEARNING_LIMITS.learning_outcome],
    ];
    for (const [field, limit] of cases) {
      const ok = "ñ".repeat(limit);
      const over = `${ok}😀`;
      const nativeForm = { ...native.emptyLearningDraftForm("quote", "es", "chapter"), title: "Título", body: "Texto" };
      expect(web.validateLearningItem(draft({ [field]: ok }))).toEqual([]);
      expect(native.learningDraftFormIssues({ ...nativeForm, [field]: ok })).toEqual([]);
      const webIssues = web.validateLearningItem(draft({ [field]: over }));
      expect(webIssues).toContainEqual(expect.objectContaining({ field, code: "too_long", limit }));
      expect(native.learningDraftFormIssues({ ...nativeForm, [field]: over })).toEqual(webIssues);
    }
  });

  it("bounds bullets, topics and priority identically on both clients", () => {
    const nativeForm = { ...native.emptyLearningDraftForm("mini_lesson", "en", "organization"), title: "Lesson", body: "Body" };
    const variants = [
      { bullets: ["a", "b", "c", "d", "e", "f"] },
      { bullets: ["x".repeat(201)] },
      { topics: ["", "ok"] },
      { topics: ["t".repeat(81)] },
      { priority: "101" },
      { is_default: true },
    ];
    for (const patch of variants) {
      const nativeIssues = native.learningDraftFormIssues({ ...nativeForm, ...patch });
      const webIssues = web.validateLearningItem({ ...web.emptyLearningDraft({ kind: "mini_lesson", locale: "en" }), title: "Lesson", body: "Body", ...patch }, { mode: "save", scope: "organization" });
      expect(nativeIssues.length).toBeGreaterThan(0);
      expect(nativeIssues).toEqual(webIssues);
    }
  });

  it("calls only the RPCs the migration defines, the same set on both clients", () => {
    const defined = new Set([...migration.matchAll(/create function public\.([a-z_]+)\(/g)].map((match) => match[1]));
    const nativeService = readFileSync("apps/mobile/src/services/learningContent.ts", "utf8");
    const nativeCalls = new Set([...nativeService.matchAll(/call\('([a-z_]+)'/g)].map((match) => match[1]));
    const webApi = readFileSync("src/features/learningContent/api.js", "utf8");
    const webCalls = new Set([...webApi.matchAll(/rpc\("([a-z_]+)"/g)].map((match) => match[1]));
    expect(nativeCalls.size).toBe(9);
    for (const name of nativeCalls) expect(defined.has(name), name).toBe(true);
    expect([...nativeCalls].sort()).toEqual([...webCalls].sort());
    expect(nativeService).toContain("createCapturedSessionRpcClient(session)");
    expect(nativeService).not.toMatch(/service_role|serviceRole|getSupabaseClient/);
  });
});
