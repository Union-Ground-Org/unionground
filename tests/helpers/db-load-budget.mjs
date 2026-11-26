// A wall-clock budget in a database proof, scaled by
// how fast this database answers a fixed calibration query right now. On a
// shared machine under load (the DGX Spark at a load of 40 ran the steward
// desk reads in 4,174 ms against a 4,000 ms budget), the calibration slows by
// the same factor as the reads, so the budget grows with it; a real regression
// slows only the reads and still fails. The budget is never below the written
// one, and never below runnerTimeout's, so CI keeps its own multiplier.
import { runnerTimeout } from "../../scripts/lib/runner-timeout.mjs";

// CPU-bound work in the database's own executor: no table, no lock, no I/O.
export const CALIBRATION_SQL = "select count(*) from (select md5(g::text) from generate_series(1, 1000000) g) calibration";
// The calibration's median on a lightly loaded DGX Spark (the disposable
// local database, Nov 15, 2026), with headroom: at or under it, the written
// budget stands.
export const CALIBRATION_REFERENCE_MS = 90;
// The most a budget may grow: a machine more than four times slower than the
// reference fails the proof honestly instead of stretching it without limit.
export const MAX_SCALE = 4;
// The steward desk's concurrent waves
// open 40 connections at once (8 waves of 5 locally), and on a loaded shared
// machine they slow far more than one connection does. On the DGX Spark on
// Nov 15, 2026, two lanes' waves read 4,064 and 4,086 ms against 4,000 while
// the one-connection calibration read 78 and 84 ms, under its 90 ms reference,
// so nothing scaled. Timed on as many connections at once as the waves open,
// the calibration follows them: its median was 200 to 228 ms idle and 420 to
// 898 ms under load, as the waves went from under 750 ms to 1.3 to 6.2 s. This
// is the idle Spark's 40-connection median, with headroom.
//
// It holds for the DGX Spark only. A machine with fewer cores can read more
// than 260 ms idle, which lifts its idle wave bound above 4,000 ms (never past
// the 7,000 ms cap). CI's standard runners skip the concurrent calibration
// (concurrentCalibrationCanMatter), and lanes prove on the Spark (the review
// of, P3-2;).
export const CONCURRENT_CALIBRATION_REFERENCE_MS = 260;
// The DGX Spark has 10 performance cores (Cortex-
// X925) and 10 efficiency cores (Cortex-A725). The calibration reads about
// 62 ms on a performance core and about 130 ms on an efficiency core (2.1
// times), but a single-connection read slows more there: the member-forms
// orgSteward read took about 620 ms on a performance core and 1,707 to 1,723
// ms on an efficiency core (2.8 times). This is the calibration on a
// performance core: a run whose paired calibration is over
// CALIBRATION_REFERENCE_MS is judged against it (pairedScale).
export const PERFORMANCE_CORE_CALIBRATION_MS = 62;

/** The median time of the calibration query over `runs` runs on `client`. */
export async function calibrationMs(client, runs = 5) {
  const times = [];
  for (let run = 0; run < runs; run += 1) {
    const started = performance.now();
    await client.query(CALIBRATION_SQL);
    times.push(performance.now() - started);
  }
  times.sort((a, b) => a - b);
  return times[Math.floor(times.length / 2)];
}

/**
 * The median time of the calibration query run on `peers` connections at
 * once, `rounds` times: how fast this database does parallel work right now.
 * `createClient` returns an unconnected client; every one is ended.
 */
export async function concurrentCalibrationMs(createClient, peers, rounds = 3) {
  const clients = Array.from({ length: peers }, () => createClient());
  try {
    await Promise.all(clients.map((client) => client.connect()));
    const times = [];
    for (let round = 0; round < rounds; round += 1) {
      times.push(...await Promise.all(clients.map(async (client) => {
        const started = performance.now();
        await client.query(CALIBRATION_SQL);
        return performance.now() - started;
      })));
    }
    times.sort((a, b) => a - b);
    return times[Math.floor(times.length / 2)];
  } finally {
    await Promise.all(clients.map((client) => client.end().catch(() => {})));
  }
}

/**
 * Whether a concurrent calibration can change a site's bound: only where the
 * runner floor for `baseMs` sits under the site's `cap`. On CI's standard
 * runners the floor (3 x 4,000) already reaches the waves' 7,000 ms cap, so
 * the calibration there would cost about 2 s a run and change nothing (the
 * review of, P3-1;).
 */
