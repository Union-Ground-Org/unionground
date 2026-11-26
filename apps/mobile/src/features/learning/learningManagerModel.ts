// REQ-UG-QUOTES-MINI-LESSONS-20260928: the pure decisions behind the
// native learning-content manager (switch and selection drafts, publication
// inputs, status presentation), kept apart from React so they are unit-tested.

import {
  LEARNING_LIMITS,
  learningDayKey,
  learningPublicationIssues,
  learningTransitionsFor,
  parseLearningInstant,
  parseLearningLocalDateTime,
  type LearningIssue,
  type LearningItem,
  type LearningLocale,
  type LearningScope,
  type LearningScopePolicy,
  type LearningStatus,
  type LearningTransition,
} from '../../lib/learningContentModel';
import type { StatusState } from '../../theme/statusRamp';

export type LearningSelectionMode = 'all' | 'none' | 'some';

export type LearningPolicyDraft = {
  quotes: boolean;
  lessons: boolean;
  mode: LearningSelectionMode;
  selected: string[];
};

export function learningPolicyDraft(policy: LearningScopePolicy): LearningPolicyDraft {
  const selected = policy.selectedIds ?? [];
  return {
    quotes: policy.quotesEnabled,
    lessons: policy.lessonsEnabled,
    mode: policy.selectedIds === null ? 'all' : selected.length === 0 ? 'none' : 'some',
    selected: [...selected],
  };
}

/**
 * The p_selected_ids a save sends: null inherits everything eligible, an empty
 * list shows nothing, and a list narrows to exactly those items. The platform
 * never sends a selection; its switches govern the default library.
 */
export function learningSelectionForSave(scope: LearningScope, draft: LearningPolicyDraft): string[] | null {
  if (scope === 'platform' || draft.mode === 'all') return null;
  if (draft.mode === 'none') return [];
  return [...new Set(draft.selected)];
}

export function learningPolicyDraftChanged(scope: LearningScope, draft: LearningPolicyDraft, saved: LearningScopePolicy): boolean {
  const next = learningSelectionForSave(scope, draft);
  const current = scope === 'platform' ? null : saved.selectedIds;
  const sameSelection = next === null || current === null
    ? next === current
    : next.length === current.length && next.every((id) => current.includes(id));
  return draft.quotes !== saved.quotesEnabled || draft.lessons !== saved.lessonsEnabled || !sameSelection;
}

export function learningSelectionOverLimit(draft: LearningPolicyDraft): boolean {
  return draft.mode === 'some' && new Set(draft.selected).size > LEARNING_LIMITS.selectedIds;
}

export function toggleLearningSelection(selected: readonly string[], id: string): string[] {
  return selected.includes(id) ? selected.filter((entry) => entry !== id) : [...selected, id];
}

/** Selected ids not among the loaded choices; they stay selected. */
export function learningSelectionOutside(selected: readonly string[], listed: readonly LearningItem[]): number {
  const ids = new Set(listed.map((item) => item.id));
  return new Set(selected.filter((id) => !ids.has(id))).size;
}

export function learningStatusState(status: LearningStatus): StatusState {
  switch (status) {
    case 'published': return 'active';
    case 'scheduled': return 'queued';
    case 'draft': return 'attention';
    case 'withdrawn': return 'done';
  }
}

/** Formats a server instant with the shared engine-independent parser. */
export function formatLearningMoment(value: string, locale: LearningLocale): string {
  const instant = parseLearningInstant(value);
  if (instant === null) return value;
  return new Intl.DateTimeFormat(locale === 'es' ? 'es-US' : 'en-US', {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  }).format(new Date(instant));
}

export type LearningWindowInput = {
  startDate: string;
  startTime: string;
  endDate: string;
  endTime: string;
};

/** A schedule form opens on tomorrow at 9:00 local time, which the editor can change. */
export function defaultLearningWindowInput(now: Date): LearningWindowInput {
  const tomorrow = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1, 9, 0, 0, 0);
  return { startDate: learningDayKey(tomorrow), startTime: '09:00', endDate: '', endTime: '' };
}

export type ParsedLearningWindow =
  | { ok: true; startsAt: Date | null; endsAt: Date | null }
  | { ok: false; field: 'starts_at' | 'ends_at' };

/**
 * Parses the typed window strictly. Publish ignores the start (the server
 * starts it now); an end is optional but, once typed, needs both halves.
 */
export function parseLearningWindowInput(action: LearningTransition, input: LearningWindowInput): ParsedLearningWindow {
  let startsAt: Date | null = null;
  if (action === 'schedule') {
    startsAt = parseLearningLocalDateTime(input.startDate, input.startTime);
    if (!startsAt) return { ok: false, field: 'starts_at' };
  }
  let endsAt: Date | null = null;
  if (action !== 'withdraw' && (input.endDate.trim() || input.endTime.trim())) {
    endsAt = parseLearningLocalDateTime(input.endDate, input.endTime);
    if (!endsAt) return { ok: false, field: 'ends_at' };
  }
  return { ok: true, startsAt, endsAt };
}

/** What still blocks publishing or scheduling the saved revision. */
export function learningItemPublicationIssues(item: LearningItem): LearningIssue[] {
  return learningPublicationIssues(item);
}

export function learningActionsFor(item: LearningItem): LearningTransition[] {
  return learningTransitionsFor(item.status);
}

/** The title a history snapshot recorded, when it recorded one. */
export function learningSnapshotTitle(snapshot: Readonly<Record<string, unknown>> | null): string {
  return snapshot && typeof snapshot.title === 'string' ? snapshot.title : '';
}

const PROVENANCE_ENTRY_LIMIT = 12;
const PROVENANCE_VALUE_LIMIT = 300;

/**
 * Recovered and imported items carry their provenance (donor path, digests,
 * the original call and a recovery note). Editors see its plain values,
 * bounded; members never receive it.
 */
export function learningProvenanceEntries(provenance: Readonly<Record<string, unknown>> | null): [string, string][] {
  if (!provenance) return [];
  const entries: [string, string][] = [];
  for (const [key, value] of Object.entries(provenance)) {
    if (entries.length >= PROVENANCE_ENTRY_LIMIT) break;
    if (typeof value === 'string' && value.trim()) {
      const points = Array.from(value.trim());
      entries.push([key, points.length > PROVENANCE_VALUE_LIMIT ? `${points.slice(0, PROVENANCE_VALUE_LIMIT - 1).join('')}…` : points.join('')]);
    } else if (typeof value === 'number' || typeof value === 'boolean') {
      entries.push([key, String(value)]);
    }
  }
  return entries;
}
