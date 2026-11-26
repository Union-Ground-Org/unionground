import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  compareCoverage,
  changedFiles,
  isCoverageEligible,
  localChangedFiles,
  normalizeCoverageSummary,
  readJson,
  raiseBaseline,
  resolveCoverageRefs,
  trackedFileCheck,
  trackedSourceFiles,
} from "../scripts/verify-coverage-ratchet.mjs";

const metrics = (lines, functions = lines, branches = lines, statements = lines) => ({
  lines: { pct: lines },
  functions: { pct: functions },
  branches: { pct: branches },
  statements: { pct: statements },
});

const fixtureProjects = [];

function removeFixtureProjects() {
  for (const path of fixtureProjects.splice(0)) rmSync(path, { recursive: true, force: true });
}

function fixtureProject(prefix = "coverage-ratchet-") {
  const project = mkdtempSync(join(tmpdir(), prefix));
  fixtureProjects.push(project);
  return project;
}

afterEach(removeFixtureProjects);

function exactRangeEnv(project) {
  const [headSha, baseSha] = execFileSync("git", ["rev-list", "--max-count=2", "HEAD"], {
    cwd: project,
    encoding: "utf8",
  }).trim().split("\n");
  return {
    ...process.env,
    ASSURANCE_BASE_REF: baseSha,
    ASSURANCE_HEAD_REF: headSha,
  };
}

function localRangeEnv() {
  const env = { ...process.env };
  delete env.ASSURANCE_BASE_REF;
  delete env.ASSURANCE_HEAD_REF;
  return env;
}

describe("normalizeCoverageSummary", () => {
  it("normalizes absolute paths and Windows separators to repository-relative paths", () => {
    const normalized = normalizeCoverageSummary({
      total: metrics(90),
      "/workspace/unionground/src/lib/kanban.js": metrics(75),
      "C:\\repo\\src\\lib\\commands.js": metrics(82),
    }, "/workspace/unionground");

    expect(normalized).toEqual({
      total: metrics(90),
      files: {
        "src/lib/kanban.js": metrics(75),
        "C:/repo/src/lib/commands.js": metrics(82),
      },
    });

    expect(normalizeCoverageSummary({
      total: metrics(90),
      "C:\\repo\\src\\lib\\commands.js": metrics(82),
    }, "C:\\repo").files).toEqual({
      "src/lib/commands.js": metrics(82),
    });
  });

  it("rejects a malformed summary instead of silently accepting no coverage", () => {
    expect(() => normalizeCoverageSummary(null, "/repo"))
      .toThrow("Coverage summary must be an object");
    expect(() => normalizeCoverageSummary({ files: {} }, "/repo"))
      .toThrow("Coverage summary is missing total");
  });

  it("rejects a missing or non-numeric required metric", () => {
    const missingFunctions = metrics(90);
    delete missingFunctions.functions;

    expect(() => normalizeCoverageSummary({ total: missingFunctions }, "/repo"))
      .toThrow("Coverage summary total is missing functions.pct");
    expect(() => normalizeCoverageSummary({ total: metrics("unknown") }, "/repo"))
      .toThrow("Coverage summary total has invalid lines.pct");
  });
});

describe("isCoverageEligible", () => {
  it("requires coverage for Vercel API handlers and their shared helpers", () => {
    expect(isCoverageEligible("api/account-lifecycle.js")).toBe(true);
    expect(isCoverageEligible("api/_lib/backend.js")).toBe(true);
    expect(isCoverageEligible("api/public/event-rsvp.js")).toBe(true);
  });

  it("excludes API test and spec files the same way src and workers are excluded", () => {
    expect(isCoverageEligible("api/account-lifecycle.test.js")).toBe(false);
    expect(isCoverageEligible("api/_lib/backend.spec.js")).toBe(false);
  });

  // The integration router worker is TypeScript, so a JavaScript-only worker
  // rule let ~900 lines of webhook routing sit outside the ratchet entirely
  // (Union Ground ships no workers/ tree; the rule stays for one).
  it("requires coverage for worker TypeScript, not only worker JavaScript", () => {
    expect(isCoverageEligible("workers/service-integration-router/index.ts")).toBe(true);
    expect(isCoverageEligible("workers/service-integration-router/signatures.ts")).toBe(true);
    expect(isCoverageEligible("workers/posthog-proxy/worker.js")).toBe(true);
  });

  it("excludes ambient declarations and TypeScript suites that carry no runtime code", () => {
    expect(isCoverageEligible("workers/service-integration-router/runtime-types.d.ts")).toBe(false);
    expect(isCoverageEligible("workers/service-integration-router/worker-configuration.d.ts")).toBe(false);
    expect(isCoverageEligible("workers/service-integration-router/index.test.ts")).toBe(false);
  });
});

