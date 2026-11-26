// @vitest-environment node
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { createSentryPrivacy } from "../src/lib/shared-core/sentryPrivacy.js";
import { sanitizeSentryEnvelope } from "../src/lib/sentryPrivacy.js";

const root = fileURLToPath(new URL("../", import.meta.url));
const sharedCore = join(root, "src/lib/shared-core");

// src/lib/shared-core holds the platform-neutral helpers the web app, the
// server functions and the native app share: feature switches, custom
// navigation links, the error-reporting privacy filter and the product brand
// (name, mark mode and official-service checks). Each module ships
// with a type declaration so the native TypeScript build reads the same API.
describe("shared-core helpers", () => {
  it("holds exactly the five shared modules, each with its declaration, and no imports from outside", () => {
    const names = readdirSync(sharedCore).sort();
    expect(names).toEqual([
      "brand.d.ts", "brand.js",
      "customNavLinks.d.ts", "customNavLinks.js",
      "featureSwitches.d.ts", "featureSwitches.js",
      "posthogPrivacy.d.ts", "posthogPrivacy.js",
      "sentryPrivacy.d.ts", "sentryPrivacy.js",
    ]);
    for (const name of names.filter((entry) => entry.endsWith(".js"))) {
      const source = readFileSync(join(sharedCore, name), "utf8");
      const specifiers = [...source.matchAll(/\bfrom\s+["']([^"']+)["']/g)].map((match) => match[1]);
      for (const specifier of specifiers) expect(specifier, name).toMatch(/^\.\/[A-Za-z]+\.js$/);
    }
  });

  it("keeps the local helper modules as thin adapters over the shared modules", () => {
    for (const [path, expected] of [
      ["src/lib/featureSwitches.js", 'export * from "./shared-core/featureSwitches.js";\n'],
      ["src/lib/customNavLinks.js", 'export * from "./shared-core/customNavLinks.js";\n'],
      ["apps/mobile/src/lib/featureSwitches.ts", 'export * from "../../../../src/lib/shared-core/featureSwitches.js";\n'],
      ["apps/mobile/src/lib/customNavLinks.ts", 'export * from "../../../../src/lib/shared-core/customNavLinks.js";\n'],
    ]) expect(readFileSync(join(root, path), "utf8"), path).toBe(expected);
    // The Sentry adapter adds only this product's fixed SDK identity.
    const sentry = readFileSync(join(root, "src/lib/sentryPrivacy.js"), "utf8");
    expect(sentry).toContain('createSentryPrivacy("sentry.javascript.unionground-private-errors")');
    expect(sentry).not.toMatch(/function sanitizeEnvelope|ERROR_TYPES|beforeSend:/);
  });

  it("rejects arbitrary SDK identities and keeps product identity outside event scope", () => {
    expect(() => createSentryPrivacy("private user text")).toThrow(TypeError);
    const envelope = [{ sdk: { name: "private user text" } }, [[{ type: "event" }, { message: "private user text" }]]];
    const clean = sanitizeSentryEnvelope(envelope);
    expect(clean[0].sdk.name).toBe("sentry.javascript.unionground-private-errors");
    expect(clean[1][0][1].sdk.name).toBe("sentry.javascript.unionground-private-errors");
    expect(JSON.stringify(clean)).not.toContain("private user text");
    expect(clean[1][0][1].user).toEqual({ geo: { lookup: "disabled" } });
  });
});
