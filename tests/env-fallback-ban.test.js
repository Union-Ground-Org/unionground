// @vitest-environment node

import { execFileSync } from "node:child_process";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import {
  applyAllowlist,
  formatFinding,
  isPublicEnvName,
  isSecretLikeName,
  scanFile,
  validateAllowlist,
} from "../scripts/lib/env-fallback-scan.mjs";
import {
  ALLOWLIST_PATH,
  REPOSITORY_ROOT,
  SCAN_EXCLUSIONS,
  SCAN_SCOPE,
  isInScope,
  loadAllowlist,
} from "../scripts/verify-env-fallback-ban.mjs";

const fixtureRoot = fileURLToPath(new URL("./fixtures/env-fallback/", import.meta.url));

function readFixture(relative) {
  return {
    path: `tests/fixtures/env-fallback/${relative}`,
    source: readFileSync(join(fixtureRoot, relative), "utf8"),
  };
}

function fixtureNames(bucket) {
  return readdirSync(join(fixtureRoot, bucket))
    .filter((name) => !name.endsWith(".md"))
    .sort();
}

const EXPECTED_UNSAFE = Object.freeze({
  "chained-literal-tail.js": {
    variable: "SUPABASE_SECRET_KEY",
    kind: "literal-fallback",
  },
  "const-binding-fallback.js": {
    variable: "STEWARD_EMAIL_INTAKE_SECRET",
    kind: "literal-fallback",
  },
  "destructured-default.js": {
    variable: "INSTITUTIONAL_RECORDS_DB_URL",
    kind: "literal-fallback",
  },
  "eas-literal-secret.json": {
    variable: "build.production.env.SENTRY_AUTH_TOKEN",
    kind: "literal-secret-value",
  },
  "indeterminate-fallback.mjs": {
    variable: "SESSION_JWT_SECRET",
    kind: "indeterminate-fallback",
  },
  "literal-fallback.js": {
    variable: "INTEGRATION_WEBHOOK_SECRET",
    kind: "literal-fallback",
  },
  "nullish-literal-fallback.js": {
    variable: "SMS_LEDGER_HASH_SALT",
    kind: "literal-fallback",
  },
  "public-variable-fallback.js": {
    variable: "SUPABASE_SERVICE_ROLE_KEY",
    kind: "public-variable-fallback",
  },
  "ternary-fallback.jsx": {
    variable: "STEWARD_EMAIL_INTAKE_SECRET",
    kind: "literal-fallback",
  },
  "unrelated-variable-fallback.ts": {
    variable: "LINEAR_API_KEY",
    kind: "unrelated-variable-fallback",
  },
  "workflow-expression-fallback.yml": {
    variable: "DEPLOY_TOKEN",
    kind: "literal-fallback",
  },
  "workflow-literal-secret.yml": {
    variable: "REGISTRY_API_KEY",
    kind: "literal-secret-value",
  },
});

describe("secret-fallback ban classification", () => {
  it.each([
    ["SUPABASE_SERVICE_ROLE_KEY", true],
    ["INTEGRATION_WEBHOOK_SECRET", true],
    ["SESSION_JWT_SECRET", true],
    ["MEMBER_OPERATIONS_DB_URL", true],
    ["APNS_PRIVATE_KEY", true],
    ["ADMIN_PASSWORD", true],
    ["LINEAR_API_KEY", true],
    ["SMS_LEDGER_HASH_SALT", true],
    ["PUBLIC_INTEREST_RATE_LIMIT_SECRET", true],
    ["ORGANIZATION_CLAIM_RATE_LIMIT_SECRET", true],
    // SEC-UG-SECRET-FALLBACK-GENERIC-KEY-NAMES-20260921: a key named for
    // what it protects, a service key, and a key form used mid-name.
    ["SENSITIVE_DATA_OLD_ACTIVE_KEY", true],
    ["CI_DB_RUN_KEY", true],
    ["SENSITIVE_MAINTENANCE_SERVICE_KEY", true],
    ["SENSITIVE_DATA_ENCRYPTION_KEY_ID", true],
    ["ADMIN_SESSION_KEY", true],
    // Approved public-key identifiers, excluded by name because they are read
    // without a bundler prefix too.
    ["SUPABASE_ANON_KEY", false],
    ["SUPABASE_PUBLISHABLE_KEY", false],
    ["VAPID_PUBLIC_KEY", false],
    // `KEY` as ordinary vocabulary: an unqualified map entry and an inner word.
    ["KEY", false],
    ["ROSTER_SORT_KEY_ORDER", false],
    ["VITE_SUPABASE_PUBLISHABLE_KEY", false],
    ["EXPO_PUBLIC_SUPABASE_URL", false],
    ["MOBILE_RELEASE_ENV", false],
    ["NODE_ENV", false],
    ["ROUTED_ENVIRONMENTS", false],
  ])("classifies %s as secret-like=%s", (name, expected) => {
    expect(isSecretLikeName(name)).toBe(expected);
  });

  it.each([
    ["VITE_SUPABASE_URL", true],
    ["EXPO_PUBLIC_PREVIEW_ENABLED", true],
    ["NEXT_PUBLIC_ANYTHING", true],
    ["REACT_APP_ANYTHING", true],
    ["PUBLIC_INTEREST_RATE_LIMIT_SECRET", false],
    ["SUPABASE_SERVICE_ROLE_KEY", false],
  ])("classifies %s as a public build variable=%s", (name, expected) => {
    expect(isPublicEnvName(name)).toBe(expected);
  });

  it.each([
    ["SENSITIVE_DATA_OLD_ACTIVE_KEY", true],
    ["SENSITIVE_MAINTENANCE_SERVICE_KEY", true],
    ["SUPABASE_ANON_KEY", false],
    ["VAPID_PUBLIC_KEY", false],
    ["ROSTER_SORT_KEY_ORDER", false],
  ])(
    "SEC-UG-SECRET-FALLBACK-GENERIC-KEY-NAMES-20260921 reports a literal default for %s=%s",
    (name, reported) => {
      const findings = scanFile({
        path: "api/generic-key-name.js",
        source: `export const value = process.env.${name} || "committed-placeholder";`,
      });

      expect(findings).toEqual(
        reported
          ? [expect.objectContaining({ variable: name, kind: "literal-fallback" })]
          : [],
      );
      expect(findings.map(formatFinding).join("\n")).not.toContain("committed-placeholder");
    },
  );
});

