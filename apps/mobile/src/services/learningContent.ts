// REQ-UG-QUOTES-MINI-LESSONS-20260928: the native client for the
// governed learning-content RPCs. Every call runs on the captured-session RPC
// client, the exact JWT that was current when the screen asked and never a
// service role; the server re-verifies the selected organization and chapter.
// Requests are validated and bounded before they leave the phone, and each
// response passes the shared normalizers plus native scope checks, so a
// malformed, foreign-locale or out-of-scope answer fails closed.

import type { Session } from '@supabase/supabase-js';

import {
  LEARNING_HISTORY_PAGE,
  LEARNING_HOME_BATCH,
  LEARNING_LIMITS,
  LEARNING_MAX_OFFSET,
  LEARNING_WORKSPACE_PAGE,
  LearningContractError,
  learningDraftFormIssues,
  learningDraftFormPayload,
  learningErrorKind,
  normalizeLearningHistoryPage,
  normalizeLearningHomeHidden,
  normalizeLearningItem,
  normalizeLearningPage,
  normalizeLearningPolicy,
  normalizeLearningScopePolicy,
  normalizeLearningWorkspace,
  validateLearningTransition,
  type LearningDraftForm,
  type LearningErrorKind,
  type LearningHistoryPage,
  type LearningIssue,
  type LearningItem,
  type LearningKindFilter,
  type LearningLocale,
  type LearningPage,
  type LearningPolicy,
  type LearningScope,
  type LearningScopePolicy,
  type LearningTransition,
  type LearningWorkspace,
} from '../lib/learningContentModel';
import { createCapturedSessionRpcClient } from './supabase';

export type LearningRpcClient = {
  rpc(name: string, args: Record<string, unknown>): PromiseLike<{ data: unknown; error: unknown }>;
};

export const LEARNING_RPC_NAMES: readonly string[] = [
  'get_learning_policy',
  'list_learning_content',
  'list_learning_choices',
  'get_learning_workspace',
  'save_learning_policy',
  'save_learning_content',
  'transition_learning_content',
  'get_learning_history',
  'set_learning_home_hidden',
];

export type LearningFailureKind = LearningErrorKind | 'contract';

/** A refused, conflicting or unverifiable call; its message is never shown. */
export class LearningRequestError extends Error {
  readonly kind: LearningFailureKind;

  constructor(kind: LearningFailureKind, message: string) {
    super(message);
    this.name = 'LearningRequestError';
    this.kind = kind;
  }
}

/** A local refusal before any request: the listed issues are shown inline. */
export class LearningValidationError extends Error {
  readonly issues: LearningIssue[];

  constructor(issues: LearningIssue[]) {
    super('learning_validation_failed');
    this.name = 'LearningValidationError';
    this.issues = issues;
  }
}

export function learningFailureKind(error: unknown): LearningFailureKind {
  if (error instanceof LearningRequestError) return error.kind;
  if (error instanceof LearningContractError) return 'contract';
  if (error instanceof LearningValidationError) return 'invalid';
  return learningErrorKind(error);
}

export type LearningListQuery = {
  chapterId: string | null;
  locale: LearningLocale;
  kind: LearningKindFilter;
  offset: number;
  limit: number;
};

export type LearningContentApi = {
  getPolicy(chapterId: string | null): Promise<LearningPolicy>;
  listContent(query: LearningListQuery): Promise<LearningPage>;
  listChoices(query: { chapterId: string | null; scope: LearningScope; offset: number }): Promise<LearningPage>;
  getWorkspace(query: { chapterId: string | null; scope: LearningScope; offset: number }): Promise<LearningWorkspace>;
  savePolicy(change: { chapterId: string | null; scope: LearningScope; quotesEnabled: boolean; lessonsEnabled: boolean; selectedIds: readonly string[] | null; expectedRevision: number }): Promise<LearningScopePolicy>;
  saveContent(change: { chapterId: string | null; form: LearningDraftForm }): Promise<LearningItem>;
  transition(change: { chapterId: string | null; id: string; action: LearningTransition; expectedRevision: number; startsAt: Date | null; endsAt: Date | null }): Promise<LearningItem>;
  getHistory(query: { chapterId: string | null; id: string; offset: number }): Promise<LearningHistoryPage>;
  setHomeHidden(change: { chapterId: string | null; hidden: boolean }): Promise<boolean>;
};

