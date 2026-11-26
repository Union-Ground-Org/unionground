// Semgrep fixture: unionground-tls-verification-disabled must report this file.
import https from "node:https";

export function runRule() {
  return https.request({ hostname: "fixture.invalid", rejectUnauthorized: false });
}
