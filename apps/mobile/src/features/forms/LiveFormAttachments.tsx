import { useEffect, useRef, useState } from 'react';
import { StyleSheet, View } from 'react-native';

import { Body, Button, Heading } from '../../components/ui';
import { ATTACHMENT_FILENAME_LIMIT, ATTACHMENT_UPLOAD_CEILING_BYTES, STAGED_FORMAT_EXTENSIONS } from '../../lib/attachmentStaging';
import { useNativeUi } from '../../lib/useNativeUi';
import type { NativeUiKey } from '../../lib/nativeUiCopy';
import { FormFileError, addFormFile, finishFormFile, listFormFiles, openFormFile, recheckFormFile, removeFormFile, type FormFile, type FormFilePhase, type FormFileTarget } from '../../services/formFiles';
import { haptics } from '../../services/haptics';
import { spacing } from '../../theme/tokens';

// REQ-UG-NATIVE-FORMS-FULL-PARITY-WITH-THE-WEBSITE-20261113 (#8699,
// part 2): the form's attachments in its filing step, as on the website. The
// member sees every file the signature will cover before drawing it; adding or
// removing one makes the server clear the signature, and an upload whose
// check did not finish stays "Upload pending" until Retry finishes it.
const FAILURE_TEXT: Record<FormFileError['reason'], NativeUiKey> = {
  rejected: 'This file was rejected by the safety check and was not attached.',
  pending: 'The file was uploaded, but its safety check did not finish. Tap Retry to finish it.',
  stale: 'This file needs a fresh safety check before it can open.',
  'step-up': 'Verify it is you, then try again.',
  'session-changed': 'You were signed out or switched accounts, so this form was not saved.',
  unavailable: 'The attachments could not be loaded. Check your connection and try again.',
  failed: 'The file was not attached. Nothing was saved; try again.',
};

const PHASE_TEXT: Record<FormFilePhase, NativeUiKey> = {
  uploading: 'Uploading…',
  checking: 'Running the safety check…',
  confirming: 'Attaching…',
};

// BUG-UG-ONE-CATCH-ALL-LINE-FOR-EVERY-REFUSAL-20261122 (#9464, M1-9):
// the limits are stated before the picker opens, and a file the phone refuses
// says why instead of "try again". The copy is local to this screen (the shared
// phone catalogue is at its byte budget); the numbers are the staging
// constants, which attachments.test.ts pins against the service's own limits.
type Words = { en: string; es: string };
const CEILING_MIB = ATTACHMENT_UPLOAD_CEILING_BYTES / (1024 * 1024);
// The exact formats the check accepts, as the staging notice lists them.
const formats = (or: string) => `${STAGED_FORMAT_EXTENSIONS.slice(0, -1).join(', ')} ${or} ${STAGED_FORMAT_EXTENSIONS.at(-1) ?? ''}`;
const LIMIT_LINE: Words = {
  en: `Attach a ${formats('or')} file of up to ${CEILING_MIB} MiB; HEIC photos are converted to JPG first. Every file must pass a safety check.`,
  es: `Adjunta un archivo ${formats('o')} de hasta ${CEILING_MIB} MiB; las fotos HEIC se convierten a JPG antes. Cada archivo debe pasar un control de seguridad.`,
};
// Keyed by the exact sentence services/attachments.ts throws; any other
// refusal keeps the neutral line.
const REFUSED_FILE = new Map<string, Words>([
  ['Choose a PDF, image, text, CSV, Word, or Excel file.', {
    en: `This type of file is not accepted, so it was not attached. Choose a ${formats('or')} file.`,
    es: `Este tipo de archivo no se acepta, así que no se adjuntó. Elige un archivo ${formats('o')}.`,
  }],
  ['Choose a file between 1 byte and 10 MiB.', {
    en: `This file is empty or larger than ${CEILING_MIB} MiB, so it was not attached. Choose a file that has content and is ${CEILING_MIB} MiB or smaller.`,
    es: `Este archivo está vacío o pesa más de ${CEILING_MIB} MiB, así que no se adjuntó. Elige un archivo que tenga contenido y pese ${CEILING_MIB} MiB o menos.`,
  }],
  ['The file name must be 1–160 characters without folders or control characters.', {
    en: `The file name is longer than ${ATTACHMENT_FILENAME_LIMIT} characters or has characters that are not allowed, so it was not attached. Rename the file, then choose it again.`,
    es: `El nombre del archivo tiene más de ${ATTACHMENT_FILENAME_LIMIT} caracteres o caracteres no permitidos, así que no se adjuntó. Cámbiale el nombre y elígelo de nuevo.`,
  }],
  ['This photo could not be converted for upload. Choose a JPEG or PNG instead.', {
    en: 'This photo could not be converted for upload, so it was not attached. Choose a JPEG or PNG instead.',
    es: 'Esta foto no se pudo convertir para subirla, así que no se adjuntó. Elige un JPEG o PNG.',
  }],
  ['The selected file changed before upload. Choose it again.', {
    en: 'The file changed before it was uploaded, so it was not attached. Choose it again.',
    es: 'El archivo cambió antes de subirse, así que no se adjuntó. Elígelo de nuevo.',
  }],
]);

