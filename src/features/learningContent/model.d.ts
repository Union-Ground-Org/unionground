// Types for model.js, the governed quote and mini-lesson contract shared by
// the web client and the native app. Keep in step with model.js.

export type LearningKind = "quote" | "mini_lesson";
export type LearningLocale = "en" | "es";
export type LearningLocaleState = "draft" | "reviewed";
export type LearningStatus = "draft" | "published" | "scheduled" | "withdrawn";
export type LearningScope = "platform" | "organization" | "chapter";
export type LearningAudience = "all" | "members" | "staff";
export type LearningTransition = "publish" | "schedule" | "withdraw";
export type LearningHistoryAction = "recover_draft" | "save_draft" | "publish" | "schedule" | "withdraw";
export type LearningPublicationState = "draft" | "withdrawn" | "upcoming" | "live" | "expired";
export type LearningErrorKind = "conflict" | "forbidden" | "not_found" | "invalid" | "unavailable" | "network" | "unknown";

export type LearningEditableField =
  | "kind" | "locale" | "locale_state" | "title" | "body" | "attribution" | "source"
  | "rights_note" | "review_note" | "bullets" | "direction" | "topics" | "audience"
  | "tone" | "learning_outcome" | "factual_claims" | "priority" | "is_default";

export type LearningTextField = "attribution" | "source" | "rights_note" | "review_note" | "direction" | "tone" | "learning_outcome";

export declare const LEARNING_KINDS: readonly LearningKind[];
export declare const LEARNING_LOCALES: readonly LearningLocale[];
export declare const LEARNING_LOCALE_STATES: readonly LearningLocaleState[];
export declare const LEARNING_STATUSES: readonly LearningStatus[];
export declare const LEARNING_SCOPES: readonly LearningScope[];
export declare const LEARNING_AUDIENCES: readonly LearningAudience[];
export declare const LEARNING_TRANSITIONS: readonly LearningTransition[];
export declare const LEARNING_HISTORY_ACTIONS: readonly LearningHistoryAction[];

export declare const LEARNING_LIMITS: Readonly<{
  title: 100;
  body: Readonly<{ quote: 500; mini_lesson: 2000 }>;
  bulletCount: 5;
  bullet: 200;
  topicCount: 5;
  topic: 80;
  attribution: 200;
  source: 1000;
  rights_note: 1000;
  review_note: 1000;
  direction: 1000;
  tone: 100;
  learning_outcome: 500;
  priorityMin: 0;
  priorityMax: 100;
  payloadBytes: 64000;
  selectedIds: 500;
}>;
export declare const LEARNING_TEXT_LIMITS: Readonly<Record<LearningTextField, number>>;
export declare const LEARNING_PAGE_SIZE: Readonly<{ home: 100; learn: 40; workspace: 40; history: 40 }>;
export declare const LEARNING_MAX_OFFSET: 10000;
export declare const LEARNING_POLICY_POLL_MS: 60000;
export declare const LEARNING_DEFAULT_PRIORITY: 0;
export declare const LEARNING_EDITABLE_FIELDS: readonly LearningEditableField[];

/** A normalized, frozen item as the RPCs return it (snake_case, as in the contract). */
export interface LearningItem {
  readonly id: string;
  readonly scope: LearningScope;
  readonly organization_id: string | null;
  readonly chapter_id: string | null;
  readonly kind: LearningKind;
  readonly locale: LearningLocale;
  readonly locale_state: LearningLocaleState;
  readonly audience: LearningAudience;
  readonly status: LearningStatus;
  readonly title: string;
  readonly body: string;
  readonly attribution: string;
  /** Empty on delivery rows (list_learning_content omits editorial fields). */
  readonly source: string;
  readonly rights_note: string;
  readonly review_note: string;
  readonly direction: string;
  readonly tone: string;
  readonly learning_outcome: string;
  readonly bullets: readonly string[];
  readonly topics: readonly string[];
  readonly factual_claims: boolean;
  readonly priority: number;
  readonly is_default: boolean;
  readonly starts_at: string | null;
  readonly ends_at: string | null;
  readonly revision: number;
  readonly provenance: Readonly<Record<string, unknown>> | null;
}

