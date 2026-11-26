// Semgrep fixture: the safe counterpart must produce no finding.
import { randomUUID } from "node:crypto";

export function runRule() {
  const sessionToken = randomUUID();
  return sessionToken;
}
