// One rule for every server-side shared secret an operator sets: the cron
// bearer, the dispatch bearers and the HMAC keys behind the rate limits. A copy
// of this project that kept a value from .env.example, or a value that only
// looks like one, has no secret at all, so every check refuses it the same way
// it refuses a missing or short value.
//
// Generate a real value with `openssl rand -hex 32` (64 characters).

export const SECRET_MIN_LENGTH = 32;

// Values that are instructions, not secrets. Matched case-insensitively against
// the start of the trimmed value. Every placeholder .env.example ever shipped
// starts with "replace-with".
const PLACEHOLDER_PREFIXES = Object.freeze(["replace-with", "changeme", "change-me", "example"]);

export function isPlaceholderSecret(value) {
  const text = String(value ?? "").trim().toLowerCase();
  return PLACEHOLDER_PREFIXES.some((prefix) => text.startsWith(prefix));
}

// "" when the value is usable, otherwise why it is not: "missing", "too_short"
// or "placeholder". The reason is for operator messages and logs; it never
// carries the value.
export function secretProblem(value, minLength = SECRET_MIN_LENGTH) {
  const text = String(value ?? "");
  if (!text.trim()) return "missing";
  if (isPlaceholderSecret(text)) return "placeholder";
  if (text.length < minLength) return "too_short";
  return "";
}

export function usableSecret(value, minLength = SECRET_MIN_LENGTH) {
  return secretProblem(value, minLength) === "";
}

// The operator-facing sentence for a refused secret. Names the variable and
// the reason, never the value.
export function secretProblemMessage(name, problem, minLength = SECRET_MIN_LENGTH) {
  const why = problem === "placeholder"
    ? "is still a placeholder value"
    : problem === "too_short"
      ? `is shorter than ${minLength} characters`
      : "is not set";
  return `${name} ${why}. Set it to a random value, for example the output of \`openssl rand -hex 32\`, and redeploy.`;
}
