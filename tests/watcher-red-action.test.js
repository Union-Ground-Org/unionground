// @vitest-environment node
import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

// The shared red-run tracker every scheduled workflow uses
// (.github/actions/watcher-red; docs/contracts/ci.md, "Scheduled assurance").
// Ported from the sibling repository's test without the alert webhook: here the
// issue is the alert. A stub `gh` records every call, so nothing reaches GitHub.

const repoRoot = new URL("..", import.meta.url).pathname;
const scriptPath = join(repoRoot, ".github/actions/watcher-red/watcher-red.sh");

describe("watcher-red issue scope", () => {
  it("files one labelled watcher-red issue and calls no webhook", () => {
    const action = readFileSync(join(repoRoot, ".github/actions/watcher-red/action.yml"), "utf8");
    const script = readFileSync(scriptPath, "utf8");
    expect(script).toContain("label=watcher-red");
    expect(script).toContain('title="watcher-red: $WATCHER"');
    expect(`${action}\n${script}`).not.toMatch(/curl|webhook_url|SLACK/iu);
  });
});

describe("watcher-red transitions", () => {
  const roots = [];
  afterEach(() => { while (roots.length) rmSync(roots.pop(), { recursive: true, force: true }); });

  const run = ({ conclusion, open = [], closed = [] }) => {
    const root = mkdtempSync(join(tmpdir(), "watcher-red-")); roots.push(root);
    const bin = join(root, "bin");
    mkdirSync(bin);
    const ghLog = join(root, "gh.log");
    writeFileSync(join(root, "open.json"), JSON.stringify(open));
    writeFileSync(join(root, "closed.json"), JSON.stringify(closed));
    writeFileSync(join(bin, "gh"), `#!/usr/bin/env bash
printf '%s\\n' "$*" >> "${ghLog}"
case "$*" in
  *"issues?state=open"*) cat "${join(root, "open.json")}" ;;
  *"issues?state=closed"*) cat "${join(root, "closed.json")}" ;;
  *) echo '{}' ;;
esac
`);
    chmodSync(join(bin, "gh"), 0o755);
    const output = join(root, "output"), summary = join(root, "summary");
    execFileSync("bash", [scriptPath], { env: { PATH: `${bin}:${process.env.PATH}`, GH_REPO: "o/r", GH_TOKEN: "t",
      WATCHER: "Weekly full root coverage", CONCLUSION: conclusion,
      RUN_URL: "https://github.com/o/r/actions/runs/1", RUN_SHA: "a".repeat(40), RUN_EVENT: "schedule",
      GITHUB_OUTPUT: output, GITHUB_STEP_SUMMARY: summary } });
    const read = (file) => { try { return readFileSync(file, "utf8"); } catch { return ""; } };
    return { transition: read(output).trim(), gh: read(ghLog), summary: read(summary) };
  };
  const openIssue = [{ number: 42, title: "watcher-red: Weekly full root coverage" }, { number: 43, title: "watcher-red: Weekly full root coverage 2" }];

  it("opens one labelled issue on a green-to-red change", () => {
    const result = run({ conclusion: "failure" });
    expect(result.transition).toBe("transition=opened");
    expect(result.gh).toMatch(/-X POST repos\/o\/r\/issues -f title=watcher-red: Weekly full root coverage .* -f labels\[\]=watcher-red/su);
    expect(result.summary).toContain("transition opened");
  });

  it("reopens the watcher's newest closed issue instead of filing another", () => {
    const result = run({ conclusion: "failure", closed: [{ number: 41, title: "watcher-red: Weekly full root coverage 2" }, { number: 40, title: "watcher-red: Weekly full root coverage" }] });
    expect(result.transition).toBe("transition=reopened");
    expect(result.gh).toMatch(/-X PATCH repos\/o\/r\/issues\/40 -f state=open -f body=/u);
    expect(result.gh).not.toMatch(/-X POST repos\/o\/r\/issues /u);
  });

  it("refreshes the open issue silently while it stays red", () => {
    const result = run({ conclusion: "failure", open: openIssue });
    expect(result.transition).toBe("transition=still-red");
    expect(result.gh).toMatch(/-X PATCH repos\/o\/r\/issues\/42 -f body=/u);
    expect(result.gh).not.toMatch(/-X POST repos\/o\/r\/issues/u);
  });

  it("closes the issue on the next green run", () => {
    const result = run({ conclusion: "success", open: openIssue });
    expect(result.transition).toBe("transition=closed");
    expect(result.gh).toMatch(/-X POST repos\/o\/r\/issues\/42\/comments/u);
    expect(result.gh).toMatch(/-X PATCH repos\/o\/r\/issues\/42 -f state=closed -f state_reason=completed/u);
  });

  it.each([["success", []], ["skipped", openIssue], ["cancelled", []]])("changes nothing on %s with %j open", (conclusion, open) => {
    const result = run({ conclusion, open });
    expect(result.transition).toBe("transition=none");
    expect(result.gh).not.toMatch(/-X (POST|PATCH)/u);
  });
});