describe("secret-fallback ban template literals", () => {
  // DEBT-UG-ENV-FALLBACK-SCAN-UNREACHABLE-TEMPLATE-BRANCH-20260921:
  // isStringLiteralLike() already returns the verdict for a no-substitution
  // backtick literal, so the template branch handles interpolation only.
  it.each([
    ["`committed-placeholder`", "literal-fallback"],
    ["``", null],
    ["`${placeholder}`", "literal-fallback"],
    ["`prefix-${placeholder}`", "literal-fallback"],
  ])("classifies the fallback %s", (fallback, kind) => {
    const findings = scanFile({
      path: "api/template-fallback.js",
      source: `const placeholder = "x"; export const value = process.env.SESSION_JWT_SECRET || ${fallback};`,
    });
    expect(findings).toEqual(
      kind ? [expect.objectContaining({ variable: "SESSION_JWT_SECRET", kind })] : [],
    );
  });

  it("keeps no unreachable no-substitution template branch", () => {
    const source = readFileSync(
      fileURLToPath(new URL("../scripts/lib/env-fallback-scan.mjs", import.meta.url)),
      "utf8",
    );
    expect(source).not.toMatch(/isNoSubstitutionTemplateLiteral/);
    expect(source).toMatch(/if \(ts\.isTemplateExpression\(expression\)\) \{\n\s*return templateHasContent\(expression\)/);
  });
});

describe("secret-fallback ban fixtures", () => {
  it.each(["||=", "??="])(
    "SEC-UG-SECRET-FALLBACK-BAN-20260904 rejects a secret defaulted with %s",
    (operator) => {
      const findings = scanFile({
        path: "api/logical-assignment.js",
        source: `process.env.INTEGRATION_WEBHOOK_SECRET ${operator} "committed-placeholder";`,
      });

      expect(findings).toEqual([
        expect.objectContaining({
          variable: "INTEGRATION_WEBHOOK_SECRET",
          kind: "literal-fallback",
        }),
      ]);
      expect(findings.map(formatFinding).join("\n")).not.toContain("committed-placeholder");
    },
  );

  it("covers every unsafe fixture with an expectation", () => {
    expect(fixtureNames("unsafe")).toEqual(Object.keys(EXPECTED_UNSAFE).sort());
  });

  it.each(Object.entries(EXPECTED_UNSAFE))(
    "rejects the unsafe fixture %s",
    (name, expectation) => {
      const findings = scanFile(readFixture(`unsafe/${name}`));
      expect(findings.length).toBeGreaterThan(0);
      const match = findings.find(
        (finding) => finding.variable === expectation.variable && finding.kind === expectation.kind,
      );
      expect(
        match,
        `expected ${name} to report ${expectation.variable} [${expectation.kind}], got ${JSON.stringify(findings)}`,
      ).toBeDefined();
    },
  );

  it.each(fixtureNames("safe"))("accepts the safe fixture %s", (name) => {
    const findings = scanFile(readFixture(`safe/${name}`));
    expect(findings, `expected no findings, got ${JSON.stringify(findings)}`).toEqual([]);
  });

  it("reports one finding per defaulted read, not one per chain link", () => {
    const findings = scanFile(readFixture("unsafe/chained-literal-tail.js"));
    expect(findings).toHaveLength(1);
  });

  it("never prints the rejected value", () => {
    for (const name of fixtureNames("unsafe")) {
      const fixture = readFixture(`unsafe/${name}`);
      const findings = scanFile(fixture);
      const rendered = findings.map(formatFinding).join("\n");
      for (const placeholder of fixture.source.match(/placeholder[a-z-]*/g) ?? []) {
        expect(rendered, `${name} leaked ${placeholder}`).not.toContain(placeholder);
      }
      expect(rendered).toContain("value redacted");
    }
  });
});

describe("reviewed allowlist", () => {
  const validEntry = Object.freeze({
    path: "scripts/example.mjs",
    variable: "EXAMPLE_TOKEN",
    kind: "literal-fallback",
    reason: "The default is a published protocol constant, not a credential.",
    reviewed_by: "codex-wave1-ci-security-gates-20260906",
    reviewed_on: "2026-09-06",
  });

  it("accepts a well-formed narrow entry", () => {
    expect(validateAllowlist({ schema: 1, entries: [validEntry] })).toEqual([]);
  });

  it.each([
    ["a glob path", { ...validEntry, path: "scripts/*.mjs" }],
    ["a traversal path", { ...validEntry, path: "../outside.mjs" }],
    ["an unknown kind", { ...validEntry, kind: "regex-wide-exclusion" }],
    ["a thin reason", { ...validEntry, reason: "ok" }],
    ["a missing reviewer", { ...validEntry, reviewed_by: "" }],
    ["an unstructured date", { ...validEntry, reviewed_on: "September 2026" }],
  ])("refuses %s", (_label, entry) => {
    expect(validateAllowlist({ schema: 1, entries: [entry] }).length).toBeGreaterThan(0);
  });

  it("refuses an extra field so an entry cannot smuggle a pattern", () => {
    expect(
      validateAllowlist({ schema: 1, entries: [{ ...validEntry, pattern: ".*" }] }).length,
    ).toBeGreaterThan(0);
  });

  it("refuses duplicate entries", () => {
    expect(
      validateAllowlist({ schema: 1, entries: [validEntry, { ...validEntry }] }).length,
    ).toBeGreaterThan(0);
  });

  it("suppresses only the exact matching finding", () => {
    const findings = [
      { path: "scripts/example.mjs", variable: "EXAMPLE_TOKEN", kind: "literal-fallback", line: 3, detail: "d" },
      { path: "scripts/example.mjs", variable: "OTHER_TOKEN", kind: "literal-fallback", line: 4, detail: "d" },
    ];
    const { remaining, unused } = applyAllowlist(findings, { schema: 1, entries: [validEntry] });
    expect(remaining.map((finding) => finding.variable)).toEqual(["OTHER_TOKEN"]);
    expect(unused).toEqual([]);
  });

  it("reports an allowlist entry that no longer matches anything", () => {
    const { unused } = applyAllowlist([], { schema: 1, entries: [validEntry] });
    expect(unused).toHaveLength(1);
  });

  it("keeps the committed allowlist valid", () => {
    expect(validateAllowlist(loadAllowlist())).toEqual([]);
  });
});

describe("scan scope", () => {
  it.each([
    ["api/twilio-send.js", true],
    ["workers/service-integration-router/persistence.ts", true],
    ["src/lib/backend.js", true],
    ["scripts/verify-db-contract.mjs", true],
    [".github/workflows/ci.yml", true],
    ["apps/mobile/app.config.ts", true],
    ["apps/mobile/eas.json", true],
    ["vercel.json", true],
    ["wrangler.integration-router.jsonc", true],
    ["tests/fixtures/env-fallback/unsafe/literal-fallback.js", false],
    ["tests/env-fallback-ban.test.js", false],
    ["docs/security/secret-fallback-ban.md", false],
  ])("classifies %s as in scope=%s", (path, expected) => {
    expect(isInScope(path)).toBe(expected);
  });

  it("names every production-capable root the record requires", () => {
    const covered = SCAN_SCOPE.map((entry) => entry.prefix ?? entry.path);
    for (const required of [
      "src/",
      "api/",
      "workers/",
      "scripts/",
      ".github/workflows/",
      "apps/mobile/app.config.ts",
      "apps/mobile/eas.json",
    ]) {
      expect(covered).toContain(required);
    }
  });

  it("excludes only fixtures and the scanner's own source", () => {
    expect([...SCAN_EXCLUSIONS]).toEqual([
      "tests/fixtures/",
      "scripts/lib/env-fallback-scan.mjs",
      "scripts/verify-env-fallback-ban.mjs",
    ]);
  });
});

describe("repository gate", () => {
  it("finds no banned secret fallback at this revision", () => {
    const allowlist = loadAllowlist();
    const tracked = execFileSync("git", ["ls-files", "-z"], {
      cwd: REPOSITORY_ROOT,
      encoding: "utf8",
      timeout: 1000,
      maxBuffer: 64 * 1024 * 1024,
    }).split("\0").filter((path) => path && isInScope(path));
    expect(tracked.length).toBeGreaterThan(100);

    // Exercise the same complete blocking CLI as CI, outside this worker's
    // coverage profiler. Fixture and classifier tests above remain in-process.
    // execFileSync throws on refusal, timeout or excess output; the assertion
    // below also requires the complete success report and checked-out count.
    const output = execFileSync(process.execPath, [
      fileURLToPath(new URL("../scripts/verify-env-fallback-ban.mjs", import.meta.url)),
    ], {
      cwd: REPOSITORY_ROOT,
      encoding: "utf8",
      // This is the complete repository scan, including cold reads on the
      // approved scratch disk; its bound is not a performance requirement.
      timeout: 30_000,
      maxBuffer: 1024 * 1024,
      env: { ...process.env, NODE_V8_COVERAGE: "" },
    });
    expect(output.trim()).toBe(
      `env-fallback ban: ${tracked.length} in-scope files scanned, `
      + `${allowlist.entries.length} reviewed allowlist entr${allowlist.entries.length === 1 ? "y" : "ies"}, no banned fallbacks.`,
    );
  }, 40_000);

  it("keeps the allowlist at its documented path", () => {
    expect(ALLOWLIST_PATH).toBe("config/env-fallback-allowlist.json");
  });
});


describe("reviewed credential identity", () => {
  it.each([
    'process.env.DATABASE_URL || process.env.STRIPE_API_KEY',
    'process.env.DATABASE_URL ?? (process.env.STRIPE_API_KEY || "")',
    'process.env.SUPABASE_DB_URL || process.env.DATABASE_URL',
    'process.env.SAMPLE_SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY',
  ])("rejects an unrelated credential: %s", expression => {
    expect(scanFile({ path: "api/example.js", source: `const value = ${expression};` }))
      .toEqual(expect.arrayContaining([expect.objectContaining({ kind: "unrelated-variable-fallback" })]));
  });

  it.each([
    "secrets['DEPLOY_TOKEN'] || 'committed-fallback'",
    'secrets["DEPLOY_TOKEN"] || \'committed-fallback\'',
    "env['DEPLOY_TOKEN'] || 'committed-fallback'",
    "secrets.DATABASE_URL || secrets.STRIPE_API_KEY",
    "secrets['DATABASE_URL'] || secrets['STRIPE_API_KEY']",
    "secrets['DEPLOY'] || 'committed-fallback'",
    "secrets.GH_TOKEN || secrets.GITHUB_TOKEN || 'committed-fallback'",
  ])("rejects a workflow fallback outside env: %s", expression => {
    expect(scanFile({ path: ".github/workflows/example.yml",
      source: `jobs:\n  deploy:\n    steps:\n      - with:\n          token: \${{ ${expression} }}\n`,
    })).toEqual(expect.arrayContaining([expect.objectContaining({ kind: "literal-fallback" })]));
  });

  it.each([
    "secrets.GH_TOKEN || secrets['GITHUB_TOKEN']",
    "secrets['SUPABASE_SECRET_KEY'] || secrets.SUPABASE_SERVICE_ROLE_KEY",
  ])("accepts only the documented workflow rename: %s", expression => {
    expect(scanFile({ path: ".github/workflows/example.yml",
      source: `env:\n  GH_TOKEN: \${{ ${expression} }}\n`,
    })).toEqual([]);
  });

  it("limits disposable database aliases to their reviewed verifier", () => {
    const source = "const value = process.env.SUPABASE_DB_URL || process.env.DB_BOUNDARY_DB_URL;";
    expect(scanFile({ path: "scripts/verify-db-boundary-tenancy.mjs", source })).toEqual([]);
    expect(scanFile({ path: "scripts/other.mjs", source })).toHaveLength(1);
    // The dues verifier was removed with the left-out dues feature; its
    // DATABASE_URL alias exemption went with it.
    const dues = "const value = process.env.SUPABASE_DB_URL || process.env.DATABASE_URL;";
    expect(scanFile({ path: "scripts/verify-dues-local.mjs", source: dues })).toHaveLength(1);
  });
});
