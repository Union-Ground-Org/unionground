import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { runnerTimeoutMultiplier } from "./scripts/lib/runner-timeout.mjs";

const root = dirname(fileURLToPath(import.meta.url));
const mutate = [
  "src/lib/commandPalette.js",
  "src/lib/kanban.js",
  "src/lib/observabilityPrivacy.js",
  "src/lib/outbox.js",
  "src/lib/sessionGuard.js",
];

for (const mutationPath of mutate) {
  if (!existsSync(resolve(root, mutationPath))) {
    throw new Error(`Stryker mutate path does not exist: ${mutationPath}`);
  }
}

export default {
  testRunner: "vitest",
  vitest: { configFile: "vite.config.mjs" },
  mutate,
  thresholds: { high: 80, low: 70, break: 60 },
  // progress-append-only writes one dated line per progress tick without
  // carriage returns, so hosted logs retain the measured mutant rate.
  reporters: ["clear-text", "progress-append-only", "html", "json"],
  htmlReporter: { fileName: "reports/mutation/mutation.html" },
  jsonReporter: { fileName: "reports/mutation/mutation.json" },
  coverageAnalysis: "perTest",
  concurrency: 2,
  timeoutMS: 30000,
  // The initial (dry) run executes the whole suite once with per-test
  // coverage. It timed out at 15 minutes on GitHub's standard 2-vCPU runner
  // (run 39845317635), so it gets the same 3x budget as the tests there
  // (scripts/lib/runner-timeout.mjs). Self-hosted slots also need 45 minutes,
  // including controlled environments that omit CI_STANDARD_RUNNER.
  dryRunTimeoutMinutes: process.env.RUNNER_ENVIRONMENT === "self-hosted"
    ? 45 : 15 * runnerTimeoutMultiplier(),
  ignoreStatic: true,
};
