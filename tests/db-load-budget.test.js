// @vitest-environment node
// Database proofs scale their wall-clock budgets by
// a calibration query, so a loaded shared machine gives no false red while a
// real regression still fails.
import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { CALIBRATION_REFERENCE_MS, CONCURRENT_CALIBRATION_REFERENCE_MS, MAX_SCALE, budgetLine, calibrationMs, concurrentCalibrationCanMatter, concurrentCalibrationMs, loadScaledBudget, scaleOf, reportSamples, samplesLine, scaledBudget } from "./helpers/db-load-budget.mjs";

const LOCAL = {};
const CI_STANDARD = { RUNNER_ENVIRONMENT: "github-hosted" };

// The calibration helpers time their queries with
// performance.now(). Their stub queries wait on setTimeout, so on real timers
// a loaded machine stretched a 10 ms stub past the bound (44 ms against 40 on
// the DGX Spark). On a fake clock that both share, each stub takes exactly its
// delay and the median is asserted exactly, whatever the machine's load.
const onFakeClock = async (work) => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance"] });
  try {
    const pending = work();
    await vi.runAllTimersAsync();
    return await pending;
  } finally {
    vi.useRealTimers();
  }
};

describe("load-scaled database budgets", () => {
  it("keeps the written budget on a machine as fast as the reference or faster", () => {
    expect(scaledBudget(4_000, CALIBRATION_REFERENCE_MS / 2, { env: LOCAL })).toBe(4_000);
    expect(scaledBudget(4_000, CALIBRATION_REFERENCE_MS, { env: LOCAL })).toBe(4_000);
  });

  it("grows the budget by the calibration's slowdown on a loaded machine", () => {
    expect(scaledBudget(4_000, CALIBRATION_REFERENCE_MS * 2.5, { env: LOCAL })).toBe(10_000);
    expect(scaledBudget(1_000, 300, { reference: 100, env: LOCAL })).toBe(3_000);
  });

  it("never goes below the CI runner's own multiplier", () => {
    expect(scaledBudget(4_000, CALIBRATION_REFERENCE_MS, { env: CI_STANDARD })).toBe(12_000);
    expect(scaledBudget(4_000, CALIBRATION_REFERENCE_MS * 4, { env: CI_STANDARD })).toBe(16_000);
  });

  it("keeps the steward desk read bound at 4,000 ms in CI, as on Main, by passing no runner environment", () => {
    // The read site passes env: {} (the review of, P1): the CI runner's
    // multiplier would make its bound 12,000 ms, past the 8 s statement timeout.
    expect(scaledBudget(4_000, CALIBRATION_REFERENCE_MS, { env: {} })).toBe(4_000);
    expect(scaledBudget(4_000, CALIBRATION_REFERENCE_MS, { env: CI_STANDARD })).toBe(12_000);
    const source = readFileSync(new URL("./steward-desk-scale-latency-db.test.js", import.meta.url), "utf8");
    expect(source).toContain("loadScaledBudget(client, 4_000, { env: {}, label: \"steward desk profiled reads\" });\n    const measurements = await profileStewardDeskScale(client);");
  });

  it("caps the growth at four times the written budget", () => {
    expect(MAX_SCALE).toBe(4);
    expect(scaledBudget(4_000, CALIBRATION_REFERENCE_MS * 10, { env: LOCAL })).toBe(16_000);
    expect(scaledBudget(1_000, CALIBRATION_REFERENCE_MS * 100, { env: CI_STANDARD })).toBe(4_000);
  });

  it("takes the median of the calibration runs", async () => {
    const delays = [5, 40, 5, 5, 5];
    let run = 0;
    const client = { query: () => new Promise((resolve) => { setTimeout(resolve, delays[run++]); }) };
    const median = await onFakeClock(() => calibrationMs(client, 5));
    expect(run).toBe(5);
    expect(median).toBe(5);
  });
});

