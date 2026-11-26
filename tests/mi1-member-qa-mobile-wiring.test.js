import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { createQaRpcAdapter } from "../src/features/qa/adapter.js";
import { memberQaPreviewState } from "../apps/mobile/src/lib/mi1QaShared.ts";
import {
  CATALOGUE_MODULE,
  MOBILE_CATALOGUE_BYTE_BUDGET,
  catalogueReach,
  importChain,
  mobileRouteEntries,
  walkMobileGraph,
} from "../scripts/lib/mobile-import-graph.mjs";

function read(path) {
  return readFileSync(path, "utf8");
}

describe("CR-018 native Q&A wiring", () => {
  it("registers /feature/qa without other first-wave domains", () => {
    const catalog = read("apps/mobile/src/lib/featureCatalog.ts");
    const hats = read("apps/mobile/src/lib/hatFunctions.ts");
    // Union Ground's native app has no "My union" screen
    // (app/union.tsx); the Campaign tab replaced it, and the Q&A entrance is
    // the hat deck and the navigation-usage catalogue.
    const navUsage = read("apps/mobile/src/lib/navUsageShared.ts");
    const feature = read("apps/mobile/src/features/FeatureScreen.tsx");
    expect(catalog).toContain("'qa'");
    expect(catalog).toContain("qa: 'Worker questions'");
    expect(hats).toContain("href: '/feature/qa'");
    expect(navUsage).toContain("href: '/feature/qa'");
    expect(existsSync("apps/mobile/app/union.tsx")).toBe(false);
    expect(feature).toContain("featureKey === 'qa'");
    expect(feature).toContain("<Mi1QaFeatureScreen />");
  });

  it("uses the secure native RPC client and never invents a tenant", async () => {
    const shared = read("apps/mobile/src/lib/mi1QaShared.ts");
    const screen = read("apps/mobile/src/features/mi1/MemberQaScreen.tsx");
    expect(shared).toContain("qaRpc: true");
    expect(shared).toContain("nativeOrganizationId(input.organizationId)");
    expect(shared).toContain("from '../../../../src/features/qa/copy.js'");
    expect(shared).not.toContain("MemberQaForum");
    expect(shared).not.toContain("features/pay");
    expect(screen).toContain("bindBusinessApi(client, writer, createQaRpcAdapter");
    expect(screen).toContain("getSupabaseClient()");
    expect(screen).toContain("live ? getSupabaseClient() : null");
    expect(screen).toContain("if (!live || !membership.ok || !client) return");
    expect(read("apps/mobile/src/features/mi1/Mi1QaFeatureScreen.tsx")).toContain("live={mode === 'authenticated'}");
    const previewReturn = [
      "  if (!live) {",
      "    const preview = memberQaPreviewState(language);",
      "    return (",
      "      <Screen>",
      "        <Heading>{qaText(language, 'title')}</Heading>",
      "        <StateMessage title={preview.title} body={preview.body} />",
      "      </Screen>",
      "    );",
      "  }",
    ].join("\n");
    expect(screen).toContain(previewReturn);
    const beforePreview = screen.slice(screen.indexOf("export function MemberQaScreen"), screen.indexOf(previewReturn));
    expect(beforePreview.length).toBeGreaterThan(0);
    expect(beforePreview).not.toMatch(/if\s*\(\s*!live\s*\)/);
    expect(screen).not.toContain("memberQaPreviewState(live, language)");
    expect(memberQaPreviewState("en")).toEqual({
      title: "Questions preview",
      body: "This preview does not load saved questions.",
    });
    expect(memberQaPreviewState("es")).toEqual({
      title: "Vista previa de preguntas",
      body: "Esta vista previa no carga preguntas guardadas.",
    });
    expect(JSON.stringify(memberQaPreviewState("en"))).not.toMatch(/sign in/i);
    const calls = [];
    const result = await createQaRpcAdapter({ rpc: async (name, args) => {
      calls.push([name, args]);
      return { data: [], error: null };
    } }).list({});
    expect(result).toEqual({ ok: true, value: [] });
    expect(calls[0][0]).toBe("list_member_qa_questions");
    expect(calls[0][1]).toMatchObject({ p_status: null });

    await createQaRpcAdapter({ rpc: async (name, args) => {
      calls.push([name, args]);
      return { data: [], error: null };
    } }).search({ status: "all" });
    expect(calls[1]).toEqual(["search_member_qa_history", {
      p_query: "",
      p_status: null,
      p_sort: "newest",
    }]);
  });
});

