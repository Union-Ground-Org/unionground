import type { AppMode } from '../state/AppProvider';

// BUG-UG-MOBILE-ATTACHMENT-UPLOAD-SILENT-FAILURE-20260905: the Android
// window of 2026-09-26 showed why a picked document vanished. Returning from
// the system picker foregrounds the app, the root layout covers it and the
// session revalidates, so `mode` passes through 'booting'. The case screen
// used to answer 'booting' by replacing its whole subtree with the loading
// message, which unmounted AttachmentPanel; the panel's selection lifecycle
// invalidated itself on unmount and the picker result was discarded before
// the begin-upload call. The panel then remounted ~2 s later, empty.
//
// The rule below keeps a case that is already on screen mounted through a
// revalidation: the loading message is for a case that has not loaded yet,
// never for one that has. The privacy cover in the root layout already hides
// the content while the session is being checked, so nothing protected is
// shown that was not shown a moment earlier.
export type CaseDetailPresence = 'loading' | 'unavailable' | 'ready';

export function caseDetailPresence({ mode, loading, hasItem }: {
  mode: AppMode;
  loading: boolean;
  hasItem: boolean;
}): CaseDetailPresence {
  if (hasItem) return 'ready';
  return loading || mode === 'booting' ? 'loading' : 'unavailable';
}

// A live case reload re-runs for the same record when the session revalidates
// (mode 'booting' -> 'authenticated'). Clearing the loaded detail on that
// re-run is what unmounts the attachment panel, so the detail is only cleared
// when the record itself changes or when there is nothing live to keep.
export function shouldClearLoadedCaseDetail({ mode, loadedID, nextID }: {
  mode: AppMode;
  loadedID: string | null;
  nextID: string | null;
}): boolean {
  if (loadedID === null || nextID === null) return true;
  if (loadedID !== nextID) return true;
  return mode !== 'booting' && mode !== 'authenticated';
}

// The attachment panel belongs to a live (non-preview) case and must survive
// the 'booting' revalidation the picker return triggers.
export function attachmentPanelMounted({ mode, hasLiveDetail }: {
  mode: AppMode;
  hasLiveDetail: boolean;
}): boolean {
  return hasLiveDetail && (mode === 'authenticated' || mode === 'booting');
}
