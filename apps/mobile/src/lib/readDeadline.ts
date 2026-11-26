// A protected feature read that never settles must not leave a screen showing
// its loading state forever with no way out
// (BUG-UG-NATIVE-REMINDERS-UNBOUNDED-LOAD-WITHOUT-RETRY-20261111). The
// auth fetch bounds sign-in requests only; a screen's own reads go through this
// deadline, which rejects so the screen's ordinary error and Try again state
// takes over. Only the race settles the caller, so a reply that arrives after
// the deadline is never published.
export const READ_DEADLINE_MS = 20_000;

export class ReadDeadlineError extends Error {
  constructor() {
    super('Read timed out');
    this.name = 'TimeoutError';
  }
}

export function withReadDeadline<T>(request: Promise<T>, ms: number = READ_DEADLINE_MS): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new ReadDeadlineError()), ms);
  });
  return Promise.race([request, deadline]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}