// ---------------------------------------------------------------------------
// PERF-UG-MOBILE-QA-BUNDLES-FULL-WEB-CATALOGUE-20260917.
//
// The case above pins that apps/mobile/src/lib/mi1QaShared.ts still re-exports
// src/features/qa/copy.js. That line is the seam this budget guards: copy.js is
// a WEB module, Metro does not tree-shake, and when copy.js became a wrapper
// over the src/lib/i18n.js barrel the whole 785 KB web catalogue started riding
// into the React Native bundle so the Q&A screen could render sixty strings.
// Every web test stayed green, because nothing on either side measures what the
// native graph reaches.
//
// So the assertion is on the graph, not on a line of source: from a route entry,
// following the specifiers Metro actually follows, how many bytes of catalogue
// does the app reach. It holds over EVERY apps/mobile route, not just the Q&A
// one, because the next regression will be a different shared module.
// ---------------------------------------------------------------------------
const REPOSITORY_ROOT = process.cwd();
const QA_ROUTE_ENTRY = "apps/mobile/app/feature/[key].tsx";


function describeReach(graph, reach) {
  return reach.reached
    .map((path) => `${path} (${graph.modules.get(path)} bytes) via ${importChain(graph, path).join(" -> ")}`)
    .join("\n");
}

describe("mobile runtime import-graph catalogue budget", () => {
  it("resolves the Q&A screen's strings without reaching the full web catalogue", () => {
    const graph = walkMobileGraph(REPOSITORY_ROOT, [QA_ROUTE_ENTRY]);
    const reach = catalogueReach(graph);

    // Not vacuous: the walk really does traverse the shared seam, so a budget
    // that passes because the walker stopped early fails here first.
    expect(importChain(graph, "src/features/qa/copy.js")).toEqual([
      QA_ROUTE_ENTRY,
      "apps/mobile/src/features/FeatureScreen.tsx",
      "apps/mobile/src/features/mi1/Mi1QaFeatureScreen.tsx",
      "apps/mobile/src/lib/mi1QaShared.ts",
      "src/features/qa/copy.js",
    ]);
    expect(reach.reached.length, "the Q&A screen reaches no register module at all").toBeGreaterThan(0);

    // The barrel is one object literal per locale that Metro cannot split, so
    // reaching it at all means shipping every key in the app.
    expect(reach.reached, `the Q&A route reaches the whole catalogue:\n${describeReach(graph, reach)}`)
      .not.toContain("src/lib/i18n.js");
    expect(reach.bytes, `the Q&A route reaches ${reach.bytes} bytes of register, over the ${MOBILE_CATALOGUE_BYTE_BUDGET} byte budget:\n${describeReach(graph, reach)}`)
      .toBeLessThanOrEqual(MOBILE_CATALOGUE_BYTE_BUDGET);
  });

  it("holds the same budget over every apps/mobile route, with no exception, so the next shared re-export cannot regress it silently", () => {
    const entries = mobileRouteEntries(REPOSITORY_ROOT);
    expect(entries, "no mobile route entries were found").toContain(QA_ROUTE_ENTRY);
    // No allowlist and no exception: the second reach the graph found
    // (app/case/[id].tsx -> MemberCaseworkProgress.tsx) is repaired in the same
    // change, so every route is held to the same number.
    const graph = walkMobileGraph(REPOSITORY_ROOT, entries);
    const reach = catalogueReach(graph);

    // A specifier that resolves to nothing would shrink the graph and weaken
    // every number below, and a module behind metro.config.js's web-JSX fence
    // is a native build failure rather than weight. Both are honesty checks.
    expect(graph.unresolved, `unresolved relative imports in the mobile graph:\n${graph.unresolved.join("\n")}`).toEqual([]);
    expect(graph.blocked, `the mobile graph reaches a web JSX desk blocked by metro.config.js:\n${graph.blocked.join("\n")}`).toEqual([]);

    expect(reach.reached.every((path) => CATALOGUE_MODULE.test(path))).toBe(true);
    expect(reach.reached, `an apps/mobile route reaches the whole catalogue:\n${describeReach(graph, reach)}`)
      .not.toContain("src/lib/i18n.js");
    expect(reach.bytes, `apps/mobile reaches ${reach.bytes} bytes of register, over the ${MOBILE_CATALOGUE_BYTE_BUDGET} byte budget:\n${describeReach(graph, reach)}`)
      .toBeLessThanOrEqual(MOBILE_CATALOGUE_BYTE_BUDGET);
  });

});
