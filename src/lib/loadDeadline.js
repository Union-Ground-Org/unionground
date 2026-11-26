export const SHELL_LOAD_DEADLINE_MS = 10_000;

export function createLoadTimeoutError(message = "Request timed out") {
  if (typeof DOMException === "function") return new DOMException(message, "TimeoutError");
  const error = new Error(message);
  error.name = "TimeoutError";
  return error;
}

export function withLoadDeadline(work, timeoutMs = SHELL_LOAD_DEADLINE_MS) {
  const promise = typeof work === "function" ? work() : work;
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) return promise;
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = globalThis.setTimeout(() => reject(createLoadTimeoutError()), timeoutMs);
    }),
  ]).finally(() => globalThis.clearTimeout(timer));
}
