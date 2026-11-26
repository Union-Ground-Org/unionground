// @vitest-environment node

import { mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { resolveProofOutputDir, writeProofFile } from "../scripts/lib/proof-output-dir.mjs";

const root = mkdtempSync(path.join(tmpdir(), "proof-output-dir-test-"));
afterAll(() => rmSync(root, { force: true, recursive: true }));

const scriptSource = (name) =>
  readFileSync(new URL(`../scripts/${name}`, import.meta.url), "utf8");

describe("proof output directories", () => {
  it("gives each unconfigured run its own private directory under the temp root", async () => {
    const first = await resolveProofOutputDir("", "proof-output-dir-test");
    const second = await resolveProofOutputDir(undefined, "proof-output-dir-test");
    try {
      expect(first).not.toBe(second);
      for (const dir of [first, second]) {
        expect(path.dirname(dir)).toBe(tmpdir());
        expect(path.basename(dir)).toMatch(/^proof-output-dir-test-.{6}$/);
        expect(statSync(dir).mode & 0o777).toBe(0o700);
      }
    } finally {
      rmSync(first, { force: true, recursive: true });
      rmSync(second, { force: true, recursive: true });
    }
  });

  it("creates and returns a configured directory as an absolute path", async () => {
    const configured = path.join(root, "operator", "chosen");
    expect(await resolveProofOutputDir(configured, "unused")).toBe(configured);
    expect(statSync(configured).isDirectory()).toBe(true);
  });

  it("creates a proof file exclusively and refuses an existing one", async () => {
    const file = path.join(root, "proof.json");
    await writeProofFile(file, "first\n");
    await expect(writeProofFile(file, "second\n")).rejects.toMatchObject({ code: "EEXIST" });
    expect(readFileSync(file, "utf8")).toBe("first\n");
    expect(statSync(file).mode & 0o777).toBe(0o600);
  });

  it("does not write through a pre-placed link", async () => {
    const target = path.join(root, "victim.txt");
    writeFileSync(target, "keep\n");
    const link = path.join(root, "link.json");
    symlinkSync(target, link);
    await expect(writeProofFile(link, "overwrite\n")).rejects.toMatchObject({ code: "EEXIST" });
    expect(readFileSync(target, "utf8")).toBe("keep\n");
  });
});

describe("proof scripts use private output directories", () => {
  const cases = [
    ["verify-mi1-pay-browser.mjs", "MI1_PAY_BROWSER_OUTPUT_DIR", "mi1-pay-browser-proof", "proof.json"],
    ["verify-mi1-qa-browser.mjs", "MI1_QA_BROWSER_OUTPUT_DIR", "mi1-qa-browser-proof", "proof.json"],
    ["verify-workload-browser.mjs", "WORKLOAD_BROWSER_OUTPUT_DIR", "ub-wkl-03-browser", "results.json"],
  ];

  it.each(cases)("%s keeps %s as an override and no fixed shared path", (name, env, prefix, file) => {
    const source = scriptSource(name);
    expect(source).toContain(`resolveProofOutputDir(process.env.${env}, "${prefix}")`);
    expect(source).toContain(`writeProofFile(path.join(outputDir, "${file}")`);
    expect(source).not.toMatch(/["'`]\/tmp\//);
    expect(source).not.toMatch(/\brm\(/);
  });

});
