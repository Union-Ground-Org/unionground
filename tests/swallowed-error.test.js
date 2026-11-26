import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";

import { withReportedFallback } from "../api/_lib/reportedFallback.js";
import { READ_LOADING, READ_STATES, readResult } from "../src/lib/readResult.js";
import {
  checkSwallowedErrors,
  countSwallowedErrors,
  inScope,
  swallowedErrorFindings,
} from "../scripts/lib/swallowed-error-scan.mjs";
import { READ_FAILURES, expectFailureShown, failingRead, readFailure } from "./helpers/failingRead.js";

const observability = vi.hoisted(() => ({ captureServerFailure: vi.fn(() => true) }));
vi.mock("../api/_lib/observability.js", () => observability);

describe("readResult keeps loaded, empty and failed apart", () => {
  it("answers each state and never rejects", async () => {
    expect(READ_LOADING).toEqual({ state: "loading", value: null, error: null });
    expect(await readResult(async () => [1])).toEqual({ state: READ_STATES.loaded, value: [1], error: null });
    expect(await readResult(() => [])).toEqual({ state: READ_STATES.empty, value: [], error: null });
    expect(await readResult(() => null)).toMatchObject({ state: "empty" });
    expect(await readResult(() => ({ rows: [] }), { isEmpty: (value) => value.rows.length === 0 })).toMatchObject({ state: "empty" });
    for (const kind of READ_FAILURES) {
      const result = await readResult(failingRead(kind));
      expect(result).toEqual({ state: READ_STATES.failed, value: null, error: readFailure(kind) });
    }
    expect(await readResult(() => { throw new Error("sync"); })).toMatchObject({ state: "failed" });
  });
});

describe("withReportedFallback reports before it falls back", () => {
  it("returns the answer, or reports and returns the fallback", async () => {
    expect(await withReportedFallback(async () => "answer", "fallback")).toBe("answer");
    expect(observability.captureServerFailure).not.toHaveBeenCalled();
    expect(await withReportedFallback(async () => { throw readFailure("server"); }, [])).toEqual([]);
    expect(observability.captureServerFailure).toHaveBeenCalledWith(500);
    const report = vi.fn();
    expect(await withReportedFallback(() => { throw readFailure("timeout"); }, (error) => error.code, { report })).toBe("LOAD_DEADLINE");
    expect(report).toHaveBeenCalledTimes(1);
  });

  it("keeps the fallback when the report itself fails", async () => {
    const report = vi.fn(() => { throw new Error("monitoring down"); });
    expect(await withReportedFallback(() => { throw readFailure("network"); }, "fallback", { report })).toBe("fallback");
  });
});

describe("failing read test kit", () => {
  it("fails three ways, counts calls, and refuses an unknown kind", async () => {
    const read = failingRead("network");
    await expect(read()).rejects.toBeInstanceOf(TypeError);
    await expect(read()).rejects.toThrow("Failed to fetch");
    expect(read.calls).toBe(2);
    expect(readFailure("server")).toMatchObject({ status: 500 });
    expect(readFailure("timeout")).toMatchObject({ name: "TimeoutError" });
    expect(() => readFailure("disk")).toThrow("Unknown read failure");
  });

  it("fails a screen that shows an empty state or a success instead of the error", () => {
    expect(() => expectFailureShown("Could not load. Try again", { failure: "Could not load." })).not.toThrow();
    expect(() => expectFailureShown("Could not load. No items yet.", { failure: "Could not load.", empty: ["No items yet."] })).toThrow("instead of its error");
    expect(() => expectFailureShown("Saved.", { failure: "Could not load.", success: ["Saved."] })).toThrow("instead of its error");
    expect(() => expectFailureShown("", { failure: "Could not load." })).toThrow("did not show");
    expect(() => expectFailureShown(null, { failure: "x" })).toThrow("did not show");
  });
});

describe("swallowed error scan", () => {
  it("counts catches that only swallow", () => {
    expect(countSwallowedErrors([
      "try { a(); } catch {}",
      "try { a(); } catch (error) { }",
      "try { a(); } catch { return []; }",
      "try { a(); } catch { return; }",
      "try { a(); } catch { setRows([]); }",
      "load().catch(() => [])",
      "load().catch(() => ({}))",
      "load().catch(() => {})",
      "load().catch((error) => null)",
      "load().catch(e => false)",
    ].join("\n"))).toBe(10);
    expect(countSwallowedErrors([
      "try { a(); } catch (error) { report(error); return []; }",
      "try { a(); } catch { setError(true); }",
      "load().catch(() => ({ data: null, error: true }))",
      "try { a(); } catch { /* swallow-ok: storage may be blocked */ }",
      "load().catch(() => null); // swallow-ok: best-effort prefetch",
    ].join("\n"))).toBe(0);
  });

  it("scans product code only", () => {
    expect(inScope("src/views/StewardView.jsx")).toBe(true);
    expect(inScope("api/_lib/reportedFallback.js")).toBe(true);
    expect(inScope("apps/mobile/src/state/AppProvider.tsx")).toBe(true);
    expect(inScope("src/views/StewardView.test.jsx")).toBe(false);
    expect(inScope("scripts/lib/swallowed-error-scan.mjs")).toBe(false);
  });

  it("fails a new or grown file and a known count that should shrink", () => {
    expect(swallowedErrorFindings({ "src/a.js": 2 }, { "src/a.js": 2 })).toEqual([]);
    expect(swallowedErrorFindings({ "src/a.js": 3, "src/b.js": 1 }, { "src/a.js": 2, "src/c.js": 1 })).toEqual([
      expect.stringContaining("src/a.js: 3 catch(es) that swallow the error (known 2)"),
      expect.stringContaining("src/b.js: 1 catch(es) that swallow the error (known 0)"),
      expect.stringContaining("src/c.js now has 0 swallowing catch(es); lower its known count from 1 to 0"),
    ]);
  });

  it("holds the repository to its known list exactly", () => {
    const failures = [];
    const counts = checkSwallowedErrors(process.cwd(), (message) => failures.push(message));
    expect(failures).toEqual([]);
    expect(counts["src/features/elections/BallotNominations.jsx"]).toBeUndefined();
  });

  it("fails closed outside a git checkout", () => {
    const root = mkdtempSync(join(tmpdir(), "swallowed-error-scan-"));
    try {
      const failures = [];
      expect(checkSwallowedErrors(root, (message) => failures.push(message))).toEqual({});
      expect(failures).toEqual([expect.stringContaining("cannot list tracked files")]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
