// @vitest-environment node
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { gzipSync } from "node:zlib";
import { afterEach, describe, expect, it } from "vitest";
import { readAtlas } from "../scripts/load-union-orgs.mjs";

const directories = [];
afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

const row = (id, olmsFileNumber) => ({ id, olmsFileNumber, name: `Fictional ${id}`, level: "local", enrichmentStatus: "enriched" });

function atlas(rows, manifestOverrides = {}) {
  const directory = mkdtempSync(join(tmpdir(), "atlas-plan-"));
  directories.push(directory);
  mkdirSync(join(directory, "data"));
  const bytes = gzipSync(JSON.stringify({ directory: rows }));
  writeFileSync(join(directory, "data/directory.json.gz"), bytes);
  writeFileSync(join(directory, "data/manifest.json"), JSON.stringify({
    dataFile: "directory.json.gz", sha256: createHash("sha256").update(bytes).digest("hex"),
    counts: { unions: rows.length }, ...manifestOverrides,
  }));
  return directory;
}

const run = (directory, mode = "plan") => spawnSync(process.execPath, [resolve("scripts/load-union-orgs.mjs"), mode, "--atlas", directory], {
  encoding: "utf8", timeout: 10000,
  // These are offline preflight tests; no database credentials or connection.
  env: { ...process.env, SUPABASE_DB_URL: "" },
});

describe("Atlas import preflight", () => {
  it("accepts distinct OLMS identities in a hash-valid plan without database credentials", () => {
    const directory = atlas([row("fixture-a", 910001), row("fixture-b", 910002)]);
    expect(readAtlas(directory).directory).toHaveLength(2);
    const result = run(directory);
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain("PLAN: 2 rows pass every declared constraint. Nothing was written.");
  });

  it.each([910001, "+00910001"])("refuses duplicate database OLMS identity %s even with distinct source ids", duplicate => {
    const directory = atlas([row("fixture-a", 910001), row("fixture-b", duplicate)]);
    const result = run(directory);
    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/duplicate.*olms_file_number.*910001/i);
    expect(result.stderr).toContain("fixture-a");
    expect(result.stderr).toContain("fixture-b");
    expect(result.stdout).not.toContain("pass every declared constraint");
  });

  it("checks the complete load input before connecting or writing the first batch", () => {
    const rows = Array.from({ length: 501 }, (_, index) => row(`fixture-${index}`, 920000 + index));
    rows[500].olmsFileNumber = rows[0].olmsFileNumber;
    const result = run(atlas(rows), "load");
    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/duplicate.*olms_file_number.*920000/i);
    expect(result.stderr).toContain("fixture-0");
    expect(result.stderr).toContain("fixture-500");
    expect(result.stderr).not.toContain("SUPABASE_DB_URL is required");
  });

  it("continues to refuse duplicate source ids", () => {
    expect(() => readAtlas(atlas([row("same-id", 910001), row("same-id", 910002)]))).toThrow(/distinct ids/);
  });

  it("continues to verify the gzip digest before accepting identities", () => {
    expect(() => readAtlas(atlas([row("fixture-a", 910001)], { sha256: "0".repeat(64) }))).toThrow(/does not match its manifest/);
  });

  it("continues to enforce the manifest row count", () => {
    expect(() => readAtlas(atlas([row("fixture-a", 910001)], { counts: { unions: 2 } }))).toThrow(/declares 2 unions.*holds 1/);
  });
});
