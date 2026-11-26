// Semgrep fixture: the safe counterpart must produce no finding.
export function runRule() {
  console.info("starting fixture session with token present", "FIXTURE_SERVICE_TOKEN" in process.env);
}