function refusedFile(error: unknown): Words | null {
  if (!(error instanceof Error) || error.name !== 'AttachmentError' || (error as { code?: unknown }).code !== 'validation') return null;
  return REFUSED_FILE.get(error.message) ?? null;
}

type Failure = FormFileError['reason'] | 'not-removed' | Words;

// An add, open, re-check or remove keeps running when a return to the
// foreground mounts the form again (#8724, gate stage 172 r1s1): the picker
// and the share sheet leave the app, and the re-check of the session on the
// way back unmounts this list. The list mounted next for the same member and
// form shows that work's progress, waits for it, then shows its outcome and
// reads the server's list.
type Flight = {
  label: string;
  phase: FormFilePhase | null;
  watchers: Set<(phase: FormFilePhase | null) => void>;
  settled: Promise<Failure | null>;
};
const flights = new Map<string, Flight>();

// The newest list read per member and form, across every list mounted for it:
// an older reply, perhaps from a list that has since unmounted, never replaces
// a newer one (gate stage 180, r7s1).
const listReads = new Map<string, number>();

const fileListKey = (target: FormFileTarget) => `${target.ownerID}\0${target.formID}`;

// Starts a list read of one member's form, as the newest. The returned check
// is true while no later read of that form has started, here or in the Forms
// editor's own reads (attachmentsAsShown and the read after a signature), so
// an older reply never replaces a newer list (ledger 223, gate stage 183 r9s1).
function startListRead(key: string): () => boolean {
  const read = (listReads.get(key) ?? 0) + 1;
  listReads.set(key, read);
  return () => listReads.get(key) === read;
}

export function startFormFileRead(target: FormFileTarget): () => boolean {
  return startListRead(fileListKey(target));
}

