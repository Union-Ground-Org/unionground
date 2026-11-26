// Semgrep fixture: the safe counterpart must produce no finding.
import { createHash } from "node:crypto";

export function runRule(source) {
  return JSON.parse(source);
}

export function fingerprint(value) {
  return createHash("sha256").update(value).digest("hex");
}
