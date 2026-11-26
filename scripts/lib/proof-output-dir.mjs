// Output directories for proof and verification scripts.
//
// A fixed path under the shared temporary directory can be pre-created or
// replaced by another local user, and a recursive remove of it is worse. With
// no configured directory each run gets a fresh private one from mkdtemp
// (mode 0700); a configured directory is the operator's own choice. Proof
// files are created exclusively so a run never writes through an existing file
// or link.
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

export async function resolveProofOutputDir(configuredDir, prefix) {
  if (configuredDir) {
    const dir = path.resolve(configuredDir);
    await mkdir(dir, { recursive: true });
    return dir;
  }
  return mkdtemp(path.join(tmpdir(), `${prefix}-`));
}

// Fails with EEXIST rather than overwriting an existing file.
export async function writeProofFile(file, contents) {
  await writeFile(file, contents, { flag: "wx", mode: 0o600 });
}
