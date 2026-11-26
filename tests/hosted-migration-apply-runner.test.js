// @vitest-environment node
//
// OPS-UG-SAMPLE-PRODUCTION-35-STAMP-MIGRATION-DIVERGENCE-REREGISTERED-20261028
// (#6434): the audited hosted apply runner keeps its exact one-row history
// append, with one explicit per-invocation exception that names ONE stamp and
// ONE environment (SAMPLE only).
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  ALLOWANCE_FLAG, allowanceRecord, checkHistoryAppend, checkPreHistory, expectedHistory, parseOutOfOrderAllowance, unexpectedArguments,
} from "../scripts/hosted-migration-apply-runner.mjs";

const STAMP = "20261023050348";
const LATEST = "20261023174600";
const row = (version, name = `m_${version}`) => ({ version, name, statements_count: 1, statements_sha256: "a".repeat(64) });
const before = {
  history_count: 4,
  latest_version: LATEST,
  full_history: [row("20261022192718"), row("20261023050341"), row("20261023173500"), row(LATEST)],
};
const applied = [row(STAMP, "bot_organization_directory_visibility")];
const allowance = { environment: "sample", stamp: STAMP };
const runner = readFileSync(new URL("../scripts/hosted-migration-apply-runner.mjs", import.meta.url), "utf8");

