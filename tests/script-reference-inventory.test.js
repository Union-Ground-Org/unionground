import { execFileSync } from "node:child_process";
import { readFileSync, statSync } from "node:fs";
import { describe, expect, it } from "vitest";

// Nothing over 2 MB is a plausible caller.
const MAX_SCANNED_BYTES = 2_000_000;
const SCRIPT = /^scripts\/.+\.(mjs|js)$/;
const EXPORTS_AN_API = /^export\s/m;

function trackedFiles() {
  return execFileSync("git", ["ls-files", "-z"], { encoding: "utf8", maxBuffer: 32 * 1024 * 1024 })
    .split("\0")
    .filter(Boolean);
}

function readCorpus(paths) {
  const corpus = new Map();
  for (const path of paths) {
    try {
      if (statSync(path).size > MAX_SCANNED_BYTES) continue;
      corpus.set(path, readFileSync(path, "utf8"));
    } catch {
      // A path git tracks but the worktree cannot read (submodule, LFS stub)
      // is simply not a caller.
    }
  }
  return corpus;
}

describe("scripts/ reference inventory", () => {
  const paths = trackedFiles();
  const corpus = readCorpus(paths);
  const scripts = [...corpus.keys()].filter((path) => SCRIPT.test(path) && EXPORTS_AN_API.test(corpus.get(path)));

  it("scans the real scripts directory", () => {
    // Guards the assertion below: a scan that silently matched nothing would
    // pass forever while dead modules accumulated.
    expect(scripts.length).toBeGreaterThan(50);
    expect(scripts).toContain("scripts/lib/build-provenance.mjs");
  });

  it("keeps every exporting script reachable from a caller, test, or workflow", () => {
    const orphans = scripts.filter((path) => {
      const stem = path.split("/").pop().replace(/\.(mjs|js)$/, "");
      for (const [other, text] of corpus) {
        if (other === path) continue;
        if (text.includes(stem)) return false;
      }
      return true;
    });
    // A module nothing imports is dead code: editing it looks like changing
    // behaviour while changing nothing. Delete it, or wire it into the caller
    // that should own it.
    expect(orphans).toEqual([]);
  });
});
