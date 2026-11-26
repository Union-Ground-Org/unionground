import { useLayoutEffect, useMemo } from "react";
import { createRequestGeneration } from "./requestGeneration.js";

// Object.is scope identity, including A -> B -> A, creates a fresh lane.
// A discarded render never invalidates the currently committed lane.
export function useRequestGeneration(scope) {
  // Scope owns the memo's lifetime; the factory itself needs no scope data.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const requests = useMemo(() => createRequestGeneration(), [scope]);
  useLayoutEffect(() => {
    requests.activate();
    return requests.dispose;
  }, [requests]);
  return requests;
}