describe("out-of-order allowance flag", () => {
  it("accepts exactly one SAMPLE allowance naming this run's stamp, in either flag form", () => {
    expect(parseOutOfOrderAllowance(["--apply", "sample", ALLOWANCE_FLAG, `sample:${STAMP}`], { target: "sample", version: STAMP })).toEqual(allowance);
    expect(parseOutOfOrderAllowance(["--approve", "sample", "f".repeat(64), `${ALLOWANCE_FLAG}=sample:${STAMP}`], { target: "sample", version: STAMP })).toEqual(allowance);
    expect(parseOutOfOrderAllowance(["--apply", "sample"], { target: "sample", version: STAMP })).toBeNull();
  });

  it.each([
    ["production as the named environment", ["--apply", "sample", ALLOWANCE_FLAG, `production:${STAMP}`], "sample", /SAMPLE only/u],
    ["a production target", ["--apply", "production", ALLOWANCE_FLAG, `sample:${STAMP}`], "production", /SAMPLE only/u],
    ["another stamp", ["--apply", "sample", ALLOWANCE_FLAG, "sample:20261023173500"], "sample", /names this run's migration/u],
    ["a second allowance", ["--apply", "sample", ALLOWANCE_FLAG, `sample:${STAMP}`, `${ALLOWANCE_FLAG}=sample:${STAMP}`], "sample", /One out-of-order allowance/u],
    ["no value", ["--apply", "sample", ALLOWANCE_FLAG], "sample", /takes <environment>:<14-digit stamp>/u],
    ["a stamp without its environment", ["--apply", "sample", ALLOWANCE_FLAG, STAMP], "sample", /takes <environment>:<14-digit stamp>/u],
    ["a short stamp", ["--apply", "sample", ALLOWANCE_FLAG, "sample:2026102305034"], "sample", /takes <environment>:<14-digit stamp>/u],
  ])("refuses %s", (_name, args, target, message) => {
    expect(() => parseOutOfOrderAllowance(args, { target, version: STAMP })).toThrow(message);
  });

  it("leaves no room for other arguments beside the phase, target, approve hash and allowance", () => {
    expect(unexpectedArguments(["--apply", "sample", ALLOWANCE_FLAG, `sample:${STAMP}`])).toEqual([]);
    expect(unexpectedArguments(["--approve", "sample", "f".repeat(64), ALLOWANCE_FLAG, `sample:${STAMP}`])).toEqual([]);
    expect(unexpectedArguments(["--apply", "sample", "--out-of-order"])).toEqual(["--out-of-order"]);
    expect(unexpectedArguments(["--apply", "sample", "f".repeat(64)])).toEqual(["f".repeat(64)]);
  });
});

describe("history checks", () => {
  it("without the allowance keeps the exact one-row append", () => {
    const later = row("20261028210000");
    const appended = { history_count: 5, latest_version: later.version, full_history: [...before.full_history, later] };
    expect(() => checkHistoryAppend(appended, before, [later], later.version, null)).not.toThrow();
    expect(() => checkPreHistory(before, { initialCount: 4, preLatest: LATEST, version: later.version, allowance: null })).not.toThrow();
  });

  it("under the allowance counts +1, inserts the row at its sorted position and keeps latest_version", () => {
    const expected = expectedHistory(before, applied, STAMP, allowance);
    expect(expected.history_count).toBe(5);
    expect(expected.latest_version).toBe(LATEST);
    expect(expected.full_history.map((entry) => entry.version)).toEqual(["20261022192718", "20261023050341", STAMP, "20261023173500", LATEST]);
    expect(() => checkPreHistory(before, { initialCount: 4, preLatest: LATEST, version: STAMP, allowance })).not.toThrow();
    expect(() => checkHistoryAppend(expected, before, applied, STAMP, allowance)).not.toThrow();
  });

  it("refuses the out-of-order history when no allowance was given", () => {
    const inserted = expectedHistory(before, applied, STAMP, allowance);
    expect(() => checkHistoryAppend(inserted, before, applied, STAMP, null)).toThrow(/Exact one-row history append/u);
  });

  it.each([
    ["the row appended at the end", (state) => ({ ...state, full_history: [...before.full_history, ...applied] })],
    ["latest_version moved to the stamp", (state) => ({ ...state, latest_version: STAMP })],
    ["a count that is not +1", (state) => ({ ...state, history_count: 6 })],
    ["another row changed", (state) => ({ ...state, full_history: state.full_history.map((entry, index) => (index === 0 ? { ...entry, name: "changed" } : entry)) })],
    ["a second inserted row", (state) => ({ ...state, history_count: 6, full_history: [...state.full_history.slice(0, 2), row("20261023050000"), ...state.full_history.slice(2)] })],
  ])("refuses %s under the allowance", (_name, mutate) => {
    const state = mutate(expectedHistory(before, applied, STAMP, allowance));
    expect(() => checkHistoryAppend(state, before, applied, STAMP, allowance)).toThrow(/sorted position/u);
  });

  it("refuses the allowance for a stamp that is not older than the latest version", () => {
    const later = "20261028210000";
    expect(() => checkPreHistory(before, { initialCount: 4, preLatest: LATEST, version: later, allowance: { environment: "sample", stamp: later } }))
      .toThrow(/needs a later latest_version/u);
    expect(() => expectedHistory(before, [row(later)], later, { environment: "sample", stamp: later })).toThrow(/needs a later history row/u);
  });

  it("records the allowance, its stamp and the kept latest_version, or that none was used", () => {
    expect(allowanceRecord(allowance, LATEST)).toEqual({ used: true, environment: "sample", stamp: STAMP, latest_version_kept: LATEST });
    expect(allowanceRecord(null, LATEST)).toEqual({ used: false });
  });
});

describe("runner wiring", () => {
  it("records the allowance in the attempt, PASS and manifest files and the receipt, and rechecks it in every later phase", () => {
    for (const needle of [
      "out_of_order_allowance: allowanceRecord(allowance, null)",
      "out_of_order_allowance: allowanceRecord(allowance, r.state.latest_version)",
      "out_of_order_allowance: json(`${target}/REHEARSAL-PASS.json`).out_of_order_allowance",
      "out_of_order_allowance: outOfOrder, verification:",
      'sameAllowance(`${target}/PREFLIGHT-PASS.json`, "Preflight")',
      'sameAllowance(`${target}/REHEARSAL-PASS.json`, "Rehearsal")',
    ]) expect(runner, needle).toContain(needle);
    expect(runner).not.toMatch(/out[-_]of[-_]order[^\n]*production:/u);
  });

  it("refuses a production allowance before reading credentials or touching a database", () => {
    const dir = mkdtempSync(join(tmpdir(), "hosted-apply-runner-"));
    try {
      mkdirSync(join(dir, "production"));
      writeFileSync(join(dir, "runner.mjs"), runner);
      writeFileSync(join(dir, "lifecycle-cte.sql"), "with x as (select 1)");
      writeFileSync(join(dir, "state-select.sql"), "select 1");
      writeFileSync(join(dir, "env.json"), JSON.stringify({ merge: "0".repeat(40), pin: "0".repeat(64), file: `${STAMP}_x.sql`, pr: 6434, initial: { sample: 4, production: 4 }, pre_latest: LATEST }));
      const run = spawnSync(process.execPath, [join(dir, "runner.mjs"), "--preflight", "production", ALLOWANCE_FLAG, `sample:${STAMP}`], { encoding: "utf8", env: { ...process.env, PATH: "" } });
      expect(run.status).not.toBe(0);
      expect(run.stderr).toMatch(/The out-of-order allowance is SAMPLE only/u);
      const unknown = spawnSync(process.execPath, [join(dir, "runner.mjs"), "--preflight", "sample", "--out-of-order"], { encoding: "utf8", env: { ...process.env, PATH: "" } });
      expect(unknown.stderr).toMatch(/Unexpected arguments: --out-of-order/u);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
