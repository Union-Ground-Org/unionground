export type AttachmentPickKind = 'document' | 'scan';

export const ATTACHMENT_PREPARING_MESSAGE = 'Preparing your attachment…';
export const ATTACHMENT_ADDING_MESSAGE = 'Adding your attachment…';
export const SCAN_PREPARING_MESSAGE = 'Preparing your scan…';
export const SCAN_ADDING_MESSAGE = 'Adding your scan…';
export const ATTACHMENT_DISCARDED_MESSAGE =
  'That attachment was discarded because this record changed. Choose the attachment again.';
export const SCAN_DISCARDED_MESSAGE =
  'That scan was discarded because this record changed. Scan the document again.';
export const ATTACHMENT_UPLOADED_MESSAGE = 'Attachment uploaded securely.';
export const SCAN_UPLOADED_MESSAGE = 'Scanned document uploaded securely.';
export const ATTACHMENT_UPLOAD_FAILED_MESSAGE = 'The attachment was not uploaded. Nothing was saved.';

// The photo re-encoder is a stage of its own, and on a mid-range device it is
// the slowest one. Naming it keeps a HEIC conversion from reading as a stall.
export const ATTACHMENT_CONVERTING_MESSAGE = 'Converting your photo to JPG on this device…';
export const SCAN_CONVERTING_MESSAGE = 'Re-encoding your scan on this device…';

// Staging copy. A selection now stops here, visible and named, until the member
// chooses to upload it, so the progress line must not claim it is being added.
export const ATTACHMENT_STAGING_MESSAGE = 'Preparing your attachment preview…';
export const SCAN_STAGING_MESSAGE = 'Preparing your scan preview…';
export const ATTACHMENT_STAGED_MESSAGE = 'Attachment ready. Check the name, then choose Upload attachment.';
export const SCAN_STAGED_MESSAGE = 'Scan ready. Check the name, then choose Upload attachment.';
export const ATTACHMENT_RELEASED_MESSAGE = 'Attachment discarded. Its temporary copy was deleted from this device.';
export const SCAN_RELEASED_MESSAGE = 'Scan discarded. Its temporary copy was deleted from this device.';

// Upload stages, driven by the service's own phase callback so the copy cannot
// drift out of step with what the upload is actually doing.
export const ATTACHMENT_UPLOAD_STARTING_MESSAGE = 'Preparing your attachment for upload…';
export const SCAN_UPLOAD_STARTING_MESSAGE = 'Preparing your scan for upload…';
export const ATTACHMENT_UPLOADING_MESSAGE = 'Uploading your attachment…';
export const SCAN_UPLOADING_MESSAGE = 'Uploading your scan…';
export const ATTACHMENT_CHECKING_MESSAGE = 'Checking this file for safety…';
export const ATTACHMENT_CONFIRMING_MESSAGE = 'Confirming the upload with this record…';

export type AttachmentSelectionResult =
  | { status: 'cancelled' }
  | { status: 'discarded'; message: string }
  | { status: 'staged'; message: string }
  | { status: 'uploaded'; message: string }
  | { status: 'failed'; error: unknown };

/** What the producer is doing between the picker closing and a staged candidate. */
export type AttachmentPreparePhase = 'preparing' | 'converting';

/** What the upload is doing, mirroring `AttachmentUploadPhase` in the service. */
export type AttachmentUploadStage = 'uploading' | 'checking' | 'confirming';

export function preparingMessage(kind: AttachmentPickKind): string {
  return kind === 'scan' ? SCAN_PREPARING_MESSAGE : ATTACHMENT_PREPARING_MESSAGE;
}

export function convertingMessage(kind: AttachmentPickKind): string {
  return kind === 'scan' ? SCAN_CONVERTING_MESSAGE : ATTACHMENT_CONVERTING_MESSAGE;
}

export function preparePhaseMessage(kind: AttachmentPickKind, phase: AttachmentPreparePhase): string {
  return phase === 'converting' ? convertingMessage(kind) : preparingMessage(kind);
}