/** get_learning_policy, normalized. */
export interface LearningPolicy {
  /** null only when isPlatformOwner is true and no organization is selected. */
  readonly organizationId: string | null;
  readonly chapterId: string | null;
  readonly quotesEnabled: boolean;
  readonly lessonsEnabled: boolean;
  readonly homeHidden: boolean;
  readonly canManage: boolean;
  readonly isPlatformOwner: boolean;
  /** Opaque; any change invalidates cached content. */
  readonly version: string;
}

/** The per-scope policy row (workspace.policy / save_learning_policy). */
export interface LearningScopePolicy {
  readonly quotesEnabled: boolean;
  readonly lessonsEnabled: boolean;
  /** null = inherit/all eligible; [] = none; otherwise only these ids. */
  readonly selectedIds: readonly string[] | null;
  readonly revision: number | null;
}

export interface LearningPage {
  readonly items: readonly LearningItem[];
  readonly hasMore: boolean;
  /** Malformed or duplicate rows that were dropped (fail closed). */
  readonly dropped: number;
}

export interface LearningWorkspace extends LearningPage {
  readonly policy: LearningScopePolicy;
  readonly canManage: boolean;
  readonly isPlatformOwner: boolean;
}

export interface LearningHistoryEntry {
  readonly revision: number;
  readonly action: string;
  readonly changedAt: string;
  readonly changedBy: string | null;
  readonly snapshot: Readonly<Record<string, unknown>> | null;
}

export interface LearningHistoryPage {
  readonly items: readonly LearningHistoryEntry[];
  readonly hasMore: boolean;
  readonly dropped: number;
}

/** Editable state. priority may be a string while a form field is being typed. */
export interface LearningDraft {
  id: string | null;
  kind: LearningKind;
  locale: LearningLocale;
  locale_state: LearningLocaleState;
  title: string;
  body: string;
  attribution: string;
  source: string;
  rights_note: string;
  review_note: string;
  bullets: string[];
  direction: string;
  topics: string[];
  audience: LearningAudience;
  tone: string;
  learning_outcome: string;
  factual_claims: boolean;
  priority: number | string;
  is_default: boolean;
}

/** p_item for save_learning_content: exactly the editable keys, trimmed. */
export interface LearningItemPayload {
  id?: string;
  kind: string;
  locale: string;
  locale_state: string;
  title: string;
  body: string;
  attribution: string;
  source: string;
  rights_note: string;
  review_note: string;
  bullets: string[];
  direction: string;
  topics: string[];
  audience: string;
  tone: string;
  learning_outcome: string;
  factual_claims: boolean;
  /** NaN when the typed value is not a number; validation reports it. */
  priority: number;
  is_default: boolean;
}

export type LearningIssueCode =
  | "invalid" | "required" | "too_long" | "too_many" | "empty_entry" | "entry_too_long"
  | "out_of_range" | "platform_only" | "not_reviewed" | "too_large"
  | "invalid_date" | "not_allowed" | "not_future" | "not_after_start";

export interface LearningIssue {
  field: LearningEditableField | "payload" | "action" | "starts_at" | "ends_at";
  code: LearningIssueCode;
  limit?: number;
  index?: number;
  min?: number;
  max?: number;
}

export interface LearningDeliveryContext {
  nowMs: number;
  locale: LearningLocale;
  quotesEnabled: boolean;
  lessonsEnabled: boolean;
  organizationId: string | null;
  chapterId: string | null;
}

export interface LearningListRequest {
  kind: LearningKind | null;
  offset: number;
  limit: number;
}

export interface LearningRotationScope {
  userId: string | null | undefined;
  organizationId: string | null | undefined;
  chapterId: string | null | undefined;
  locale: string | null | undefined;
}

