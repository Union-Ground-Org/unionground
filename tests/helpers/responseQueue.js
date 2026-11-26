// A deterministic server boundary: start requests in any order, then release
// or reject each by label. No timers or framework mocks are needed.
export function createResponseQueue() {
  const pending = new Map();
  const used = new Set();
  function take(label) {
    const response = pending.get(label);
    if (!response) throw new Error(`No pending response: ${label}`);
    pending.delete(label);
    return response;
  }
  return {
    request(label) {
      if (used.has(label)) throw new Error(`Response label already used: ${label}`);
      used.add(label);
      return new Promise((resolve, reject) => { pending.set(label, { resolve, reject }); });
    },
    resolve(label, value) { take(label).resolve(value); },
    reject(label, error) { take(label).reject(error); },
    pending() { return [...pending.keys()]; },
  };
}
