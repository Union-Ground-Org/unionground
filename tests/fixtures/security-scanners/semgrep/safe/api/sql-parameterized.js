// Semgrep fixture: the safe counterpart must produce no finding.
export function runRule(client, userId) {
  return client.query("SELECT * FROM fixture_users WHERE id = $1", [userId]);
}
