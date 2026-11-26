// Semgrep fixture: unionground-secret-written-to-logs must report this file.
export function runRule() {
  console.info("starting fixture session with token present", process.env.FIXTURE_SERVICE_TOKEN);
}
