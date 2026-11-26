// @vitest-environment node
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../scripts/visual-audit.mjs", () => ({ settleVisualAuditSurface: async () => {} }));
afterEach(() => { vi.unstubAllEnvs(); vi.resetModules(); });

const expectedSha = "a".repeat(40);
async function observe(documentSha) {
  vi.stubEnv("DEMO_COVENANT_EXPECTED_SHA", expectedSha);
  vi.stubEnv("DEMO_COVENANT_BASE_URL", "http://127.0.0.1:4173");
  const { observePhoneFocusIsolation } = await import("../scripts/verify-demo-chrome-covenant.mjs");
  const frame = {};
  const url = "http://127.0.0.1:4173/m?demo=1";
  const request = { isNavigationRequest: () => true, frame: () => frame, url: () => url, redirectedFrom: () => null };
  const response = {
    request: () => request, url: () => url, status: () => 200,
    body: async () => Buffer.from(`<html><head><meta name="union-ground-build-sha" content="${documentSha}"></head></html>`),
    headerValue: async () => "text/html",
  };
  const locator = { first() { return this; }, locator() { return this; }, click: async () => {}, waitFor: async () => {}, isVisible: async () => false };
  const page = {
    goto: async () => response, mainFrame: () => frame, url: () => url,
    locator: () => locator, waitForFunction: async () => {},
    evaluate: async () => ({ hatMenuCount: 0, triggerCount: 0, activeElementIsTrigger: false }),
  };
  const context = {
    addInitScript: async () => {},
    route: async () => {},
    unrouteAll: async () => {},
    newPage: async () => page,
    close: vi.fn(),
  };
  try {
    return await observePhoneFocusIsolation({ newContext: async () => context });
  } finally {
    expect(context.close).toHaveBeenCalledOnce();
  }
}

describe("phone covenant loaded-document provenance", () => {
  it("refuses a stale phone document even when its focus observations would pass", async () => {
    await expect(observe("b".repeat(40))).rejects.toThrow(/SHA|sha|build/);
  });
  it("retains the phone document SHA alongside its focus observation", async () => {
    expect(await observe(expectedSha)).toMatchObject({ documentSha: expectedSha, hatSelectorPresent: false });
  });
});
