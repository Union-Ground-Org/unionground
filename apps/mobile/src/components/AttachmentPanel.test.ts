import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import {
  ATTACHMENT_ADDING_MESSAGE,
  ATTACHMENT_DISCARDED_MESSAGE,
  ATTACHMENT_PREPARING_MESSAGE,
  ATTACHMENT_STAGED_MESSAGE,
  ATTACHMENT_STAGING_MESSAGE,
  ATTACHMENT_UPLOAD_FAILED_MESSAGE,
  ATTACHMENT_UPLOADED_MESSAGE,
  SCAN_STAGED_MESSAGE,
  preparePhaseMessage,
  releasedMessage,
  runAttachmentSelection,
  selectionFeedback,
  uploadStageMessage,
  type AttachmentSelectionResult,
  type AttachmentUploadStage,
} from '../lib/attachmentPickLifecycle';
import {
  ATTACHMENT_FILENAME_LIMIT,
  ATTACHMENT_LIMIT_NOTICE,
  ATTACHMENT_UPLOAD_CEILING_BYTES,
  STAGED_FORMAT_EXTENSIONS,
  boundedTextPreview,
  formatAttachmentBytes,
  splitStagedFilename,
  stagedFilename,
  stagedNameProblem,
  stagedPreviewKind,
  stagedSummary,
} from '../lib/attachmentStaging';

// The mobile lane ships no React renderer (no react-test-renderer, no
// @testing-library/react-native, no DOM environment), so the selection
// lifecycle is extracted and executed here. Remaining panel anatomy contracts
// stay as source assertions, in the same style as chromeContract.test.ts.

const panel = readFileSync(fileURLToPath(new URL('./AttachmentPanel.tsx', import.meta.url)), 'utf8');
const service = readFileSync(fileURLToPath(new URL('../services/attachments.ts', import.meta.url)), 'utf8');

const candidate = { uri: 'file:///cache/doc.pdf' };

describe('attachment selection lifecycle', () => {
  it('shows preparing progress as soon as the picker supplies an asset, before upload starts', async () => {
    const progress: string[] = [];
    let consumeStarted = false;
    let releasePrepare: (() => void) | undefined;
    const prepared = new Promise<void>((resolve) => { releasePrepare = resolve; });

    const running = runAttachmentSelection({
      kind: 'document',
      isMounted: () => true,
      pick: async (onPreparing) => {
        onPreparing();
        expect(progress).toEqual([ATTACHMENT_PREPARING_MESSAGE]);
        expect(consumeStarted).toBe(false);
        await prepared;
        return candidate;
      },
      consume: async (): Promise<{ status: 'uploaded' }> => {
        consumeStarted = true;
        return { status: 'uploaded' };
      },
      setProgress: (message) => { progress.push(message); },
    });

    expect(progress).toEqual([ATTACHMENT_PREPARING_MESSAGE]);
    expect(consumeStarted).toBe(false);
    releasePrepare?.();
    const result = await running;
    expect(progress).toEqual([ATTACHMENT_PREPARING_MESSAGE, ATTACHMENT_ADDING_MESSAGE]);
    expect(result).toEqual({ status: 'uploaded', message: ATTACHMENT_UPLOADED_MESSAGE });
  });

  it('surfaces a begin-upload rejection as a failed result instead of returning to the empty list', async () => {
    const progress: string[] = [];
    const error = Object.assign(new Error('This record no longer accepts attachments through your current authorization.'), {
      name: 'AttachmentError',
      code: 'authorization',
    });
    const result = await runAttachmentSelection({
      kind: 'document',
      isMounted: () => true,
      pick: async (onPreparing) => {
        onPreparing();
        return candidate;
      },
      consume: async () => {
        throw error;
      },
      setProgress: (message) => { progress.push(message); },
    });

    expect(progress).toEqual([ATTACHMENT_PREPARING_MESSAGE, ATTACHMENT_ADDING_MESSAGE]);
    expect(result).toEqual({ status: 'failed', error });
    expect(result.status === 'failed' ? (result.error as Error).message : '').toMatch(/no longer accepts attachments/);
    expect(ATTACHMENT_UPLOAD_FAILED_MESSAGE).toContain('not uploaded');
    expect(panel).toContain("t('Refresh attachments')");
    expect(service).toContain("throw new AttachmentError('authorization', 'This record no longer accepts attachments through your current authorization.');");
  });

  it('leaves a visible discarded notice while mounted and suppresses the announcement after unmount', async () => {
    const result = await runAttachmentSelection({
      kind: 'document',
      isMounted: () => false,
      pick: async (onPreparing) => {
        onPreparing();
        return candidate;
      },
      consume: async (): Promise<{ status: 'discarded' }> => ({ status: 'discarded' }),
      setProgress: () => {
        throw new Error('unmounted panel must not write progress');
      },
    });

    expect(result).toEqual({ status: 'discarded', message: ATTACHMENT_DISCARDED_MESSAGE });
    expect(selectionFeedback(result.status === 'discarded' ? result : { status: 'discarded', message: '' }, true))
      .toEqual({ notice: ATTACHMENT_DISCARDED_MESSAGE, announcement: ATTACHMENT_DISCARDED_MESSAGE });
    expect(selectionFeedback(result.status === 'discarded' ? result : { status: 'discarded', message: '' }, false))
      .toEqual({ notice: null, announcement: null });
    expect(panel).toContain('selectionFeedback(result, stillCurrent)');
    expect(panel).toContain('if (feedback.announcement) queueAnnouncement(feedback.announcement)');
  });
});

