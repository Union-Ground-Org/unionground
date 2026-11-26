// @vitest-environment node
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { captureHistorySnapshot, gitleaksArguments } from "../scripts/run-security-scan.mjs";
import { loadPolicy } from "../scripts/lib/security-scanner-policy.mjs";

const roots = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "security-history-refs-")); roots.push(root);
  const git = (...args) => execFileSync("git", args, { cwd: root, encoding: "utf8", stdio: "pipe" }).trim();
  git("init", "-b", "Main"); git("config", "user.name", "Fixture"); git("config", "user.email", "fixture@example.invalid");
  writeFileSync(join(root, "source.txt"), "base\n"); git("add", "."); git("commit", "-m", "base");
  return { root, git };
}

describe("immutable all-ref history scan source", () => {
  it("keeps off-Main branch and tag coverage stable when their refs subsequently move", () => {
    const { root, git } = fixture(), policy = loadPolicy(), main = git("rev-parse", "HEAD");
    git("checkout", "-b", "independent");
    writeFileSync(join(root, "branch.txt"), "branch\n"); git("add", "."); git("commit", "-m", "branch before capture");
    const branch = git("rev-parse", "HEAD"); git("tag", "retained-tag"); git("checkout", "Main");
    const snapshot = captureHistorySnapshot(policy, { root, expectedSourceSha: main });
    const args = gitleaksArguments(policy, { history: true, historySnapshot: snapshot });
    const opts = args.find(value => value.startsWith("--log-opts=")).slice("--log-opts=".length).split(" ");
    const before = git("log", "--format=%H", ...opts).split("\n");
    expect(before).toContain(branch); expect(before).toContain(main);
    git("checkout", "independent"); writeFileSync(join(root, "later.txt"), "later\n"); git("add", "."); git("commit", "-m", "after capture");
    const later = git("rev-parse", "HEAD"); git("tag", "-f", "retained-tag"); git("checkout", "Main");
    expect(git("log", "--format=%H", ...opts).split("\n")).toEqual(before);
    expect(before).not.toContain(later);
    expect(opts).not.toContain("--all");
    expect(snapshot.policy_source_sha).toBe(main);
    expect(snapshot.refs).toContainEqual(["refs/heads/independent", branch]);
  });
  it("rejects a checkout differing from the event policy source", () => {
    const { root } = fixture();
    expect(() => captureHistorySnapshot(loadPolicy(), { root, expectedSourceSha: "f".repeat(40) })).toThrow(/history source/);
  });
  it("refuses history execution without a frozen source snapshot", () => {
    expect(() => gitleaksArguments(loadPolicy(), { history: true })).toThrow(/snapshot/);
  });
  it("rejects malformed revision arguments and excessive snapshot roots", () => {
    const policy = loadPolicy(), snapshot = { schema: 1, policy_source_sha: "a".repeat(40), history_commit_budget: policy.scanners.gitleaks.history_commit_budget, refs: [["HEAD", "--all"]] };
    expect(() => gitleaksArguments(policy, { history: true, historySnapshot: snapshot })).toThrow(/snapshot/);
    snapshot.refs = Array.from({ length: 2050 }, (_, index) => [`refs/heads/branch-${index}`, "a".repeat(40)]);
    expect(() => gitleaksArguments(policy, { history: true, historySnapshot: snapshot })).toThrow(/snapshot/);
  });
});
