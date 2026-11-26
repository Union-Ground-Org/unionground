// @vitest-environment node
// OPS-UG-PRODUCTION-DEPLOY-STEP-GREW-FROM-6-TO-15-MINUTES-20261110:
// Vercel traces every api/*.js function separately, and each one reaches
// @sentry/node through api/_lib/observability.js. When @sentry/vite-plugin's
// older @sentry/core holds the hoisted slot, npm nests a fresh @sentry/core
// under every @sentry/* package, and each function traced four copies of it
// (3,298 files instead of 1,882). Production builds went from about 5 to
// about 9 minutes on October 22 and November 2, 2026, the two times a
// dependency bump left those nested copies, and back on October 26 when one
// removed them. With @sentry/bundler-plugins at @sentry/node's version (inside
// @sentry/vite-plugin's ^10.76.0 range) both ask for the same @sentry/core, so
// npm hoists one copy. No override: npm 10 (CI) and npm 11 resolve a nested
// override differently. Since OPS-UG-SERVER-SENTRY-NODE-CORE-LIGHT-20261113
// the functions import @sentry/core directly, a pinned dependency that must be
// the hoisted copy @sentry/react shares.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const manifest = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
const lock = JSON.parse(readFileSync(new URL("../package-lock.json", import.meta.url), "utf8"));

describe("one shared @sentry/core for the server and browser Sentry SDKs", () => {
  it("hoists the server's pinned @sentry/core and nests no other runtime copy", () => {
    expect(lock.packages["node_modules/@sentry/core"].version).toBe(manifest.dependencies["@sentry/core"]);
    expect(manifest.dependencies).not.toHaveProperty("@sentry/node");
    // Lighthouse keeps its own Sentry 11 copies: development-only packages
    // never ship in a function.
    const nested = Object.entries(lock.packages)
      .filter(([path, entry]) => path.endsWith("/node_modules/@sentry/core") && !entry.dev)
      .map(([path]) => path);
    expect(nested).toEqual([]);
  });
});
