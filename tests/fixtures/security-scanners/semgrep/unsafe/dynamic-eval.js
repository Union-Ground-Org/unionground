// Semgrep fixture: unionground-eval-on-dynamic-input must report this file.
export function runRule(source) {
  return eval(source);
}
