// Semgrep fixture: unionground-math-random-for-credential must report this file.
export function runRule() {
  const sessionToken = Math.random().toString(36).slice(2);
  return sessionToken;
}