export declare function codePointLength(value: unknown): number;
export declare function learningBodyLimit(kind: unknown): number | null;
export declare function learningPayloadBytes(payload: unknown): number;
export declare function parseLearningInstant(value: unknown): number | null;

export declare function normalizeLearningItem(raw: unknown): LearningItem | null;
export declare function normalizeLearningPolicy(raw: unknown): LearningPolicy | null;
export declare function normalizeLearningScopePolicy(raw: unknown): LearningScopePolicy | null;
export declare function normalizeLearningPage(raw: unknown): LearningPage | null;
export declare function normalizeLearningWorkspace(raw: unknown): LearningWorkspace | null;
export declare function normalizeLearningHistoryPage(raw: unknown): LearningHistoryPage | null;
export declare function normalizeLearningHomeHidden(raw: unknown): boolean | null;

export declare function emptyLearningDraft(options?: { kind?: string; locale?: string }): LearningDraft;
export declare function learningDraftFromItem(item: LearningItem | null | undefined): LearningDraft;
export declare function learningDraftFromSnapshot(snapshot: unknown, currentItem: LearningItem | null | undefined): LearningDraft;
export declare function buildLearningItemPayload(draft: Partial<LearningDraft> | LearningItem | null | undefined): LearningItemPayload;
export declare function learningPayloadsEqual(left: Partial<LearningDraft> | LearningItem | null | undefined, right: Partial<LearningDraft> | LearningItem | null | undefined): boolean;
export declare function learningSourceRequired(input: { attribution?: unknown; factual_claims?: unknown } | null | undefined): boolean;
export declare function validateLearningItem(
  input: Partial<LearningDraft> | LearningItem | null | undefined,
  options?: { mode?: "save" | "publish"; scope?: LearningScope | null },
): LearningIssue[];
export declare function learningPublicationIssues(item: Partial<LearningDraft> | LearningItem | null | undefined): LearningIssue[];
export declare function learningTransitionsFor(status: LearningStatus | string): LearningTransition[];
export declare function validateLearningTransition(options: {
  action: LearningTransition | string;
  startsAt?: string | number | Date | null;
  endsAt?: string | number | Date | null;
  nowMs: number;
}): LearningIssue[];

export declare function isLearningItemLive(item: LearningItem | null | undefined, nowMs: number): boolean;
export declare function isLearningItemEligible(item: LearningItem | null | undefined, context: Omit<LearningDeliveryContext, "nowMs">): boolean;
export declare function isLearningItemDeliverable(item: LearningItem | null | undefined, context: LearningDeliveryContext): boolean;
export declare function learningPublicationState(item: LearningItem | null | undefined, nowMs: number): LearningPublicationState;
export declare function learningHomeRequest(policy: LearningPolicy | null | undefined): LearningListRequest | null;
export declare function learningLibraryRequest(policy: LearningPolicy | null | undefined, offset?: number): LearningListRequest | null;
export declare function nextLearningBoundary(items: readonly (LearningItem | null | undefined)[] | null | undefined, nowMs: number): number | null;

export declare function learningDayKey(date?: Date | number | string): string;
export declare function learningRotationSeed(parts: LearningRotationScope & { day: string }): string;
export declare function stableLearningHash(text: string): number;
export declare function orderLearningItems<T extends LearningItem>(items: readonly (T | null | undefined)[] | null | undefined, seed: string): T[];
export declare function learningRotationStorageKey(scope: LearningRotationScope): string;
export declare function parseLearningRotationState(raw: unknown, day: string): number;
export declare function serializeLearningRotationState(day: string, index: number): string;
export declare function pickLearningItem<T extends LearningItem>(ordered: readonly T[] | null | undefined, index: number, nowMs: number): { item: T; index: number } | null;
export declare function nextLearningIndex(ordered: readonly LearningItem[] | null | undefined, index: number, nowMs: number): number;
export declare function liveLearningCount(ordered: readonly LearningItem[] | null | undefined, nowMs: number): number;

export declare function learningErrorKind(error: unknown): LearningErrorKind;