describe("trackedSourceFiles", () => {
  // Union Ground carries no workers/ tree, so the tracked set is anchored on
  // the API handlers and src/ runtime modules, and on the ambient declarations
  // under src/ that carry no runtime code.
  it("demands coverage for every tracked runtime module and none of the declarations", () => {
    const tracked = trackedSourceFiles();
    const trackedSet = new Set(tracked);

    expect(trackedSet).toContain("api/_lib/backend.js");
    expect(tracked.some((file) => file.startsWith("src/"))).toBe(true);
    for (const declaration of [
      "src/lib/sentryPrivacy.d.ts",
      "src/lib/sourceLine.d.ts",
      "src/lib/trustedBackends.d.ts",
    ]) {
      expect(trackedSet).not.toContain(declaration);
    }
    expect(tracked.every((file) => isCoverageEligible(file))).toBe(true);
  });
});

describe("vitest coverage instrumentation", () => {
  // Eligibility and instrumentation are declared in two files; when they drift
  // the ratchet either demands coverage nothing measures or silently measures
  // nothing at all. Keep the worker half of the two lists in step.
  it("instruments the worker TypeScript the ratchet holds to the baseline", () => {
    // Read rather than import: vite.config.mjs pulls in esbuild, which refuses
    // to load under this suite's jsdom environment.
    const source = readFileSync(resolve("vite.config.mjs"), "utf8");
    const coverage = source.slice(source.indexOf("coverage: {"));
    const globs = (key) => JSON.parse(new RegExp(`\\b${key}: (\\[[^\\]]*\\])`).exec(coverage)[1]);
    const [include, exclude] = [globs("include"), globs("exclude")];
    const expandBraces = (glob) => {
      const braces = /^(.*)\{([^{}]*)\}(.*)$/.exec(glob);
      return braces ? braces[2].split(",").map((option) => `${braces[1]}${option}${braces[3]}`) : [glob];
    };

    expect(include.flatMap(expandBraces)).toEqual(expect.arrayContaining([
      "workers/**/*.js",
      "workers/**/*.ts",
    ]));
    expect(exclude).toContain("**/*.d.ts");
  });
});

