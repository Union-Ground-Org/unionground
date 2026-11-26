// @vitest-environment node
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// A real `vite build` refuses, at configuration time, a production build that
// has no product name of its own or borrows the Union Ground name. Both stop
// before anything is bundled, so these runs are short.
function viteBuild(extraEnv) {
  const output = mkdtempSync(join(tmpdir(), "unionground-brand-build-"));
  const env = { ...process.env, ...extraEnv };
  // Outside the suite's own official-build setting (vite.config.mjs).
  delete env.VITEST;
  delete env.VITEST_POOL_ID;
  delete env.VITEST_WORKER_ID;
  try {
    return spawnSync(
      process.execPath,
      [join(process.cwd(), "node_modules", "vite", "bin", "vite.js"), "build", "--outDir", output],
      { cwd: process.cwd(), encoding: "utf8", env, timeout: 60_000 },
    );
  } finally {
    rmSync(output, { recursive: true, force: true });
  }
}

describe("production web build branding", () => {
  it("fails with an operator message when VITE_BRAND_NAME is unset", () => {
    const run = viteBuild({ VITE_BRAND_NAME: "", VITE_OFFICIAL_BRANDING: "" });
    expect(run.status).not.toBe(0);
    expect(`${run.stdout}${run.stderr}`).toMatch(/VITE_BRAND_NAME is not set\. A production build needs a product name\./);
  });

  it("fails when the build borrows the Union Ground name without official branding", () => {
    const run = viteBuild({ VITE_BRAND_NAME: "union  GROUND", VITE_OFFICIAL_BRANDING: "" });
    expect(run.status).not.toBe(0);
    expect(`${run.stdout}${run.stderr}`).toMatch(/reserved for Union Ground LLC's official builds/);
  });
});
