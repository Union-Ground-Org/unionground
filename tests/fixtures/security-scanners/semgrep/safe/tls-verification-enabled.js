// Semgrep fixture: the safe counterpart must produce no finding.
import https from "node:https";

export function runRule() {
  return https.request({ hostname: "fixture.invalid", rejectUnauthorized: true });
}