describe("compareCoverage", () => {
  it("fails a global metric regression larger than 0.1 percentage points", () => {
    const findings = compareCoverage({
      current: { total: metrics(79.89), files: {} },
      baseline: { total: metrics(80), files: {} },
      changedFiles: [],
    });

    expect(findings).toEqual([
      expect.objectContaining({
        lane: "global",
        metric: "lines",
        expected: 79.9,
        actual: 79.89,
      }),
      expect.objectContaining({ lane: "global", metric: "functions" }),
      expect.objectContaining({ lane: "global", metric: "branches" }),
      expect.objectContaining({ lane: "global", metric: "statements" }),
    ]);
  });

  it("accepts a global regression exactly on the 0.1 percentage-point boundary", () => {
    expect(compareCoverage({
      current: { total: metrics(89.9), files: {} },
      baseline: { total: metrics(90), files: {} },
      changedFiles: [],
    })).toEqual([]);
  });

  it("tolerates run-to-run noise in the totals while holding a changed file to 0.01", () => {
    const current = { total: metrics(89.95), files: { "src/lib/kanban.js": metrics(74.98) } };
    const baseline = { total: metrics(90), files: { "src/lib/kanban.js": metrics(75) } };

    const findings = compareCoverage({ current, baseline, changedFiles: ["src/lib/kanban.js"] });
    expect(findings.map((finding) => finding.lane)).toEqual(["changed-file", "changed-file", "changed-file", "changed-file"]);
    expect(findings[0]).toEqual(expect.objectContaining({ file: "src/lib/kanban.js", metric: "lines", actual: 74.98 }));
    expect(findings[0].expected).toBeCloseTo(74.99, 10);
  });

  it("fails an existing changed file regression but ignores the same unchanged file", () => {
    const current = { total: metrics(90), files: { "src/lib/kanban.js": metrics(74) } };
    const baseline = { total: metrics(90), files: { "src/lib/kanban.js": metrics(75) } };

    expect(compareCoverage({ current, baseline, changedFiles: ["src\\lib\\kanban.js"] }))
      .toEqual([
        expect.objectContaining({ lane: "changed-file", file: "src/lib/kanban.js", metric: "lines" }),
        expect.objectContaining({ lane: "changed-file", file: "src/lib/kanban.js", metric: "functions" }),
        expect.objectContaining({ lane: "changed-file", file: "src/lib/kanban.js", metric: "branches" }),
        expect.objectContaining({ lane: "changed-file", file: "src/lib/kanban.js", metric: "statements" }),
      ]);
    expect(compareCoverage({ current, baseline, changedFiles: [] })).toEqual([]);
  });

  it("enforces the 80/80/70/80 floor on a new production file", () => {
    const findings = compareCoverage({
      current: { total: metrics(90), files: { "src/lib/new.js": metrics(79, 79, 69, 79) } },
      baseline: { total: metrics(90), files: {} },
      changedFiles: ["src/lib/new.js"],
    });

    expect(findings.map((item) => item.metric)).toEqual([
      "lines",
      "functions",
      "branches",
      "statements",
    ]);
    expect(findings).toEqual(expect.arrayContaining([
      expect.objectContaining({ lane: "new-file", file: "src/lib/new.js", metric: "branches", expected: 70, actual: 69 }),
    ]));
  });

  it("uses caller-supplied epsilon and new-file floors", () => {
    expect(compareCoverage({
      current: { total: metrics(89.94), files: { "workers/new.js": metrics(59) } },
      baseline: { total: metrics(90), files: {} },
      changedFiles: ["workers/new.js"],
      epsilon: 0.1,
      newFileMinimums: { lines: 60, functions: 60, branches: 60, statements: 60 },
    })).toEqual([
      expect.objectContaining({ lane: "new-file", metric: "lines", expected: 60 }),
      expect.objectContaining({ lane: "new-file", metric: "functions", expected: 60 }),
      expect.objectContaining({ lane: "new-file", metric: "branches", expected: 60 }),
      expect.objectContaining({ lane: "new-file", metric: "statements", expected: 60 }),
    ]);
  });

  it("fails closed for the current Dialog baseline case and any eligible changed file absent from coverage", () => {
    const findings = compareCoverage({
      current: { total: metrics(90), files: { "src/components/Dialogs.jsx": metrics(90) } },
      baseline: { total: metrics(90), files: { "src/components/Dialogs.jsx": metrics(90) } },
      changedFiles: ["src/components/Dialog.jsx", "workers/new/worker.js"],
    });

    expect(findings).toEqual([
      { lane: "missing-coverage", file: "src/components/Dialog.jsx" },
      { lane: "missing-coverage", file: "workers/new/worker.js" },
    ]);
  });

  // DEBT-UG-COVERAGE-RATCHET-OMITS-INTEGRATION-ROUTER-WORKER-20260921: a
  // changed worker TypeScript module that the coverage run never measured must
  // fail the ratchet, exactly like worker JavaScript; its ambient declarations
  // and TypeScript suites carry no runtime code and stay out.
  it("fails a changed worker TypeScript file that has no coverage summary entry", () => {
    const findings = compareCoverage({
      current: { total: metrics(90), files: {} },
      baseline: { total: metrics(90), files: {} },
      changedFiles: [
        "workers/service-integration-router/providers.ts",
        "workers/service-integration-router/worker-configuration.d.ts",
        "workers/service-integration-router/providers.test.ts",
      ],
    });

    expect(findings).toEqual([
      { lane: "missing-coverage", file: "workers/service-integration-router/providers.ts" },
    ]);
  });

  it("requires every tracked eligible source while reporting a changed missing file only once", () => {
    const findings = compareCoverage({
      current: { total: metrics(90), files: {} },
      baseline: { total: metrics(90), files: {} },
      changedFiles: ["src/lib/changed.js", "src/lib/untracked-new.js"],
      trackedFiles: [
        "src/lib/unchanged.js",
        "src/lib/changed.js",
        "src/main.jsx",
        "tests/unchanged.test.js",
      ],
    });

    expect(findings).toEqual([
      { lane: "missing-coverage", file: "src/lib/changed.js" },
      { lane: "missing-coverage", file: "src/lib/unchanged.js" },
      { lane: "missing-coverage", file: "src/lib/untracked-new.js" },
    ]);
  });

  it("fails a changed API handler that regresses against baseline and one missing from coverage entirely", () => {
    const current = {
      total: metrics(90),
      files: { "api/dues-checkout.js": metrics(80) },
    };
    const baseline = {
      total: metrics(90),
      files: { "api/dues-checkout.js": metrics(81) },
    };

    expect(compareCoverage({
      current,
      baseline,
      changedFiles: ["api/dues-checkout.js"],
    })).toEqual([
      expect.objectContaining({ lane: "changed-file", file: "api/dues-checkout.js", metric: "lines" }),
      expect.objectContaining({ lane: "changed-file", file: "api/dues-checkout.js", metric: "functions" }),
      expect.objectContaining({ lane: "changed-file", file: "api/dues-checkout.js", metric: "branches" }),
      expect.objectContaining({ lane: "changed-file", file: "api/dues-checkout.js", metric: "statements" }),
    ]);

    expect(compareCoverage({
      current: { total: metrics(90), files: {} },
      baseline: { total: metrics(90), files: {} },
      changedFiles: ["api/dues-checkout.js"],
    })).toEqual([
      { lane: "missing-coverage", file: "api/dues-checkout.js" },
    ]);
  });

  it("requires the normal coverage floors when a changed API file has an under-floor baseline", () => {
    expect(compareCoverage({
      current: {
        total: metrics(90),
        files: { "api/twilio-send.js": metrics(0) },
      },
      baseline: {
        total: metrics(90),
        files: { "api/twilio-send.js": metrics(0) },
      },
      changedFiles: ["api/twilio-send.js"],
    })).toEqual([
      { lane: "changed-api-floor", file: "api/twilio-send.js", metric: "lines", expected: 80, actual: 0 },
      { lane: "changed-api-floor", file: "api/twilio-send.js", metric: "functions", expected: 80, actual: 0 },
      { lane: "changed-api-floor", file: "api/twilio-send.js", metric: "branches", expected: 70, actual: 0 },
      { lane: "changed-api-floor", file: "api/twilio-send.js", metric: "statements", expected: 80, actual: 0 },
    ]);
  });

  it("does not demand instrumentation for tests, excluded entrypoints, or non-code files", () => {
    expect(compareCoverage({
      current: { total: metrics(90), files: {} },
      baseline: { total: metrics(90), files: {} },
      changedFiles: [
        "src/components/Dialog.test.jsx",
        "src/main.jsx",
        "src/styles.css",
        "workers/proxy/README.md",
        "tests/Dialog.test.jsx",
      ],
    })).toEqual([]);
  });
});

