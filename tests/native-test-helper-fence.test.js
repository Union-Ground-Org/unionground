// @vitest-environment node
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { runInNewContext } from "node:vm";
import { describe, expect, it } from "vitest";

const root = fileURLToPath(new URL("..", import.meta.url));
const configFile = resolve(root, "apps/mobile/metro.config.js");
function metroConfig() {
  const module = { exports: {} };
  runInNewContext(readFileSync(configFile, "utf8"), {
    module, __dirname: dirname(configFile),
    // This edition's config folds the brand variables into Metro's cache key.
    process: { env: {} },
    require: (name) => name === "expo/metro-config"
      ? { getDefaultConfig: () => ({ transformer: {}, resolver: {} }) }
      : name === "path" ? { resolve, join: (...parts) => resolve(...parts), sep: "/" } : undefined,
  }, { filename: configFile });
  return module.exports;
}

describe("native protocol fixtures cannot enter a production bundle (#9256 R1 item 6)", () => {
  it("blocks the writer fixture and its whole test-helper directory in the real Metro config", () => {
    const config = metroConfig();
    for (const name of ["stubSessionWriter.ts", "reactNativeStandIn.tsx", "uiStandIn.tsx"]) {
      const file = resolve(root, "apps/mobile/src/testing", name);
      expect(config.resolver.blockList.some((pattern) => pattern.test(file)), name).toBe(true);
    }
    expect(config.resolver.blockList.some((pattern) => pattern.test(resolve(root, "apps/mobile/src/services/supabase.ts")))).toBe(false);
  });
  it("keeps the real-client and screen-ownership regressions independent of the permissive protocol fixture", () => {
    for (const file of ["services/onlineWriters.session.test.ts", "services/peerConversations.session.test.ts", "features/onlineWriteContinuation.screen.test.tsx"]) {
      const source = readFileSync(resolve(root, "apps/mobile/src", file), "utf8");
      expect(source, file).not.toMatch(/from\s*['"][^'"]*stubSessionWriter/);
      expect(source, file).toMatch(/createSessionBoundWriter|captureSessionWriter/);
    }
  });
});
