// Semgrep fixture: unionground-permissive-cors-with-credentials must report this file.
export function runRule() {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Credentials": "true",
  };
}