describe("raiseBaseline", () => {
  it("creates the initial baseline", () => {
    const current = {
      total: metrics(89),
      files: { "src/lib/kanban.js": metrics(75) },
    };

    expect(raiseBaseline({ current })).toEqual({ baseline: current, findings: [] });
  });

  it("refuses to write a baseline that lowers any recorded metric", () => {
    const result = raiseBaseline({
      current: { total: metrics(89), files: {} },
      baseline: { total: metrics(90), files: {} },
    });

    expect(result.baseline).toBeUndefined();
    expect(result.findings).toEqual([
      expect.objectContaining({ lane: "baseline-update", metric: "lines" }),
      expect.objectContaining({ lane: "baseline-update", metric: "functions" }),
      expect.objectContaining({ lane: "baseline-update", metric: "branches" }),
      expect.objectContaining({ lane: "baseline-update", metric: "statements" }),
    ]);
  });

  it("reports the applied floor, one tolerance below the record, when an update is refused", () => {
    const result = raiseBaseline({
      current: { total: metrics(89.89), files: { "src/lib/kanban.js": metrics(74.98) } },
      baseline: { total: metrics(90), files: { "src/lib/kanban.js": metrics(75) } },
    });

    expect(result.baseline).toBeUndefined();
    const totalLines = result.findings.find(({ file, metric }) => !file && metric === "lines");
    const fileLines = result.findings.find(({ file, metric }) => file === "src/lib/kanban.js" && metric === "lines");
    expect(totalLines.expected).toBeCloseTo(89.9, 10);
    expect(fileLines.expected).toBeCloseTo(74.99, 10);
  });

  it("retains the higher recorded value when floating-point noise is within epsilon", () => {
    const baseline = { total: metrics(90), files: {} };
    const result = raiseBaseline({
      current: { total: metrics(89.995), files: {} },
      baseline,
    });

    expect(result).toEqual({ baseline, dropped: [], findings: [] });
  });

  it("raises a baseline whose totals sit within the global tolerance of the current run", () => {
    const baseline = { total: metrics(90), files: {} };
    const result = raiseBaseline({
      current: { total: metrics(89.95), files: {} },
      baseline,
    });

    expect(result).toEqual({ baseline, dropped: [], findings: [] });
  });

  it("drops the floor of a deleted file but keeps an existing file absent from the summary", () => {
    const result = raiseBaseline({
      current: { total: metrics(90), files: { "src/lib/kept.js": metrics(91) } },
      baseline: {
        total: metrics(90),
        files: {
          "api/deleted.js": metrics(95),
          "src/lib/kept.js": metrics(90),
          "src/lib/unmeasured.js": metrics(85),
        },
      },
      fileExists: (file) => file !== "api/deleted.js",
    });

    expect(result).toEqual({
      baseline: {
        total: metrics(90),
        files: { "src/lib/kept.js": metrics(91), "src/lib/unmeasured.js": metrics(85) },
      },
      dropped: ["api/deleted.js"],
      findings: [],
    });
  });

  it("refuses to add a new production file below the minimum floors", () => {
    const result = raiseBaseline({
      current: {
        total: metrics(90),
        files: {
          "src/lib/existing.js": metrics(90),
          "src/lib/new.js": metrics(79, 79, 69, 79),
        },
      },
      baseline: {
        total: metrics(90),
        files: { "src/lib/existing.js": metrics(90) },
      },
    });

    expect(result.baseline).toBeUndefined();
    expect(result.findings).toEqual([
      expect.objectContaining({ lane: "new-file", file: "src/lib/new.js", metric: "lines", expected: 80, actual: 79 }),
      expect.objectContaining({ lane: "new-file", file: "src/lib/new.js", metric: "functions", expected: 80, actual: 79 }),
      expect.objectContaining({ lane: "new-file", file: "src/lib/new.js", metric: "branches", expected: 70, actual: 69 }),
      expect.objectContaining({ lane: "new-file", file: "src/lib/new.js", metric: "statements", expected: 80, actual: 79 }),
    ]);
  });
});

