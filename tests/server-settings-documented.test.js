// @vitest-environment node
// #9532: .env.example lists every setting the server and the build read (names only).
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const ROOT = fileURLToPath(new URL("../", import.meta.url));
const read = (path) => readFileSync(join(ROOT, path), "utf8");
const NAME = /^[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+$/;
const CAPS = /^[A-Z][A-Z0-9_]*$/;
const DOT_READ = /\b[A-Za-z_$]*env\??\.([A-Za-z_]\w*)/gi;
const META_READ = /import\.meta\.env\.([A-Z][A-Z0-9_]*)/g;

// Read by the code but not deployment settings.
const NOT_SETTINGS = {
  CI: "CI runner", CI_ASSURANCE_WORKERS: "CI test workers", DEV: "Vite built-in",
  GITHUB_ACTIONS: "CI runner", MODE: "Vite built-in", PROD: "Vite built-in",
  TZ: "test time zone", UG_TEST_DEFAULT_SHELL: "test-only", VITEST: "test runner",
  VITEST_KEEP_TZ: "test-only", UNION_UPDATE: "notification category",
  AWS_LAMBDA_FUNCTION_NAME: "platform runtime marker", AWS_LAMBDA_FUNCTION_VERSION: "platform runtime marker",
  LAMBDA_TASK_ROOT: "platform runtime marker", VERCEL_GIT_COMMIT_REF: "Vercel-provided", VERCEL_TOKEN: "Vercel CLI credential, only refused",
  ENABLE_ONLY_AFTER_CONTACT_VERIFICATION_REVIEWER_AND_PURGE_READY: "a confirmation value, not a setting name",
};

const sources = (dir) => readdirSync(join(ROOT, dir), { withFileTypes: true }).flatMap((entry) => {
  const path = join(dir, entry.name);
  if (entry.name === "node_modules" || entry.name.startsWith(".")) return [];
  return entry.isDirectory() ? sources(path) : /\.[cm]?[jt]sx?$/.test(entry.name) ? [path] : [];
});

// env.NAME, env["NAME"], "NAME", `${prefix}NAME`; a "SAMPLE_" file reads SAMPLE_ twins.
function serverNames(source) {
  const names = new Set([...source.matchAll(DOT_READ)].map((m) => m[1]).filter((n) => CAPS.test(n)));
  const literals = [...source.matchAll(/(["'`])([A-Z][A-Z0-9_]*)\1/g)].map((m) => m[2]);
  const prefixes = literals.filter((literal) => literal.endsWith("_"));
  const twins = prefixes.includes("SAMPLE_");
  for (const literal of literals.filter((l) => NAME.test(l))) {
    names.add(literal);
    if (twins && !literal.startsWith("SAMPLE_")) names.add(`SAMPLE_${literal}`);
  }
  for (const [, suffix] of source.matchAll(/\$\{[^}]+\}([A-Z][A-Z0-9_]*)/g)) {
    if (!NAME.test(suffix)) continue;
    for (const prefix of prefixes) names.add(prefix + suffix);
    if (twins) names.add(suffix);
  }
  return names;
}

const buildNames = (source) => new Set([
  ...[...source.matchAll(DOT_READ)].map((m) => m[1]).filter((n) => CAPS.test(n)),
  ...[...source.matchAll(META_READ)].map((m) => m[1]),
]);
const listed = (text) => new Set([...text.matchAll(/^[ \t]*#?[ \t]*([A-Z][A-Z0-9_]*)=/gm)].map((m) => m[1]));

// node scripts in Vercel's install and build commands and npm's build.
function deployScripts() {
  const vercel = JSON.parse(read("vercel.json"));
  const commands = [vercel.installCommand, vercel.buildCommand, JSON.parse(read("package.json")).scripts.build].join(" ");
  return [...new Set([...commands.matchAll(/\bnode\s+(scripts\/[\w./-]+\.mjs)/g)].map((m) => m[1]))];
}

function readers() {
  const found = new Map();
  const note = (path, names) => { for (const n of names) found.set(n, [...(found.get(n) ?? []), path]); };
  for (const path of sources("api")) note(path, serverNames(read(path)));
  for (const path of ["vite.config.mjs", ...deployScripts()]) note(path, buildNames(read(path)));
  // The api dot pattern, so `import.meta.env?.NAME` counts as a read too.
  for (const path of sources("src")) note(path, buildNames(read(path)));
  return found;
}

describe("server settings list (#9532)", () => {
  const documented = listed(read(".env.example"));
  const found = readers();

  it("lists every setting the server and the build read in .env.example", () => {
    expect(deployScripts().length).toBeGreaterThan(0);
    const missing = [...found.keys()].filter((n) => !documented.has(n) && !Object.hasOwn(NOT_SETTINGS, n)).sort()
      .map((n) => `${n} (read in ${[...new Set(found.get(n))].sort().join(", ")})`);
    expect(missing, "list each in .env.example with its purpose, or in NOT_SETTINGS").toEqual([]);
  });

  // The stress harness that read the MEMBER_*STRESS* names is not part of this
  // edition, so only the not-a-setting list is held current here.
  it("keeps NOT_SETTINGS current", () => {
    expect(Object.keys(NOT_SETTINGS).filter((n) => !found.has(n) || documented.has(n))).toEqual([]);
  });

  it("parses reads and listed lines", () => {
    const source = 'process.env.ALPHA_ONE; env?.BRAVO_TWO; env["CHARLIE_THREE"]; envValue(env, "DELTA_FOUR"); '
      + 'env[`${demo ? "SAMPLE_" : ""}ECHO_FIVE`]; env.notASetting;';
    expect([...serverNames(source)].sort()).toEqual(["ALPHA_ONE", "BRAVO_TWO", "CHARLIE_THREE", "DELTA_FOUR",
      "ECHO_FIVE", "SAMPLE_CHARLIE_THREE", "SAMPLE_DELTA_FOUR", "SAMPLE_ECHO_FIVE"]);
    const named = 'const prefix = sample ? "SAMPLE_PAY_" : "PAY_"; value(env, `${prefix}CLIENT_ID`);';
    expect([...serverNames(named)].sort()).toEqual(["PAY_CLIENT_ID", "SAMPLE_PAY_CLIENT_ID"]);
    expect([...listed("# Purpose.\nSET_ONE=x\n# UNSET_TWO=\n# not A_NAME")].sort()).toEqual(["SET_ONE", "UNSET_TWO"]);
  });
});