describe('attachment panel safety-check states', () => {
  it('shows an explicit checking phase driven by the upload itself', () => {
    // The phase comes from uploadAuthorizedAttachment, so the copy cannot drift
    // out of step with when the inspection actually runs.
    expect(service).toContain("export type AttachmentUploadPhase = 'uploading' | 'checking' | 'confirming';");
    expect(service).toContain("notifyPhase(options.onPhase, 'checking');");
    expect(service).toContain("notifyPhase(options.onPhase, 'confirming');");
    expect(panel).toContain('function uploadPhase(phase: AttachmentUploadPhase)');
    expect(panel).toContain("setChecking(phase === 'checking')");
    // Exactly one upload call site now: the explicit upload step, fed the
    // per-attempt duplicate of the staged file.
    expect(panel).toContain('onPhase: (phase) => { if (isCurrentRequest(requestGeneration)) uploadPhase(phase); }');
    expect((panel.match(/uploadAuthorizedAttachment\(/g) ?? [])).toHaveLength(1);
    expect(panel).toContain('Checking this file for safety');
    // The checking notice is polite, not assertive: it is progress, not an error.
    expect(panel).toMatch(/Checking this file for safety[\s\S]{0,80}accessibilityLiveRegion="polite"|accessibilityLiveRegion="polite"[\s\S]{0,120}Checking this file for safety/);
  });

  it('names every upload stage the worker waits through, from the service phases', () => {
    // The stage copy is a pure function of the service's own phase, and every
    // phase in the service union has a line: a stage the upload reports but the
    // panel cannot name would be a silent wait.
    const stages: AttachmentUploadStage[] = ['uploading', 'checking', 'confirming'];
    for (const phase of stages) {
      expect(uploadStageMessage(phase, 'document').length).toBeGreaterThan(0);
      expect(uploadStageMessage(phase, 'scan').length).toBeGreaterThan(0);
    }
    expect(uploadStageMessage('checking', 'document')).toBe('Checking this file for safety…');
    expect(uploadStageMessage('uploading', 'scan')).not.toBe(uploadStageMessage('uploading', 'document'));
    expect(uploadStageMessage('confirming', 'document')).toMatch(/confirming/i);
    // Conversion is a producer stage rather than an upload stage, and it is
    // named separately for each producer.
    expect(preparePhaseMessage('document', 'converting')).toMatch(/converting/i);
    expect(preparePhaseMessage('scan', 'converting')).not.toBe(preparePhaseMessage('document', 'converting'));
    expect(preparePhaseMessage('document', 'preparing')).toBe(ATTACHMENT_PREPARING_MESSAGE);
    // The panel drives the stage line from the service phase and the staged
    // kind, and keeps the safety-check line as its own dedicated region.
    expect(panel).toContain("setProgress(phase === 'checking' ? null : uploadStageMessage(phase, staged?.kind ?? 'document'))");
    expect(panel).toContain('setProgress(uploadStartingMessage(selection.kind))');
    expect(panel).toContain("if (phase === 'converting') producer.converted = true;");
  });

  it('renders a permanent rejection with only a read-only refresh affordance', () => {
    expect(service).toContain("'This file was rejected by the safety check and was not attached.',");
    expect(service).toContain('{ rejected: true }');
    expect(panel).toContain('setRejected(nextError.rejected)');
    // A refusal is about these exact bytes; re-running the same request can only
    // reach the same verdict. Refresh only reads the list; re-check stays absent.
    expect(panel).toContain("t('Refresh attachments')");
    expect(panel).toContain('nextError.recheckable && attachmentID ? attachmentID : null');
  });

  it('offers exactly one re-check for a lapsed verdict and keeps the list intact', () => {
    expect(panel).toContain('async function recheckFile(attachmentID: string)');
    expect(panel).toContain('await runOperation(`check:${attachmentID}`');
    expect(panel).toContain('await recheckAuthorizedAttachment(target, attachmentID, writer);');
    expect(panel).toContain('busy={busy === `check:${staleAttachmentID}`}');
    // One tap, one inspection: the guard refuses a second call while the first
    // is in flight, and the button is disabled for every other busy state.
    expect(panel).toMatch(/async function recheckFile[\s\S]*?await runOperation\(`check:\$\{attachmentID\}`[\s\S]*?if \(busy\) return;/);
    expect(panel).toContain('disabled={busy !== null && busy !== `check:${staleAttachmentID}`}');
    // The affordance survives its own in-flight request, so the busy state is
    // actually reachable rather than unmounting on the first tap.
    expect(panel).toMatch(/async function recheckFile[\s\S]{0,1200}setStaleAttachmentID\(null\);/);
    expect((panel.match(/recheckAuthorizedAttachment\(/g) ?? [])).toHaveLength(1);
    // A recoverable verdict must not wipe the rows the member is looking at.
    expect(panel).toMatch(/async function openFile[\s\S]*?catch \(nextError\) \{[\s\S]*?clearIfAuthorizationChanged\(nextError\);/);
    expect(panel).toContain("nextError.code === 'authorization'");
  });

  it('keeps every announcement free of the filename and of scanner detail', () => {
    expect(panel).toContain('queueAnnouncement(message)');
    // Only safeAttachmentMessage-derived copy is announced, and no announcement
    // interpolates a row, a filename, an object name or an error code.
    expect(panel).not.toMatch(/queueAnnouncement\([^)]*(?:filename|row\.|objectName|code)/);
    // Control names may identify the file; passive outcome announcements stay generic.
    expect(panel).not.toMatch(/(?:const|let) message\s*=\s*`[^`]*\$\{[^}]*filename[^}]*\}[^`]*`/);
    for (const message of [
      'This file was rejected by the safety check and was not attached.',
      'This file needs a fresh safety check before it can be opened.',
      'The safety check could not be completed. Try again.',
    ]) {
      expect(service).toContain(message);
      expect(message).not.toMatch(/clamav|signature|sha256|bucket|object/i);
    }
  });
});

describe('staged selection, then an explicit upload', () => {
  it('walks preparing, converting and staging, and stops at a named staged file', async () => {
    const progress: string[] = [];

    const result = await runAttachmentSelection({
      kind: 'document',
      outcome: 'staged',
      isMounted: () => true,
      pick: async (onPreparing) => {
        onPreparing();
        onPreparing('converting');
        return candidate;
      },
      consume: async (): Promise<{ status: 'uploaded' }> => ({ status: 'uploaded' }),
      setProgress: (message) => { progress.push(message); },
    });

    // Three named stages before anything leaves the device, and no upload at all.
    expect(progress).toEqual([
      ATTACHMENT_PREPARING_MESSAGE,
      preparePhaseMessage('document', 'converting'),
      ATTACHMENT_STAGING_MESSAGE,
    ]);
    expect(progress).not.toContain(ATTACHMENT_ADDING_MESSAGE);
    expect(result).toEqual({ status: 'staged', message: ATTACHMENT_STAGED_MESSAGE });
    // The staged copy tells the member what happens next; it never claims the
    // file was uploaded.
    expect(ATTACHMENT_STAGED_MESSAGE).toContain('Upload attachment');
    expect(ATTACHMENT_STAGED_MESSAGE).not.toMatch(/uploaded/i);
    expect(SCAN_STAGED_MESSAGE).not.toBe(ATTACHMENT_STAGED_MESSAGE);
  });

  it('keeps the single-step disposition available for callers that consume a candidate directly', async () => {
    const result = await runAttachmentSelection({
      kind: 'document',
      isMounted: () => true,
      pick: async (onPreparing) => { onPreparing(); return candidate; },
      consume: async (): Promise<{ status: 'uploaded' }> => ({ status: 'uploaded' }),
      setProgress: () => undefined,
    });
    expect(result).toEqual({ status: 'uploaded', message: ATTACHMENT_UPLOADED_MESSAGE });
  });

  it('discards a staged candidate whose record changed while the picker was open', async () => {
    // The generation guard is the same one the single-step upload used, so a
    // late picker result is released rather than staged against a new record.
    const cleaned: string[] = [];
    const result = await runAttachmentSelection({
      kind: 'document',
      outcome: 'staged',
      isMounted: () => true,
      pick: async (onPreparing) => { onPreparing(); return candidate; },
      consume: async (late): Promise<{ status: 'discarded' }> => {
        cleaned.push(late.uri);
        return { status: 'discarded' };
      },
      setProgress: () => undefined,
    });

    expect(cleaned).toEqual([candidate.uri]);
    expect(result).toEqual({ status: 'discarded', message: ATTACHMENT_DISCARDED_MESSAGE });
    expect(selectionFeedback(result.status === 'discarded' ? result : { status: 'discarded', message: '' }, true).notice)
      .toBe(ATTACHMENT_DISCARDED_MESSAGE);
  });

  it('says nothing on a destination screen when the panel is gone before staging settles', async () => {
    const staged: Extract<AttachmentSelectionResult, { status: 'staged' }> = {
      status: 'staged',
      message: ATTACHMENT_STAGED_MESSAGE,
    };
    expect(selectionFeedback(staged, true))
      .toEqual({ notice: ATTACHMENT_STAGED_MESSAGE, announcement: ATTACHMENT_STAGED_MESSAGE });
    expect(selectionFeedback(staged, false)).toEqual({ notice: null, announcement: null });
    // And the panel releases what it can no longer own instead of leaving bytes.
    expect(panel).toContain('if (!stillCurrent && selection) await releaseStagedSelection(selection);');
  });

  it('renames only the stem when the worker edits the staged name', () => {
    const picked = 'IMG_0042.JPG';
    const parts = splitStagedFilename(picked);
    expect(stagedNameProblem('Grievance photo', parts.extension)).toBeNull();
    expect(stagedFilename('Grievance photo', parts.extension)).toBe('Grievance photo.JPG');
    // The panel asks the service for the same join, and the service revalidates
    // it, so the rename cannot change the file kind.
    expect(panel).toContain('stagedFilename(stagedStem, selection.extension)');
    expect(service).toMatch(/copyStagedAttachmentCandidate\([\s\S]{0,900}?const requested = validateAttachmentCandidate\(\{/);
    expect(panel).toContain('maxLength={ATTACHMENT_FILENAME_LIMIT}');
    expect(ATTACHMENT_FILENAME_LIMIT).toBe(160);
  });

  it('states the ceiling and the formats above the picker buttons, not after a refusal', () => {
    const noticeAt = panel.indexOf('{ATTACHMENT_LIMIT_NOTICE}');
    const chooseAt = panel.indexOf('label="Choose document"');
    const scanAt = panel.indexOf('label="Scan document"');
    expect(noticeAt).toBeGreaterThan(-1);
    expect(noticeAt).toBeLessThan(chooseAt);
    expect(noticeAt).toBeLessThan(scanAt);
    expect(ATTACHMENT_UPLOAD_CEILING_BYTES).toBe(10485760);
    expect(STAGED_FORMAT_EXTENSIONS.length).toBe(8);
    // The notice is only meaningful for a member who can actually attach.
    expect(panel).toMatch(/canWrite \? \([\s\S]{0,200}ATTACHMENT_LIMIT_NOTICE/);
  });

  it('previews from the device-local staged copy and from nowhere else', () => {
    expect(panel).toContain('source={{ uri: activeStaged.candidate.uri }}');
    expect(panel).toContain("stagedKind === 'image'");
    expect(panel).toContain('resizeMode="contain"');
    // No remote image source, no preview or thumbnail service, ever.
    expect(panel).not.toMatch(/source=\{\{\s*uri:\s*['"`]http/);
    expect(panel).not.toMatch(/https?:\/\//);
    expect(panel).not.toMatch(/thumbnail|cloudinary|imgix|preview-service/i);
    // Text previews come from the service's bounded read; documents get the
    // honest summary instead of an empty frame.
    expect(panel).toContain('preview: await readStagedTextPreview(candidate)');
    expect(panel).toContain('{STAGED_DOCUMENT_PREVIEW_NOTE}');
    expect(panel).toContain('{STAGED_TEXT_PREVIEW_UNAVAILABLE_NOTE}');
    expect(panel).toContain('stagedSummary(activeStaged.candidate.mimeType, activeStaged.candidate.sizeBytes)');
    expect(stagedPreviewKind('application/pdf')).toBe('document');
    expect(stagedSummary('application/pdf', 4096)).toBe('PDF document · 4 KiB');
    expect(boundedTextPreview(new TextEncoder().encode('a,b\n1,2\n'), 8)?.text).toBe('a,b\n1,2');
    expect(formatAttachmentBytes(4096)).toBe('4 KiB');
  });

  it('uploads only when the worker says so, and keeps the picker out of the way until then', () => {
    expect(panel).toContain("label={activeStaged.pendingUploadID ? 'Check upload status' : 'Upload attachment'}");
    expect(panel).toContain('label="Discard selection"');
    expect(panel).toContain('onPress={() => { void uploadStaged(); }}');
    expect(panel).toContain('onPress={() => { void discardStaged(); }}');
    // Nothing uploads from the picker path: the only upload call site is the
    // explicit one, and the pick handlers refuse while a selection is staged.
    expect((panel.match(/uploadAuthorizedAttachment\(/g) ?? [])).toHaveLength(1);
    expect(panel).toMatch(/async function chooseDocument\(\) \{\s*if \(!mounted.current\) return;\s*await runOperation\('pick',[\s\S]*?if \(!canWrite \|\| busy \|\| activeStaged\) return;/);
    expect(panel).toMatch(/async function scanDocument\(\) \{\s*if \(!mounted.current\) return;\s*await runOperation\('camera',[\s\S]*?if \(!canWrite \|\| busy \|\| activeStaged\) return;/);
    expect(panel).toContain('{activeStaged ? null : (');
    // A name the validator would refuse blocks the upload button itself.
    expect(panel).toContain('disabled={nameProblem !== null || (busy !== null && busy !== \'upload\')}');
  });

  it('retains a recoverable failure and releases a permanent refusal', () => {
    // The upload consumes a per-attempt duplicate, so the staged bytes survive.
    expect(panel).toContain('const uploadCandidate = await copyStagedAttachmentCandidate(');
    expect(service).toContain('export async function copyStagedAttachmentCandidate(');
    expect(service).toContain('await source.copy(destination);');
    // Permanent inspection and local validation refusals release the selection.
    expect(panel).toMatch(/catch \(nextError\) \{\s*if \(!isCurrentRequest\(requestGeneration\)\) return;[\s\S]*?reportFailure\(nextError, ATTACHMENT_UPLOAD_FAILED_MESSAGE\);[\s\S]*?if \(nextError instanceof AttachmentError && \(nextError\.rejected \|\| nextError\.code === 'validation'\)\) \{\s*await releaseStagedSelection\(selection\);/);
    expect(panel).toContain("t('Refresh attachments')");
  });

  it('cleans the private cache on discard, unmount, a target change and a revocation', () => {
    // One effect covers unmount and a target change: its cleanup releases
    // whatever is staged, and its body clears the state for the new record.
    expect(panel).toMatch(/useEffect\(\(\) => \{\s*forgetStagedSelection\(\);[\s\S]*?return \(\) => \{[\s\S]*?cleanupAttachmentCandidate\(selection\.candidate\)[\s\S]*?\}, \[targetKey\]\);/);
    expect(panel).toContain('const activeStaged = canWrite && staged && staged.targetKey === targetKey ? staged : null;');
    // A revoked authorization releases the bytes rather than holding them for a
    // retry that can never succeed.
    expect(panel).toMatch(/nextError\.code === 'authorization'\) \{[\s\S]{0,400}releaseStagedSelection\(selection\)/);
    // Discard is explicit, and an unverified deletion keeps the selection on
    // screen so it can be tried again.
    expect(panel).toContain('async function discardStaged()');
    expect(panel).toContain('stagedRef.current = selection;');
    expect(releasedMessage('document')).toContain('deleted from this device');
    expect(releasedMessage('scan')).not.toBe(releasedMessage('document'));
    // Late picker results and orphaned staged bytes both go through the one
    // cleanup entry point the service already retries.
    expect((panel.match(/cleanupAttachmentCandidate\(/g) ?? [])).toHaveLength(3);
  });
});

// #9120: the case screen writes the staff updated_case access-history entry
// from onChanged, so the panel reports every file it attaches or removes, once,
// as soon as the write succeeded and before any check that the member is still
// on the record (the change happened either way), and never for a discarded
// selection, a failure or a safety re-check.
describe('attachment panel change report', () => {
  it('reports a confirmed or completed upload and a removal, and nothing else', () => {
    expect((panel.match(/onChanged\?\.\(\)/g) ?? [])).toHaveLength(3);
    expect(panel).toMatch(/reconcileAuthorizedAttachmentUpload\([\s\S]*?if \(result\.status === 'confirmed'\) \{[\s\S]*?await onChanged\?\.\(\);[\s\S]*?if \(!isCurrentRequest\(requestGeneration\)\) return;/);
    expect(panel).toMatch(/accepted = disposition\.status !== 'discarded';[\s\S]*?if \(accepted\) await onChanged\?\.\(\);\s*const released = await releaseStagedSelection\(selection\);[\s\S]*?if \(!isCurrentRequest\(requestGeneration\)\) return;/);
    expect(panel).toMatch(/await removeAuthorizedAttachment\(target, row\.id, writer\);[\s\S]*?await onChanged\?\.\(\);[\s\S]*?const ownership = await writer.check\(\);/);
    expect(panel).not.toMatch(/recheckAuthorizedAttachment\(target, attachmentID\);\s*onChanged/);
  });
});
