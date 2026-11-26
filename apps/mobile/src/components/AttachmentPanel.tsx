import { useApp } from '../state/AppProvider';
import { captureSessionWriter } from '../services/supabase';
import { useNativeUi } from '../lib/useNativeUi';
import { useBusinessOperation } from '../lib/useBusinessWriter';
import { Ionicons } from '@expo/vector-icons';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Alert, Image, Linking, StyleSheet, View } from 'react-native';
import { Text, TextInput } from './Text';

import type { TaskAttachmentFailure, TaskAttachmentProducerPhase } from '../lib/taskDocumentHandoff';
import { useAccessibilityAnnouncementQueue } from '../lib/announce';
import {
  ATTACHMENT_UPLOAD_FAILED_MESSAGE,
  discardedMessage,
  preparePhaseMessage,
  releasedMessage,
  runAttachmentSelection,
  selectionFeedback,
  uploadStageMessage,
  uploadStartingMessage,
  uploadedMessage,
  type AttachmentPickKind,
} from '../lib/attachmentPickLifecycle';
import {
  ATTACHMENT_FILENAME_LIMIT,
  ATTACHMENT_LIMIT_NOTICE,
  STAGED_CLEANUP_PENDING_MESSAGE,
  STAGED_CONVERTED_NOTE,
  STAGED_DOCUMENT_PREVIEW_NOTE,
  STAGED_TEXT_PREVIEW_TRUNCATED_NOTE,
  STAGED_TEXT_PREVIEW_UNAVAILABLE_NOTE,
  formatAttachmentBytes,
  splitStagedFilename,
  stagedFilename,
  stagedNameProblem,
  stagedPreviewKind,
  stagedSummary,
  type StagedTextPreview,
} from '../lib/attachmentStaging';
import {
  AttachmentError,
  AttachmentSelectionLifecycle,
  captureAuthorizedScan,
  cleanupAttachmentCandidate,
  copyStagedAttachmentCandidate,
  listAuthorizedAttachments,
  openAuthorizedAttachment,
  pickAuthorizedDocument,
  readStagedTextPreview,
  reconcileAuthorizedAttachmentUpload,
  recheckAuthorizedAttachment,
  removeAuthorizedAttachment,
  uploadAuthorizedAttachment,
  type AttachmentCandidate,
  type AttachmentTarget,
  type AttachmentUploadPhase,
  type AuthorizedAttachment,
} from '../services/attachments';
import { haptics } from '../services/haptics';
import { recordLifecycleEvent } from '../services/lifecycleDiagnostics';
import { useTheme } from '../theme/ThemeProvider';
import { minimumTouchTarget, radii, spacing } from '../theme/tokens';
import { Body, Button, Card, Heading, StateMessage } from './ui';

import { typeface } from '../theme/typeface';
/**
 * A file the member has chosen and can still see, name, and change their mind
 * about. Its bytes sit in the app-private attachment cache under an opaque
 * name; nothing has been sent anywhere yet.
 */
type StagedSelection = {
  /** The record this file was chosen for. A different record never inherits it. */
  targetKey: string;
  kind: AttachmentPickKind;
  candidate: AttachmentCandidate;
  /** The file's actual extension, preserved verbatim through a rename. */
  extension: string;
  /** True when the producer re-encoded the bytes on this device. */
  converted: boolean;
  preview: StagedTextPreview | null;
  pendingUploadID?: string;
};

export type DocumentPickerHandoff = {
  picking: boolean;
  kind?: AttachmentPickKind;
  scan?(): void;
  producerPhase?: TaskAttachmentProducerPhase | null;
  failure?: TaskAttachmentFailure | null;
  candidate: AttachmentCandidate | null;
  converted: boolean;
  choose(): void;
  take(candidate: AttachmentCandidate): boolean;
  discard(): void;
};

export function AttachmentPanel(props: {
  target: AttachmentTarget;
  canWrite: boolean;
  documentHandoff?: DocumentPickerHandoff;
  /** Called once after this panel attaches or removes a file (#9120). */
  onChanged?: () => void;
}) {
  const { session } = useApp();
  return <OwnedAttachmentPanel key={`${session?.user.id ?? 'signed-out'}:${props.target.kind}:${props.target.id}`} {...props} />;
}

