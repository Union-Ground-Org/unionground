export function beginSampleHatChoice(sequenceRef) {
  const sequence = sequenceRef.current + 1;
  sequenceRef.current = sequence;
  return {
    sequence,
    stillWanted: () => sequenceRef.current === sequence,
  };
}

export function createSampleHatTransitionQueue() {
  let tail = Promise.resolve();
  return {
    enqueue(work) {
      // verifyOtp mutates one shared browser session and cannot be cancelled
      // after it begins. Keep those side effects in choice order so the next
      // queued choice can observe and correct any superseded verification.
      const result = tail.then(work, work);
      tail = result.catch(() => undefined);
      return result;
    },
  };
}

export function resolveSampleHatRollback({
  selectedHat,
  currentEmail,
  currentView,
  currentPath,
  demo,
  personas,
  hats,
}) {
  const authenticatedPersona = personas.find((persona) => persona.email === currentEmail);
  const previousHat = authenticatedPersona?.hat ?? selectedHat;
  const selectionMatchesSession = previousHat === selectedHat;
  const previousEntry = hats.find((item) => item.key === previousHat) ?? hats[0];
  return {
    previousHat,
    previousView: selectionMatchesSession ? currentView : previousEntry?.view ?? currentView,
    previousPath: selectionMatchesSession
      ? currentPath
      : `${previousEntry?.path ?? "/m"}${demo ? "?demo=1" : ""}`,
  };
}
