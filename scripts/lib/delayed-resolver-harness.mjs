import { setTimeout as realSetTimeout } from "node:timers";

// Opt-in diagnostics for mockResolvedValue/Once, not a default test policy.
// Fake-clock tests own their scheduling and must keep Vitest's microtask-only
// resolution. A delay started on the real clock must also survive a subsequent
// vi.useFakeTimers(), so schedule it through Node's real timer reference.
export function configuredResolverDelay(raw = "60") {
  if (typeof raw !== "string" || raw.trim() === "") {
    throw new RangeError("Resolver delay cannot be blank");
  }
  const delayMs = Number(raw);
  if (!Number.isFinite(delayMs) || delayMs < 0 || delayMs > 60_000) {
    throw new RangeError("Resolver delay must be between 0 and 60000 milliseconds");
  }
  return delayMs;
}

export function installDelayedResolvers(vi, delayMs = 60) {
  if (!Number.isFinite(delayMs) || delayMs < 0 || delayMs > 60_000) {
    throw new RangeError("Resolver delay must be between 0 and 60000 milliseconds");
  }
  const originalFn = vi.fn;
  const later = value => {
    if (vi.isFakeTimers()) return Promise.resolve(value);
    // Observe adoption immediately, including rejection, before forwarding the
    // settled outcome after the diagnostic delay.
    const outcome = Promise.allSettled([value]);
    return new Promise((resolve, reject) => {
      realSetTimeout(() => {
        outcome.then(([result]) => {
          if (result.status === "fulfilled") resolve(result.value);
          else reject(result.reason);
        });
      }, delayMs);
    });
  };

  vi.fn = (...args) => {
    const mock = originalFn.apply(vi, args);
    mock.mockResolvedValueOnce = value => mock.mockImplementationOnce(() => later(value));
    mock.mockResolvedValue = value => mock.mockImplementation(() => later(value));
    return mock;
  };

  return () => { vi.fn = originalFn; };
}
