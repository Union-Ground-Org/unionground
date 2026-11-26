// REQ-UG-VISIBLE-ANALYTICS-OPT-OUT-20261016: a request whose abort
// signal carries a guard is checked again at the moment it reaches the
// network, after any wait on authentication. Another tab's opt-out is visible
// in shared storage before this tab receives its storage event, so the abort
// signal alone can arrive too late; the guard reads the shared choice itself.
const guards = new WeakMap();

export function guardSignal(signal, allowed) {
  guards.set(signal, allowed);
  return signal;
}

export function guardedFetch(fetchImpl) {
  return (input, init) => {
    const allowed = init?.signal ? guards.get(init.signal) : undefined
    if (allowed && !allowed()) return Promise.reject(new DOMException("The operation was aborted.", "AbortError"));
    return fetchImpl(input, init);
  };
}
