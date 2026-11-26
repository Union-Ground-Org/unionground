// One independent request lane. A newer begin, scope invalidation or disposal
// retires every older ticket, for both successful responses and failures.
export class StaleResponseError extends Error {
  constructor() {
    super("The request was superseded.");
    this.name = "StaleResponseError";
  }
}

export function isStaleResponse(error) {
  return error instanceof StaleResponseError;
}

export function createRequestGeneration() {
  let generation = Symbol();
  let active = true;
  const invalidate = () => { generation = Symbol(); };
  const capture = () => {
    const mine = generation;
    const isCurrent = () => active && mine === generation;
    return Object.freeze({
      isCurrent,
      assertCurrent() { if (!isCurrent()) throw new StaleResponseError(); },
    });
  };
  return Object.freeze({
    begin() { invalidate(); return capture(); },
    capture,
    invalidate,
    activate() { invalidate(); active = true; },
    dispose() { invalidate(); active = false; },
  });
}
