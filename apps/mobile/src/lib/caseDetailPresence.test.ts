import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import { attachmentPanelMounted, caseDetailPresence, shouldClearLoadedCaseDetail } from './caseDetailPresence';

// BUG-UG-MOBILE-ATTACHMENT-UPLOAD-SILENT-FAILURE-20260905. The Android
// window of 2026-09-26 logged the exit point: picker return ->
// privacy cover -> mode 'booting' -> case screen swaps to its loading message
// -> AttachmentPanel unmounts (panel-unmounted) -> picker-result mounted=false
// -> consume outcome=discarded. The mobile lane has no React renderer, so the
// presence rule is a pure function exercised here and the screen is pinned by
// source.

const caseScreen = readFileSync(fileURLToPath(new URL('../../app/issue/[id].tsx', import.meta.url)), 'utf8');

describe('issue detail presence through session revalidation', () => {
  it('keeps a loaded issue on screen while the session revalidates', () => {
    expect(caseDetailPresence({ mode: 'booting', loading: false, hasItem: true })).toBe('ready');
    expect(caseDetailPresence({ mode: 'authenticated', loading: true, hasItem: true })).toBe('ready');
  });

  it('shows the loading message only for an issue that has not loaded yet', () => {
    expect(caseDetailPresence({ mode: 'booting', loading: false, hasItem: false })).toBe('loading');
    expect(caseDetailPresence({ mode: 'authenticated', loading: true, hasItem: false })).toBe('loading');
    expect(caseDetailPresence({ mode: 'authenticated', loading: false, hasItem: false })).toBe('unavailable');
    expect(caseDetailPresence({ mode: 'preview', loading: false, hasItem: false })).toBe('unavailable');
  });

  it('clears the loaded detail only when the record changes or the session is gone', () => {
    // The revalidation re-run for the same record keeps the detail mounted.
    expect(shouldClearLoadedCaseDetail({ mode: 'booting', loadedID: 'case-1', nextID: 'case-1' })).toBe(false);
    expect(shouldClearLoadedCaseDetail({ mode: 'authenticated', loadedID: 'case-1', nextID: 'case-1' })).toBe(false);
    // A different record, an unloaded screen, or a signed-out session clears it.
    expect(shouldClearLoadedCaseDetail({ mode: 'authenticated', loadedID: 'case-1', nextID: 'case-2' })).toBe(true);
    expect(shouldClearLoadedCaseDetail({ mode: 'authenticated', loadedID: null, nextID: 'case-1' })).toBe(true);
    expect(shouldClearLoadedCaseDetail({ mode: 'booting', loadedID: 'case-1', nextID: null })).toBe(true);
    expect(shouldClearLoadedCaseDetail({ mode: 'signedOut', loadedID: 'case-1', nextID: 'case-1' })).toBe(true);
    expect(shouldClearLoadedCaseDetail({ mode: 'mfaRequired', loadedID: 'case-1', nextID: 'case-1' })).toBe(true);
    expect(shouldClearLoadedCaseDetail({ mode: 'preview', loadedID: 'case-1', nextID: 'case-1' })).toBe(true);
  });

  it('mounts the attachment panel for a live issue through booting, never for preview or a missing detail', () => {
    expect(attachmentPanelMounted({ mode: 'authenticated', hasLiveDetail: true })).toBe(true);
    expect(attachmentPanelMounted({ mode: 'booting', hasLiveDetail: true })).toBe(true);
    expect(attachmentPanelMounted({ mode: 'booting', hasLiveDetail: false })).toBe(false);
    expect(attachmentPanelMounted({ mode: 'preview', hasLiveDetail: true })).toBe(false);
    expect(attachmentPanelMounted({ mode: 'signedOut', hasLiveDetail: true })).toBe(false);
  });

  it('is what the issue screen renders from', () => {
    expect(caseScreen).toContain("import { attachmentPanelMounted, caseDetailPresence, shouldClearLoadedCaseDetail } from '../../src/lib/caseDetailPresence';");
    expect(caseScreen).toContain("const keepLoaded = !shouldClearLoadedCaseDetail({ mode, loadedID: loadedID.current, nextID });");
    expect(caseScreen).toContain("const presence = caseDetailPresence({ mode, loading, hasItem: item !== null });");
    expect(caseScreen).toContain("if (presence === 'loading') return <Screen><StateMessage title=\"Loading issue\"");
    expect(caseScreen).toContain("{attachmentPanelMounted({ mode, hasLiveDetail: detail !== null && mode !== 'preview' }) ? (");
    // The old gates that unmounted the panel on every revalidation are gone.
    expect(caseScreen).not.toContain("if (loading || mode === 'booting') return");
    expect(caseScreen).not.toContain("{mode === 'authenticated' ? (\n        <AttachmentPanel");
    // A revalidation must not clear the loaded detail before the panel can
    // consume the picker result.
    expect(caseScreen).toContain("if (mode === 'booting') return () => { active = false; };");
    expect(caseScreen).toContain("if (!keepLoaded) {\n      loadedID.current = null;\n      setDetail(null);\n      setLoading(true);\n    }");
  });
});
