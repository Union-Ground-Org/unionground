// @vitest-environment node

import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import {
  LANES,
  REQUIRED_BLOCKING,
  SCANNER_IDS,
  applyPolicy,
  digestOf,
  formatFinding,
  entryAppliesToLane,
  isBlocking,
  loadPolicy,
  normalizeGitleaksReport,
  normalizeSemgrepReport,
  normalizeTrivyReport,
  validatePolicy,
} from "../scripts/lib/security-scanner-policy.mjs";
import {
  gitleaksArguments,
  gitleaksTreeExclusions,
  semgrepArguments,
  trivyArguments,
  unusedOutsideExclusions,
} from "../scripts/run-security-scan.mjs";
import {
  assertAllowedTarget,
  loadZapPolicy,
  summarizeReport,
} from "../scripts/run-passive-web-scan.mjs";

const repositoryFile = (relative) => fileURLToPath(new URL(`../${relative}`, import.meta.url));
const policy = loadPolicy();

describe("reviewed scanner policy", () => {
  it("is structurally valid", () => {
    expect(validatePolicy(policy)).toEqual([]);
  });

  it("accepts the public scanner policy and rejects one entry past the 65 cap", () => {
    expect(policy.allowlist_policy.max_entries).toBe(65);
    expect(policy.allowlist).toHaveLength(10);
    expect(validatePolicy(policy)).toEqual([]);
    const overflow = structuredClone(policy);
    while (overflow.allowlist.length < overflow.allowlist_policy.max_entries) {
      overflow.allowlist.push({
        ...overflow.allowlist[0],
        path: `tests/cap-overflow-fixture-${overflow.allowlist.length}.js`,
      });
    }
    expect(validatePolicy(overflow)).toEqual([]);
    overflow.allowlist.push({ ...overflow.allowlist[0], path: "tests/cap-overflow-fixture-65.js" });
    expect(validatePolicy(overflow)).toContain(
      "allowlist holds 66 entries, above the reviewed cap of 65",
    );
  });

  it.each([undefined, 0, -1, 1.5, "65", 66])("refuses an invalid exception cap of %s", (value) => {
    const mutated = structuredClone(policy);
    mutated.allowlist_policy.max_entries = value;
    expect(validatePolicy(mutated)).toContain(
      "allowlist_policy.max_entries must be a positive integer of at most 65",
    );
  });

  it.each(SCANNER_IDS)("pins %s to an exact image digest", (id) => {
    expect(policy.scanners[id].digest).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(policy.scanners[id].tag).toEqual(expect.any(String));
  });

  it.each(Object.entries(REQUIRED_BLOCKING))(
    "keeps %s blocking on its required severities",
    (id, required) => {
      for (const severity of required) {
        expect(policy.scanners[id].blocking_severities).toContain(severity);
      }
    },
  );

  it("refuses a policy that lowers a blocking floor", () => {
    const lowered = structuredClone(policy);
    lowered.scanners.trivy.blocking_severities = ["CRITICAL"];
    expect(validatePolicy(lowered)).toContain("scanner trivy must block on HIGH");
  });

  it("refuses a policy that unpins an image", () => {
    const unpinned = structuredClone(policy);
    unpinned.scanners.semgrep.digest = "latest";
    expect(validatePolicy(unpinned)).toContain(
      "scanner semgrep must be pinned to an exact sha256 image digest",
    );
  });

  it("refuses a semgrep rule timeout that is missing, unlimited or unbounded", () => {
    for (const value of [undefined, 0, -1, 1.5, "60", 301]) {
      const mutated = structuredClone(policy);
      mutated.scanners.semgrep.rule_timeout_seconds = value;
      expect(validatePolicy(mutated)).toContain(
        "scanner semgrep rule_timeout_seconds must be a positive integer of at most 300",
      );
    }
  });

  it("refuses a policy that makes gitleaks non-blocking", () => {
    const relaxed = structuredClone(policy);
    relaxed.scanners.gitleaks.blocking = false;
    expect(validatePolicy(relaxed)).toContain("scanner gitleaks must be blocking");
  });

  it("refuses a severity listed as both blocking and merely recorded", () => {
    const contradictory = structuredClone(policy);
    contradictory.scanners.trivy.recorded_severities = ["HIGH", "MEDIUM"];
    expect(validatePolicy(contradictory).join("\n")).toMatch(/both blocking and recorded/);
  });

  it("keeps ZAP a non-blocking passive gate with an honest history and explicit targets", () => {
    expect(policy.zap.blocking).toBe(false);
    expect(policy.zap.historical_status).toMatch(/never a blocking release gate/i);
    expect(policy.zap.allowed_targets.length).toBeGreaterThan(0);
    for (const target of policy.zap.allowed_targets) expect(target).toMatch(/^https:\/\//);

    const rewritten = structuredClone(policy);
    rewritten.zap.blocking = true;
    expect(validatePolicy(rewritten)).toContain(
      "ZAP must stay a non-blocking, separately calibrated passive gate",
    );
  });

  it("requires the SBOM and registry signature gates to fail closed", () => {
    expect(policy.sbom.fail_closed).toBe(true);
    expect(policy.registry_signatures.blocking).toBe(true);
    const softened = structuredClone(policy);
    softened.sbom.fail_closed = false;
    expect(validatePolicy(softened)).toContain("the SBOM policy must exist and fail closed");
  });

  it("names SBOM targets that exist in the repository", () => {
    for (const target of policy.sbom.targets) {
      expect(existsSync(repositoryFile(target.lockfile)), target.lockfile).toBe(true);
      expect(existsSync(repositoryFile(target.manifest)), target.manifest).toBe(true);
    }
  });
});

describe("reviewed exceptions", () => {
  it("binds every gitleaks exception to the exact detected value", () => {
    const entries = policy.allowlist.filter((entry) => entry.scanner === "gitleaks");
    expect(entries.length).toBeGreaterThan(0);
    for (const entry of entries) expect(entry.match_sha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it("admits a semgrep exception for at most its stated occurrences, only at its path, until it expires", () => {
    const path = "scripts/lib/example-git-blob.mjs";
    const entry = { scanner: "semgrep", identifier: "unionground-weak-hash-for-security", path, max_occurrences: 1,
      reason: "SHA-1 reconstructs a Git blob object identifier; SHA-256 pins the content.",
      reviewed_by: "fixture", reviewed_on: "2026-09-28", expires_on: "2026-12-27" };
    const finding = { scanner: "semgrep", identifier: entry.identifier, path, line: 86, severity: "ERROR" };
    const scoped = { ...policy, allowlist: [entry] };
    const options = { today: "2026-09-28", scanners: ["semgrep"] };
    expect(applyPolicy([finding], scoped, options).blocking).toHaveLength(0);
    expect(applyPolicy([finding, { ...finding, line: 90 }], scoped, options).blocking).toHaveLength(1);
    expect(applyPolicy([{ ...finding, path: "api/credentials.js" }], scoped, options).blocking).toHaveLength(1);
    expect(applyPolicy([finding], scoped, options).expired).toEqual([]);
    expect(applyPolicy([finding], scoped, { ...options, today: "2026-12-27" }).expired).toEqual([entry]);
  });

  it("gives every exception a dated review and a bounded expiry", () => {
    // Build-tool classifications are not exceptions and
    // carry no expiry; every other entry must expire after its review.
    for (const entry of policy.allowlist) {
      expect(entry.reviewed_on).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      if (entry.classification === "build-tool") expect(entry).not.toHaveProperty("expires_on");
      else expect(entry.expires_on > entry.reviewed_on).toBe(true);
      expect(entry.reason.length).toBeGreaterThanOrEqual(40);
    }
  });

  it.each([
    ["a pattern path", (entry) => { entry.path = "scripts/**"; }],
    ["a pattern identifier", (entry) => { entry.identifier = "*"; }],
    ["a missing expiry", (entry) => { delete entry.expires_on; }],
    ["an unbounded lifetime", (entry) => { entry.expires_on = "2099-01-01"; }],
    ["a thin reason", (entry) => { entry.reason = "known issue"; }],
  ])("refuses an exception with %s", (_label, mutate) => {
    const mutated = structuredClone(policy);
    mutate(mutated.allowlist[0]);
    expect(validatePolicy(mutated).length).toBeGreaterThan(0);
  });

  it("refuses a value digest on a non-gitleaks exception", () => {
    const mutated = structuredClone(policy);
    const semgrepEntry = mutated.allowlist.find((entry) => entry.scanner === "semgrep");
    semgrepEntry.match_sha256 = digestOf("anything");
    expect(validatePolicy(mutated).join("\n")).toMatch(/may only bind a value digest for gitleaks/);
  });
});

describe("policy application", () => {
  const semgrepFinding = {
    scanner: "semgrep",
    identifier: "unionground-eval-on-dynamic-input",
    path: "api/example.js",
    line: 4,
    severity: "ERROR",
    title: "eval on dynamic input",
  };
  const warningFinding = { ...semgrepFinding, severity: "WARNING" };

  it("blocks a finding at the blocking severity", () => {
    expect(isBlocking(policy, semgrepFinding)).toBe(true);
    const { blocking } = applyPolicy([semgrepFinding], policy, {
      today: "2026-09-06",
      scanners: ["semgrep"],
    });
    expect(blocking).toHaveLength(1);
  });

  it("records a finding below the blocking floor without failing", () => {
    const { blocking, recorded } = applyPolicy([warningFinding], policy, {
      today: "2026-09-06",
      scanners: ["semgrep"],
    });
    expect(blocking).toHaveLength(0);
    expect(recorded).toHaveLength(1);
  });

  it("accepts a finding that an exact reviewed exception covers", () => {
    const entry = policy.allowlist.find((candidate) => candidate.scanner === "semgrep");
    const covered = {
      scanner: "semgrep",
      identifier: entry.identifier,
      path: entry.path,
      line: 1,
      severity: "ERROR",
      title: "covered",
    };
    const { blocking, accepted } = applyPolicy([covered], policy, {
      today: "2026-09-06",
      scanners: ["semgrep"],
    });
    expect(blocking).toHaveLength(0);
    expect(accepted).toHaveLength(1);
  });

  it("stops covering a gitleaks finding once the detected value changes", () => {
    const entry = policy.allowlist.find((candidate) => candidate.scanner === "gitleaks");
    const before = {
      scanner: "gitleaks",
      identifier: entry.identifier,
      path: entry.path,
      line: 3,
      severity: "HIGH",
      title: "committed secret",
      valueDigest: entry.match_sha256,
    };
    const after = { ...before, valueDigest: digestOf("a genuinely new credential") };
    expect(applyPolicy([before], policy, { today: "2026-09-06", scanners: ["gitleaks"] }).blocking)
      .toHaveLength(0);
    expect(applyPolicy([after], policy, { today: "2026-09-06", scanners: ["gitleaks"] }).blocking)
      .toHaveLength(1);
  });

  it("reports an exception that matches nothing", () => {
    const { unused } = applyPolicy([], policy, { today: "2026-09-06", scanners: ["semgrep"] });
    expect(unused.length).toBeGreaterThan(0);
    expect(unused.every((entry) => entry.scanner === "semgrep")).toBe(true);
  });

  it("limits the unused report to the lanes that actually ran", () => {
    const { unused } = applyPolicy([], policy, { today: "2026-09-06", scanners: ["trivy"] });
    // Only the scanner that ran can report its own entries as unused.
    const trivyEntries = policy.allowlist.filter((entry) => entry.scanner === "trivy");
    expect(unused).toEqual(trivyEntries);
  });

  it("keeps a history-scoped exception out of the per-change lane", () => {
    const historyEntry = {
      scanner: "gitleaks",
      identifier: "generic-api-key",
      path: "tests/fixtures/example-key.txt",
      match_sha256: "a".repeat(64),
      lanes: ["history"],
      reviewed_on: "2026-09-01",
      expires_on: "2026-10-01",
    };
    const fixturePolicy = { ...policy, allowlist: [historyEntry] };
    expect(entryAppliesToLane(historyEntry, "history")).toBe(true);
    expect(entryAppliesToLane(historyEntry, "tree")).toBe(false);

    const finding = {
      scanner: "gitleaks",
      identifier: historyEntry.identifier,
      path: historyEntry.path,
      line: 1,
      severity: "HIGH",
      title: "committed secret",
      valueDigest: historyEntry.match_sha256,
    };
    const inTree = applyPolicy([finding], fixturePolicy, {
      today: "2026-09-06", scanners: ["gitleaks"], lane: "tree",
    });
    const inHistory = applyPolicy([finding], fixturePolicy, {
      today: "2026-09-06", scanners: ["gitleaks"], lane: "history",
    });
    expect(inTree.blocking).toHaveLength(1);
    expect(inHistory.blocking).toHaveLength(0);
    expect(inHistory.accepted).toHaveLength(1);
  });

  it("applies an unscoped exception to both lanes", () => {
    const entry = policy.allowlist.find((candidate) => candidate.lanes === undefined);
    expect(entry).toBeDefined();
    for (const lane of LANES) expect(entryAppliesToLane(entry, lane)).toBe(true);
  });

  it("refuses a history-scoped exception for a scanner that cannot bind a value", () => {
    const mutated = structuredClone(policy);
    const semgrepEntry = mutated.allowlist.find((entry) => entry.scanner === "semgrep");
    semgrepEntry.lanes = ["history"];
    expect(validatePolicy(mutated).join("\n")).toMatch(/only be history-scoped for gitleaks/);
  });

  it("refuses an unknown lane", () => {
    const mutated = structuredClone(policy);
    mutated.allowlist[0].lanes = ["production"];
    expect(validatePolicy(mutated).join("\n")).toMatch(/lanes must be a non-empty subset/);
  });

  it("reports an expired exception", () => {
    const treeEntries = policy.allowlist.filter((entry) => entryAppliesToLane(entry, "tree"));
    const { expired } = applyPolicy([], policy, { today: "2099-01-01", scanners: SCANNER_IDS });
    expect(expired.length).toBe(treeEntries.filter((entry) => entry.classification !== "build-tool").length);
  });

  it("never prints a detected value", () => {
    const rendered = formatFinding({
      scanner: "gitleaks",
      identifier: "generic-api-key",
      path: "src/example.js",
      line: 2,
      severity: "HIGH",
      title: "committed secret",
      valueDigest: digestOf("super-secret"),
    });
    expect(rendered).not.toContain("super-secret");
    expect(rendered).toContain("src/example.js:2");
  });
});

describe("scanner report normalizers", () => {
  it("normalizes a semgrep report", () => {
    expect(normalizeSemgrepReport({
      results: [{
        check_id: "config.unionground-eval-on-dynamic-input",
        path: "/src/api/example.js",
        start: { line: 7 },
        extra: { severity: "ERROR", message: "eval on dynamic input\nmore" },
      }],
    })).toEqual([{
      scanner: "semgrep",
      identifier: "unionground-eval-on-dynamic-input",
      path: "api/example.js",
      line: 7,
      severity: "ERROR",
      title: "eval on dynamic input",
    }]);
  });

  it("normalizes a gitleaks report and digests the value", () => {
    const [finding] = normalizeGitleaksReport([{
      RuleID: "generic-api-key",
      File: "/repo/src/example.js",
      StartLine: 3,
      Description: "Detected a Generic API Key",
      Secret: "synthetic",
    }]);
    expect(finding.path).toBe("src/example.js");
    expect(finding.valueDigest).toBe(digestOf("synthetic"));
    expect(JSON.stringify(finding)).not.toContain("synthetic");
  });

  it("normalizes trivy vulnerabilities, misconfigurations and secrets", () => {
    const findings = normalizeTrivyReport({
      Results: [{
        Target: "/repo/package-lock.json",
        Vulnerabilities: [{ VulnerabilityID: "CVE-1", Severity: "HIGH", PkgName: "x", InstalledVersion: "1" }],
        Misconfigurations: [{ ID: "AVD-1", Severity: "MEDIUM", Title: "m", CauseMetadata: { StartLine: 2 } }],
        Secrets: [{ RuleID: "aws", Severity: "CRITICAL", Title: "s", StartLine: 5 }],
      }],
    });
    expect(findings.map((finding) => [finding.identifier, finding.severity])).toEqual([
      ["CVE-1", "HIGH"],
      ["AVD-1", "MEDIUM"],
      ["aws", "CRITICAL"],
    ]);
    expect(findings[0].path).toBe("package-lock.json");
  });
});

describe("scanner invocation", () => {
  it("runs every scanner from its pinned digest", () => {
    const commands = [
      semgrepArguments(policy).join(" "),
      gitleaksArguments(policy).join(" "),
      trivyArguments(policy).join(" "),
    ];
    for (const [index, id] of SCANNER_IDS.entries()) {
      expect(commands[index]).toContain(`${policy.scanners[id].image}@${policy.scanners[id].digest}`);
      expect(commands[index]).not.toMatch(/:latest\b/);
    }
  });

  it("scans the reviewed production roots with semgrep", () => {
    const args = semgrepArguments(policy);
    for (const path of policy.scanners.semgrep.scan_paths) expect(args).toContain(path);
    expect(args).toContain(policy.scanners.semgrep.ruleset);
  });

  // Semgrep fails the whole scan on a missing root, and an existing delivery
  // root left off the list would go unscanned without any error.
  it("lists every delivery root that exists and only roots that exist", () => {
    const paths = policy.scanners.semgrep.scan_paths;
    for (const path of paths) expect(existsSync(repositoryFile(path)), `${path} must exist`).toBe(true);
    for (const root of ["api", "src", "workers", "scripts", "apps/mobile/app", "apps/mobile/src", "apps/mobile/scripts"]) {
      expect(paths.includes(root), `${root} is a delivery root`).toBe(existsSync(repositoryFile(root)));
    }
  });

  it("passes the reviewed per-rule timeout to semgrep, including in the self-test", () => {
    for (const args of [
      semgrepArguments(policy),
      semgrepArguments(policy, { target: "tests/fixtures/security-scanners/semgrep", applyExclusions: false }),
    ]) {
      const index = args.indexOf("--timeout");
      expect(index).toBeGreaterThan(args.indexOf("scan"));
      expect(args[index + 1]).toBe(String(policy.scanners.semgrep.rule_timeout_seconds));
    }
  });

  it("bounds the scheduled history scan by the reviewed commit budget", () => {
    const args = gitleaksArguments(policy, { history: true, historySnapshot: {
      schema: 1, policy_source_sha: "a".repeat(40), history_commit_budget: policy.scanners.gitleaks.history_commit_budget, refs: [["HEAD", "a".repeat(40)]],
    } }).join(" ");
    expect(args).toContain(`--max-count=${policy.scanners.gitleaks.history_commit_budget}`);
    expect(args).not.toContain("--no-git");
  });

  it("applies the repository gitleaks configuration to the repository scan only", () => {
    expect(gitleaksArguments(policy).join(" ")).toContain("config/gitleaks.toml");
    expect(gitleaksArguments(policy, { useRepositoryConfig: false }).join(" "))
      .not.toContain("config/gitleaks.toml");
  });

  it("enables every trivy scanner class the policy names", () => {
    const args = trivyArguments(policy).join(" ");
    expect(args).toContain(policy.scanners.trivy.enabled_scanners.join(","));
  });
});

describe("passive web scan policy", () => {
  const zap = loadZapPolicy();

  it("pins the scanner image to an exact digest", () => {
    expect(zap.image).toEqual(expect.any(String));
    expect(zap.digest).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  it("accepts only an allowlisted bare https origin", () => {
    for (const target of zap.allowed_targets) {
      expect(assertAllowedTarget(target, zap)).toBe(target);
    }
  });

  it.each([
    ["an unlisted origin", "https://example.com"],
    ["a path under an allowlisted origin", "https://unionground.org/admin"],
    ["a query under an allowlisted origin", "https://unionground.org/?debug=1"],
    ["a plaintext scheme", "http://unionground.org"],
    ["an empty target", ""],
  ])("refuses %s", (_label, target) => {
    expect(() => assertAllowedTarget(target, zap)).toThrow(/PASSIVE_SCAN_FAIL/);
  });

  it("reduces a report to counts and rule identifiers only", () => {
    const summary = summarizeReport({
      site: [{
        "@name": "https://unionground.org",
        alerts: [{
          pluginid: "10038",
          alertRef: "10038-1",
          alert: "Content Security Policy Header Not Set",
          riskcode: "2",
          confidence: "3",
          instances: [
            { uri: "https://unionground.org/member/secret-path", param: "session", evidence: "Set-Cookie: sb-access-token=abc" },
          ],
        }],
      }],
    }, { target: "https://unionground.org" });

    expect(summary.blocking).toBe(false);
    expect(summary.alertCount).toBe(1);
    expect(summary.alerts[0].instanceCount).toBe(1);
    const serialized = JSON.stringify(summary);
    expect(serialized).not.toContain("secret-path");
    expect(serialized).not.toContain("sb-access-token");
    expect(serialized).not.toContain("evidence");
  });
});

describe("gitleaks configuration", () => {
  const source = readFileSync(repositoryFile("config/gitleaks.toml"), "utf8");

  it("extends the upstream ruleset instead of replacing it", () => {
    expect(source).toMatch(/\[extend\]\s*\nuseDefault\s*=\s*true/);
  });

  it("allowlists paths only, never rules or value patterns", () => {
    expect(source).not.toMatch(/^\s*regexes\s*=/m);
    expect(source).not.toMatch(/^\s*stopwords\s*=/m);
    expect(source).not.toMatch(/^\s*commits\s*=/m);
  });

  it("excludes only the scanner fixtures and generated build output", () => {
    const quoted = String.raw`'''`;
    const pattern = new RegExp(`${quoted}([^']+)${quoted}`, "g");
    const paths = [...source.matchAll(pattern)].map((match) => match[1]);
    expect(paths).toContain("tests/fixtures/security-scanners/");
    for (const generated of ["node_modules", "dist", "coverage"]) {
      expect(paths.some((entry) => entry.includes(generated)), generated).toBe(true);
    }
    for (const root of ["src", "api", "workers", "scripts", "supabase"]) {
      expect(
        paths.some((entry) => entry.replace(/[^A-Za-z0-9/]/g, "") === root),
        `${root} must stay in scope`,
      ).toBe(false);
    }
  });
});
