// @vitest-environment node
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { baselineHistoryFailures, readBaselineHistory } from "../scripts/type-coverage-history.mjs";

const baseline = {
  schema: 1, minimum_coverage_percent: 98, new_file_minimum_percent: 95,
  maximum_suppressions: { tsNoCheck: 0, tsIgnore: 1, tsExpectError: 2, explicitAny: 3, asAny: 4, doubleAssertion: 5 },
  files: { "src/old.ts": 100 },
};
const roots = [];
afterEach(() => roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true })));
function repository() {
  const root = mkdtempSync(join(tmpdir(), "coverage-history-"));
  roots.push(root);
  const git = (...args) => execFileSync("git", args, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  git("init", "-b", "Main");
  git("config", "user.name", "Coverage test");
  git("config", "user.email", "coverage@example.invalid");
  writeFileSync(join(root, "README.md"), "fixture\n");
  git("add", "."); git("commit", "-m", "bootstrap");
  const bootstrap = git("rev-parse", "HEAD");
  const save = (value) => {
    mkdirSync(join(root, "apps/mobile"), { recursive: true });
    writeFileSync(join(root, "apps/mobile/type-coverage-baseline.json"), JSON.stringify(value));
    git("add", "."); git("commit", "-m", "baseline");
    return git("rev-parse", "HEAD");
  };
  return { root, git, bootstrap, save };
}

describe("historical mobile coverage floors", () => {
  it.each([
    ["deleted entry", { files: {} }],
    ["deleted and re-added at 95", { files: { "src/old.ts": 95 } }],
    ["lower aggregate", { minimum_coverage_percent: 97 }],
    ["lower new-file floor", { new_file_minimum_percent: 90 }],
    ["higher suppression ceiling", { maximum_suppressions: { ...baseline.maximum_suppressions, tsIgnore: 2 } }],
    ["new low-coverage file pre-recorded", { files: { ...baseline.files, "src/new.ts": 90 } }],
  ])("rejects %s even if the candidate measurement passes", (_label, patch) => {
    expect(baselineHistoryFailures({ ...baseline, ...patch }, [baseline]).length).toBeGreaterThan(0);
  });
  it("accepts new files and tighter floors while preserving retired path floors", () => {
    expect(baselineHistoryFailures({ ...baseline, minimum_coverage_percent: 99, files: { ...baseline.files, "src/new.ts": 96 } }, [baseline])).toEqual([]);
  });
  it("reads committed local HEAD even when the working baseline was edited", () => {
    const r = repository(); r.save(baseline);
    writeFileSync(join(r.root, "apps/mobile/type-coverage-baseline.json"), JSON.stringify({ ...baseline, files: {} }));
    expect(readBaselineHistory({ repositoryRoot: r.root, env: {} })).toEqual([baseline]);
  });
  it("also reads the exact local Main merge base after committing a lower floor", () => {
    const r = repository(); const base = r.save(baseline);
    r.git("update-ref", "refs/remotes/origin/Main", base);
    r.save({ ...baseline, files: { "src/old.ts": 95 } });
    expect(readBaselineHistory({ repositoryRoot: r.root, env: {} })).toContainEqual(baseline);
  });
  it.each(["pull_request", "push", "merge_group"])("binds %s to the event base and actual checkout", (eventName) => {
    const r = repository(); const base = r.save(baseline);
    const head = r.save({ ...baseline, files: { "src/old.ts": 95 } });
    const event = eventName === "pull_request" ? { pull_request: { base: { sha: base }, head: { sha: head } } }
      : eventName === "push" ? { before: base, after: head, forced: false }
        : { merge_group: { base_sha: base, head_sha: head } };
    const eventPath = join(r.root, "event.json"); writeFileSync(eventPath, JSON.stringify(event));
    const env = { GITHUB_ACTIONS: "true", GITHUB_EVENT_NAME: eventName, GITHUB_EVENT_PATH: eventPath, CI_BASE_SHA: base, CI_HEAD_SHA: head, GITHUB_SHA: head };
    expect(readBaselineHistory({ repositoryRoot: r.root, env })).toEqual([baseline]);
    expect(() => readBaselineHistory({ repositoryRoot: r.root, env: { ...env, CI_BASE_SHA: r.bootstrap } })).toThrow(/coordinates/);
    r.git("checkout", "--detach", base);
    expect(() => readBaselineHistory({ repositoryRoot: r.root, env })).toThrow(/checkout/);
  });
  it("allows an initial baseline only when an existing exact base tree proves absence", () => {
    const r = repository();
    expect(readBaselineHistory({ repositoryRoot: r.root, env: {} })).toEqual([]);
    expect(() => readBaselineHistory({ repositoryRoot: r.root, env: { GITHUB_ACTIONS: "true" } })).toThrow(/event/);
  });
  it("rejects missing base objects and malformed historical baselines", () => {
    const r = repository(); const head = r.save(baseline);
    const base = "1".repeat(40);
    const eventPath = join(r.root, "event.json");
    writeFileSync(eventPath, JSON.stringify({ before: base, after: head }));
    expect(() => readBaselineHistory({ repositoryRoot: r.root, env: { GITHUB_ACTIONS: "true", GITHUB_EVENT_NAME: "push", GITHUB_EVENT_PATH: eventPath, GITHUB_SHA: head } })).toThrow(/Git history/);
    r.save({ files: {} });
    expect(() => readBaselineHistory({ repositoryRoot: r.root, env: {} })).toThrow(/historical baseline/);
  });
});