export function concurrentCalibrationCanMatter(baseMs, cap, env = process.env) {
  return runnerTimeout(baseMs, env) < cap;
}

/**
 * Why a site skips its concurrent calibration, for the budget line, or
 * undefined when it runs (the review of, P3-1).
 */
export function concurrentSkipReason(baseMs, cap, env = process.env) {
  return concurrentCalibrationCanMatter(baseMs, cap, env) ? undefined : `runner floor ${runnerTimeout(baseMs, env)} ms reaches the ${cap} ms cap`;
}

/**
 * The slowdown a budget is scaled by: the larger of the one-connection
 * calibration's and, when one was taken, the concurrent calibration's, each
 * against its own reference, from 1 to MAX_SCALE.
 */
export function scaleOf(calibration, { reference = CALIBRATION_REFERENCE_MS, concurrent, concurrentReference = CONCURRENT_CALIBRATION_REFERENCE_MS } = {}) {
  const slowdown = Math.max(calibration / reference, concurrent === undefined ? 0 : concurrent / concurrentReference);
  return Math.min(MAX_SCALE, Math.max(1, slowdown));
}

/**
 * The budget for `baseMs` when the calibration took `calibration` ms: the
 * written budget times the slowdown (scaleOf), never below
 * runnerTimeout(baseMs, env). A site whose bound never took the runner
 * multiplier on Main passes `env: {}` so CI keeps the written bound.
 */
export function scaledBudget(baseMs, calibration, { env = process.env, ...scaling } = {}) {
  return Math.max(runnerTimeout(baseMs, env), baseMs * scaleOf(calibration, scaling));
}

/**
 * The scale for one run from a calibration taken beside it on the same
 * connection: 1 at or under CALIBRATION_REFERENCE_MS, exactly as
 * the start-of-test calibration is read; over it, the run's backend was on a
 * slower core or slowed by load, so the run is judged against the
 * performance-core calibration (PERFORMANCE_CORE_CALIBRATION_MS), up to
 * MAX_SCALE.
 */
export function pairedScale(calibration) {
  return calibration <= CALIBRATION_REFERENCE_MS ? 1 : Math.min(MAX_SCALE, calibration / PERFORMANCE_CORE_CALIBRATION_MS);
}

/**
 * Judges a single-connection read by its best of 1 + `extraRuns` runs, each
 * against its own bound. The first run is the
 * one already taken (`firstMs`); each later run comes from `measureAgain`.
 * Every run gets three calibration queries on `client` beside it (three after
 * the first; one before and two after each later one) and is read by their
 * median, so one noisy reading cannot lift its bound while a core placement
 * that shows in two of the three still does (the review of, P3-1;
 *). Its bound is max(`budget`, `baseMs` x
 * pairedScale(that median)). So a run
 * is never judged more tightly than by the site's start-of-test budget, and
 * a run whose backend sat on one of the Spark's efficiency cores is judged by
 * that core's speed. The read passes when its best run is under its bound.
 *
 * Load only ever adds time to a run, so a regression in the read's
 * steady-state work (its plan, rows and functions) is slow on every run and
 * still fails. A cost paid only by the first call of a transaction or session
 * is not: runs after the first find it warm (compiled functions, cached
 * plans, per-transaction memos), so the best run hides it. A site whose first
 * run is that cold call bounds the first run by the budget too, as the
 * steward desk's profiled reads do.
 */
export async function pairedFastest(client, firstMs, measureAgain, { baseMs, budget, extraRuns = 2, calibrate = async () => {
  const started = performance.now();
  await client.query(CALIBRATION_SQL);
  return performance.now() - started;
} } = {}) {
  const median = (readings) => readings.sort((a, b) => a - b)[1];
  const runs = [{ ms: firstMs, calibration: median([await calibrate(), await calibrate(), await calibrate()]) }];
  for (let run = 0; run < extraRuns; run += 1) {
    const before = await calibrate();
    const { ms } = await measureAgain();
    runs.push({ ms, calibration: median([before, await calibrate(), await calibrate()]) });
  }
  for (const run of runs) {
    run.bound = Math.max(budget, baseMs * pairedScale(run.calibration));
    // A run that returned no time (an error) never passes.
    run.ratio = Number.isFinite(run.ms) ? run.ms / run.bound : Number.POSITIVE_INFINITY;
  }
  const best = runs.reduce((winner, run) => (run.ratio < winner.ratio ? run : winner));
  return { runs, best, passed: best.ratio < 1 };
}