export function addingMessage(kind: AttachmentPickKind): string {
  return kind === 'scan' ? SCAN_ADDING_MESSAGE : ATTACHMENT_ADDING_MESSAGE;
}

export function stagingMessage(kind: AttachmentPickKind): string {
  return kind === 'scan' ? SCAN_STAGING_MESSAGE : ATTACHMENT_STAGING_MESSAGE;
}

export function stagedMessage(kind: AttachmentPickKind): string {
  return kind === 'scan' ? SCAN_STAGED_MESSAGE : ATTACHMENT_STAGED_MESSAGE;
}

export function releasedMessage(kind: AttachmentPickKind): string {
  return kind === 'scan' ? SCAN_RELEASED_MESSAGE : ATTACHMENT_RELEASED_MESSAGE;
}

export function uploadStartingMessage(kind: AttachmentPickKind): string {
  return kind === 'scan' ? SCAN_UPLOAD_STARTING_MESSAGE : ATTACHMENT_UPLOAD_STARTING_MESSAGE;
}

export function uploadStageMessage(stage: AttachmentUploadStage, kind: AttachmentPickKind): string {
  if (stage === 'uploading') return kind === 'scan' ? SCAN_UPLOADING_MESSAGE : ATTACHMENT_UPLOADING_MESSAGE;
  if (stage === 'checking') return ATTACHMENT_CHECKING_MESSAGE;
  return ATTACHMENT_CONFIRMING_MESSAGE;
}

export function discardedMessage(kind: AttachmentPickKind): string {
  return kind === 'scan' ? SCAN_DISCARDED_MESSAGE : ATTACHMENT_DISCARDED_MESSAGE;
}

export function uploadedMessage(kind: AttachmentPickKind): string {
  return kind === 'scan' ? SCAN_UPLOADED_MESSAGE : ATTACHMENT_UPLOADED_MESSAGE;
}

/**
 * Discarded, staged and successful-upload copy may render and announce only
 * while the panel is still mounted. After unmount (deep link, notification) the
 * destination screen must not speak this record's notice.
 */
export function selectionFeedback(
  result: Extract<AttachmentSelectionResult, { status: 'discarded' | 'staged' | 'uploaded' }>,
  mounted: boolean,
): { notice: string | null; announcement: string | null } {
  return {
    notice: mounted ? result.message : null,
    announcement: mounted ? result.message : null,
  };
}

/**
 * Run one producer round trip under the caller's generation guard.
 *
 * `outcome` names what consuming the candidate accomplished. `'staged'` keeps
 * the candidate on the device under the member's control; `'uploaded'` is the
 * legacy single-step disposition, still used by callers that consume a
 * candidate directly. Cancellation, the generation-guarded discard, and the
 * failure funnel are identical for both.
 */
export async function runAttachmentSelection<TCandidate>(input: {
  kind: AttachmentPickKind;
  outcome?: 'staged' | 'uploaded';
  isMounted: () => boolean;
  pick: (onPreparing: (phase?: AttachmentPreparePhase) => void) => Promise<TCandidate | null>;
  consume: (candidate: TCandidate) => Promise<{ status: 'discarded' } | { status: 'uploaded'; value?: unknown }>;
  setProgress: (message: string) => void;
}): Promise<AttachmentSelectionResult> {
  const outcome = input.outcome ?? 'uploaded';
  try {
    const candidate = await input.pick((phase) => {
      if (input.isMounted()) input.setProgress(preparePhaseMessage(input.kind, phase ?? 'preparing'));
    });
    if (!candidate) return { status: 'cancelled' };
    if (input.isMounted()) {
      input.setProgress(outcome === 'staged' ? stagingMessage(input.kind) : addingMessage(input.kind));
    }
    const disposition = await input.consume(candidate);
    if (disposition.status === 'discarded') {
      return { status: 'discarded', message: discardedMessage(input.kind) };
    }
    return outcome === 'staged'
      ? { status: 'staged', message: stagedMessage(input.kind) }
      : { status: 'uploaded', message: uploadedMessage(input.kind) };
  } catch (error) {
    return { status: 'failed', error };
  }
}