function sizeText(bytes: number): string {
  return bytes >= 1024 * 1024 ? `${(bytes / (1024 * 1024)).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

export function LiveFormAttachments({ target, files, busy, onFiles }: {
  // Null until the form has been saved once and has an id.
  target: FormFileTarget | null;
  // The files as last read or changed here; null until the first read.
  files: FormFile[] | null;
  busy: boolean;
  onFiles: (files: FormFile[]) => void;
}) {
  const { t, language } = useNativeUi();
  const [working, setWorking] = useState<string | null>(null);
  const [phase, setPhase] = useState<FormFilePhase | null>(null);
  const [failure, setFailure] = useState<Failure | null>(null);
  // A confirmed file whose open found its safety verdict lapsed; it and any
  // file the list reports as no longer current offer Re-check, as on the
  // website (gate stage 168, r1s4).
  const [staleID, setStaleID] = useState<string | null>(null);
  const formKey = target ? fileListKey(target) : '';
  const current = useRef(formKey);
  current.current = formKey;

  async function refresh(key = formKey) {
    if (!target) return;
    const newestRead = startListRead(key);
    const newest = () => current.current === key && newestRead();
    try {
      const next = await listFormFiles(target);
      if (newest()) onFiles(next);
    } catch (error) {
      if (newest()) setFailure(error instanceof FormFileError ? error.reason : 'unavailable');
    }
  }

  useEffect(() => {
    setFailure(null);
    void refresh(formKey);
    const flight = flights.get(formKey);
    if (!flight) return undefined;
    const key = formKey;
    setWorking(flight.label);
    setPhase(flight.phase);
    const watch = (next: FormFilePhase | null) => { if (current.current === key) setPhase(next); };
    flight.watchers.add(watch);
    void flight.settled.then((outcome) => {
      if (current.current !== key) return;
      setWorking(null);
      setPhase(null);
      setFailure(outcome);
      void refresh(key);
    });
    return () => { flight.watchers.delete(watch); };
    // A new form or member reads its own list; the callbacks are the latest.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [formKey]);

  // Progress of this list's own work, which a list mounted later also shows.
  const reportPhase = (next: FormFilePhase) => {
    setPhase(next);
    const flight = flights.get(formKey);
    if (!flight) return;
    flight.phase = next;
    for (const watch of flight.watchers) watch(next);
  };

  // removal: a failed Remove is worded as one, not as a file not attached.
  async function run(label: string, action: () => Promise<unknown>, removal = false) {
    if (!target || working || busy) return;
    const key = formKey;
    let settle: (outcome: Failure | null) => void = () => {};
    const flight: Flight = { label, phase: null, watchers: new Set(), settled: new Promise((resolve) => { settle = resolve; }) };
    flights.set(key, flight);
    let outcome: Failure | null = null;
    setWorking(label);
    setFailure(null);
    try {
      await action();
      void haptics.success();
      if (current.current === key && label === staleID) setStaleID(null);
    } catch (error) {
      const reason = error instanceof FormFileError ? error.reason : 'failed';
      outcome = refusedFile(error) ?? (removal && reason === 'failed' ? 'not-removed' : reason);
      if (current.current === key) {
        setFailure(outcome);
        if (reason === 'stale') setStaleID(label);
      }
    } finally {
      // The server's list is the truth after every change, success or not.
      await refresh(key);
      if (flights.get(key) === flight) flights.delete(key);
      settle(outcome);
      if (current.current === key) {
        setWorking(null);
        setPhase(null);
      }
    }
  }

  const disabled = !target || busy || working !== null;
  return (
    <View style={styles.section}>
      <Heading level={2}>{t('Attachments')}</Heading>
      <Body muted>{LIMIT_LINE[language]}</Body>
      {!target ? <Body muted>{t('Save the form before adding files.')}</Body> : null}
      {files && files.length === 0 ? <Body muted>{t('No files attached.')}</Body> : null}
      {(files ?? []).map((file) => (
        <View key={file.id} style={styles.file}>
          <Body>{`${file.filename} · ${sizeText(file.sizeBytes)} · ${!file.confirmed ? t('Upload pending') : file.scanCurrent && staleID !== file.id ? t('Checked') : t('Needs a fresh safety check')}`}</Body>
          <View style={styles.actions}>
            {file.confirmed
              ? <Button label={t('Open {name}', { name: file.filename })} variant="secondary" disabled={disabled} onPress={() => { void run(file.id, () => openFormFile(target as FormFileTarget, file)); }} />
              : <Button label={t('Retry {name}', { name: file.filename })} variant="secondary" disabled={disabled} onPress={() => { void run(file.id, () => finishFormFile(target as FormFileTarget, file.id, reportPhase)); }} />}
            {file.confirmed && (!file.scanCurrent || staleID === file.id) ? (
              <Button
                label={working === file.id && phase === 'checking' ? t('Re-checking…') : t('Re-check {name}', { name: file.filename })}
                variant="secondary"
                disabled={disabled}
                onPress={() => { void run(file.id, () => { reportPhase('checking'); return recheckFormFile(target as FormFileTarget, file.id); }); }}
              />
            ) : null}
            <Button label={t('Remove {name}', { name: file.filename })} variant="secondary" disabled={disabled} onPress={() => { void run(file.id, () => removeFormFile(target as FormFileTarget, file.id), true); }} />
          </View>
        </View>
      ))}
      <Button
        label={working === 'add' && phase ? t(PHASE_TEXT[phase]) : t('Add a file')}
        variant="secondary"
        disabled={disabled}
        onPress={() => {
          void run('add', async () => {
            // Loaded on use: the picker module reads the build configuration.
            const { pickAuthorizedDocument } = await import('../../services/attachments');
            const candidate = await pickAuthorizedDocument();
            if (candidate && target) await addFormFile(target, candidate, reportPhase);
          });
        }}
      />
      {failure ? (
        <View accessibilityLiveRegion="polite" accessibilityRole="alert">
          <Body>{typeof failure === 'object' ? failure[language] : t(failure === 'not-removed' ? 'The file was not removed. Nothing changed; try again.' : FAILURE_TEXT[failure])}</Body>
        </View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  section: { gap: spacing.sm },
  file: { gap: spacing.xs },
  actions: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm },
});
