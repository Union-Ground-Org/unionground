// @vitest-environment node
import { fileURLToPath } from "node:url";
import { build } from "vite";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import configure from "../vite.config.mjs";

beforeEach(() => vi.stubEnv("NODE_ENV", "production"));
afterEach(() => vi.unstubAllEnvs());

it.each([
  ["without a DSN", undefined, false],
  ["with a DSN", "https://public@o0.ingest.us.sentry.io/1", true],
])("ships SDK initialization only when configured: %s", async (_label, dsn, configured) => {
  vi.stubEnv("VITE_SENTRY_DSN", dsn);
  const config = configure({ mode: "production" });
  const { target, rolldownOptions } = config.build;
  const observability = fileURLToPath(new URL("../src/lib/observability.js", import.meta.url));
  const entry = "virtual:observability-boot";
  const result = await build({
    configFile: false,
    envFile: false,
    logLevel: "silent",
    oxc: config.oxc,
    define: {
      ...config.define,
      __BUILD_SHA__: JSON.stringify("test-build"),
    },
    plugins: [config.plugins.find((plugin) => plugin.name === "unconfigured-sentry-dead-code"), {
      name: "observability-boot-fixture",
      resolveId(id) { return id === entry ? id : null; },
      load(id) {
        return id === entry ? `
          import { initObservability } from ${JSON.stringify(observability)};
          initObservability();
        ` : null;
      },
    }],
    build: {
      write: false,
      target,
      rolldownOptions: {
        ...rolldownOptions,
        input: entry,
        output: { ...rolldownOptions.output, format: "es" },
      },
    },
  });
  const output = [result].flat().flatMap((bundle) => bundle.output);
  const modules = output.filter((item) => item.type === "chunk")
    .flatMap((chunk) => Object.entries(chunk.modules)
      .filter(([, module]) => module.renderedLength > 0).map(([id]) => id));
  // Exercise the real SDK and production optimizer: an unconfigured build
  // never initializes a client. (This edition's root error boundary is its own
  // RootErrorBoundary and the Sentry namespace is private to observability.js.)
  expect(modules.some((id) => id.includes("/@sentry/core/") && id.endsWith("/client.js"))).toBe(configured);
  expect(modules.some((id) => id.includes("/@sentry/browser/") && id.endsWith("/sdk.js"))).toBe(configured);
});
