// @vitest-environment node

import { spawnSync } from "node:child_process";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { requireDatabaseUrl } from "../scripts/lib/required-database-url.mjs";

/**
 * Local database proof scripts that used to carry a committed connection
 * string. Each now fails closed. The shared-stack ports are named explicitly
 * because the old default silently selected one whenever the operator forgot to
 * export the variable.
 */
const LOCAL_PROOF_SCRIPTS = Object.freeze([
  ["scripts/verify-institutional-records-local.mjs", 'requireDatabaseUrl("INSTITUTIONAL_RECORDS_DB_URL")'],
  ["scripts/verify-member-operations-local.mjs", 'requireDatabaseUrl("MEMBER_OPERATIONS_DB_URL")'],
  ["scripts/verify-voice-survey-completion.mjs", 'requireDatabaseUrl("VOICE_SURVEY_DB_URL")'],
  ["scripts/verify-admin-command-center-local.mjs", "SUPABASE_DB_URL"],
  ["scripts/verify-chapter-events-local.mjs", "SUPABASE_DB_URL"],
  ["scripts/verify-compass-ai-governance-local.mjs", "SUPABASE_DB_URL"],
  ["scripts/verify-connected-automation-concurrency-local.mjs", "SUPABASE_DB_URL"],
  ["scripts/verify-event-scan-concurrency-local.mjs", "SUPABASE_DB_URL"],
  ["scripts/verify-form-filing-concurrency-local.mjs", "SUPABASE_DB_URL"],
  ["scripts/verify-member-account-lifecycle-local.mjs", "SUPABASE_DB_URL"],
  ["scripts/verify-mi1-automation-control-local.mjs", "SUPABASE_DB_URL"],
  ["scripts/verify-mi1-retention-engine-local.mjs", "SUPABASE_DB_URL"],
  ["scripts/verify-public-interest-submission-local.mjs", "SUPABASE_DB_URL"],
  ["scripts/verify-reward-peer-contact-local.mjs", "SUPABASE_DB_URL"],
  ["scripts/verify-specialized-task-template-concurrency-local.mjs", "SUPABASE_DB_URL"],
  ["scripts/verify-specialized-task-templates-local.mjs", "SUPABASE_DB_URL"],
  ["scripts/verify-twilio-sms-rate-limits-local.mjs", "SUPABASE_DB_URL"],
  ["scripts/verify-unified-messaging-local.mjs", "SUPABASE_DB_URL"],
]);

function readRepositoryFile(relative) {
  return readFileSync(fileURLToPath(new URL(`../${relative}`, import.meta.url)), "utf8");
}

describe("requireDatabaseUrl", () => {
  it("returns the trimmed configured value", () => {
    expect(
      requireDatabaseUrl("EXAMPLE_DB_URL", {
        env: { EXAMPLE_DB_URL: "  postgresql://user@127.0.0.1:5999/db  " },
      }),
    ).toBe("postgresql://user@127.0.0.1:5999/db");
  });

  it("falls through published aliases of the same value", () => {
    expect(
      requireDatabaseUrl("PRIMARY_DB_URL", {
        env: { LEGACY_DB_URL: "postgresql://user@127.0.0.1:5999/db" },
        aliases: ["LEGACY_DB_URL"],
      }),
    ).toBe("postgresql://user@127.0.0.1:5999/db");
  });

  it("prefers the primary name over an alias", () => {
    expect(
      requireDatabaseUrl("PRIMARY_DB_URL", {
        env: {
          PRIMARY_DB_URL: "postgresql://primary@127.0.0.1:5999/db",
          LEGACY_DB_URL: "postgresql://legacy@127.0.0.1:5999/db",
        },
        aliases: ["LEGACY_DB_URL"],
      }),
    ).toContain("primary@");
  });

  it.each([
    ["absent", {}],
    ["blank", { EXAMPLE_DB_URL: "   " }],
    ["non-string", { EXAMPLE_DB_URL: 5 }],
  ])("throws when the variable is %s", (_label, env) => {
    expect(() => requireDatabaseUrl("EXAMPLE_DB_URL", { env })).toThrow(
      /EXAMPLE_DB_URL must be set/,
    );
  });

  it("names every accepted variable when none is set", () => {
    expect(() => requireDatabaseUrl("PRIMARY_DB_URL", { env: {}, aliases: ["LEGACY_DB_URL"] }))
      .toThrow(/PRIMARY_DB_URL or LEGACY_DB_URL must be set/);
  });

  it("never echoes the configured value in its error", () => {
    let message = "";
    try {
      requireDatabaseUrl("EXAMPLE_DB_URL", { env: { EXAMPLE_DB_URL: "" } });
    } catch (error) {
      message = error.message;
    }
    expect(message).not.toContain("postgres");
  });

  it("refuses an empty variable name", () => {
    expect(() => requireDatabaseUrl("", { env: {} })).toThrow(/exact environment variable name/);
  });
});

