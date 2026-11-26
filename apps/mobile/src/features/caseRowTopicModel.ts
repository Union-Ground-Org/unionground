// #7059 gate r2s1/r4s1: a case-topic switch saves, then re-reads the server's
// answer. The two steps fail differently: a refused save changed nothing,
// while a failed re-read comes after the server already holds the new value.

export type SaveFailure = 'save' | 'reload';

export type SaveOutcome<T> =
  | { failure: null; setting: T | null }
  | { failure: 'save' }
  | { failure: 'reload'; setting: T };

/**
 * Saves, then reloads. A refused save keeps what the card shows. A reload
 * failure after a confirmed save shows the confirmed value and says the
 * re-read failed, never that the save did.
 */
export async function saveThenReload<T>(save: () => Promise<void>, reload: () => Promise<T | null>, confirmed: T): Promise<SaveOutcome<T>> {
  try {
    await save();
  } catch {
    return { failure: 'save' };
  }
  try {
    return { failure: null, setting: await reload() };
  } catch {
    return { failure: 'reload', setting: confirmed };
  }
}

export const SAVE_FAILURE_MESSAGES: Record<SaveFailure, string> = {
  save: 'The setting could not be saved. Your saved choice has not changed.',
  reload: 'Your choice was saved, but the current setting could not be reloaded. Reopen this screen to check it.',
};

const NEUTRAL_NOTE = 'Restricted and private-identity issues stay neutral.';

/**
 * #7059 gate r4g1: the steward card's note. When the chapter already shows
 * topics it says so beside the neutrality sentence, never in place of it.
 */
export function caseTopicNote(chapterShown: boolean): string {
  return `${chapterShown ? 'Your campaign shows issue topics in lists.' : 'Only your own lists change. Other people see what the campaign setting allows.'} ${NEUTRAL_NOTE}`;
}
