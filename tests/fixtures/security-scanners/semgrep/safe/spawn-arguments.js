// Semgrep fixture: the safe counterpart must produce no finding.
import { execFileSync } from "node:child_process";

export function runRule(filename) {
  return execFileSync("cat", [filename], { encoding: "utf8" });
}