describe("local database proof scripts fail closed", () => {
  it.each(LOCAL_PROOF_SCRIPTS)(
    "%s requires an explicit target instead of defaulting to a shared stack",
    (path, marker) => {
      const source = readRepositoryFile(path);
      expect(source).toContain("requireDatabaseUrl");
      expect(source).toContain(marker);
      expect(source).not.toMatch(/postgresql:\/\/[^"'\s]*:[^"'\s]*@/);
      expect(source).not.toContain("54422");
      expect(source).not.toContain("54322");
    },
  );

  it("leaves no script binding a shared-stack port in executable code", () => {
    // A connection string built for a stack the script just created at a
    // computed port is legitimate; a fixed 54322 or 54422 is the shared stack
    // this repair exists to stop selecting by accident. Comment lines are
    // documentation and are read out first.
    const scriptsDirectory = fileURLToPath(new URL("../scripts/", import.meta.url));
    const offenders = readdirSync(scriptsDirectory)
      .filter((name) => name.endsWith(".mjs"))
      .filter((name) => {
        const executable = readFileSync(`${scriptsDirectory}${name}`, "utf8")
          .split("\n")
          .filter((line) => !line.trimStart().startsWith("//"))
          .join("\n");
        return /postgres(?:ql)?:\/\/[^\s"'`]*@[^\s"'`]*:543[24]2/.test(executable);
      });
    expect(offenders).toEqual([]);
  });
});

describe("local database proof scripts refuse a tunnel-style loopback target", () => {
  // DEBT-UG-LOCAL-DB-PROOF-TARGET-GUARDS-INCONSISTENT-20260921: an SSH
  // tunnel to a hosted database listens on 127.0.0.1 too, so "is loopback" is
  // not a target check. Every operator-targeted local proof calls the shared
  // assertDisposableProofUrl() (owned disposable ports 55000-59999).
  // verify-chapter-standing-burst-local.mjs takes no target: it starts and
  // checks its own container.
  const scriptsDirectory = fileURLToPath(new URL("../scripts/", import.meta.url));
  const SELF_OWNED_TARGET = new Set(["verify-chapter-standing-burst-local.mjs"]);
  const proofs = [
    ...readdirSync(scriptsDirectory).filter((name) => /^verify-.*-local\.mjs$/.test(name)),
    "verify-voice-survey-completion.mjs",
  ].filter((name) => !SELF_OWNED_TARGET.has(name)).sort();
  const tunnel = "postgresql://postgres:postgres@127.0.0.1:6543/postgres";
  const env = {
    PATH: process.env.PATH,
    HOME: process.env.HOME,
    SUPABASE_DB_URL: tunnel,
    DATABASE_URL: tunnel,
    INSTITUTIONAL_RECORDS_DB_URL: tunnel,
    MEMBER_OPERATIONS_DB_URL: tunnel,
    VOICE_SURVEY_DB_URL: tunnel,
  };

  it("covers every operator-targeted local proof", () => {
    expect(proofs.length).toBeGreaterThanOrEqual(24);
    for (const name of proofs) {
      expect(readFileSync(`${scriptsDirectory}${name}`, "utf8"), name).toMatch(/assertDisposableProofUrl\(/);
    }
  });

  it.each(proofs)("%s refuses before connecting", (name) => {
    const result = spawnSync(process.execPath, [`scripts/${name}`], {
      cwd: fileURLToPath(new URL("../", import.meta.url)),
      encoding: "utf8",
      env,
      timeout: 60_000,
    });
    expect(result.status, result.stdout).not.toBe(0);
    expect(result.stderr).toMatch(/require the owned disposable loopback Supabase target on ports 55000-59999/);
    expect(result.stderr).not.toMatch(/ECONNREFUSED|password authentication/);
  }, 90_000);
});
