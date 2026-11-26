import { OFFLINE_LIMITS, type OfflineDraft, type OfflineScope } from './offlineAvailability';

export type LearningNoteEditor = { body: string; editing: { id: string; revision: number } | null };
export type ScopedLearningNoteEditor = LearningNoteEditor & OfflineScope;
export const emptyLearningNoteEditor = (): LearningNoteEditor => ({ body: '', editing: null });

export function learningEditorForScope(editor: ScopedLearningNoteEditor | null, scope: OfflineScope): LearningNoteEditor {
  return editor?.accountID === scope.accountID && editor.organizationID === scope.organizationID
    ? { body: editor.body, editing: editor.editing } : emptyLearningNoteEditor();
}

// An unrelated saved note expiring must not erase a new unsaved reminder.
export function reconcileLearningEditor(editor: LearningNoteEditor, drafts: readonly OfflineDraft[], now: number): LearningNoteEditor {
  if (!editor.editing) return editor;
  return drafts.some((draft) => draft.id === editor.editing?.id && now >= draft.createdAt
    && now - draft.createdAt < OFFLINE_LIMITS.draftMaxAgeMs) ? editor : emptyLearningNoteEditor();
}
