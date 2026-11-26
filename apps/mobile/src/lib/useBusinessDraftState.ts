import { useBusinessRequestOwner, useBusinessSubjectState } from './useBusinessWriter';

// A write's local settlement belongs to its composing workspace and subject.
// Its control uses useBusinessState separately, so a grant/subject change
// cannot release an operation whose write or follow-up is still in flight.
export function useBusinessDraftState<T>(initial: T | (() => T), subject: string | null = null) {
  const owner = useBusinessRequestOwner();
  return useBusinessSubjectState(JSON.stringify([owner.workspace, subject]), initial);
}
