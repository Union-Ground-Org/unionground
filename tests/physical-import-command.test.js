// @vitest-environment node
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { physicalImportCommand } from "../scripts/lib/physical-db-baseline.mjs";

// End-to-end review, record #79, finding U79-03: the restore's archive guards
// were `! grep ...;` under `sh -e`, which never stops the script, so an
// archive with a symbolic link went on to empty the lab and extract. This
// runs the real command, with its three container paths mapped to a scratch
// directory, the way the restore's helper runs it.
describe("the snapshot restore's import command", () => {
  const roots = [];
  afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

  function lab(build) {
    const root = mkdtempSync(join(tmpdir(), "physical-import-"));
    roots.push(root);
    const source = join(root, "source");
    const data = join(root, "data");
    const scratch = join(root, "scratch");
    for (const directory of [source, data, scratch]) mkdirSync(directory);
    writeFileSync(join(data, "old-state"), "kept until a good archive replaces it\n");
    const archive = join(root, "data.tgz");
    build({ source, archive, root });
    const result = spawnSync("/bin/sh", ["-ec", physicalImportCommand({ archive, data, scratch })], { encoding: "utf8" });
    return { result, data };
  }

  it("replaces the lab's data with a plain archive", () => {
    const { result, data } = lab(({ source, archive }) => {
      mkdirSync(join(source, "base"));
      writeFileSync(join(source, "base", "PG_VERSION"), "17\n");
      execFileSync("tar", ["-czf", archive, "-C", source, "."]);
    });
    expect(result.status).toBe(0);
    expect(existsSync(join(data, "old-state"))).toBe(false);
    expect(readFileSync(join(data, "base", "PG_VERSION"), "utf8")).toBe("17\n");
  });

  it("refuses an archive with a symbolic link before it deletes or extracts anything", () => {
    const { result, data } = lab(({ source, archive }) => {
      writeFileSync(join(source, "file"), "x\n");
      symlinkSync("/etc/hostname", join(source, "link"));
      execFileSync("tar", ["-czf", archive, "-C", source, "."]);
    });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("not a file or a directory");
    expect(existsSync(join(data, "old-state"))).toBe(true);
    expect(existsSync(join(data, "file"))).toBe(false);
  });

  it("refuses an archive with an absolute entry", () => {
    const { result, data } = lab(({ source, archive }) => {
      writeFileSync(join(source, "file"), "x\n");
      execFileSync("tar", ["-czPf", archive, join(source, "file")]);
    });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("absolute or traversing");
    expect(existsSync(join(data, "old-state"))).toBe(true);
  });

  it("is the command the restore runs", () => {
    const source = readFileSync(new URL("../scripts/physical-db-baseline.mjs", import.meta.url), "utf8");
    expect(source).toContain("physicalImportCommand(),");
    expect(source).not.toMatch(/! grep/u);
    expect(physicalImportCommand()).not.toMatch(/! grep/u);
  });
});