function OwnedAttachmentPanel({ target, canWrite, documentHandoff, onChanged }: {
  target: AttachmentTarget;
  canWrite: boolean;
  documentHandoff?: DocumentPickerHandoff;
  /** Called once after this panel attaches or removes a file (#9120). */
  onChanged?: () => void;
}) {
  const { session } = useApp();
  const { t } = useNativeUi();
  const theme = useTheme();
  const queueAnnouncement = useAccessibilityAnnouncementQueue(`attachment:${target.kind}:${target.id}`);
  const mounted = useRef(true);
  const selectionLifecycleRef = useRef<AttachmentSelectionLifecycle | null>(null);
  if (!selectionLifecycleRef.current) selectionLifecycleRef.current = new AttachmentSelectionLifecycle();
  const selectionLifecycle = selectionLifecycleRef.current;
  selectionLifecycle.updateTarget(target);
  const targetKey = `${target.kind}:${target.id}`;
  const [attachments, setAttachments] = useState<AuthorizedAttachment[] | null>(null);
  const [busy, setBusy] = useState<'pick' | 'camera' | 'upload' | 'discard' | `check:${string}` | string | null>(null);
  const [runOperation] = useBusinessOperation<string | null>(setBusy, null);
  const listGeneration = useRef(0);
  const [needsRefresh, setNeedsRefresh] = useState(false);
  const acceptedRemovals = useRef(new Set<string>());
  const acceptedSelections = useRef(new WeakSet<StagedSelection>());
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  // A distinct in-progress line shown from the moment a selection resolves
  // until the upload settles. Without it the empty-list copy stays on screen
  // through the whole upload, which is exactly the silent surface the G6 drill
  // captured (BUG-UG-MOBILE-ATTACHMENT-UPLOAD-SILENT-FAILURE-20260905).
  const [progress, setProgress] = useState<string | null>(null);
  const [checking, setChecking] = useState(false);
  // A permanent refusal of these exact bytes: no retry is offered, because
  // repeating the same upload can only reach the same verdict.
  const [rejected, setRejected] = useState(false);
  // The opposite: a verdict that lapsed. One re-check can recover it, and the
  // attachment it applies to is remembered so exactly one inspection is issued.
  const [staleAttachmentID, setStaleAttachmentID] = useState<string | null>(null);
  const [cameraCanAskAgain, setCameraCanAskAgain] = useState(true);
  // The staged file, its member-edited name stem, and why that stem cannot be
  // used yet. The ref carries the same selection for the cleanup paths that run
  // after this component can no longer set state.
  const [staged, setStaged] = useState<StagedSelection | null>(null);
  const [stagedStem, setStagedStem] = useState('');
  const [nameProblem, setNameProblem] = useState<string | null>(null);
  const stagedRef = useRef<StagedSelection | null>(null);
  // A selection belongs to the record it was chosen for. Deriving it keeps a
  // target change from ever rendering a name whose bytes are already released.
  const activeStaged = canWrite && staged && staged.targetKey === targetKey ? staged : null;

  function isCurrentRequest(token: number) {
    return mounted.current && selectionLifecycle.capture() === token;
  }

  function beginAction() {
    setError(null);
    setNotice(null);
    setProgress(null);
    setChecking(false);
    setRejected(false);
    setStaleAttachmentID(null);
  }

  function reportFailure(nextError: unknown, fallback: string, attachmentID?: string) {
    clearIfAuthorizationChanged(nextError);
    const message = safeAttachmentMessage(nextError, fallback);
    if (mounted.current) {
      setError(message);
      if (nextError instanceof AttachmentError) {
        setRejected(nextError.rejected);
        setStaleAttachmentID(nextError.recheckable && attachmentID ? attachmentID : null);
      }
    }
    // Announcements stay generic: no filename, no object name, no scanner
    // detail ever reaches the accessibility channel.
    queueAnnouncement(message);
    void haptics.warning();
  }

  function uploadPhase(phase: AttachmentUploadPhase) {
    if (!mounted.current) return;
    setChecking(phase === 'checking');
    // The safety check keeps its own dedicated line below, so the stage line
    // never repeats it.
    setProgress(phase === 'checking' ? null : uploadStageMessage(phase, staged?.kind ?? 'document'));
  }

  /**
   * Delete a staged file's bytes from the app-private cache.
   *
   * The service keeps an unverified path queued for its next foreground pass,
   * so a false return means "not yet proven gone", not "lost". The ref is
   * cleared first: a double release is harmless, an unreleased one is not.
   */
  async function releaseStagedSelection(selection: StagedSelection): Promise<boolean> {
    if (stagedRef.current === selection) stagedRef.current = null;
    try {
      await cleanupAttachmentCandidate(selection.candidate);
      return true;
    } catch (error) {
      recordLifecycleEvent({
        scope: 'attachment-cache',
        step: 'cache-purge-failed',
        outcome: 'retained-cache-cleanup',
        error,
      });
      return false;
    }
  }

  function applyStagedSelection(selection: StagedSelection) {
    stagedRef.current = selection;
    setStaged(selection);
    setStagedStem(splitStagedFilename(selection.candidate.filename).stem);
    setNameProblem(null);
  }

  function forgetStagedSelection() {
    setStaged(null);
    setStagedStem('');
    setNameProblem(null);
  }

  // A SAF selection that ends back on the empty-list copy leaves no trace of
  // where it stopped: a remount, a discarded disposition, or a cancelled
  // picker all look identical in a hierarchy dump. Record the lifecycle so the
  // next drill can locate the exit point. Only generation counters, busy
  // states, and enumerated dispositions are recorded — never the filename, the
  // content URI, the preview, or the picker payload. Groundwork for
  // BUG-UG-MOBILE-ATTACHMENT-UPLOAD-SILENT-FAILURE-20260905; the rendering
  // this panel already does is unchanged.
  useEffect(() => {
    mounted.current = true;
    recordLifecycleEvent({ scope: 'attachment-selection', step: 'panel-mounted' });
    return () => {
      mounted.current = false;
      selectionLifecycle.invalidate();
      recordLifecycleEvent({ scope: 'attachment-selection', step: 'panel-unmounted' });
    };
  }, []);

  // Unmount and a target change end the same way: the staged bytes belong to
  // the record they were chosen for, so the private cache is cleaned before the
  // panel can show a different record. A late picker result is already covered
  // by the generation guard, which discards and cleans it instead of staging it.
  useEffect(() => {
    forgetStagedSelection();
    setNotice(null);
    setProgress(null);
    setChecking(false);
    setRejected(false);
    return () => {
      const selection = stagedRef.current;
      stagedRef.current = null;
      if (!selection) return;
      recordLifecycleEvent({
        scope: 'attachment-selection',
        step: 'consume',
        outcome: 'discarded',
        detail: { generation: selectionLifecycle.capture(), mounted: mounted.current },
      });
      void cleanupAttachmentCandidate(selection.candidate).catch((error: unknown) => {
        recordLifecycleEvent({
          scope: 'attachment-cache',
          step: 'cache-purge-failed',
          outcome: 'retained-cache-cleanup',
          error,
        });
      });
    };
  }, [targetKey]);

  useEffect(() => {
    if (canWrite) return;
    selectionLifecycle.invalidate();
    const selection = stagedRef.current;
    if (selection) void releaseStagedSelection(selection);
    forgetStagedSelection();
    setProgress(null);
    setChecking(false);
  }, [canWrite]);

  const loadAttachments = useCallback(async (writer: ReturnType<typeof captureSessionWriter>) => {
    const generation = ++listGeneration.current;
    const current = () => mounted.current && generation === listGeneration.current;
    try {
      if (await writer.check() !== 'current') throw new AttachmentError('load', 'Attachments could not be refreshed.');
      if (!current()) return;
      const rows = await listAuthorizedAttachments(target);
      const proof = await writer.check();
      if (!current()) return;
      if (proof !== 'current') throw new AttachmentError('load', 'Attachments could not be refreshed.');
      setAttachments(rows.filter(row => !acceptedRemovals.current.has(row.id)));
      setNeedsRefresh(false);
      setError(null);
    } catch (nextError) {
      if (current()) {
        documentHandoff?.discard();
        setNeedsRefresh(true);
        setError(safeAttachmentMessage(nextError, 'Attachments could not be refreshed.'));
      }
    }
  }, [target.id, target.kind]);
  const refresh = useCallback(async () => {
    await runOperation('refresh', async () => loadAttachments(captureSessionWriter(session)));
  }, [loadAttachments, runOperation, session]);
  useEffect(() => {
    void refresh();
    return () => { listGeneration.current += 1; };
  }, [target.id, target.kind]);

  // A task picker is owned above the protected subtree. Its result is offered
  // only after fresh staff scope, and is claimed only after this exact target's
  // attachment read succeeds. From here the usual generation/cleanup owns it.
  const returnedDocument = documentHandoff?.candidate ?? null;
  useEffect(() => {
    if (!returnedDocument || !documentHandoff || !canWrite || attachments === null || busy || activeStaged) return;
    const converted = documentHandoff.converted;
    const kind = documentHandoff.kind ?? 'document';
    if (!documentHandoff.take(returnedDocument)) return;
    const requestGeneration = selectionLifecycle.capture();
    const staging: { selection: StagedSelection | null } = { selection: null };
    void runOperation(kind === 'scan' ? 'camera' : 'pick', async () => {
    beginAction();
    try {
    const result = await runAttachmentSelection({
      kind, outcome: 'staged', isMounted: () => mounted.current,
      pick: async () => returnedDocument,
      consume: (candidate) => selectionLifecycle.consume(requestGeneration, candidate, async () => {
        staging.selection = await stageCandidate(kind, candidate, converted);
        return staging.selection;
      }),
      setProgress: (message) => { if (isCurrentRequest(requestGeneration)) setProgress(message); },
    });
    await finishSelection(kind, requestGeneration, result, staging.selection);
    } finally {
        if (isCurrentRequest(requestGeneration)) {
          setChecking(false);
          setProgress(null);
        }
    }
    });
  }, [returnedDocument, canWrite, attachments, busy, activeStaged, documentHandoff, selectionLifecycle]);

  const handoffFailure = documentHandoff?.failure;
  useEffect(() => {
    if (!handoffFailure) return;
    const reason = handoffFailure.reason;
    const message = reason === 'camera-denied-retry'
      ? 'Camera access was not granted. Choose Scan document to ask again.'
      : reason === 'camera-denied-settings'
        ? 'Camera access is off. Open system settings to allow document scanning.'
        : reason === 'scan' ? 'The scan could not be prepared. Choose Scan document again.'
          : 'That document could not be prepared. Choose the document again.';
    setCameraCanAskAgain(reason !== 'camera-denied-settings');
    setError(message);
    queueAnnouncement(message);
    void haptics.warning();
  }, [handoffFailure, queueAnnouncement]);

  const handoffPicking = documentHandoff?.picking === true;
  useEffect(() => { if (handoffPicking) { beginAction(); setCameraCanAskAgain(true); } }, [handoffPicking]);

  function clearIfAuthorizationChanged(nextError: unknown) {
    if (nextError instanceof AttachmentError && nextError.code === 'authorization') {
      // Authorization for this record is gone, so a staged file can never be
      // uploaded to it. Release the bytes rather than holding them for a retry
      // that cannot succeed.
      const selection = stagedRef.current;
      if (selection) void releaseStagedSelection(selection);
      if (mounted.current) {
        setAttachments([]);
        if (selection) forgetStagedSelection();
      }
    }
  }

  /**
   * Turn a resolved candidate into a staged selection.
   *
   * The bounded text window is read here, while the generation guard still
   * holds. Nothing else about the file is read, and a failure to build the
   * selection releases the candidate instead of orphaning it in the cache.
   */
  async function stageCandidate(
    kind: AttachmentPickKind,
    candidate: AttachmentCandidate,
    converted: boolean,
  ): Promise<StagedSelection> {
    try {
      return {
        targetKey,
        kind,
        candidate,
        extension: splitStagedFilename(candidate.filename).extension,
        converted,
        preview: await readStagedTextPreview(candidate),
      };
    } catch (error) {
      await cleanupAttachmentCandidate(candidate).catch(() => undefined);
      throw error;
    }
  }

  async function finishSelection(
    kind: AttachmentPickKind,
    requestGeneration: number,
    result: Awaited<ReturnType<typeof runAttachmentSelection>>,
    selection: StagedSelection | null,
  ) {
    if (result.status === 'cancelled') return;
    if (result.status === 'failed') {
      if (!isCurrentRequest(requestGeneration)) return;
      if (kind === 'document') {
        recordLifecycleEvent({
          scope: 'attachment-selection',
          step: 'failed',
          detail: { generation: requestGeneration, mounted: mounted.current },
          error: result.error,
        });
        reportFailure(result.error, ATTACHMENT_UPLOAD_FAILED_MESSAGE);
      } else {
        reportFailure(result.error, 'The scan was not uploaded. Nothing was saved.');
      }
      return;
    }
    const stillCurrent = isCurrentRequest(requestGeneration);
    // A selection this panel can no longer own must not survive as cache bytes.
    if (!stillCurrent && selection) await releaseStagedSelection(selection);
    const feedback = selectionFeedback(result, stillCurrent);
    if (feedback.notice) setNotice(feedback.notice);
    if (feedback.announcement) queueAnnouncement(feedback.announcement);
    if (stillCurrent && selection) {
      if (kind === 'scan') setCameraCanAskAgain(true);
      applyStagedSelection(selection);
      void haptics.success();
    }
  }

  async function chooseDocument() {
    if (!mounted.current) return;
    await runOperation('pick', async () => {
    if (!canWrite || busy || activeStaged) return;
    const requestGeneration = selectionLifecycle.capture();
    recordLifecycleEvent({
      scope: 'attachment-selection',
      step: 'capture',
      detail: { generation: requestGeneration },
    });

    recordLifecycleEvent({ scope: 'attachment-selection', step: 'busy-set', outcome: 'pick' });
    beginAction();
    setCameraCanAskAgain(true);
    const producer = { converted: false };
    const staging: { selection: StagedSelection | null } = { selection: null };
    try {
      const result = await runAttachmentSelection({
        kind: 'document',
        outcome: 'staged',
        isMounted: () => mounted.current,
        pick: async (onPreparing) => {
          const candidate = await pickAuthorizedDocument({
            onPhase: (phase) => {
              if (phase === 'converting') producer.converted = true;
              onPreparing(phase);
            },
          });
          recordLifecycleEvent({
            scope: 'attachment-selection',
            step: 'picker-result',
            outcome: candidate ? 'selected' : 'cancelled',
            detail: { generation: requestGeneration, mounted: mounted.current },
          });
          return candidate;
        },
        consume: async (candidate) => {
          const disposition = await selectionLifecycle.consume(
            requestGeneration,
            candidate,
            async () => {
              staging.selection = await stageCandidate('document', candidate, producer.converted);
              return staging.selection;
            },
          );
          recordLifecycleEvent({
            scope: 'attachment-selection',
            step: 'consume',
            outcome: disposition.status === 'discarded' ? 'discarded' : 'selected',
            detail: {
              generation: requestGeneration,
              currentGeneration: selectionLifecycle.capture(),
              mounted: mounted.current,
            },
          });
          return disposition;
        },
        setProgress: (message) => { if (isCurrentRequest(requestGeneration)) setProgress(message); },
      });
      await finishSelection('document', requestGeneration, result, staging.selection);
    } finally {
      if (isCurrentRequest(requestGeneration)) {

        setChecking(false);
        setProgress(null);
        recordLifecycleEvent({
          scope: 'attachment-selection',
          step: 'busy-cleared',
          detail: { generation: requestGeneration },
        });
      }
    }

    });
  }

  async function scanDocument() {
    if (!mounted.current) return;
    await runOperation('camera', async () => {
    if (!canWrite || busy || activeStaged) return;
    const requestGeneration = selectionLifecycle.capture();

    beginAction();
    const producer = { converted: false };
    const staging: { selection: StagedSelection | null } = { selection: null };
    try {
      const captured = await captureAuthorizedScan({
        onPhase: (phase) => {
          if (phase === 'converting') producer.converted = true;
          if (isCurrentRequest(requestGeneration)) setProgress(preparePhaseMessage('scan', phase));
        },
      });
      if (captured.status === 'cancelled') return;
      if (captured.status === 'permission-denied') {
        if (!isCurrentRequest(requestGeneration)) return;
        const message = captured.canAskAgain
          ? 'Camera access was not granted. Choose Scan document to ask again.'
          : 'Camera access is off. Open system settings to allow document scanning.';
        if (mounted.current) {
          setCameraCanAskAgain(captured.canAskAgain);
          setError(message);
        }
        queueAnnouncement(message);
        void haptics.warning();
        return;
      }
      const result = await runAttachmentSelection({
        kind: 'scan',
        outcome: 'staged',
        isMounted: () => mounted.current,
        pick: async () => captured.candidate,
        consume: (candidate) => selectionLifecycle.consume(
          requestGeneration,
          candidate,
          async () => {
            staging.selection = await stageCandidate('scan', candidate, producer.converted);
            return staging.selection;
          },
        ),
        setProgress: (message) => { if (isCurrentRequest(requestGeneration)) setProgress(message); },
      });
      await finishSelection('scan', requestGeneration, result, staging.selection);
    } catch (nextError) {
      if (isCurrentRequest(requestGeneration)) reportFailure(nextError, 'The scan was not uploaded. Nothing was saved.');
    } finally {
      if (isCurrentRequest(requestGeneration)) {

        setChecking(false);
        setProgress(null);
      }
    }

    });
  }

  function changeStagedStem(next: string) {
    const safe = next.normalize('NFC').replace(/\p{C}/gu, '');
    setStagedStem(safe);
    setNameProblem(activeStaged ? stagedNameProblem(safe, activeStaged.extension) : null);
  }

  /**
   * Upload the staged file under the name the member chose.
   *
   * The upload receives a per-attempt duplicate, because
   * `uploadAuthorizedAttachment` deletes the copy it is given before the safety
   * verdict lands — the ordering that lets a refusal roll a pending row back.
   * The staged original therefore survives a recoverable failure and can be
   * uploaded again without another picker round trip. A permanent refusal
   * releases it: retrying the same bytes can only reach the same verdict.
   */
  async function uploadStaged() {
    if (!mounted.current) return;
    await runOperation('upload', async () => {
    const writer = captureSessionWriter(session);
    const selection = activeStaged;
    if (!canWrite || !selection || busy || acceptedSelections.current.has(selection)) return;
    const problem = stagedNameProblem(stagedStem, selection.extension);
    if (problem) {
      setNameProblem(problem);
      queueAnnouncement(problem);
      void haptics.warning();
      return;
    }
    const requestGeneration = selectionLifecycle.capture();

    beginAction();
    setProgress(uploadStartingMessage(selection.kind));
    let accepted = false;
    try {
      if (selection.pendingUploadID) {
        setProgress('Checking the previous upload. No new copy is being uploaded.');
        setChecking(true);
        const result = await reconcileAuthorizedAttachmentUpload(target, selection.pendingUploadID, {
          writer,
          onPhase: (phase) => { if (isCurrentRequest(requestGeneration)) uploadPhase(phase); },
        });
        // The record changed even when the member has since left it, so the
        // change is reported from this attempt's own render before any
        // staleness check (#9120).
        if (result.status === 'confirmed') {
          accepted = true;
          acceptedSelections.current.add(selection);
          forgetStagedSelection();
          await onChanged?.();
          const released = await releaseStagedSelection(selection);
          const proof = await writer.check();
          if (!isCurrentRequest(requestGeneration)) return;
          if (proof === 'changed') return;
          setNotice(uploadedMessage(selection.kind));
          if (proof === 'unavailable') { setNeedsRefresh(true); setError(t('Refresh your account when your connection returns.')); return; }
          await loadAttachments(writer);
          if (!released) setError(STAGED_CLEANUP_PENDING_MESSAGE);
          return;
        }
        if (!isCurrentRequest(requestGeneration)) return;
        if (result.status === 'aborted') {
          const ready = { ...selection, pendingUploadID: undefined };
          stagedRef.current = ready;
          setStaged(ready);
          setNotice('The previous attempt was removed. Your file and name are ready to upload again.');
          return;
        }
        if (result.status === 'cleanup-queued') {
          const ready = { ...selection, pendingUploadID: undefined };
          stagedRef.current = ready;
          setStaged(ready);
          setNotice('The previous attempt was not attached, and its temporary upload is being removed. Your file and name are ready to upload again.');
          return;
        }
        if (result.status === 'rejected') {
          throw new AttachmentError('upload', 'This file was rejected by the safety check and was not attached.', { rejected: true });
        }
        throw new AttachmentError('cleanup', result.status === 'reauth-required'
          ? 'Verify it is you, then check the previous upload again.'
          : 'The previous upload still needs confirmation. Check its status again later.',
        { pendingUploadID: selection.pendingUploadID, reauthRequired: result.status === 'reauth-required' });
      }
      const uploadCandidate = await copyStagedAttachmentCandidate(
        selection.candidate,
        stagedFilename(stagedStem, selection.extension),
      );
      const disposition = await selectionLifecycle.consume(
        requestGeneration,
        uploadCandidate,
        () => uploadAuthorizedAttachment(target, uploadCandidate, {
          writer,
          onPhase: (phase) => { if (isCurrentRequest(requestGeneration)) uploadPhase(phase); },
        }),
      );
      recordLifecycleEvent({
        scope: 'attachment-selection',
        step: 'consume',
        outcome: disposition.status === 'discarded' ? 'discarded' : 'uploaded',
        detail: {
          generation: requestGeneration,
          currentGeneration: selectionLifecycle.capture(),
          mounted: mounted.current,
        },
      });
      accepted = disposition.status !== 'discarded';
      acceptedSelections.current.add(selection);
      forgetStagedSelection();
      if (accepted) await onChanged?.();
      const released = await releaseStagedSelection(selection);
      const proof = await writer.check();
      if (!isCurrentRequest(requestGeneration)) return;
      if (proof === 'changed') return;
      const message = disposition.status === 'discarded'
        ? discardedMessage(selection.kind)
        : uploadedMessage(selection.kind);
      if (mounted.current) {
        setNotice(message);
        if (proof === 'unavailable') { setNeedsRefresh(true); setError(t('Refresh your account when your connection returns.')); return; }
        if (disposition.status !== 'discarded') await loadAttachments(writer);
        if (!released) setError(STAGED_CLEANUP_PENDING_MESSAGE);
      }
      queueAnnouncement(message);
      if (disposition.status !== 'discarded') void haptics.success();
    } catch (nextError) {
      if (!isCurrentRequest(requestGeneration)) return;
      if (accepted) {
        await releaseStagedSelection(selection);
        setNeedsRefresh(true);
        setNotice(uploadedMessage(selection.kind));
        setError(t('The attachment was uploaded, but its list could not be refreshed. Refresh the record when your connection returns.'));
        return;
      }
      reportFailure(nextError, ATTACHMENT_UPLOAD_FAILED_MESSAGE);
      if (nextError instanceof AttachmentError && nextError.pendingUploadID) {
        const pending = { ...selection, pendingUploadID: nextError.pendingUploadID };
        stagedRef.current = pending;
        setStaged(pending);
      }
      if (nextError instanceof AttachmentError && (nextError.rejected || nextError.code === 'validation')) {
        await releaseStagedSelection(selection);
        if (mounted.current) forgetStagedSelection();
      }
    } finally {
      if (isCurrentRequest(requestGeneration)) {

        setChecking(false);
        setProgress(null);
      }
    }

    });
  }

  async function discardStaged() {
    if (!mounted.current) return;
    await runOperation('discard', async () => {
    const selection = activeStaged;
    if (!selection || busy) return;
    const requestGeneration = selectionLifecycle.capture();

    beginAction();
    const released = await releaseStagedSelection(selection);
    if (!isCurrentRequest(requestGeneration)) return;
    const message = released ? releasedMessage(selection.kind) : STAGED_CLEANUP_PENDING_MESSAGE;
    if (mounted.current) {
      if (released) {
        forgetStagedSelection();
        setNotice(message);
      } else {
        // Not proven gone, so the selection stays on screen and Discard can be
        // tried again; the service also retries it on the next foreground pass.
        stagedRef.current = selection;
        setError(message);
      }

    }
    queueAnnouncement(message);
    if (released) void haptics.success();
    else void haptics.warning();

    });
  }

  async function openFile(row: AuthorizedAttachment) {
    if (!mounted.current) return;
    await runOperation(`open:${row.id}`, async () => {
    const writer = captureSessionWriter(session);
    if (busy) return;

    beginAction();
    setCameraCanAskAgain(true);
    try {
      await openAuthorizedAttachment(target, row.id, writer);
    } catch (nextError) {
      // A lapsed verdict is recoverable, so the list must survive it; only an
      // authorization change clears the rows.
      clearIfAuthorizationChanged(nextError);
      reportFailure(nextError, 'The attachment could not be opened securely.', row.id);
    }

    });
  }

  async function recheckFile(attachmentID: string) {
    if (!mounted.current) return;
    await runOperation(`check:${attachmentID}`, async () => {
    const writer = captureSessionWriter(session);
    if (busy) return;

    setNotice(null);
    setChecking(true);
    // The error and its stale marker deliberately stay on screen while the
    // re-check runs, so the button that started it keeps its place and its busy
    // state instead of vanishing under the member's finger.
    try {
      await recheckAuthorizedAttachment(target, attachmentID, writer);
      setStaleAttachmentID(null);
      const ownership = await writer.check();
      if (!mounted.current || ownership === 'changed') return;
      if (ownership === 'unavailable') {
        setNeedsRefresh(true);
        reportFailure(new AttachmentError('load', t('The safety check finished, but authorization could not be verified. Refresh the record when your connection returns.')), 'Refresh the attachment list.');
        return;
      }
      const message = 'This file passed its safety check. Open it again.';
      if (mounted.current) {
        setError(null);
        setStaleAttachmentID(null);
        setNotice(message);
      }
      queueAnnouncement(message);
      void haptics.success();
    } catch (nextError) {
      reportFailure(nextError, 'The safety check could not be completed.', attachmentID);
    } finally {
      if (mounted.current) {

        setChecking(false);
      }
    }

    });
  }

  async function removeFile(row: AuthorizedAttachment) {
    if (!mounted.current || acceptedRemovals.current.has(row.id)) return;
    await runOperation(`remove:${row.id}`, async () => {
    const writer = captureSessionWriter(session);
    if (busy) return;

    beginAction();
    setCameraCanAskAgain(true);
    let accepted = false;
    try {
      await removeAuthorizedAttachment(target, row.id, writer);
      accepted = true;
      acceptedRemovals.current.add(row.id);
      setAttachments(previous => previous?.filter(item => item.id !== row.id) ?? null);
      await onChanged?.();
      const ownership = await writer.check();
      if (!mounted.current || ownership === 'changed') return;
      if (ownership === 'unavailable') {
        setNeedsRefresh(true);
        reportFailure(new AttachmentError('load', t('The attachment was removed, but its list could not be refreshed. Refresh the record when your connection returns.')), 'Refresh the attachment list.');
        return;
      }
      const message = 'Attachment removed.';
      if (mounted.current) {
        setNotice(message);
        await loadAttachments(writer);
      }
      queueAnnouncement(message);
      void haptics.success();
    } catch (nextError) {
      if (accepted) {
        setNeedsRefresh(true);
        reportFailure(new AttachmentError('load', t('The attachment was removed, but its list could not be refreshed. Refresh the record when your connection returns.')), 'Refresh the attachment list.');
        return;
      }
      reportFailure(nextError, 'The attachment could not be removed securely.');
    }

    });
  }

  function confirmRemoval(row: AuthorizedAttachment) {
    Alert.alert(
      'Remove attachment?',
      'This deletes the file from the private record. This action cannot be undone.',
      [
        { text: 'Cancel', style: 'cancel' },
        { text: 'Remove', style: 'destructive', onPress: () => { void removeFile(row); } },
      ],
    );
  }

  async function openCameraSettings() {
    try {
      await Linking.openSettings();
    } catch {
      const message = 'System settings could not be opened. Enable camera access from this device’s app settings.';
      if (mounted.current) setError(message);
      queueAnnouncement(message);
    }
  }

  const visibleProgress = progress ?? (documentHandoff?.picking && documentHandoff.producerPhase
    ? preparePhaseMessage(documentHandoff.kind ?? 'document', documentHandoff.producerPhase) : null);
  const stagedKind = activeStaged ? stagedPreviewKind(activeStaged.candidate.mimeType) : null;

  return (
    <Card>
      <View style={styles.header}>
        <View style={styles.headingCopy}>
          <Heading level={3}>Attachments</Heading>
          <Body muted>Only people who can open this record can open its files. Camera scans are converted to a standard image before upload.</Body>
        </View>
        <View style={[styles.lock, { backgroundColor: theme.secondary }]}>
          <Ionicons name="lock-closed" size={16} color={theme.secondaryForeground} accessibilityElementsHidden />
        </View>
      </View>

      {canWrite ? (
        <>
          {/* The ceiling and the format list are stated before the picker opens,
              not discovered from a refusal after a file has been chosen. */}
          <Body muted>{ATTACHMENT_LIMIT_NOTICE}</Body>
          {activeStaged ? null : (
            <View style={styles.actions}>
              <Button
                label="Choose document"
                variant="secondary"
                busy={busy === 'pick' || (documentHandoff?.picking === true && documentHandoff.kind !== 'scan')}
                disabled={(busy !== null && busy !== 'pick') || (documentHandoff?.picking === true && documentHandoff.kind === 'scan')}
                icon={<Ionicons name="document-attach-outline" size={18} color={theme.secondaryForeground} accessibilityElementsHidden />}
                onPress={() => { if (documentHandoff) documentHandoff.choose(); else void chooseDocument(); }}
              />
              <Button
                label="Scan document"
                variant="secondary"
                busy={busy === 'camera' || (documentHandoff?.picking === true && documentHandoff.kind === 'scan')}
                disabled={(busy !== null && busy !== 'camera') || documentHandoff?.picking === true}
                icon={<Ionicons name="camera-outline" size={18} color={theme.secondaryForeground} accessibilityElementsHidden />}
                onPress={() => { if (documentHandoff?.scan) documentHandoff.scan(); else void scanDocument(); }}
              />
            </View>
          )}
        </>
      ) : (
        <Body muted>You can open these files, but your current role cannot add or remove them.</Body>
      )}

      {visibleProgress ? (
        <Text style={[styles.messageText, { color: theme.primary }]} accessibilityLiveRegion="polite">
          {visibleProgress}
        </Text>
      ) : null}

      {checking ? (
        <Text style={[styles.messageText, { color: theme.mutedForeground }]} accessibilityLiveRegion="polite">
          Checking this file for safety…
        </Text>
      ) : null}

      {error ? (
        <View style={[styles.message, { borderColor: theme.destructive }]} accessibilityLiveRegion="assertive">
          <Text style={[styles.messageText, { color: theme.destructive }]}>{error}</Text>
          {!cameraCanAskAgain ? <Button label="Open camera settings" variant="secondary" onPress={() => { void openCameraSettings(); }} /> : null}
          {staleAttachmentID ? (
            <Button
              label="Re-check this file"
              variant="secondary"
              busy={busy === `check:${staleAttachmentID}`}
              disabled={busy !== null && busy !== `check:${staleAttachmentID}`}
              onPress={() => { void recheckFile(staleAttachmentID); }}
            />
          ) : null}
        </View>
      ) : null}
      {notice ? <Text style={[styles.messageText, { color: theme.primary }]} accessibilityLiveRegion="polite">{notice}</Text> : null}
      <Button label={busy === 'refresh' ? t('Refreshing attachments…') : t('Refresh attachments')} variant="secondary" disabled={busy !== null} onPress={() => { void refresh(); }} />

      {activeStaged ? (
        <View style={[styles.staged, { borderColor: theme.border, backgroundColor: theme.muted }]}>
          <Heading level={3}>Ready to upload</Heading>
          {activeStaged.pendingUploadID ? <Body muted>A previous upload still needs confirmation. Checking its status sends no new copy. Discard removes only this device's selection; it does not cancel that upload.</Body> : null}
          {/* The preview reads the app-private cache copy on this device. No
              remote URL, no preview service, and no upload has happened yet. */}
          {stagedKind === 'image' ? (
            <Image
              source={{ uri: activeStaged.candidate.uri }}
              style={[styles.preview, { borderColor: theme.border, backgroundColor: theme.card }]}
              resizeMode="contain"
              accessible
              accessibilityLabel="Preview of the file you selected"
              accessibilityIgnoresInvertColors
            />
          ) : null}
          {stagedKind === 'text' ? (
            activeStaged.preview ? (
              <View style={[styles.textPreview, { borderColor: theme.border, backgroundColor: theme.card }]}>
                <Text
                  style={[styles.textPreviewBody, { color: theme.foreground }]}
                  accessibilityLabel="Beginning of the file you selected"
                >
                  {activeStaged.preview.text}
                </Text>
                {activeStaged.preview.truncated ? (
                  <Text style={[styles.metadata, { color: theme.mutedForeground }]}>{STAGED_TEXT_PREVIEW_TRUNCATED_NOTE}</Text>
                ) : null}
              </View>
            ) : <Body muted>{STAGED_TEXT_PREVIEW_UNAVAILABLE_NOTE}</Body>
          ) : null}
          {stagedKind === 'document' ? <Body muted>{STAGED_DOCUMENT_PREVIEW_NOTE}</Body> : null}
          <Text style={[styles.metadata, { color: theme.mutedForeground }]}>
            {stagedSummary(activeStaged.candidate.mimeType, activeStaged.candidate.sizeBytes)}
          </Text>
          {activeStaged.converted ? (
            <Text style={[styles.metadata, { color: theme.mutedForeground }]}>{STAGED_CONVERTED_NOTE}</Text>
          ) : null}

          <Text style={[styles.fieldLabel, { color: theme.foreground }]}>File name</Text>
          <View style={styles.nameRow}>
            <TextInput
              accessibilityLabel="File name, without its extension"
              keyboardAppearance={theme.appearance}
              maxLength={ATTACHMENT_FILENAME_LIMIT}
              value={stagedStem}
              onChangeText={changeStagedStem}
              editable={busy === null && !activeStaged.pendingUploadID}
              autoCapitalize="none"
              autoCorrect={false}
              style={[styles.nameInput, { color: theme.foreground, backgroundColor: theme.input, borderColor: theme.border }]}
            />
            {/* The real extension is shown and kept; only the stem is editable,
                so a rename can never change what kind of file this is. */}
            <Text
              style={[styles.extension, { color: theme.mutedForeground }]}
              accessibilityLabel="File extension, kept as it is"
            >
              {extensionLabel(activeStaged.extension)}
            </Text>
          </View>
          {nameProblem ? (
            <Text style={[styles.messageText, { color: theme.destructive }]} accessibilityLiveRegion="polite">{nameProblem}</Text>
          ) : null}

          <View style={styles.actions}>
            <Button
              label={activeStaged.pendingUploadID ? 'Check upload status' : 'Upload attachment'}
              busy={busy === 'upload'}
              disabled={nameProblem !== null || (busy !== null && busy !== 'upload')}
              onPress={() => { void uploadStaged(); }}
            />
            <Button
              label="Discard selection"
              variant="secondary"
              busy={busy === 'discard'}
              disabled={busy !== null && busy !== 'discard'}
              onPress={() => { void discardStaged(); }}
            />
          </View>
        </View>
      ) : null}

      {attachments === null && !error ? (
        <StateMessage title="Loading attachments" body="Rechecking this record and its private file list." />
      ) : attachments?.length === 0 ? (
        // While a resolved selection is uploading, the empty-list copy would
        // read as "nothing happened" — the exact silent failure this panel must
        // not reproduce — so only the progress line renders.
        visibleProgress || checking ? null : <Body muted>No attachments yet.</Body>
      ) : attachments?.map((row) => (
        <View key={row.id} style={[styles.file, { borderColor: theme.border, backgroundColor: theme.muted }]}>
          <View style={styles.fileCopy}>
            <Text style={[styles.filename, { color: theme.foreground }]}>{row.filename}</Text>
            <Text style={[styles.metadata, { color: theme.mutedForeground }]}>{formatAttachmentBytes(row.sizeBytes)} · {formatDate(row.createdAt)}</Text>
          </View>
          <View style={styles.actions}>
            <Button
              label="Open securely"
              accessibilityLabel={`Open securely: ${row.filename}`}
              variant="secondary"
              busy={busy === `open:${row.id}`}
              disabled={needsRefresh || busy !== null && busy !== `open:${row.id}`}
              onPress={() => { void openFile(row); }}
            />
            {canWrite ? (
              <Button
                label="Remove file"
                accessibilityLabel={`Remove file: ${row.filename}`}
                variant="danger"
                busy={busy === `remove:${row.id}`}
                disabled={needsRefresh || busy !== null && busy !== `remove:${row.id}`}
                onPress={() => confirmRemoval(row)}
              />
            ) : null}
          </View>
        </View>
      ))}
    </Card>
  );
}

function safeAttachmentMessage(error: unknown, fallback: string): string {
  return error instanceof AttachmentError ? error.message : fallback;
}

function extensionLabel(extension: string): string {
  return extension ? stagedFilename('', extension) : '';
}

function formatDate(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? 'Uploaded' : date.toLocaleDateString();
}

const styles = StyleSheet.create({
  header: { flexDirection: 'row', alignItems: 'flex-start', gap: spacing.md },
  headingCopy: { flex: 1, gap: spacing.xs },
  lock: { width: 36, height: 36, borderRadius: 18, alignItems: 'center', justifyContent: 'center' },
  actions: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm },
  message: { gap: spacing.sm, borderLeftWidth: 3, paddingLeft: spacing.md },
  messageText: { fontSize: 14, lineHeight: 20, ...typeface.controlStrong },
  file: { gap: spacing.sm, borderWidth: StyleSheet.hairlineWidth, borderRadius: radii.md, padding: spacing.md },
  fileCopy: { gap: spacing.xs },
  filename: { fontSize: 15, lineHeight: 21, ...typeface.controlStrong },
  metadata: { fontSize: 12, lineHeight: 17, ...typeface.control },
  staged: { gap: spacing.sm, borderWidth: StyleSheet.hairlineWidth, borderRadius: radii.md, padding: spacing.md },
  preview: { width: '100%', height: 180, borderRadius: radii.md, borderWidth: StyleSheet.hairlineWidth },
  textPreview: { gap: spacing.xs, borderWidth: StyleSheet.hairlineWidth, borderRadius: radii.md, padding: spacing.sm },
  textPreviewBody: { fontSize: 13, lineHeight: 19, ...typeface.bodyMedium },
  fieldLabel: { fontSize: 13, lineHeight: 18, ...typeface.controlStrong },
  nameRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  nameInput: {
    flex: 1,
    minHeight: minimumTouchTarget,
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: radii.md,
    paddingHorizontal: spacing.md,
    fontSize: 16,
  },
  extension: { fontSize: 15, lineHeight: 21, ...typeface.controlStrong },
});
