import { useCallback, useEffect, useRef, useState } from "react";

// The lock is acquired synchronously, before React can commit a busy state.
// Each mounted surface owns its ref, and each write function owns a key.
function acquireBusyWrite(ref, key, event) {
  const locks = ref.current;
  if (locks.has(key)) {
    event?.preventDefault?.();
    return null;
  }
  locks.add(key);
  let released = false;
  const release = () => {
    if (!released) { released = true; locks.delete(key); }
  };
  return release;
}

export async function runBusyWrite(ref, key, operation, event) {
  const release = acquireBusyWrite(ref, key, event);
  if (!release) return undefined;
  // A synchronous refusal can finish its whole busy=true/false cycle before
  // React commits. Let the write's own finally release inline, so an immediate
  // corrected retry succeeds. The backstop also handles a thrown operation.
  try { return await operation(release); }
  finally { release(); }
}

// Validation and a cancelled confirmation start no write. Keep those paths
// synchronous so correcting a field can submit immediately, while rejecting
// a second invocation before even preparing a write that is already pending.
export function prepareBusyWrite(ref, key, prepare, event) {
  if (ref.current.has(key)) {
    event?.preventDefault?.();
    return undefined;
  }
  const operation = prepare();
  return typeof operation === "function" ? runBusyWrite(ref, key, operation, event) : operation;
}

// Record 8435 rule: a press is refused only while its control is visibly
// pending. When busy can be cleared by anything other than the write settling
// (a scope, owner, chapter or key change, an unmount), the lock must end with
// it. Each activation of a scope, a return to an earlier scope included, gets
// a fresh generation: key the lock and the busy state by it, and check
// isCurrent(started) before a late answer touches state or calls out. An old
// operation still releases its own lock. guard(callback) wraps a callback the
// owner of the scope hands to a child: it runs only while the activation it
// was made in is current, so a child that merely unmounts in the same scope
// still reaches it, and one from an earlier scope does not.
export function useBusyScope(scope) {
  const [activation, setActivation] = useState(() => ({ scope, generation: 1 }));
  let current = activation;
  if (!Object.is(activation.scope, scope)) {
    current = { scope, generation: activation.generation + 1 };
    setActivation(current);
  }
  const generationRef = useRef(current.generation);
  generationRef.current = current.generation;
  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => { mountedRef.current = false; };
  }, []);
  const isCurrent = useCallback((generation) => mountedRef.current && generationRef.current === generation, []);
  const guard = useCallback((callback) => {
    const generation = generationRef.current;
    return (...args) => (isCurrent(generation) ? callback(...args) : undefined);
  }, [isCurrent]);
  return { generation: current.generation, isCurrent, guard };
}
