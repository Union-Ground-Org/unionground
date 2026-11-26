import { ReadDeadlineError } from '../lib/readDeadline';
import type { RetainedDraft, RetainedOutcome } from '../lib/retainedDraft';

// #9240 pull request C: the source-extracted handler tests (the part B
// lifetime, accepted and scope suites) run a handler without its component,
// so they hand it the held drafts the component would. A stub is shown and
// idle; begin hands out one attempt over the given value and reports how it
// settled. The handlers' own guards and continuations stay the production ones.
export function retainedDraftStub<T>(value: T, settled: (outcome: RetainedOutcome) => void = () => {}): RetainedDraft<T> {
  return {
    shown: true, checkFailed: false, value, stale: false, pending: false, failed: null,
    set: () => {}, discard: () => {}, refused: () => {},
    begin: () => ({ value, key: 'attempt-key', settle: (outcome: RetainedOutcome) => { settled(outcome); return true; } }),
  };
}

// The module names those handlers read beside their held drafts. Writes pass
// through without the 20-second deadline, so a held proof never races a timer.
export const retainedDraftHandlerNames = {
  withReadDeadline: <T,>(request: Promise<T>): Promise<T> => request,
  ReadDeadlineError,
  sessionRefused: (): boolean => false,
  beHeardOutcomeUnknown: (): boolean => false,
  CAMPAIGN_FAILURES: { refused: 'This account cannot write a campaign for that audience.', failed: 'The draft could not be saved. Try again.' },
  COACHING_FAILED: 'The coaching note was not confirmed.',
  SNAPSHOT_FAILED: 'The health snapshot was not confirmed. Check the date, measures, and your leadership access.',
  snapshotStale: false,
  requestUncertain: false,
};
