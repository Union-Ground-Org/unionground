// Semgrep fixture: unionground-sql-string-concatenation must report this file.
export function runRule(client, userId) {
  return client.query(`SELECT * FROM fixture_users WHERE id = ${userId}`);
}
