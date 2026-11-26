import { OPERATION_KEY_MAX_AGE_MS } from './operationKey';

// A write whose fields include the time it was made (an HR contact's
// occurredAt) keeps the first press's time while it is retried, so the retry
// is the same intent and reuses its operation key instead of filing a second
// row. A changed write, an answered one, or one older than the key's ten
// minutes gets a new time (review of #8648).
export function createIntentStamp(now: () => number = Date.now) {
  let held: { intent: string; at: number } | null = null;
  return {
    stamp(intent: string): string {
      if (!held || held.intent !== intent || now() - held.at >= OPERATION_KEY_MAX_AGE_MS) held = { intent, at: now() };
      return new Date(held.at).toISOString();
    },
    settle(): void {
      held = null;
    },
  };
}