// Each run of a single-connection read is judged by
// a calibration taken beside it on the same connection.
describe("the best of several runs, each judged beside its own calibration", () => {
  const judge = async (first, later, calibrations, options) => {
    const { pairedFastest } = await import("./helpers/db-load-budget.mjs");
    const queue = [...later];
    const cal = [...calibrations];
    return pairedFastest(null, first, async () => ({ ms: queue.shift() }), { calibrate: async () => cal.shift(), ...options });
  };

  it("passes on the best run, so one run slowed by a burst does not fail", async () => {
    const judged = await judge(2_200, [900, 1_400], Array(9).fill(62), { baseMs: 1_000, budget: 1_000 });
    expect(judged.passed).toBe(true);
    expect(judged.best.ms).toBe(900);
  });

  it("still fails a read that is slow on every run on an idle machine, exactly as Main's bound", async () => {
    const judged = await judge(1_100, [1_050, 1_200], [62, 61, 63, 62, 64, 62, 61, 62, 63], { baseMs: 1_000, budget: 1_000 });
    expect(judged.runs.map((run) => run.bound)).toEqual([1_000, 1_000, 1_000]);
    expect(judged.passed).toBe(false);
  });

  it("judges a run on one of the Spark's efficiency cores by that core's speed", async () => {
    // Measured on the Spark (Nov 15, 2026): orgSteward 1,715 ms with the
    // calibration at 130 ms beside it, 620 ms at 62 ms on a performance core.
    const judged = await judge(1_715, [1_707, 1_723], [130, 128, 137, 130, 132, 134, 128, 135, 131], { baseMs: 1_000, budget: 1_000 });
    // Each run's bound follows the median of the three calibrations beside
    // it (130, 132 and 131 ms): 2,097, 2,129 and 2,113 ms.
    expect(judged.runs.map((run) => Math.round(run.bound))).toEqual([2_097, 2_129, 2_113]);
    expect(judged.passed).toBe(true);
    // Main judged all three against the start-of-test budget, 1,000 ms.
    expect(judged.best.ms).toBeGreaterThan(1_000);
  });

  // The review of, P3-2.
  it("still fails a read that is slow on every run when its paired calibration is over 90 ms", async () => {
    const judged = await judge(2_300, [2_350, 2_400], Array(9).fill(130), { baseMs: 1_000, budget: 1_000 });
    expect(judged.runs.map((run) => Math.round(run.bound))).toEqual([2_097, 2_097, 2_097]);
    expect(judged.passed).toBe(false);
  });

  // The review of, P3-1: the median of three.
  it("does not let one noisy calibration lift a run's bound, while two slow readings of three still do", async () => {
    const spike = await judge(1_300, [1_350, 1_320], [62, 200, 63, 61, 190, 62, 62, 63, 180], { baseMs: 1_000, budget: 1_000 });
    expect(spike.runs.map((run) => run.bound)).toEqual([1_000, 1_000, 1_000]);
    expect(spike.passed).toBe(false);
    const placed = await judge(1_300, [1_350, 1_320], [62, 130, 133, 62, 62, 63, 62, 61, 62], { baseMs: 1_000, budget: 1_000 });
    expect(Math.round(placed.runs[0].bound)).toBe(2_097);
    expect(placed.passed).toBe(true);
  });

  it("never judges a run more tightly than the start-of-test budget", async () => {
    const judged = await judge(1_400, [1_450, 1_420], Array(9).fill(62), { baseMs: 1_000, budget: 1_481 });
    expect(judged.runs.every((run) => run.bound === 1_481)).toBe(true);
    expect(judged.passed).toBe(true);
  });

  it("keeps CI's bound: the runner floor (3 x) holds unless a calibration passes 186 ms", async () => {
    const budget = scaledBudget(1_000, 60, { env: CI_STANDARD });
    expect(budget).toBe(3_000);
    const judged = await judge(400, [380, 390], [60, 61, 62, 150, 186, 160, 61, 62, 60], { baseMs: 1_000, budget });
    expect(judged.runs.map((run) => run.bound)).toEqual([3_000, 3_000, 3_000]);
    // The edge (the review of, P3-1): a median
    // of exactly 186 ms gives 3 x 1,000 = the floor itself; just above it the
    // paired scale takes over.
    const edge = await judge(400, [380, 390], [186, 186, 186, 186, 187, 186, 187, 187, 187], { baseMs: 1_000, budget });
    expect(edge.runs.map((run) => Math.round(run.bound))).toEqual([3_000, 3_000, 3_016]);
  });

  it("never passes a run that returned no time", async () => {
    const judged = await judge(undefined, [undefined, undefined], Array(9).fill(62), { baseMs: 1_000, budget: 1_000 });
    expect(judged.passed).toBe(false);
  });

  it("reads a calibration at or under 90 ms as Main does, and over it against the performance core", async () => {
    const { PERFORMANCE_CORE_CALIBRATION_MS, pairedScale, pairedLine } = await import("./helpers/db-load-budget.mjs");
    expect(PERFORMANCE_CORE_CALIBRATION_MS).toBe(62);
    expect(pairedScale(62)).toBe(1);
    expect(pairedScale(CALIBRATION_REFERENCE_MS)).toBe(1);
    expect(pairedScale(124)).toBe(2);
    expect(pairedScale(1_000)).toBe(MAX_SCALE);
    expect(pairedLine("member forms shared drafts, orgSteward", [{ ms: 1_715.4, calibration: 130.2, bound: 2_097.4 }, { ms: undefined, calibration: 62, bound: 1_000 }]))
      .toBe("DB SAMPLES member forms shared drafts, orgSteward: 1715 ms (calibration 130 ms, bound 2097 ms), error ms (calibration 62 ms, bound 1000 ms)\n");
  });

  it("is used at every single-connection budget site, and fastestMs is gone", () => {
    const helper = readFileSync(new URL("./helpers/db-load-budget.mjs", import.meta.url), "utf8");
    expect(helper).not.toContain("export async function fastestMs");
    const sites = {
      "./member-forms-shared-drafts-once-db.test.js": 1,
      "./shared-member-drafts-scale-db.test.js": 2,
      "./staff-desk-overview-scale-db.test.js": 1,
    };
    for (const [file, count] of Object.entries(sites)) {
      const source = readFileSync(new URL(file, import.meta.url), "utf8");
      expect(source.match(/await pairedFastest\(db, result\.ms, /g), file).toHaveLength(count);
      expect(source.match(/toBeLessThan\(judged\.best\.bound\)/g), file).toHaveLength(count);
      expect(source, file).not.toContain("fastestMs");
    }
  });
});

describe("the first, cold sample (ledgers 271 and 278)", () => {
  it("is held to the same scaled budget as the fastest of three at the steward desk read site", () => {
    const source = readFileSync(new URL("./steward-desk-scale-latency-db.test.js", import.meta.url), "utf8");
    const site = "expect(Math.min(...samples), context).toBeLessThan(budget);\n      expect(samples[0], context).toBeLessThan(firstBound);";
    expect(source).toContain("const firstBound = Math.min(budget, 7_000);");
    expect(source).toContain(site);
    expect(source.split(site)).toHaveLength(2);
    // The fixed 7,000 ms bound is gone with its helper (the review of,
    // P2-1): a cold first call of 4,500 ms beside two warm runs of 100 ms
    // passes the fastest-of-three check and now fails, as on Main before .
    expect(source).not.toContain("firstSampleBound");
    const budget = scaledBudget(4_000, CALIBRATION_REFERENCE_MS, { env: {} });
    expect(Math.min(4_500, 100, 100)).toBeLessThan(budget);
    expect(4_500).not.toBeLessThan(Math.min(budget, 7_000));
    // The review of, P2-1: from a calibration
    // of 157.5 ms the scaled budget passes 7,000, but a first sample of 7,000
    // to 8,000 ms still fails, as it did on Main.
    const loaded = scaledBudget(4_000, 160, { env: {} });
    expect(loaded).toBeGreaterThan(7_000);
    expect(7_500).not.toBeLessThan(Math.min(loaded, 7_000));
  });
});

describe("the budget line in the CI job log (ledger 271 addendum)", () => {
  it("prints the calibration, the scale and the budget once per call", async () => {
    const lines = [];
    const client = { query: async () => {} };
    const result = await loadScaledBudget(client, 4_000, { env: {}, label: "steward desk profiled reads", write: (line) => lines.push(line) });
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(/^DB LOAD BUDGET steward desk profiled reads: calibration \d+ ms \(reference 90 ms\), scale 1\.00, written 4000 ms, enforced 4000 ms\n$/);
    expect(result.budget).toBe(4_000);
    expect(result.enforced).toBe(4_000);
  });

  it("shows a scaled budget and its scale", () => {
    expect(budgetLine("staff desk overview", 2_000, 180, { budget: 4_000 })).toBe("DB LOAD BUDGET staff desk overview: calibration 180 ms (reference 90 ms), scale 2.00, written 2000 ms, enforced 4000 ms\n");
  });

  // The review of, P3-1: print the bound the
  // site enforces, so "scale 1.00" never stands beside an unexplained budget.
  it("names the runner floor that lifts a budget in CI", async () => {
    const lines = [];
    const client = { query: async () => {} };
    const result = await loadScaledBudget(client, 1_000, { env: CI_STANDARD, label: "member forms shared drafts", write: (line) => lines.push(line) });
    expect(result.enforced).toBe(3_000);
    expect(lines[0]).toMatch(/scale 1\.00, written 1000 ms, runner floor 3000 ms, enforced 3000 ms\n$/);
  });

  it("prints the waves' 7,000 ms cap as the enforced bound, with the budget it caps", async () => {
    const lines = [];
    const client = { query: async () => {} };
    const result = await loadScaledBudget(client, 4_000, { env: CI_STANDARD, label: "steward desk concurrent waves", cap: 7_000, write: (line) => lines.push(line) });
    expect(result).toMatchObject({ budget: 12_000, enforced: 7_000 });
    expect(lines[0]).toMatch(/scale 1\.00, written 4000 ms, runner floor 12000 ms, scaled budget 12000 ms, enforced 7000 ms\n$/);
    const source = readFileSync(new URL("./steward-desk-scale-latency-db.test.js", import.meta.url), "utf8");
    expect(source).toContain('label: "steward desk concurrent waves",\n      cap: 7_000,\n      concurrent: concurrentSkipped\n        ? undefined\n        : { createClient: () => new pg.Client({ connectionString: waveUrl, ssl: false }), peers: fanOut * rpcCalls.length },\n      concurrentSkipped,');
    expect(source).toContain("const concurrentSkipped = concurrentSkipReason(4_000, 7_000);");
    //: two waves under CI, where four timed out on 2-vCPU runners; eight locally.
    expect(source).toContain("const fanOut = process.env.CI ? 2 : 8;");
    expect(source).toContain("toBeLessThan(enforced);");
    expect(source).not.toContain("toBeLessThan(Math.min(budget, 7_000))");
  });

  it("prints each measured time with the bounds that judged it", () => {
    expect(samplesLine("steward desk profiled reads, list_steward_forms, balanced", [612.4, 66.2, 65], { fastest: 4_000, first: 7_000 }))
      .toBe("DB SAMPLES steward desk profiled reads, list_steward_forms, balanced: 612, 66, 65 ms; fastest under 4000 ms, first under 7000 ms\n");
    const lines = [];
    reportSamples("steward desk concurrent waves, balanced", [1_200, 1_400], { each: 7_000 }, (line) => lines.push(line));
    expect(lines).toEqual(["DB SAMPLES steward desk concurrent waves, balanced: 1200, 1400 ms; each under 7000 ms\n"]);
    const source = readFileSync(new URL("./steward-desk-scale-latency-db.test.js", import.meta.url), "utf8");
    expect(source).toContain("reportSamples(`steward desk profiled reads, ${measurement.name}, ${distribution}`, samples, { fastest: budget, first: firstBound });");
    expect(source).toContain("reportSamples(`steward desk concurrent waves, ${distribution}`, batches.map(([wave]) => wave.wall_ms), { each: enforced });");
  });

  it("writes to the process's stdout, which the required DB proof runner relays, at every budget site", () => {
    const helper = readFileSync(new URL("./helpers/db-load-budget.mjs", import.meta.url), "utf8");
    expect(helper).toContain("const stdout = (line) => process.stdout.write(line);");
    expect(helper).toContain("{ label = \"unlabelled site\", write = stdout, cap, concurrent: parallel, concurrentSkipped, ...options } = {}");
    expect(helper).toContain("export function reportSamples(label, samples, bounds, write = stdout)");
    const sites = {
      "./steward-desk-scale-latency-db.test.js": ["steward desk profiled reads", "steward desk concurrent waves"],
      "./member-forms-shared-drafts-once-db.test.js": ["member forms shared drafts"],
      "./shared-member-drafts-scale-db.test.js": ["shared member drafts"],
      "./staff-desk-overview-scale-db.test.js": ["staff desk overview"],
    };
    for (const [file, labels] of Object.entries(sites)) {
      const source = readFileSync(new URL(file, import.meta.url), "utf8");
      expect(source.match(/loadScaledBudget\(/g), file).toHaveLength(labels.length);
      for (const label of labels) expect(source, file).toContain(`label: "${label}"`);
    }
  });
});

// The steward desk's concurrent waves are
// also scaled by the calibration timed on as many connections as they open.
describe("the concurrent calibration (ledger 254, waves under load)", () => {
  it("scales by the larger slowdown of the one-connection and the concurrent calibration", () => {
    expect(CONCURRENT_CALIBRATION_REFERENCE_MS).toBe(260);
    expect(scaleOf(62)).toBe(1);
    expect(scaleOf(62, { concurrent: 206 })).toBe(1);
    expect(scaleOf(84, { concurrent: 520 })).toBe(2);
    expect(scaleOf(180, { concurrent: 130 })).toBe(2);
    expect(scaleOf(62, { concurrent: 5_000 })).toBe(MAX_SCALE);
  });

  // Measured on the DGX Spark (Nov 15, 2026, the 40 connections of local waves).
  it.each([
    ["idle", 62, 206, 743, 4_000],
    ["20 busy loops, where the one-connection rule failed the waves", 106, 898, 6_188, 7_000],
    ["16 connections of database load", 146, 420, 3_078, 6_489],
  ])("keeps a regression's bound and a loaded machine's waves green: %s", (_label, single, concurrent, slowestWave, enforced) => {
    const local = Math.min(scaledBudget(4_000, single, { env: {}, concurrent }), 7_000);
    expect(Math.round(local)).toBe(enforced);
    expect(slowestWave).toBeLessThan(local);
  });

  // The review of, P3-1.
  it("runs the concurrent calibration only where it can change the waves' bound: not on CI's standard runners", async () => {
    expect(concurrentCalibrationCanMatter(4_000, 7_000, LOCAL)).toBe(true);
    expect(concurrentCalibrationCanMatter(4_000, 7_000, CI_STANDARD)).toBe(false);
    // Skipped in CI, the bound is the 7,000 ms it would have been anyway.
    const lines = [];
    let opened = 0;
    const client = { query: async () => {} };
    const peer = () => { opened += 1; return { connect: async () => {}, query: async () => {}, end: async () => {} }; };
    const concurrent = concurrentCalibrationCanMatter(4_000, 7_000, CI_STANDARD) ? { createClient: peer, peers: 20 } : undefined;
    const result = await loadScaledBudget(client, 4_000, { env: CI_STANDARD, label: "steward desk concurrent waves", cap: 7_000, concurrent, write: (line) => lines.push(line) });
    expect(opened).toBe(0);
    expect(result).toMatchObject({ enforced: 7_000, concurrentCalibrationMs: undefined });
    expect(lines[0]).not.toContain("concurrent calibration");
  });

  // The review of, P3-1.
  it("says on the budget line when the concurrent calibration is skipped, and why", async () => {
    const { concurrentSkipReason } = await import("./helpers/db-load-budget.mjs");
    expect(concurrentSkipReason(4_000, 7_000, LOCAL)).toBeUndefined();
    expect(concurrentSkipReason(4_000, 7_000, CI_STANDARD)).toBe("runner floor 12000 ms reaches the 7000 ms cap");
    const lines = [];
    const client = { query: async () => {} };
    await loadScaledBudget(client, 4_000, { env: CI_STANDARD, label: "steward desk concurrent waves", cap: 7_000, concurrentSkipped: concurrentSkipReason(4_000, 7_000, CI_STANDARD), write: (line) => lines.push(line) });
    expect(lines[0]).toMatch(/^DB LOAD BUDGET steward desk concurrent waves: calibration \d+ ms \(reference 90 ms\), concurrent calibration skipped \(runner floor 12000 ms reaches the 7000 ms cap\), scale 1\.00, written 4000 ms, runner floor 12000 ms, scaled budget 12000 ms, enforced 7000 ms\n$/);
    expect(budgetLine("staff desk overview", 2_000, 62, { budget: 2_000 })).not.toContain("concurrent");
  });

  it("leaves CI's waves bound at 7,000 ms, which its runner floor already sets", () => {
    for (const concurrent of [100, 260, 900]) expect(Math.min(scaledBudget(4_000, 60, { env: CI_STANDARD, concurrent }), 7_000)).toBe(7_000);
  });

  it("times the calibration on that many connections at once, takes the median, and ends every client", async () => {
    const delays = [10, 10, 60, 10, 10, 10];
    let next = 0;
    const clients = [];
    const createClient = () => {
      const client = { ended: false, connect: async () => {}, query: () => new Promise((resolve) => { setTimeout(resolve, delays[next++ % delays.length]); }), end: async () => { client.ended = true; } };
      clients.push(client);
      return client;
    };
    const median = await onFakeClock(() => concurrentCalibrationMs(createClient, 3, 2));
    expect(clients).toHaveLength(3);
    expect(next).toBe(6);
    // Six readings, 10, 10, 60 and 10, 10, 10: the median is 10, and the one
    // slow reading neither lifts it nor counts toward a mean.
    expect(median).toBe(10);
    expect(clients.every((client) => client.ended)).toBe(true);
    const failing = [];
    await expect(concurrentCalibrationMs(() => {
      const client = { ended: false, connect: async () => { throw new Error("refused"); }, query: async () => {}, end: async () => { client.ended = true; } };
      failing.push(client);
      return client;
    }, 2)).rejects.toThrow("refused");
    expect(failing.every((client) => client.ended)).toBe(true);
  });

  it("prints the concurrent calibration and its connection count on the budget line", async () => {
    const lines = [];
    const client = { query: async () => {} };
    const peer = () => ({ connect: async () => {}, query: async () => {}, end: async () => {} });
    const result = await loadScaledBudget(client, 4_000, { env: {}, label: "steward desk concurrent waves", cap: 7_000, concurrent: { createClient: peer, peers: 40 }, write: (line) => lines.push(line) });
    expect(result.enforced).toBe(4_000);
    expect(lines[0]).toMatch(/^DB LOAD BUDGET steward desk concurrent waves: calibration \d+ ms \(reference 90 ms\), concurrent calibration \d+ ms on 40 connections \(reference 260 ms\), scale 1\.00, written 4000 ms, enforced 4000 ms\n$/);
    expect(budgetLine("steward desk concurrent waves", 4_000, 106, { budget: 13_815, enforced: 7_000, concurrent: 898, peers: 40 }))
      .toBe("DB LOAD BUDGET steward desk concurrent waves: calibration 106 ms (reference 90 ms), concurrent calibration 898 ms on 40 connections (reference 260 ms), scale 3.45, written 4000 ms, scaled budget 13815 ms, enforced 7000 ms\n");
  });
});
