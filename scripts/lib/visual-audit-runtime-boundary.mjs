export function createTargetRuntimeBoundary() {
  let generation = 0;
  let currentTargetGeneration = null;
  const requestGenerations = new WeakMap();

  return {
    restartTarget() {
      generation += 1;
      currentTargetGeneration = generation;
      return generation;
    },

    trackRequest(request) {
      requestGenerations.set(request, generation);
    },

    belongsToCurrentTarget(request) {
      return currentTargetGeneration !== null
        && requestGenerations.get(request) === currentTargetGeneration;
    },
  };
}

function describeRuntimeLocation(value, baseUrl) {
  const url = new URL(value);
  const scope = url.origin === new URL(baseUrl).origin ? "app" : "upstream";
  return `${scope}: ${url.pathname}`;
}

export function describeRuntimeHttpFailure({ status, responseUrl, baseUrl }) {
  return `HTTP ${status} ${describeRuntimeLocation(responseUrl, baseUrl)}`;
}

export function describeRuntimeNetworkFailure({ errorText, requestUrl, baseUrl }) {
  return `Network ${errorText} ${describeRuntimeLocation(requestUrl, baseUrl)}`;
}

export function isGenericResourceConsoleError(message) {
  return String(message).startsWith("Failed to load resource:");
}
