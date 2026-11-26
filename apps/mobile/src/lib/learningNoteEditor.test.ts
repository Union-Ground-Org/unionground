import { describe, expect, it } from 'vitest';
import { OFFLINE_LIMITS } from './offlineAvailability';
import { learningEditorForScope, reconcileLearningEditor } from './learningNoteEditor';

const scope = { accountID: 'account-a', organizationID: 'chapter-a' };
const now = 100 * 86_400_000;
const note = { id: 'note', body: 'Saved reminder', revision: 1, createdAt: now - OFFLINE_LIMITS.draftMaxAgeMs, updatedAt: now - OFFLINE_LIMITS.draftMaxAgeMs };

describe('private learning-note composer during reauthorization', () => {
  it('restores unsaved text only for the same freshly authorized account and campaign', () => {
    const saved = { ...scope, body: 'Text before the app switch', editing: null };
    expect(learningEditorForScope(saved, scope).body).toBe(saved.body);
    expect(learningEditorForScope(saved, { ...scope, accountID: 'account-b' }).body).toBe('');
    expect(learningEditorForScope(saved, { ...scope, organizationID: 'chapter-b' }).body).toBe('');
  });
  it('preserves an unrelated new composer when a saved note expires', () => {
    const editor = { body: 'Still typing a new reminder', editing: null };
    expect(reconcileLearningEditor(editor, [note], now)).toBe(editor);
  });
  it('removes text only when the note being edited expires or disappears', () => {
    const editor = { body: 'Edited reminder', editing: { id: note.id, revision: note.revision } };
    expect(reconcileLearningEditor(editor, [note], now - 1)).toBe(editor);
    expect(reconcileLearningEditor(editor, [note], now)).toEqual({ body: '', editing: null });
    expect(reconcileLearningEditor(editor, [], now - 1)).toEqual({ body: '', editing: null });
  });
});