function boundedOffset(offset: number): number {
  if (!Number.isInteger(offset) || offset < 0 || offset > LEARNING_MAX_OFFSET) {
    throw new LearningRequestError('invalid', 'learning_offset_out_of_bounds');
  }
  return offset;
}

function requireId(id: string): string {
  if (typeof id !== 'string' || !id.trim()) throw new LearningRequestError('invalid', 'learning_id_invalid');
  return id;
}

function boundedPage<T extends { items: readonly unknown[] }>(page: T | null, limit: number, name: string): T {
  if (!page) throw new LearningContractError(`${name}_unverified`);
  if (page.items.length > limit) throw new LearningContractError(`${name}_over_limit`);
  return page;
}

const STATUS_AFTER: Record<LearningTransition, LearningItem['status']> = {
  publish: 'published',
  schedule: 'scheduled',
  withdraw: 'withdrawn',
};

export function createLearningContentApi(client: LearningRpcClient, clock: () => number = () => Date.now()): LearningContentApi {
  async function call(name: string, args: Record<string, unknown>): Promise<unknown> {
    const { data, error } = await client.rpc(name, args);
    if (error) throw new LearningRequestError(learningErrorKind(error), `${name}_refused`);
    return data;
  }

  return {
    async getPolicy(chapterId) {
      const policy = normalizeLearningPolicy(await call('get_learning_policy', { p_chapter_id: chapterId }));
      if (!policy) throw new LearningContractError('learning_policy_unverified');
      // The server verifies the selected chapter; an answer about any other
      // chapter belongs to a scope this screen no longer shows.
      if (chapterId !== null && policy.chapterId !== chapterId) throw new LearningContractError('learning_scope_changed');
      return policy;
    },

    async listContent({ chapterId, locale, kind, offset, limit }) {
      // Home reads one batch of at most a hundred; Learn pages by forty.
      if (!Number.isInteger(limit) || limit < 1 || limit > LEARNING_HOME_BATCH) {
        throw new LearningRequestError('invalid', 'learning_limit_out_of_bounds');
      }
      const page = boundedPage(normalizeLearningPage(await call('list_learning_content', {
        p_chapter_id: chapterId,
        p_locale: locale,
        p_kind: kind,
        p_offset: boundedOffset(offset),
        p_limit: limit,
      })), limit, 'learning_page');
      // Defence in depth: nothing in another locale or kind reaches a screen,
      // so a Spanish reader is never handed English content.
      const items = page.items.filter((item) => item.locale === locale && (kind === null || item.kind === kind));
      return { items, hasMore: page.hasMore, dropped: page.dropped + (page.items.length - items.length) };
    },

    async listChoices({ chapterId, scope, offset }) {
      return boundedPage(normalizeLearningPage(await call('list_learning_choices', {
        p_chapter_id: chapterId,
        p_scope: scope,
        p_offset: boundedOffset(offset),
      })), LEARNING_WORKSPACE_PAGE, 'learning_choices');
    },

    async getWorkspace({ chapterId, scope, offset }) {
      const workspace = boundedPage(normalizeLearningWorkspace(await call('get_learning_workspace', {
        p_chapter_id: chapterId,
        p_scope: scope,
        p_offset: boundedOffset(offset),
      })), LEARNING_WORKSPACE_PAGE, 'learning_workspace');
      if (!workspace.canManage || workspace.items.some((item) => item.scope !== scope)) throw new LearningContractError('learning_workspace_unverified');
      return workspace;
    },

    async savePolicy({ chapterId, scope, quotesEnabled, lessonsEnabled, selectedIds, expectedRevision }) {
      if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0) throw new LearningRequestError('invalid', 'learning_revision_required');
      let selection: string[] | null = null;
      if (selectedIds !== null) {
        // The platform switches govern the reviewed default library; only an
        // organization or chapter narrows content by explicit selection.
        if (scope === 'platform') throw new LearningRequestError('invalid', 'learning_platform_selection_refused');
        selection = [...new Set(selectedIds)];
        if (selection.length > LEARNING_LIMITS.selectedIds || selection.some((id) => typeof id !== 'string' || !id.trim())) {
          throw new LearningRequestError('invalid', 'learning_selection_invalid');
        }
      }
      const saved = normalizeLearningScopePolicy(await call('save_learning_policy', {
        p_chapter_id: chapterId,
        p_scope: scope,
        p_quotes_enabled: quotesEnabled,
        p_lessons_enabled: lessonsEnabled,
        p_selected_ids: selection,
        p_expected_revision: expectedRevision,
      }));
      if (!saved || saved.revision === null || saved.revision <= expectedRevision || saved.quotesEnabled !== quotesEnabled || saved.lessonsEnabled !== lessonsEnabled) throw new LearningContractError('learning_policy_save_unverified');
      return saved;
    },

    async saveContent({ chapterId, form }) {
      const issues = learningDraftFormIssues(form);
      if (issues.length > 0) throw new LearningValidationError(issues);
      if (form.id !== null && (!form.id.trim() || form.revision === null)) {
        throw new LearningRequestError('invalid', 'learning_revision_required');
      }
      // Only the eighteen editable fields (plus the id of an existing item) are
      // sent: ownership, status, dates, revision and provenance stay server-owned.
      const saved = normalizeLearningItem(await call('save_learning_content', {
        p_chapter_id: chapterId,
        p_scope: form.scope,
        p_item: learningDraftFormPayload(form),
        p_expected_revision: form.id === null ? null : form.revision,
      }));
      // A content save always returns the item to draft with no window.
      if (!saved || saved.scope !== form.scope || (form.id !== null && saved.id !== form.id)
        || saved.status !== 'draft' || saved.starts_at !== null || saved.ends_at !== null) {
        throw new LearningContractError('learning_save_unverified');
      }
      return saved;
    },

    async transition({ chapterId, id, action, expectedRevision, startsAt, endsAt }) {
      if (!Number.isInteger(expectedRevision) || expectedRevision < 1) throw new LearningRequestError('invalid', 'learning_revision_required');
      const startsAtText = action === 'schedule' && startsAt ? startsAt.toISOString() : null;
      const endsAtText = action !== 'withdraw' && endsAt ? endsAt.toISOString() : null;
      if (action === 'schedule' && !startsAt) throw new LearningValidationError([{ field: 'starts_at', code: 'required' }]);
      const issues = validateLearningTransition({ action, startsAt: startsAtText, endsAt: endsAtText, nowMs: clock() });
      if (issues.length > 0) throw new LearningValidationError(issues);
      const item = normalizeLearningItem(await call('transition_learning_content', {
        p_chapter_id: chapterId,
        p_id: requireId(id),
        p_action: action,
        p_expected_revision: expectedRevision,
        p_starts_at: startsAtText,
        p_ends_at: endsAtText,
      }));
      if (!item || item.id !== id || item.status !== STATUS_AFTER[action] || item.revision <= expectedRevision) {
        throw new LearningContractError('learning_transition_unverified');
      }
      return item;
    },

    async getHistory({ chapterId, id, offset }) {
      return boundedPage(normalizeLearningHistoryPage(await call('get_learning_history', {
        p_chapter_id: chapterId,
        p_id: requireId(id),
        p_offset: boundedOffset(offset),
      })), LEARNING_HISTORY_PAGE, 'learning_history');
    },

    async setHomeHidden({ chapterId, hidden }) {
      const saved = normalizeLearningHomeHidden(await call('set_learning_home_hidden', { p_chapter_id: chapterId, p_hidden: hidden }));
      if (saved !== hidden) throw new LearningContractError('learning_home_preference_unverified');
      return saved;
    },
  };
}

// One captured-session client per Session object: a token refresh or an
// account change produces a new Session, and with it a new client whose JWT
// can never be swapped underneath a request already in flight.
const capturedLearningApis = new WeakMap<Session, LearningContentApi>();

export function learningApiForSession(session: Session): LearningContentApi {
  const cached = capturedLearningApis.get(session);
  if (cached) return cached;
  const api = createLearningContentApi(createCapturedSessionRpcClient(session));
  capturedLearningApis.set(session, api);
  return api;
}
