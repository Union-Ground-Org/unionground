// Semgrep fixture: the safe counterpart must produce no finding.
// The reviewed rule flags a wildcard origin or a credentialed response header
// by itself; a reflected origin with no credentialed header stays clean.
export function runRule(origin) {
  return {
    "Access-Control-Allow-Origin": origin,
  };
}
