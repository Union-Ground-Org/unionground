// Reads that fail the three ways a real one does, and the check that the
// screen said so instead of showing an empty state or a success
// (src/lib/readResult.js; SYS-UG-SHARED-SWALLOWED-ERROR-GUARD-20261113).
export const READ_FAILURES = Object.freeze(["network", "server", "timeout"]);

export function readFailure(kind) {
  if (kind === "network") return new TypeError("Failed to fetch");
  if (kind === "server") return Object.assign(new Error("Internal Server Error"), { status: 500, code: "PGRST000" });
  if (kind === "timeout") return Object.assign(new Error("The read took too long"), { name: "TimeoutError", code: "LOAD_DEADLINE" });
  throw new Error(`Unknown read failure: ${kind}`);
}

// A read that rejects the way kind describes, counting its calls so a test can
// check that Try again reads once more.
export function failingRead(kind) {
  const read = async () => {
    read.calls += 1;
    throw readFailure(kind);
  };
  read.calls = 0;
  return read;
}

// text is what the person can read (a container's textContent). Fails when the
// failure looks like an empty list or a success, or when no error is shown.
export function expectFailureShown(text, { failure, empty = [], success = [] }) {
  const shown = String(text ?? "");
  for (const phrase of [...empty, ...success]) {
    if (shown.includes(phrase)) throw new Error(`A failed read showed "${phrase}" instead of its error`);
  }
  if (!shown.includes(failure)) throw new Error(`A failed read did not show "${failure}"`);
}
