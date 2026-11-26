// Writes the server binds to the member's selected chapter at execution time
// (event creation, and notices since
// REQ-UG-OFFICER-NOTICES-WITH-READ-RECEIPTS-20261030). A write is
// refused while a chapter switch is current, and a switch waits for every
// write already submitted (switchChapterScope reads `pendingRef`), so a
// switch can never overtake a write meant for the previous chapter.
export async function fencedChapterWrite(transitionRef, pendingRef, start) {
  if (transitionRef.current?.operation.isCurrent()) throw new Error("Chapter switch in progress");
  const request = start();
  pendingRef.current.add(request);
  try {
    return await request;
  } finally {
    pendingRef.current.delete(request);
  }
}
