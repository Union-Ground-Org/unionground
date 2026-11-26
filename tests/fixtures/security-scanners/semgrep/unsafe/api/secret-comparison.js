// Semgrep fixture: unionground-non-constant-time-secret-comparison must report this file.
export function runRule(providedSignature, expectedSignature) {
  return providedSignature === expectedSignature;
}
