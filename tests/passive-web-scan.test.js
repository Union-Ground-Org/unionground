// @vitest-environment node

import { spawnSync } from "node:child_process";
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const source = fileURLToPath(new URL("../scripts/run-passive-web-scan.mjs", import.meta.url));
const policy = fileURLToPath(new URL("../config/security-scanner-policy.json", import.meta.url));
const secret = "PRIVATE_RESPONSE_AND_COOKIE_VALUE";
const report = {
  "@programName": "ZAP",
  site: [{
    "@name": "https://unionground.org",
    alerts: [{ pluginid: "10038", alertRef: "10038-1", alert: "Content Security Policy Header Not Set", riskcode: "2", confidence: "3", instances: [{ uri: `https://unionground.org/private/${secret}`, evidence: secret, cookie: secret }] }],
  }],
};
let root;
let output;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "passive-scan-cli-"));
  for (const name of ["scripts", "config", "bin"]) mkdirSync(join(root, name));
  output = join(root, "output with spaces");
  copyFileSync(source, join(root, "scripts/run-passive-web-scan.mjs"));
  copyFileSync(policy, join(root, "config/security-scanner-policy.json"));
  const docker = join(root, "bin/docker");
  writeFileSync(docker, `#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");
const args = process.argv.slice(2);
fs.writeFileSync(process.env.DOCKER_CALL_FILE, JSON.stringify(args));
const volume = args[args.indexOf("--volume") + 1];
const mount = args[args.indexOf("--mount") + 1];
const directory = args.includes("--mount") ? mount.match(/source=([^,]+)/)[1] : volume.slice(0, -":/zap/wrk:rw".length);
const report = path.join(directory, "zap-report.json");
if (process.env.SCAN_MODE === "valid") fs.writeFileSync(report, process.env.SCAN_REPORT);
if (process.env.SCAN_MODE === "malformed") fs.writeFileSync(report, process.env.SCAN_SECRET);
if (process.env.SCAN_MODE === "oversized") { fs.writeFileSync(report, ""); fs.truncateSync(report, 64 * 1024 * 1024 + 1); }
if (process.env.SCAN_MODE === "symlink") fs.symlinkSync(process.env.OUTSIDE_REPORT, report);
console.log(process.env.SCAN_SECRET);
console.error("Permission denied: " + process.env.SCAN_SECRET);
process.exit(Number(process.env.SCAN_EXIT));
`);
  chmodSync(docker, 0o755);
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

function run({ mode = "valid", exit = 0, value = report, args, env = {} } = {}) {
  return spawnSync(process.execPath, [join(root, "scripts/run-passive-web-scan.mjs"), ...(args ?? ["--target", "https://unionground.org", "--out", output])], {
    encoding: "utf8",
    env: { ...process.env, PATH: `${join(root, "bin")}:${process.env.PATH}`, DOCKER_CALL_FILE: join(root, "docker-call.json"), SCAN_MODE: mode, SCAN_EXIT: String(exit), SCAN_REPORT: JSON.stringify(value), SCAN_SECRET: secret, ...env },
  });
}
function expectPrivateFailure(result) {
  expect(result.status).toBe(1);
  expect(result.stderr).toContain("PASSIVE_SCAN_FAIL");
  expect(result.stdout + result.stderr).not.toContain(secret);
  expect(existsSync(join(output, "passive-web-summary.json"))).toBe(false);
  expect(readdirSync(output)).toEqual([]);
}

describe("passive scanner CLI execution", () => {
  it.each([0, 1, 2])("retains only a redacted summary for valid informational ZAP exit %i", (exit) => {
    const result = run({ exit });
    expect(result.status, result.stderr).toBe(0);
    expect(readdirSync(output)).toEqual(["passive-web-summary.json"]);
    const summary = readFileSync(join(output, "passive-web-summary.json"), "utf8");
    expect(summary + result.stdout + result.stderr).not.toContain(secret);
    expect(JSON.parse(summary)).toMatchObject({ blocking: false, alertCount: 1, alerts: [{ pluginId: "10038", instanceCount: 1 }] });
  });

  it("runs as the operator in a private writable home without weakening the target or image", () => {
    expect(run().status).toBe(0);
    const args = JSON.parse(readFileSync(join(root, "docker-call.json"), "utf8"));
    expect(args[args.indexOf("--user") + 1]).toBe(`${process.getuid()}:${process.getgid()}`);
    expect(args).toContain("HOME=/zap/wrk/home");
    expect(args[args.indexOf("-z") + 1]).toBe("-dir /zap/wrk/home/zap");
    expect(args[args.indexOf("-t") + 1]).toBe("https://unionground.org");
    expect(args.some((arg) => /^ghcr\.io\/zaproxy\/zaproxy@sha256:[a-f0-9]{64}$/.test(arg))).toBe(true);
    expect(args).toContain("zap-baseline.py");
    expect(args).not.toContain("--privileged");
  });

  it.each([3, 125, 137])("refuses execution exit %i even when a complete report was written", (exit) => {
    expectPrivateFailure(run({ exit }));
  });

  it.each(["missing", "malformed", "oversized"])("refuses and cleans an exit-zero %s report without logging scanner output", (mode) => {
    expectPrivateFailure(run({ mode }));
  });

  it("omits free-form alert names and unexpected report metadata from the retained summary", () => {
    const value = structuredClone(report);
    value.site[0].alerts[0].alert = secret;
    value.site[0].alerts[0].name = secret;
    value.site[0].alerts[0].description = secret;
    value.site[0].alerts[0].headers = { cookie: secret };
    value.unexpected = secret;
    const result = run({ value });
    expect(result.status, result.stderr).toBe(0);
    const summary = readFileSync(join(output, "passive-web-summary.json"), "utf8");
    expect(summary + result.stdout + result.stderr).not.toContain(secret);
    expect(JSON.parse(summary).alerts[0]).toEqual({ pluginId: "10038", alertRef: "10038-1", riskcode: "2", confidence: "3", instanceCount: 1 });
  });

  it.each([{}, { site: [] }, { site: [{}] }, { site: [{ alerts: "invalid" }] }])("refuses an incomplete report %j", (value) => {
    expectPrivateFailure(run({ value }));
  });

  it("never adopts a previous report or summary when the new scanner produces nothing", () => {
    mkdirSync(output);
    writeFileSync(join(output, "zap-report.json"), JSON.stringify(report));
    writeFileSync(join(output, "passive-web-summary.json"), "stale summary");
    const result = run({ mode: "missing" });
    expect(result.status).toBe(1);
    expect(existsSync(join(output, "passive-web-summary.json"))).toBe(false);
    // The current attempt owns only its private workspace, never this preexisting file.
    expect(readFileSync(join(output, "zap-report.json"), "utf8")).toBe(JSON.stringify(report));
  });

  it("refuses report symlinks without reading or altering their target", () => {
    const outside = join(root, "outside.json");
    writeFileSync(outside, JSON.stringify(report));
    expectPrivateFailure(run({ mode: "symlink", env: { OUTSIDE_REPORT: outside } }));
    expect(readFileSync(outside, "utf8")).toBe(JSON.stringify(report));
  });

  it("rejects an unlisted target without echoing its path or credentials", () => {
    const result = run({ args: ["--target", `https://user:${secret}@unionground.org/private`, "--out", output] });
    expect(result.status).toBe(1);
    expect(result.stdout + result.stderr).not.toContain(secret);
    expect(existsSync(join(root, "docker-call.json"))).toBe(false);
  });
});
