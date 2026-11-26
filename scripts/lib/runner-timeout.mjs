// Test time budgets for the runner a CI job is on.
//
// Every CI job here runs on GitHub's standard 2-vCPU, 8 GB runner
// (docs/contracts/ci.md). Budgets written for a developer machine do not fit
// it: on November 11, 2026 a 30 s test timed out on pull request #64, and the
// first run of the database lane (#81, run 43068498609) passed 2,227 of 2,228
// proofs and failed the one that carries a wall-clock budget, at a median of
// 4,335 ms against 4,000 ms.
//
// The sibling repository met the same runner on October 22, 2026, and its
// owner rule is the one applied here: fit the job to the runner, never move
// runners. Every budget is multiplied by 3 on a GitHub-hosted runner and left
// as written everywhere else, including ordinary local runs.
//
// GitHub sets RUNNER_ENVIRONMENT=github-hosted in every step of a hosted job.
// This repository reads no repository variable for its runner
// (tests/actions-runner-policy.test.js), so that marker is the only signal.
export const GITHUB_HOSTED_TIMEOUT_MULTIPLIER = 3;

export function runnerTimeoutMultiplier(env = process.env) {
  return env.RUNNER_ENVIRONMENT === "github-hosted" ? GITHUB_HOSTED_TIMEOUT_MULTIPLIER : 1;
}

// A test's or hook's budget in milliseconds on the current runner.
export function runnerTimeout(ms, env = process.env) {
  return ms * runnerTimeoutMultiplier(env);
}
