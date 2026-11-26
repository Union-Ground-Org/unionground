// Semgrep fixture: unionground-child-process-shell-interpolation must report this file.
import childProcess from "node:child_process";

export function runRule(filename) {
  return childProcess.execSync(`cat ${filename}`, { encoding: "utf8" });
}