describe("coverage CLI", () => {
  it("uses the exact base and head refs when resolving changed files", () => {
    const baseRef = "a".repeat(40);
    const headRef = "b".repeat(40);
    const calls = [];
    const execute = (command, args, options) => {
      calls.push({ command, args, options });
      return Buffer.from("src/lib/new.js\0workers/new.js\0");
    };

    expect(changedFiles(baseRef, headRef, execute)).toEqual(["src/lib/new.js", "workers/new.js"]);
    expect(calls).toEqual([{
      command: "git",
      args: ["diff", "--name-only", "-z", "--diff-filter=ACMR", `${baseRef}...${headRef}`, "--"],
      options: { encoding: null, stdio: ["ignore", "pipe", "pipe"] },
    }]);
  });

  it("fails without retrying when an exact event ref is unavailable", () => {
    const calls = [];
    const execute = (_command, args) => {
      calls.push(args);
      throw new Error("unknown revision");
    };
    const baseRef = "a".repeat(40);
    const headRef = "b".repeat(40);

    expect(() => changedFiles(baseRef, headRef, execute)).toThrow("unknown revision");
    expect(calls).toEqual([[
      "diff", "--name-only", "-z", "--diff-filter=ACMR", `${baseRef}...${headRef}`, "--",
    ]]);
  });

  it("requires both comparison refs and rejects zero or symbolic refs", () => {
    expect(() => resolveCoverageRefs("a".repeat(40), undefined)).toThrow(/provided together/);
    expect(() => resolveCoverageRefs("0".repeat(40), "b".repeat(40))).toThrow(/nonzero exact/);
    expect(() => resolveCoverageRefs("origin/Main", "b".repeat(40))).toThrow(/nonzero exact/);
  });

  it("requires both exact coverage refs to resolve to those commit objects", () => {
    const baseSha = "a".repeat(40);
    const headSha = "b".repeat(40);
    const calls = [];
    const execute = (_command, args) => {
      calls.push(args);
      return `${args[2].slice(0, 40)}\n`;
    };

    expect(resolveCoverageRefs(baseSha, headSha, execute)).toEqual({ baseSha, headSha });
    expect(calls).toEqual([
      ["rev-parse", "--verify", `${baseSha}^{commit}`],
      ["rev-parse", "--verify", `${headSha}^{commit}`],
    ]);

    expect(() => resolveCoverageRefs(baseSha, headSha, () => {
      throw new Error("not fetched");
    })).toThrow(/ASSURANCE_BASE_REF .* is unavailable/);
  });

  it("resolves a local exact head and merge base without a parent-commit fallback", () => {
    const headSha = "b".repeat(40);
    const baseSha = "a".repeat(40);
    const calls = [];
    const execute = (_command, args) => {
      calls.push(args);
      return `${args[0] === "rev-parse" ? headSha : baseSha}\n`;
    };

    expect(resolveCoverageRefs(undefined, undefined, execute)).toEqual({ baseSha, headSha });
    expect(calls).toEqual([
      ["rev-parse", "--verify", "HEAD^{commit}"],
      ["merge-base", "origin/Main", headSha],
    ]);
  });

  it("unions committed, staged, unstaged, and untracked paths in a real local repository", () => {
    const project = fixtureProject("coverage-local-range-");
    try {
      mkdirSync(join(project, "src", "lib"), { recursive: true });
      writeFileSync(join(project, "README.md"), "fixture\n");
      writeFileSync(join(project, "src", "lib", "unstaged.js"), "export const value = 1;\n");
      execFileSync("git", ["init", "--quiet", "-b", "Main"], { cwd: project });
      execFileSync("git", ["add", "."], { cwd: project });
      execFileSync("git", ["-c", "user.name=Assurance", "-c", "user.email=assurance@example.test", "commit", "--quiet", "-m", "base"], { cwd: project });
      const baseSha = execFileSync("git", ["rev-parse", "HEAD"], { cwd: project, encoding: "utf8" }).trim();
      execFileSync("git", ["update-ref", "refs/remotes/origin/Main", baseSha], { cwd: project });

      writeFileSync(join(project, "src", "lib", "committed.js"), "export const committed = true;\n");
      execFileSync("git", ["add", "src/lib/committed.js"], { cwd: project });
      execFileSync("git", ["-c", "user.name=Assurance", "-c", "user.email=assurance@example.test", "commit", "--quiet", "-m", "candidate"], { cwd: project });
      const headSha = execFileSync("git", ["rev-parse", "HEAD"], { cwd: project, encoding: "utf8" }).trim();

      writeFileSync(join(project, "src", "lib", "staged.js"), "export const staged = true;\n");
      execFileSync("git", ["add", "src/lib/staged.js"], { cwd: project });
      writeFileSync(join(project, "src", "lib", "unstaged.js"), "export const value = 2;\n");
      writeFileSync(join(project, "src", "lib", "untracked.js"), "export const untracked = true;\n");
      writeFileSync(join(project, "src", "lib", "untracked\nfile.js"), "export const untracked = true;\n");

      const execute = (command, args, options) => execFileSync(command, args, {
        ...options,
        cwd: project,
      });
      expect(new Set(localChangedFiles(baseSha, headSha, execute))).toEqual(new Set([
        "src/lib/committed.js",
        "src/lib/staged.js",
        "src/lib/unstaged.js",
        "src/lib/untracked.js",
        "src/lib/untracked\nfile.js",
      ]));

      mkdirSync(join(project, "coverage"));
      mkdirSync(join(project, "assurance"));
      writeFileSync(join(project, "coverage", "coverage-summary.json"), JSON.stringify({
        total: metrics(90),
      }));
      writeFileSync(join(project, "assurance", "coverage-baseline.json"), JSON.stringify({
        total: metrics(90),
        files: {},
      }));
      const script = resolve(process.cwd(), "scripts/verify-coverage-ratchet.mjs");
      const result = spawnSync(process.execPath, [script], {
        cwd: project,
        encoding: "utf8",
        env: localRangeEnv(),
      });

      expect(result.status).toBe(1);
      expect(result.stderr).toContain("missing-coverage: src/lib/committed.js");
      expect(result.stderr).toContain("missing-coverage: src/lib/staged.js");
      expect(result.stderr).toContain("missing-coverage: src/lib/unstaged.js");
      expect(result.stderr).toContain("missing-coverage: src/lib/untracked.js");
    } finally {
      rmSync(project, { recursive: true, force: true });
    }
  });

  it("preserves the parser failure when coverage JSON is malformed", () => {
    const project = fixtureProject();
    const malformed = join(project, "coverage-summary.json");
    writeFileSync(malformed, "{");

    try {
      readJson(malformed, "coverage summary");
      throw new Error("Expected malformed JSON to fail");
    } catch (error) {
      expect(error.message).toContain("Unable to read coverage summary");
      expect(error.cause).toBeInstanceOf(SyntaxError);
    }
  });

  it("creates an initial baseline from the generated JSON summary", () => {
    const project = fixtureProject();
    mkdirSync(join(project, "coverage"));
    writeFileSync(join(project, "coverage", "coverage-summary.json"), JSON.stringify({
      total: metrics(91),
      [join(project, "src", "lib", "kanban.js")]: metrics(81),
    }));
    const script = resolve(process.cwd(), "scripts/verify-coverage-ratchet.mjs");

    const stdout = execFileSync(process.execPath, [script, "--update"], {
      cwd: project,
      encoding: "utf8",
    });

    expect(stdout).toContain("Coverage baseline created");
    expect(JSON.parse(readFileSync(join(project, "assurance", "coverage-baseline.json"), "utf8")))
      .toEqual({ total: metrics(91), files: { "src/lib/kanban.js": metrics(81) } });
  });

  it("drops and reports the floor of a recorded file that no longer exists on disk", () => {
    const project = fixtureProject();
    mkdirSync(join(project, "coverage"));
    mkdirSync(join(project, "assurance"));
    mkdirSync(join(project, "src", "lib"), { recursive: true });
    writeFileSync(join(project, "src", "lib", "existing.js"), "export const value = 1;\n");
    writeFileSync(join(project, "assurance", "coverage-baseline.json"), `${JSON.stringify({
      total: metrics(90),
      files: { "api/deleted.js": metrics(95), "src/lib/existing.js": metrics(90) },
    })}\n`);
    writeFileSync(join(project, "coverage", "coverage-summary.json"), JSON.stringify({
      total: metrics(90),
      [join(project, "src", "lib", "existing.js")]: metrics(92),
    }));
    execFileSync("git", ["init", "--quiet"], { cwd: project });
    execFileSync("git", ["add", "src/lib/existing.js"], { cwd: project });
    const script = resolve(process.cwd(), "scripts/verify-coverage-ratchet.mjs");

    const stdout = execFileSync(process.execPath, [script, "--update"], { cwd: project, encoding: "utf8" });

    expect(stdout).toContain("Dropped the floor for deleted file api/deleted.js");
    expect(JSON.parse(readFileSync(join(project, "assurance", "coverage-baseline.json"), "utf8")))
      .toEqual({ total: metrics(90), files: { "src/lib/existing.js": metrics(92) } });
  });

  it("keeps the floor of a tracked file that is only missing from the working tree", () => {
    const project = fixtureProject();
    mkdirSync(join(project, "coverage"));
    mkdirSync(join(project, "assurance"));
    mkdirSync(join(project, "api"), { recursive: true });
    writeFileSync(join(project, "api", "sparse.js"), "export const value = 1;\n");
    execFileSync("git", ["init", "--quiet"], { cwd: project });
    execFileSync("git", ["add", "api/sparse.js"], { cwd: project });
    rmSync(join(project, "api", "sparse.js"));
    writeFileSync(join(project, "assurance", "coverage-baseline.json"), `${JSON.stringify({
      total: metrics(90),
      files: { "api/sparse.js": metrics(95) },
    })}\n`);
    writeFileSync(join(project, "coverage", "coverage-summary.json"), JSON.stringify({ total: metrics(90) }));
    const script = resolve(process.cwd(), "scripts/verify-coverage-ratchet.mjs");

    const stdout = execFileSync(process.execPath, [script, "--update"], { cwd: project, encoding: "utf8" });

    expect(stdout).not.toContain("Dropped the floor");
    expect(JSON.parse(readFileSync(join(project, "assurance", "coverage-baseline.json"), "utf8")).files)
      .toEqual({ "api/sparse.js": metrics(95) });
  });

  it("asks git about one path at a time, so a large index cannot overflow the output buffer", () => {
    const calls = [];
    const fileExists = trackedFileCheck("/repo", (command, args) => {
      calls.push(args);
      return args.at(-1) === "src/kept.js" ? "src/kept.js\0" : "";
    });
    expect(fileExists("src/kept.js")).toBe(true);
    expect(fileExists("api/deleted.js")).toBe(false);
    expect(calls).toEqual([
      ["-C", "/repo", "ls-files", "-z", "--", "src/kept.js"],
      ["-C", "/repo", "ls-files", "-z", "--", "api/deleted.js"],
    ]);
  });

  it("refuses to drop floors when the tracked files cannot be read", () => {
    const fileExists = trackedFileCheck("/nonexistent", () => { throw new Error("not a git repository"); });
    expect(() => fileExists("api/deleted.js")).toThrow("Cannot read the tracked files");
  });

  it("leaves the baseline untouched when an update would admit a low-coverage new file", () => {
    const project = fixtureProject();
    mkdirSync(join(project, "coverage"));
    mkdirSync(join(project, "assurance"));
    const recorded = { total: metrics(90), files: { "src/lib/existing.js": metrics(90) } };
    writeFileSync(join(project, "assurance", "coverage-baseline.json"), `${JSON.stringify(recorded)}\n`);
    writeFileSync(join(project, "coverage", "coverage-summary.json"), JSON.stringify({
      total: metrics(90),
      [join(project, "src", "lib", "existing.js")]: metrics(90),
      [join(project, "src", "lib", "new.js")]: metrics(79, 79, 69, 79),
    }));
    const script = resolve(process.cwd(), "scripts/verify-coverage-ratchet.mjs");

    const result = spawnSync(process.execPath, [script, "--update"], { cwd: project, encoding: "utf8" });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("new-file: src/lib/new.js lines expected 80.00%, actual 79.00%");
    expect(JSON.parse(readFileSync(join(project, "assurance", "coverage-baseline.json"), "utf8"))).toEqual(recorded);
  });

  it("prints structured process-level errors when an exact-range new file misses its floor", () => {
    const project = fixtureProject();
    mkdirSync(join(project, "coverage"));
    mkdirSync(join(project, "assurance"));
    mkdirSync(join(project, "src", "lib"), { recursive: true });
    writeFileSync(join(project, "README.md"), "fixture\n");
    execFileSync("git", ["init", "--quiet"], { cwd: project });
    execFileSync("git", ["add", "README.md"], { cwd: project });
    execFileSync("git", ["-c", "user.name=Assurance", "-c", "user.email=assurance@example.test", "commit", "--quiet", "-m", "initial"], { cwd: project });
    writeFileSync(join(project, "src", "lib", "new.js"), "export const value = 1;\n");
    execFileSync("git", ["add", "src/lib/new.js"], { cwd: project });
    execFileSync("git", ["-c", "user.name=Assurance", "-c", "user.email=assurance@example.test", "commit", "--quiet", "-m", "new file"], { cwd: project });
    writeFileSync(join(project, "coverage", "coverage-summary.json"), JSON.stringify({
      total: metrics(90),
      [join(project, "src", "lib", "new.js")]: metrics(79, 90, 90, 90),
    }));
    writeFileSync(join(project, "assurance", "coverage-baseline.json"), JSON.stringify({ total: metrics(90), files: {} }));
    const script = resolve(process.cwd(), "scripts/verify-coverage-ratchet.mjs");

    const result = spawnSync(process.execPath, [script], {
      cwd: project,
      encoding: "utf8",
      env: exactRangeEnv(project),
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toBe("new-file: src/lib/new.js lines expected 80.00%, actual 79.00%\n");
  });

  it("prints a structured missing-coverage error before accepting a changed source file", () => {
    const project = fixtureProject();
    mkdirSync(join(project, "coverage"));
    mkdirSync(join(project, "assurance"));
    mkdirSync(join(project, "src", "components"), { recursive: true });
    writeFileSync(join(project, "README.md"), "fixture\n");
    execFileSync("git", ["init", "--quiet"], { cwd: project });
    execFileSync("git", ["add", "README.md"], { cwd: project });
    execFileSync("git", ["-c", "user.name=Assurance", "-c", "user.email=assurance@example.test", "commit", "--quiet", "-m", "initial"], { cwd: project });
    writeFileSync(join(project, "src", "components", "Dialog.jsx"), "export const Dialog = () => null;\n");
    execFileSync("git", ["add", "src/components/Dialog.jsx"], { cwd: project });
    execFileSync("git", ["-c", "user.name=Assurance", "-c", "user.email=assurance@example.test", "commit", "--quiet", "-m", "dialog"], { cwd: project });
    writeFileSync(join(project, "coverage", "coverage-summary.json"), JSON.stringify({ total: metrics(90) }));
    writeFileSync(join(project, "assurance", "coverage-baseline.json"), JSON.stringify({ total: metrics(90), files: {} }));
    const script = resolve(process.cwd(), "scripts/verify-coverage-ratchet.mjs");

    const result = spawnSync(process.execPath, [script], {
      cwd: project,
      encoding: "utf8",
      env: exactRangeEnv(project),
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toBe("missing-coverage: src/components/Dialog.jsx is absent from the coverage summary\n");
  });

  it("fails closed when an added Vercel API handler has no instrumented coverage", () => {
    const project = fixtureProject();
    mkdirSync(join(project, "coverage"));
    mkdirSync(join(project, "assurance"));
    mkdirSync(join(project, "api"), { recursive: true });
    writeFileSync(join(project, "README.md"), "fixture\n");
    execFileSync("git", ["init", "--quiet"], { cwd: project });
    execFileSync("git", ["add", "README.md"], { cwd: project });
    execFileSync("git", ["-c", "user.name=Assurance", "-c", "user.email=assurance@example.test", "commit", "--quiet", "-m", "initial"], { cwd: project });
    writeFileSync(join(project, "api", "new-handler.js"), "export default function handler(req, res) { res.status(200).end(); }\n");
    execFileSync("git", ["add", "api/new-handler.js"], { cwd: project });
    execFileSync("git", ["-c", "user.name=Assurance", "-c", "user.email=assurance@example.test", "commit", "--quiet", "-m", "add handler without tests"], { cwd: project });
    writeFileSync(join(project, "coverage", "coverage-summary.json"), JSON.stringify({ total: metrics(90) }));
    writeFileSync(join(project, "assurance", "coverage-baseline.json"), JSON.stringify({ total: metrics(90), files: {} }));
    const script = resolve(process.cwd(), "scripts/verify-coverage-ratchet.mjs");

    const result = spawnSync(process.execPath, [script], {
      cwd: project,
      encoding: "utf8",
      env: exactRangeEnv(project),
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toBe("missing-coverage: api/new-handler.js is absent from the coverage summary\n");
  });

  it("fails when an unchanged tracked production source disappears from coverage", () => {
    const project = fixtureProject();
    mkdirSync(join(project, "coverage"));
    mkdirSync(join(project, "assurance"));
    mkdirSync(join(project, "src", "lib"), { recursive: true });
    writeFileSync(join(project, "README.md"), "initial\n");
    writeFileSync(join(project, "src", "lib", "forgotten.js"), "export const forgotten = true;\n");
    execFileSync("git", ["init", "--quiet"], { cwd: project });
    execFileSync("git", ["add", "README.md", "src/lib/forgotten.js"], { cwd: project });
    execFileSync("git", ["-c", "user.name=Assurance", "-c", "user.email=assurance@example.test", "commit", "--quiet", "-m", "initial"], { cwd: project });
    writeFileSync(join(project, "README.md"), "changed\n");
    execFileSync("git", ["add", "README.md"], { cwd: project });
    execFileSync("git", ["-c", "user.name=Assurance", "-c", "user.email=assurance@example.test", "commit", "--quiet", "-m", "readme only"], { cwd: project });
    writeFileSync(join(project, "coverage", "coverage-summary.json"), JSON.stringify({ total: metrics(90) }));
    writeFileSync(join(project, "assurance", "coverage-baseline.json"), JSON.stringify({ total: metrics(90), files: {} }));
    const script = resolve(process.cwd(), "scripts/verify-coverage-ratchet.mjs");

    const result = spawnSync(process.execPath, [script], {
      cwd: project,
      encoding: "utf8",
      env: exactRangeEnv(project),
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toBe("missing-coverage: src/lib/forgotten.js is absent from the coverage summary\n");
  });
});

describe("fixture project cleanup", () => {
  let tracked;

  it("tracks a fixture project for removal while its test runs", () => {
    tracked = fixtureProject("coverage-ratchet-cleanup-");
    expect(existsSync(tracked)).toBe(true);
    expect(fixtureProjects).toContain(tracked);
  });

  it("removes the previous test's fixture project instead of leaving it in the temp directory", () => {
    expect(typeof tracked).toBe("string");
    expect(existsSync(tracked)).toBe(false);
    expect(fixtureProjects).not.toContain(tracked);
  });
});
