// BUG-UG-MOBILE-LEGAL-READER-SHARE-OPEN-FAILURES-20260920: the legal
// reader used to discard the result of Share.share and Linking.openURL and
// fire its confirmation unconditionally, so a dismissed share sheet read as a
// completed share and a failed share or website open left the member with no
// recovery signal at all. The outcomes live here, in one pure module, so the
// screen can render exactly what the platform reported:
//
// - 'completed' — the platform confirms the action finished; the caller may
//   confirm and fire the selection haptic.
// - 'dismissed' — the member closed the share sheet without sharing; the
//   caller stays silent: no confirmation, no notice.
// - 'failed' — the platform reports the action did not complete; the caller
//   shows the returned notice, which names what failed and how to recover.

export type LegalReaderOutcome =
  | { status: 'completed' }
  | { status: 'dismissed' }
  | { status: 'failed'; notice: string };

// react-native's Share resolves with { action: 'sharedAction' } when the
// content left the device and { action: 'dismissedAction' } when the sheet
// was dismissed without sharing.
export const SHARE_SHEET_SHARED_ACTION = 'sharedAction';
export const SHARE_SHEET_DISMISSED_ACTION = 'dismissedAction';

export const SHARE_FAILED_NOTICE =
  'The share did not complete. The document is still open in the reader.';

export function openFailedNotice(url: string): string {
  return `The website did not open. You can read this document at ${url}.`;
}

export type ShareSheetResolution =
  | { ok: true; action: string }
  | { ok: false; error: unknown };

export type OpenResolution = { ok: true } | { ok: false; url: string; error: unknown };

export function shareOutcome(resolution: ShareSheetResolution): LegalReaderOutcome {
  if (!resolution.ok) {
    return { status: 'failed', notice: SHARE_FAILED_NOTICE };
  }
  if (resolution.action === SHARE_SHEET_DISMISSED_ACTION) {
    return { status: 'dismissed' };
  }
  return { status: 'completed' };
}

export function openOutcome(resolution: OpenResolution): LegalReaderOutcome {
  if (!resolution.ok) {
    return { status: 'failed', notice: openFailedNotice(resolution.url) };
  }
  return { status: 'completed' };
}
