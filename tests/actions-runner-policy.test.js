// @vitest-environment node

import { readFileSync, readdirSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parseDocument } from "yaml";
import { siblingIdentityIn } from "../scripts/lib/sibling-deny-list.mjs";

// Every job names GitHub's standard ubuntu-24.04 runner. A label no
// machine serves leaves the required check queued. See docs/contracts/ci.md.

const GITHUB_STANDARD_RUNNER = "ubuntu-24.04";

const workflowDirectory = new URL("../.github/workflows/", import.meta.url);
const actionlintConfigPath = new URL("../.github/actionlint.yaml", import.meta.url);

function loadYaml(source, label) {
  const document = parseDocument(source);
  expect(document.errors, `${label} must be valid YAML`).toEqual([]);
  // An unquoted `!cancelled()` in an `if` is an unresolved YAML tag that the
  // parser drops with only a warning, silently changing the condition.
  expect(document.warnings, `${label} must parse without YAML warnings`).toEqual([]);
  return document.toJS();
}

const workflowFileNames = () => readdirSync(workflowDirectory).filter((name) => /\.ya?ml$/.test(name)).sort();
const workflowSource = (fileName) => readFileSync(new URL(fileName, workflowDirectory), "utf8");
// Composite actions the workflows call (.github/actions/<name>/), every file in
// each: they run inside a workflow's job, so the same rules bind them.
const actionsDirectory = new URL("../.github/actions/", import.meta.url);
const actionFiles = () => readdirSync(actionsDirectory, { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .flatMap((entry) => readdirSync(new URL(`${entry.name}/`, actionsDirectory)).map((name) => `${entry.name}/${name}`))
  .sort();
const actionSource = (path) => readFileSync(new URL(path, actionsDirectory), "utf8");
const uncommented = (source) => source.split("\n").filter((line) => !/^\s*#/.test(line)).join("\n");
// The sibling product's hosts and Supabase refs, listed by digest
// (config/sample-backend.json; tests/provider-boundary.test.js).

// The one exception (docs/contracts/mobile-release.md): the hand-dispatched
// iOS release workflow reads EXPO_TOKEN, stored only on its protected
// environment. Nothing else in it, and nothing in any other file, may read a
// secret or name an environment; tests/mobile-ios-eas-dispatch.test.js pins
// which steps carry the token.
const RELEASE_WORKFLOW = "mobile-ios-eas.yml";
function withoutReleaseSecret(label, code) {
  if (label !== RELEASE_WORKFLOW) return code;
  return code
    .replaceAll("EXPO_TOKEN: ${{ secrets.EXPO_TOKEN }}", "")
    .replace(/^ {4}environment: mobile-ios-release$/gm, "");
}

// Every job's runner problem, or none. A job must name GitHub's standard
// runner as a plain string: no expression, no label list, no group, no
// self-hosted, larger or third-party label.
function runnerProblems(workflow, fileName) {
  const problems = [];
  for (const [jobName, job] of Object.entries(workflow?.jobs ?? {})) {
    if (job?.uses) {
      problems.push(`${fileName}:${jobName} calls a reusable workflow; run its steps here instead`);
      continue;
    }
    if (job?.["runs-on"] !== GITHUB_STANDARD_RUNNER) {
      problems.push(`${fileName}:${jobName} runs on ${JSON.stringify(job?.["runs-on"])}, not ${GITHUB_STANDARD_RUNNER}`);
    }
  }
  return problems;
}

describe("Actions runner policy", () => {
  it("finds the workflows it polices", () => {
    expect(workflowFileNames()).toEqual(expect.arrayContaining([
      "ci.yml", "coverage-weekly.yml", "dependency-audit-daily.yml", "mobile-ios-eas.yml",
    ]));
    expect(actionFiles()).toEqual(expect.arrayContaining(["watcher-red/action.yml", "watcher-red/watcher-red.sh"]));
  });

  it("runs every job of every workflow on GitHub's standard ubuntu-24.04 runner", () => {
    const problems = workflowFileNames().flatMap((fileName) =>
      runnerProblems(loadYaml(workflowSource(fileName), fileName), fileName));
    expect(problems).toEqual([]);
  });

  it("refuses every other runner form", () => {
    const refused = [
      "blacksmith-2vcpu-ubuntu-2404",
      "depot-ubuntu-24.04",
      "ubuntu-latest",
      "ubuntu-24.04-arm",
      "ubuntu-latest-8-cores",
      "self-hosted",
      ["self-hosted", "linux"],
      "${{ vars.CI_STANDARD_RUNNER || 'ubuntu-24.04' }}",
      { group: "larger-runners" },
      undefined,
    ];
    for (const runner of refused) {
      expect(runnerProblems({ jobs: { lane: { "runs-on": runner } } }, "fixture.yml"), JSON.stringify(runner)).toHaveLength(1);
    }
    expect(runnerProblems({ jobs: { lane: { uses: "./.github/workflows/other.yml" } } }, "fixture.yml")).toHaveLength(1);
    expect(runnerProblems({ jobs: { lane: { "runs-on": GITHUB_STANDARD_RUNNER } } }, "fixture.yml")).toEqual([]);
  });

  it("reads no repository variable and names no runner switch in any workflow or action", () => {
    const sources = [
      ...workflowFileNames().map((fileName) => [fileName, workflowSource(fileName)]),
      ...actionFiles().map((path) => [`actions/${path}`, actionSource(path)]),
    ];
    for (const [label, source] of sources) {
      // The one exception: the iOS release reads its own identity (never a
      // runner) from three repository variables (docs/contracts/mobile-release.md).
      const code = uncommented(source);
      const identityVariables = label === "mobile-ios-eas.yml" ? /\bvars\.(?:EXPO_OWNER|EAS_PROJECT_ID|MOBILE_APPLICATION_ID)\b/g : null;
      expect(identityVariables ? code.replace(identityVariables, "") : code, label).not.toMatch(/\bvars\./);
      expect(code, label).not.toMatch(/CI_(?:STANDARD|GROUP|LARGE|FAST)_RUNNER|ci-runner-switch/);
      expect(code, label).not.toMatch(/blacksmith|depot-ubuntu|ug-local|self-hosted/i);
    }
  });

  it("reads no secret beyond the run's own token and names none of the sibling product's hosts", () => {
    const sources = [
      ...workflowFileNames().map((fileName) => [fileName, workflowSource(fileName)]),
      ...actionFiles().map((path) => [`actions/${path}`, actionSource(path)]),
    ];
    for (const [label, source] of sources) {
      expect(withoutReleaseSecret(label, uncommented(source)), label).not.toMatch(/\bsecrets\.|SUPABASE_DB_URL|SLACK_WEBHOOK|environment:/);
      expect(siblingIdentityIn(source), `${label} names a sibling target`).toEqual([]);
    }
  });

  it("lets only the release workflow read only EXPO_TOKEN on its own environment", () => {
    const banned = /\bsecrets\.|environment:/;
    const token = "        EXPO_TOKEN: ${{ secrets.EXPO_TOKEN }}";
    expect(withoutReleaseSecret(RELEASE_WORKFLOW, `${token}\n    environment: mobile-ios-release`)).not.toMatch(banned);
    expect(withoutReleaseSecret("ci.yml", token)).toMatch(banned);
    expect(withoutReleaseSecret(RELEASE_WORKFLOW, "        PLAY_KEY: ${{ secrets.PLAY_KEY }}")).toMatch(banned);
    expect(withoutReleaseSecret(RELEASE_WORKFLOW, "        TOKEN: ${{ secrets.EXPO_TOKEN_2 }}")).toMatch(banned);
    expect(withoutReleaseSecret(RELEASE_WORKFLOW, "    environment: production")).toMatch(banned);
  });

  it("keeps Actionlint free of custom labels and repository variables", () => {
    const config = loadYaml(readFileSync(actionlintConfigPath, "utf8"), ".github/actionlint.yaml");
    expect(config["self-hosted-runner"]?.labels).toEqual([]);
    expect(config["config-variables"]).toEqual([]);
  });
});
