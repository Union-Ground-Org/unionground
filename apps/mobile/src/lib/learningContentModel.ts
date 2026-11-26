// REQ-UG-QUOTES-MINI-LESSONS-20260928: native governed quotes and
// mini-lessons use the one pure contract the web client uses
// (src/features/learningContent/model.js): the same limits, validation,
// normalizers, engine-independent instants, delivery checks and day-stable
// rotation, so the two clients cannot drift apart. This file re-exports that
// model and adds only what is native: an editor form whose priority is text,
// a Keychain/Keystore-safe Next storage key, typed local date entry for
// scheduling, and the Home load plan the native controller follows.

import {
  LEARNING_AUDIENCES,
  LEARNING_EDITABLE_FIELDS,
  LEARNING_KINDS,
  LEARNING_LIMITS,
  LEARNING_LOCALES,
  LEARNING_LOCALE_STATES,
  LEARNING_MAX_OFFSET,
  LEARNING_PAGE_SIZE,
  LEARNING_POLICY_POLL_MS,
  LEARNING_SCOPES,
  LEARNING_STATUSES,
  buildLearningItemPayload,
  codePointLength,
  emptyLearningDraft,
  isLearningItemDeliverable,
  isLearningItemEligible,
  isLearningItemLive,
  learningBodyLimit,
  learningDayKey,
  learningDraftFromItem,
  learningErrorKind,
  learningHomeRequest,
  learningLibraryRequest,
  learningPayloadBytes,
  learningPayloadsEqual,
  learningPublicationIssues,
  learningPublicationState,
  learningRotationSeed,
  learningRotationStorageKey,
  learningSourceRequired,
  learningTransitionsFor,
  liveLearningCount,
  nextLearningBoundary,
  nextLearningIndex,
  normalizeLearningHistoryPage,
  normalizeLearningHomeHidden,
  normalizeLearningItem,
  normalizeLearningPage,
  normalizeLearningPolicy,
  normalizeLearningScopePolicy,
  normalizeLearningWorkspace,
  orderLearningItems,
  parseLearningInstant,
  parseLearningRotationState,
  pickLearningItem,
  serializeLearningRotationState,
  stableLearningHash,
  validateLearningItem,
  validateLearningTransition,
  type LearningAudience,
  type LearningDraft,
  type LearningErrorKind,
  type LearningHistoryEntry,
  type LearningHistoryPage,
  type LearningIssue,
  type LearningItem,
  type LearningItemPayload,
  type LearningKind,
  type LearningLocale,
  type LearningLocaleState,
  type LearningPage,
  type LearningPolicy,
  type LearningRotationScope,
  type LearningScope,
  type LearningScopePolicy,
  type LearningStatus,
  type LearningTransition,
  type LearningWorkspace,
} from '../../../../src/features/learningContent/model.js';

export {
  LEARNING_AUDIENCES,
  LEARNING_EDITABLE_FIELDS,
  LEARNING_KINDS,
  LEARNING_LIMITS,
  LEARNING_LOCALES,
  LEARNING_LOCALE_STATES,
  LEARNING_MAX_OFFSET,
  LEARNING_PAGE_SIZE,
  LEARNING_POLICY_POLL_MS,
  LEARNING_SCOPES,
  LEARNING_STATUSES,
  buildLearningItemPayload,
  codePointLength,
  isLearningItemDeliverable,
  isLearningItemEligible,
  isLearningItemLive,
  learningBodyLimit,
  learningDayKey,
  learningErrorKind,
  learningHomeRequest,
  learningLibraryRequest,
  learningPayloadBytes,
  learningPublicationIssues,
  learningPublicationState,
  learningRotationSeed,
  learningSourceRequired,
  learningTransitionsFor,
  liveLearningCount,
  nextLearningBoundary,
  nextLearningIndex,
  normalizeLearningHistoryPage,
  normalizeLearningHomeHidden,
  normalizeLearningItem,
  normalizeLearningPage,
  normalizeLearningPolicy,
  normalizeLearningScopePolicy,
  normalizeLearningWorkspace,
  orderLearningItems,
  parseLearningInstant,
  parseLearningRotationState,
  pickLearningItem,
  serializeLearningRotationState,
  stableLearningHash,
  validateLearningItem,
  validateLearningTransition,
};

export type {
  LearningAudience,
  LearningDraft,
  LearningErrorKind,
  LearningHistoryEntry,
  LearningHistoryPage,
  LearningIssue,
  LearningItem,
  LearningItemPayload,
  LearningKind,
  LearningLocale,
  LearningLocaleState,
  LearningPage,
  LearningPolicy,
  LearningRotationScope,
  LearningScope,
  LearningScopePolicy,
  LearningStatus,
  LearningTransition,
  LearningWorkspace,
};

export type LearningKindFilter = LearningKind | null;
export type LearningIssueField = LearningIssue['field'];

/** A verification failure in a response the shared normalizers accepted. */
export class LearningContractError extends Error {
  readonly code: string;