/** One line of a read's paired runs, for the CI job log. */
export function pairedLine(label, runs) {
  const each = runs.map((run) => `${Number.isFinite(run.ms) ? Math.round(run.ms) : "error"} ms (calibration ${Math.round(run.calibration)} ms, bound ${Math.round(run.bound)} ms)`).join(", ");
  return `DB SAMPLES ${label}: ${each}\n`;
}


/**
 * The one budget line a proof prints for its `label` site: the calibration and
 * scale, the written budget, the runner's floor when it lifts the budget, and
 * the bound the site actually enforces (the review of, P3-1: in CI the
 * runner floor made "scale 1.00" print beside three times the written budget,
 * and the waves' 7,000 ms cap was not shown).
 */
export function budgetLine(label, baseMs, calibration, { budget, floor = baseMs, enforced = budget, concurrent, peers, concurrentSkipped } = {}) {
  const scale = scaleOf(calibration, { concurrent });
  const concurrentText = concurrent !== undefined
    ? `, concurrent calibration ${Math.round(concurrent)} ms on ${peers} connections (reference ${CONCURRENT_CALIBRATION_REFERENCE_MS} ms)`
    : concurrentSkipped ? `, concurrent calibration skipped (${concurrentSkipped})` : "";
  const floorText = floor > baseMs ? `, runner floor ${Math.round(floor)} ms` : "";
  const budgetText = Math.round(enforced) === Math.round(budget) ? "" : `, scaled budget ${Math.round(budget)} ms`;
  return `DB LOAD BUDGET ${label}: calibration ${Math.round(calibration)} ms (reference ${CALIBRATION_REFERENCE_MS} ms)${concurrentText}, scale ${scale.toFixed(2)}, written ${baseMs} ms${floorText}${budgetText}, enforced ${Math.round(enforced)} ms\n`;
}

/** One line of a site's measured times with the bounds they were judged by, for the CI job log. */
export function samplesLine(label, samples, bounds) {
  const times = samples.map((ms) => `${Math.round(ms)}`).join(", ");
  const judged = Object.entries(bounds).map(([name, bound]) => `${name} under ${Math.round(bound)} ms`).join(", ");
  return `DB SAMPLES ${label}: ${times} ms; ${judged}\n`;
}

const stdout = (line) => process.stdout.write(line);

/**
 * Calibrates on `client` and returns the scaled budget for `baseMs`, with the
 * calibration time, and prints one budget line for `label`. The line goes to
 * stdout directly: the required DB proof runner uses vitest's JSON reporter,
 * which drops console output, but it relays the process's own stdout to the
 * CI job log.
 */
//
// `cap`, when given, is a fixed ceiling the site enforces over the budget (the
// waves' 7,000 ms under the 8 s statement timeout); `enforced` is the bound to
// judge by, and the line prints it. `concurrent`, when given as
// `{ createClient, peers }`, also times the calibration on that many
// connections at once, for a site that runs that many;
// `concurrentSkipped`, a reason a site gives instead, is printed on the line
export async function loadScaledBudget(client, baseMs, { label = "unlabelled site", write = stdout, cap, concurrent: parallel, concurrentSkipped, ...options } = {}) {
  const calibration = await calibrationMs(client);
  const concurrent = parallel === undefined ? undefined : await concurrentCalibrationMs(parallel.createClient, parallel.peers);
  const budget = scaledBudget(baseMs, calibration, { ...options, concurrent });
  const enforced = cap === undefined ? budget : Math.min(budget, cap);
  write(budgetLine(label, baseMs, calibration, { budget, floor: runnerTimeout(baseMs, options.env ?? process.env), enforced, concurrent, peers: parallel?.peers, concurrentSkipped }));
  return { budget, enforced, calibrationMs: calibration, concurrentCalibrationMs: concurrent };
}

/** Prints a site's measured times and bounds to the CI job log. */
export function reportSamples(label, samples, bounds, write = stdout) {
  write(samplesLine(label, samples, bounds));
}

/** Prints a read's paired runs to the CI job log. */
export function reportPaired(label, runs, write = stdout) {
  write(pairedLine(label, runs));
}
