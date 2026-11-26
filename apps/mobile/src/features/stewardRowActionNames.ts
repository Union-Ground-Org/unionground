import type { StewardFormReviewRow, StewardRequestRow } from '../services/stewardDeskSections';
import { formatFormSubmittedAt } from '../services/stewardFormReview';
import { nativeCatalogLabel, nativeUiText, type NativeLanguage } from '../lib/nativeUiCopy';

// A11Y-UG-NATIVE-STEWARD-ROW-ACTIONS-OMIT-TARGET-20261109: every
// repeated Acknowledge, Close request and Review button is named with its
// visible action text first, then the member and the record it acts on, so a
// screen reader or speech control can tell two cards apart. When two cards
// would still read the same (one member, one topic), the name says which of
// them it is instead of leaving the reader to count rows.

function withOrdinals<T>(rows: readonly T[], base: (row: T) => string): Map<T, string> {
  const counts = new Map<string, number>();
  for (const row of rows) counts.set(base(row), (counts.get(base(row)) ?? 0) + 1);
  const seen = new Map<string, number>();
  const names = new Map<T, string>();
  for (const row of rows) {
    const name = base(row);
    const total = counts.get(name) ?? 1;
    if (total === 1) {
      names.set(row, name);
      continue;
    }
    const position = (seen.get(name) ?? 0) + 1;
    seen.set(name, position);
    names.set(row, `${name}, ${position} of ${total}`);
  }
  return names;
}

function requestTarget(row: StewardRequestRow): string {
  const topic = row.topic.trim();
  return topic ? `request from ${row.memberName}: ${topic}` : `request from ${row.memberName}`;
}

export function stewardRequestTargets(rows: readonly StewardRequestRow[]): Map<StewardRequestRow, string> {
  return withOrdinals(rows, requestTarget);
}

export function stewardRequestActionName(action: 'acknowledge' | 'close', target: string): string {
  return action === 'acknowledge' ? `Acknowledge ${target}` : `Close ${target}`;
}

export function stewardFormReviewNames(rows: readonly StewardFormReviewRow[], language: NativeLanguage = 'en'): Map<StewardFormReviewRow, string> {
  const t = nativeUiText(language);
  return withOrdinals(rows, (row) => t('Review {form} from {member}, {submitted}', {
    form: nativeCatalogLabel(language, row.templateLabel),
    member: row.memberName,
    submitted: formatFormSubmittedAt(row.submittedAt, language),
  }));
}