  constructor(code: string) {
    super(code);
    this.name = 'LearningContractError';
    this.code = code;
  }
}

// ---------------------------------------------------------------------------
// Editor form. The shared draft carries the eighteen editable fields; the form
// adds the revision a save must present and the scope it saves into, and keeps
// the priority as the text the field shows, so a partial entry is an explicit
// out_of_range issue rather than a silent zero.

export type LearningDraftForm = Omit<LearningDraft, 'priority' | 'bullets' | 'topics'> & {
  bullets: string[];
  topics: string[];
  priority: string;
  revision: number | null;
  scope: LearningScope;
};

export function emptyLearningDraftForm(kind: LearningKind, locale: LearningLocale, scope: LearningScope): LearningDraftForm {
  const draft = emptyLearningDraft({ kind, locale });
  return { ...draft, bullets: [...draft.bullets], topics: [...draft.topics], priority: String(draft.priority), revision: null, scope };
}

export function learningDraftFormFromItem(item: LearningItem): LearningDraftForm {
  const draft = learningDraftFromItem(item);
  return { ...draft, bullets: [...draft.bullets], topics: [...draft.topics], priority: String(draft.priority), revision: item.revision, scope: item.scope };
}

/** Save-time issues, exactly as the shared model and the server judge them. */
export function learningDraftFormIssues(form: LearningDraftForm): LearningIssue[] {
  return validateLearningItem(form, { mode: 'save', scope: form.scope });
}

/** p_item: the eighteen editable keys, trimmed, plus the id of an existing item. */
export function learningDraftFormPayload(form: LearningDraftForm): LearningItemPayload {
  return buildLearningItemPayload(form);
}

export function learningDraftFormChanged(form: LearningDraftForm, baseline: LearningDraftForm): boolean {
  return !learningPayloadsEqual(form, baseline);
}

// ---------------------------------------------------------------------------
// Next. The shared storage key contains ":" and percent-escapes, which
// expo-secure-store refuses in a key, so the native key is a digest of it:
// still one key per user, organization, chapter and locale.

export function learningNextStoreKey(scope: LearningRotationScope): string {
  const digest = stableLearningHash(learningRotationStorageKey(scope)).toString(16).padStart(8, '0');
  return `org.unionground.app.learning-rotation-v1.${digest}`;
}

export function msUntilNextLocalDay(date: Date): number {
  const next = new Date(date.getFullYear(), date.getMonth(), date.getDate() + 1, 0, 0, 0, 0);
  return Math.max(1_000, next.getTime() - date.getTime());
}

// ---------------------------------------------------------------------------
// Scheduling input. Native has no date-picker dependency, so a start or end is
// typed as a device-local date and 24-hour time and parsed strictly.

export function parseLearningLocalDateTime(date: string, time: string): Date | null {
  const dateMatch = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date.trim());
  const timeMatch = /^(\d{1,2}):(\d{2})$/.exec(time.trim());
  if (!dateMatch || !timeMatch) return null;
  const year = Number(dateMatch[1]);
  const month = Number(dateMatch[2]);
  const day = Number(dateMatch[3]);
  const hour = Number(timeMatch[1]);
  const minute = Number(timeMatch[2]);
  if (month < 1 || month > 12 || day < 1 || hour > 23 || minute > 59) return null;
  const parsed = new Date(year, month - 1, day, hour, minute, 0, 0);
  // Refuse roll-over dates such as February 31.
  if (parsed.getFullYear() !== year || parsed.getMonth() !== month - 1 || parsed.getDate() !== day
    || parsed.getHours() !== hour || parsed.getMinutes() !== minute) return null;
  return parsed;
}

// ---------------------------------------------------------------------------
// Home load plan. Hidden Home and disabled modules read nothing; a new policy
// version or changed switches invalidate the cache and read only the enabled
// kinds; an unchanged policy keeps what is cached.

export type LearningHomeLoadPlan = {
  clear: boolean;
  load: boolean;
  kind: LearningKindFilter;
  signature: string;
};

export function planLearningHomeLoad(
  cached: { version: string | null; signature: string | null; loaded: boolean },
  policy: LearningPolicy,
): LearningHomeLoadPlan {
  const request = learningHomeRequest(policy);
  const signature = `${policy.quotesEnabled ? 'q' : ''}${policy.lessonsEnabled ? 'l' : ''}`;
  if (!request) return { clear: true, load: false, kind: null, signature };
  if (cached.loaded && cached.version === policy.version && cached.signature === signature) {
    return { clear: false, load: false, kind: null, signature };
  }
  return { clear: true, load: true, kind: request.kind, signature };
}

export const LEARNING_HOME_BATCH: number = LEARNING_PAGE_SIZE.home;
export const LEARNING_LIBRARY_PAGE: number = LEARNING_PAGE_SIZE.learn;
export const LEARNING_WORKSPACE_PAGE: number = LEARNING_PAGE_SIZE.workspace;
export const LEARNING_HISTORY_PAGE: number = LEARNING_PAGE_SIZE.history;
