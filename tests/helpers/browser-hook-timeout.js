import { runnerTimeout } from "../../scripts/lib/runner-timeout.mjs";

// Browser suites launch Chromium in a beforeAll hook. On a Depot runner the
// first launch outran Vitest's 10 s hook default (run 40698708004,
// tests/pr1815-wave-a6-geometry.test.jsx: "Hook timed out in 10000ms"), so a
// launch hook gets 60 s, still scaled for the runner it is on.
export function browserHookTimeout(env = process.env) {
  return runnerTimeout(60_000, env);
}

export const BROWSER_HOOK_TIMEOUT = browserHookTimeout();
