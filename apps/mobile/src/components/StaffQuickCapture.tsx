import { Ionicons } from '@expo/vector-icons';
import type { AudioPlayer, AudioRecorder } from 'expo-audio';
import { useIsFocused, useRouter } from 'expo-router';
import { useEffect, useMemo, useRef, useState } from 'react';
import { Alert, Pressable, StyleSheet, useWindowDimensions, View } from 'react-native';
import { Text, TextInput } from './Text';

import { useAccessibilityAnnouncementQueue } from '../lib/announce';
import { defaultShortcutKeys, reconcileShortcutKeys } from '../lib/deskCopy';
import { placeholderFitMultiplier, placeholderMaxHeight } from '../lib/placeholderFit';
import type { NativeUiKey } from '../lib/nativeUiCopy';
import { defineRetainedSurface, useRetainedDraft, type Held } from '../lib/retainedDraft';
import { SavedWorkCheckFailed } from './SavedWorkCheckFailed';
import { featureGroupsForHat, featureGroupsForRoles, staffAuthorizedForScopes, withMyCampaignGroup, withoutDuesGroups, type HatFunctionGroup } from '../lib/hatFunctions';
import { quickActionsScope, quickCaptureScope } from '../lib/quickActions';
import { useNativeUi } from '../lib/useNativeUi';
import { haptics } from '../services/haptics';
import { loadAudioModule } from '../services/optionalAudio';
import {
  addQuickNote,
  bindQuickCaptureOrganization,
  createQuickTask,
  deleteVoiceRecording,
  loadPinnedDestinationKeys,
  loadQuickNotes,
  loadQuickTasks,
  MAX_QUICK_NOTES,
  MAX_QUICK_TASKS,
  QUICK_NOTE_BODY_LIMIT,
  QUICK_TASK_TITLE_LIMIT,
  removeQuickNote,
  saveQuickTasks,
  type QuickNote,
  type QuickTask,
} from '../services/quickCapture';
import { useApp } from '../state/AppProvider';
import { useTheme } from '../theme/ThemeProvider';
import { minimumTouchTarget, radii, spacing } from '../theme/tokens';
import { useRevealAboveKeyboard } from './ScreenKeyboardReveal';
import { Body, Button, Heading } from './ui';

import { typeface } from '../theme/typeface';
type VoiceMemo = { uri: string; durationMs: number };
// #9240 PR A: the unsaved note and task text wait in memory through a session
// check for the same person in the same organization (the item names the
// chapter-bound capture scope, and a chapter change clears every draft). The
// voice memo is a file and keeps its unmount cleanup.
type CaptureText = { text: string };
const noteSurface = defineRetainedSurface<Held<CaptureText>>('staff-quick-note');
const taskSurface = defineRetainedSurface<Held<CaptureText>>('staff-quick-task');
const EMPTY_TEXT: CaptureText = { text: '' };
const NOTE_SAVE_FAILED: NativeUiKey = 'Your note could not be saved securely. It stays in the composer so you can try again.';
const TASK_SAVE_FAILED: NativeUiKey = 'The change could not be saved securely. Try again.';

// Work owns capture; the right-edge drawer owns the Guide for every hat.
// Unmount the content on lock/privacy/identity changes so its drafts, recorder
// and player cannot survive into another account, campaign or worker identity.
export function StaffQuickCapture() {
  const { t } = useNativeUi();
  const focused = useIsFocused();
  const { mode, previewHat, chapterRoles, organizationRoles, authorizedRoles, locked, privacyCovered, session, chapterMemberships, organizationID, duesContext } = useApp();
  const staff = mode === 'preview'
    ? previewHat !== null && previewHat !== 'member'
    : mode === 'authenticated' && staffAuthorizedForScopes(chapterRoles, organizationRoles);
  if (!staff || !focused || locked || privacyCovered) return null;
  const membership = chapterMemberships.find((entry) => entry.selected);
  // Refuse a stale chapter; preserve legacy chapter-less captures through the
  // existing '.none' key with an organization binding before any content read.
  if (mode === 'authenticated' && (!session || !organizationID || (membership && membership.organizationID !== organizationID))) {
    return <View style={styles.section}><Heading level={3}>{t('Quick capture')}</Heading><Body muted>{t('Select a campaign to use quick capture.')}</Body></View>;
  }
  const scope = quickCaptureScope(mode, previewHat, session?.user.id ?? null, membership?.chapterID ?? null);
  const shortcutScope = quickActionsScope(mode, previewHat, authorizedRoles);
  const groups = withMyCampaignGroup(withoutDuesGroups(mode === 'preview' ? featureGroupsForHat(previewHat) : featureGroupsForRoles(chapterRoles, organizationRoles), duesContext?.runsDues));
  return <StaffQuickCaptureContent key={`${scope}.${organizationID ?? 'preview'}`} scope={scope} shortcutScope={shortcutScope} groups={groups} organizationID={organizationID} />;
}

function formatDuration(durationMs: number) {
  const totalSeconds = Math.max(0, Math.round(durationMs / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = `${totalSeconds % 60}`.padStart(2, '0');
  return `${minutes}:${seconds}`;
}

// The composer fields' text and the multiline fields' usual height cap. At the
// largest text size a placeholder must stay whole: the multiline caps grow so
// it can wrap, and the single-line task field's text grows only as far as its
// placeholder fits
// (BUG-UG-NATIVE-QUICK-NOTE-PLACEHOLDER-CLIPPED-AT-LARGEST-TEXT-IOS-20261103,
// src/lib/placeholderFit.ts).
const INPUT_FONT_SIZE = 16;
const INPUT_LINE_HEIGHT = 22;
const INPUT_BORDER = 1;
const MULTILINE_MAX_HEIGHT = 120;
const INPUT_VERTICAL_CHROME = spacing.sm * 2 + INPUT_BORDER * 2;
const INPUT_HORIZONTAL_CHROME = spacing.md * 2 + INPUT_BORDER * 2;

function multilineMaxHeight(placeholder: string, fontScale: number): number {
  return placeholderMaxHeight(placeholder, { baseMaxHeight: MULTILINE_MAX_HEIGHT, lineHeight: INPUT_LINE_HEIGHT, fontScale, verticalChrome: INPUT_VERTICAL_CHROME });
}

function StaffQuickCaptureContent({ scope, shortcutScope, groups, organizationID }: {
  scope: string;
  shortcutScope: string;
  groups: HatFunctionGroup[];
  organizationID: string | null;
}) {
  const theme = useTheme();
  const router = useRouter();
  const { t, locale, catalogLabel } = useNativeUi();
  // Placeholder fit is measured on the text shown, so a longer Spanish
  // placeholder still stays whole at the largest text size.
  const notePlaceholder = t('Capture a note');
  const taskPlaceholder = t('Add a task');
  const { fontScale } = useWindowDimensions();
  const keyboardReveal = useRevealAboveKeyboard();
  const noteBlockRef = useRef<View>(null);
  // While the note field is focused its block is re-lifted whenever it changes
  // size: the multiline field grows from 48 to 120 pt as the member types, and
  // a voice memo or error line can appear, each pushing Save note back down.
  const noteFocusedRef = useRef(false);
  const taskRowRef = useRef<View>(null);
  const taskFocusedRef = useRef(false);
  const { mode, session, captureAccountSessionGuard } = useApp();
  // Bind ownership once for this composer. An unrelated render must not give
  // its existing draft a replacement login's live guard.
  const [captureSessionIsCurrent] = useState(() => mode === 'preview'
    ? () => true : captureAccountSessionGuard(session?.user.id ?? null));
  const [pinnedKeys, setPinnedKeys] = useState<string[] | null>(null);
  const pinnedDestinations = useMemo(() => {
    const byKey = new Map(groups.flatMap((group) => group.items).map((item) => [item.key, item]));
    return reconcileShortcutKeys(pinnedKeys, [...byKey.keys()], defaultShortcutKeys(groups, 4), 4)
      .flatMap((key) => { const item = byKey.get(key); return item ? [item] : []; });
  }, [groups, pinnedKeys]);
  useEffect(() => {
    let alive = true;
    void loadPinnedDestinationKeys(shortcutScope).then((keys) => { if (alive) setPinnedKeys(keys); });
    return () => { alive = false; };
  }, [shortcutScope]);
  const [notes, setNotes] = useState<QuickNote[]>([]);
  const [ready, setReady] = useState(false);
  const [loadError, setLoadError] = useState(false);
  const [loadAttempt, setLoadAttempt] = useState(0);
  const [tasks, setTasks] = useState<QuickTask[]>([]);
  const note = useRetainedDraft({ surface: noteSurface, item: `${scope}.${organizationID ?? 'none'}`, empty: EMPTY_TEXT, fresh: ready, scope: 'organization' });
  const task = useRetainedDraft({ surface: taskSurface, item: `${scope}.${organizationID ?? 'none'}`, empty: EMPTY_TEXT, fresh: ready, scope: 'organization' });
  const noteDraft = note.value.text;
  const taskDraft = task.value.text;
  const setNoteDraft = (text: string) => note.set({ text });
  const setTaskDraft = (text: string) => task.set({ text });
  const [taskLineWidth, setTaskLineWidth] = useState(0);
  const [noteError, setNoteError] = useState<string | null>(null);
  const [noteSaving, setNoteSaving] = useState(false);
  const [taskError, setTaskError] = useState<string | null>(null);
  const [voiceError, setVoiceError] = useState<string | null>(null);
  const [recording, setRecording] = useState(false);
  const [recordingStarting, setRecordingStarting] = useState(false);
  const [voiceMemo, setVoiceMemo] = useState<VoiceMemo | null>(null);
  const [taskSaving, setTaskSaving] = useState(false);
  const [expandedNoteId, setExpandedNoteId] = useState<string | null>(null);
  const recorderRef = useRef<AudioRecorder | null>(null);
  const recorderStartingRef = useRef(false);
  const stoppingRef = useRef<Promise<VoiceMemo | null> | null>(null);
  const taskSaveBusyRef = useRef(false);
  const playerRef = useRef<AudioPlayer | null>(null);
  const voiceMemoRef = useRef(voiceMemo);
  voiceMemoRef.current = voiceMemo;
  const aliveRef = useRef(true);
  const savingMemoRef = useRef<string | null>(null);
  const noteSaveBusyRef = useRef(false);
  const announce = useAccessibilityAnnouncementQueue(`staff-quick-capture:${scope}`);

  // #9536: a full list keeps what was typed or recorded and says how to make
  // room; nothing saved is deleted for the new capture.
  function explainFullList(message: string) {
    Alert.alert(t('Quick capture is full'), message, [{ text: t('OK') }]);
    announce(message);
    void haptics.warning();
  }

  useEffect(() => {
    aliveRef.current = true;
    let alive = true;
    setLoadError(false);
    void bindQuickCaptureOrganization(scope, organizationID).then(() => {
      if (!alive) return null;
      return Promise.all([loadQuickNotes(scope), loadQuickTasks(scope)]);
    }).then((stored) => {
      if (!alive || !stored) return;
      const [storedNotes, storedTasks] = stored;
      setNotes(storedNotes);
      setTasks(storedTasks);
      setReady(true);
    }).catch(() => { if (alive) setLoadError(true); });
    return () => {
      alive = false;
      aliveRef.current = false;
      const recorder = recorderRef.current;
      recorderRef.current = null;
      if (recorder) {
        // An unmounted panel can never attach the in-flight take, so stop it,
        // delete the partial file, and return audio routing to playback mode.
        void recorder.stop()
          .then(() => Promise.all([
            deleteVoiceRecording(recorder.uri),
            loadAudioModule()?.setAudioModeAsync({ allowsRecording: false }) ?? Promise.resolve(),
          ]))
          .catch(() => undefined)
          .finally(() => recorder.release());
      }
      playerRef.current?.remove();
      playerRef.current = null;
      // A memo never attached to a saved note has no remaining reference.
      if (voiceMemoRef.current?.uri !== savingMemoRef.current) {
        void deleteVoiceRecording(voiceMemoRef.current?.uri ?? null);
      }
    };
  }, [scope, organizationID, loadAttempt]);

  async function startRecording() {
    if (!aliveRef.current || noteSaveBusyRef.current || recording || recorderRef.current || recorderStartingRef.current || stoppingRef.current) return;
    const audio = loadAudioModule();
    if (!audio) {
      setVoiceError(t('Voice notes need the newest app build. Type the note instead.'));
      return;
    }
    recorderStartingRef.current = true;
    setRecordingStarting(true);
    let preparingRecorder: AudioRecorder | null = null;
    try {
      const permission = await audio.requestRecordingPermissionsAsync();
      if (!aliveRef.current || noteSaveBusyRef.current) return;
      if (!permission.granted) {
        setVoiceError(t('Microphone access is off for Union Ground. Allow it in Settings to record.'));
        return;
      }
      await audio.setAudioModeAsync({ allowsRecording: true, playsInSilentMode: true });
      if (!aliveRef.current || noteSaveBusyRef.current) {
        await audio.setAudioModeAsync({ allowsRecording: false });
        return;
      }
      // prepareToRecordAsync flattens the preset's platform sections; the
      // constructor alone would leave the native recorder on default quality.
      const recorder = new audio.AudioModule.AudioRecorder(audio.RecordingPresets.HIGH_QUALITY);
      preparingRecorder = recorder;
      await recorder.prepareToRecordAsync(audio.RecordingPresets.HIGH_QUALITY);
      if (!aliveRef.current || noteSaveBusyRef.current) {
        const uri = recorder.uri;
        recorder.release();
        preparingRecorder = null;
        await deleteVoiceRecording(uri);
        await audio.setAudioModeAsync({ allowsRecording: false });
        return;
      }
      recorder.record();
      recorderRef.current = recorder;
      preparingRecorder = null;
      // Keep the previous take playable and saveable if replacement startup fails.
      // Once the new recorder is running, it owns the next attachment.
      const replaced = voiceMemoRef.current;
      voiceMemoRef.current = null;
      setVoiceMemo(null);
      if (replaced) void deleteVoiceRecording(replaced.uri);
      setVoiceError(null);
      setRecording(true);
      void haptics.impact();
    } catch {
      if (preparingRecorder) {
        const uri = preparingRecorder.uri;
        preparingRecorder.release();
        await deleteVoiceRecording(uri);
      }
      await audio.setAudioModeAsync({ allowsRecording: false }).catch(() => undefined);
      setVoiceError(t('Recording could not start. Try again.'));
    } finally {
      recorderStartingRef.current = false;
      setRecordingStarting(false);
    }
  }

  function stopRecording(): Promise<VoiceMemo | null> {
    if (stoppingRef.current) return stoppingRef.current;
    const recorder = recorderRef.current;
    if (!recorder) return Promise.resolve(voiceMemoRef.current);
    recorderRef.current = null;
    const stopping = finishRecording(recorder).finally(() => {
      stoppingRef.current = null;
      setRecording(false);
    });
    stoppingRef.current = stopping;
    return stopping;
  }

  async function finishRecording(recorder: AudioRecorder): Promise<VoiceMemo | null> {
    let memo: VoiceMemo | null = null;
    try {
      const beforeStopMs = recorder.getStatus().durationMillis;
      await recorder.stop();
      let durationMs = beforeStopMs;
      try {
        durationMs = Math.max(beforeStopMs, recorder.getStatus().durationMillis);
      } catch {
        // Keep the pre-stop reading if the recorder no longer reports status.
      }
      const uri = recorder.uri;
      if (!aliveRef.current) {
        await deleteVoiceRecording(uri);
      } else if (uri) {
        memo = { uri, durationMs };
        voiceMemoRef.current = memo;
        if (noteSaveBusyRef.current) savingMemoRef.current = uri;
        setVoiceMemo(memo);
      } else {
        setVoiceError(t('The recording could not be saved. Try again.'));
      }
    } catch {
      setVoiceError(t('The recording could not be saved. Try again.'));
    } finally {
      recorder.release();
    }
    await loadAudioModule()?.setAudioModeAsync({ allowsRecording: false }).catch(() => undefined);
    return memo;
  }

  function playMemo(uri: string) {
    if (!aliveRef.current) return;
    const audio = loadAudioModule();
    if (!audio) {
      setVoiceError(t('Voice playback needs the newest app build.'));
      return;
    }
    playerRef.current?.remove();
    const player = audio.createAudioPlayer(uri);
    playerRef.current = player;
    player.play();
  }

  async function saveNote() {
    if (!aliveRef.current || noteSaveBusyRef.current || recorderStartingRef.current) return;
    // Recorder shutdown may outlive sign-out's synchronous session commit,
    // before React runs this component's cleanup. Retain the saving session's
    // ownership rather than treating a still-mounted component as authorized.
    if (!captureSessionIsCurrent()) return;
    // Own the attachment before the first await, including recorder shutdown.
    // Refs also refuse presses retained from the preceding render.
    noteSaveBusyRef.current = true;
    setNoteSaving(true);
    let memo: typeof voiceMemo = null;
    let attempt: ReturnType<typeof note.begin> = null;
    try {
      memo = stoppingRef.current || recorderRef.current ? await stopRecording() : voiceMemoRef.current;
      if (!aliveRef.current || !captureSessionIsCurrent()) {
        savingMemoRef.current = null;
        await deleteVoiceRecording(memo?.uri ?? null);
        return;
      }
      const body = noteDraft.trim();
      if (!body && !memo) {
        setNoteError(t('Write or record something before saving.'));
        return;
      }
      if (notes.length >= MAX_QUICK_NOTES) {
        // The take stays attached and discardable; it was never saved.
        savingMemoRef.current = null;
        explainFullList(t('Quick capture holds {count} notes, voice notes included. Delete one, then save this.', { count: MAX_QUICK_NOTES }));
        return;
      }
      // A held attempt locks the text it saves; a note with only a memo has none.
      attempt = noteDraft ? note.begin() : null;
      if (noteDraft && !attempt) return;
      savingMemoRef.current = memo?.uri ?? null;
      const next = await addQuickNote(scope, {
        body,
        voiceUri: memo?.uri ?? null,
        voiceDurationMs: memo?.durationMs ?? null,
      });
      // Settled even after unmount: a returning composer starts blank.
      attempt?.settle('done');
      savingMemoRef.current = null;
      voiceMemoRef.current = null;
      if (!aliveRef.current) return;
      setNotes(next);
      setVoiceMemo(null);
      setNoteError(null);
      void haptics.success();
    } catch {
      savingMemoRef.current = null;
      attempt?.settle({ failed: NOTE_SAVE_FAILED });
      if (!aliveRef.current || !captureSessionIsCurrent()) {
        await deleteVoiceRecording(memo?.uri ?? null);
        return;
      }
      setNoteError(t(NOTE_SAVE_FAILED));
      void haptics.warning();
    } finally {
      noteSaveBusyRef.current = false;
      setNoteSaving(false);
    }
  }

  function discardVoiceMemo() {
    const memo = voiceMemoRef.current;
    if (!aliveRef.current || noteSaveBusyRef.current || stoppingRef.current || !memo || memo.uri === savingMemoRef.current) return;
    voiceMemoRef.current = null;
    setVoiceMemo(null);
    void deleteVoiceRecording(memo.uri);
  }

  async function deleteNote(id: string) {
    if (!aliveRef.current) return;
    try {
      const next = await removeQuickNote(scope, id);
      setNotes(next);
      void haptics.select();
    } catch {
      setNoteError(t('The note could not be deleted. Try again.'));
      void haptics.warning();
    }
  }

  async function persistTasks(next: QuickTask[], rollback: QuickTask[]) {
    if (!aliveRef.current || taskSaveBusyRef.current) return false;
    taskSaveBusyRef.current = true;
    setTaskSaving(true);
    setTasks(next);
    try {
      await saveQuickTasks(scope, next);
      setTaskError(null);
      return true;
    } catch {
      setTasks(rollback);
      setTaskError(t(TASK_SAVE_FAILED));
      void haptics.warning();
      return false;
    } finally {
      taskSaveBusyRef.current = false;
      setTaskSaving(false);
    }
  }

  async function addTask() {
    if (!aliveRef.current || taskSaveBusyRef.current) return;
    const title = taskDraft.trim();
    if (!title) return;
    if (tasks.length >= MAX_QUICK_TASKS) {
      explainFullList(t('Quick capture holds {count} tasks. Delete one, then add this.', { count: MAX_QUICK_TASKS }));
      return;
    }
    // Built first: a task that cannot be built never leaves the text locked.
    const next = [createQuickTask(title), ...tasks];
    const attempt = task.begin();
    if (!attempt) return;
    const saved = await persistTasks(next, tasks);
    attempt.settle(saved ? 'done' : { failed: TASK_SAVE_FAILED });
    if (saved) void haptics.success();
  }

  async function toggleTask(id: string) {
    const next = tasks.map((task) => (task.id === id ? { ...task, done: !task.done } : task));
    if (await persistTasks(next, tasks)) void haptics.select();
  }

  async function deleteTask(id: string) {
    const next = tasks.filter((task) => task.id !== id);
    if (await persistTasks(next, tasks)) void haptics.select();
  }

  const inputStyle = [styles.input, { backgroundColor: theme.card, borderColor: theme.border, color: theme.foreground }];

  const noteBusy = noteSaving || note.pending === 'sending';
  const taskBusy = taskSaving || task.pending === 'sending';
  // While the reads are unconfirmed only the held text waits: a saved row's
  // or the recorder's own error still shows, the held failure copy does not.
  const noteMessage = noteError ?? (note.shown && note.failed ? t(note.failed as NativeUiKey) : null);
  const taskMessage = taskError ?? (task.shown && task.failed ? t(task.failed as NativeUiKey) : null);
  // A field hidden while focused never blurs: release its keyboard lift, so
  // the block is not lifted again when it returns unfocused (#9399 r4s1).
  useEffect(() => {
    if (!note.shown && noteFocusedRef.current) { noteFocusedRef.current = false; keyboardReveal.release(noteBlockRef.current); }
    if (!task.shown && taskFocusedRef.current) { taskFocusedRef.current = false; keyboardReveal.release(taskRowRef.current); }
  }, [note.shown, task.shown, keyboardReveal]);

  if (!ready) {
    return (
      <View style={styles.section}>
        <Heading level={3}>{t('Quick capture')}</Heading>
        <Body muted>{loadError ? t('Quick capture is unavailable for this campaign.') : t('Loading quick capture…')}</Body>
        {loadError ? <Button label={t('Try quick capture again')} variant="secondary" onPress={() => setLoadAttempt((attempt) => attempt + 1)} /> : null}
      </View>
    );
  }

  return (
    <View style={styles.section} accessibilityLabel={t('Quick capture')}>
        <Heading level={3}>{t('Quick capture')}</Heading>
        <Text style={[styles.sectionLabel, { color: theme.mutedForeground }]}>{t('Pinned destinations').toLocaleUpperCase(locale)}</Text>
        {pinnedDestinations.map((item) => (
          <Button key={item.key} label={catalogLabel(item.label)} variant="secondary" onPress={() => router.push(item.href as never)} />
        ))}

        <Text style={[styles.sectionLabel, { color: theme.mutedForeground }]}>{t('Quick note').toLocaleUpperCase(locale)}</Text>
        <Body muted>{t('Holds up to {count} notes, voice notes included.', { count: MAX_QUICK_NOTES })}</Body>
        {/* The note field and everything down to Save note is the block a
            focus lifts above the keyboard
            (BUG-UG-NATIVE-QUICK-NOTE-HIDDEN-BY-KEYBOARD-20261103).
            Only the composers wait on the holder: pinned destinations and
            saved notes and tasks stay while the provider's reads settle, and
            so does what the composer holds besides its text: a running
            recorder keeps its status and Stop, a finished take its chip, to be
            saved once the reads are back (#9399 r4s1). */}
        <View
          ref={noteBlockRef}
          onLayout={() => { if (noteFocusedRef.current) keyboardReveal.reveal(noteBlockRef.current); }}
          style={styles.section}
        >
          <View style={styles.composerRow}>
            {note.shown ? <TextInput
              accessibilityLabel={t('Quick note')}
              onFocus={() => { noteFocusedRef.current = true; keyboardReveal.reveal(noteBlockRef.current); }}
              onBlur={() => { noteFocusedRef.current = false; keyboardReveal.release(noteBlockRef.current); }}
              multiline
              maxLength={QUICK_NOTE_BODY_LIMIT}
              keyboardAppearance={theme.appearance}
              selectionColor={theme.primary}
              placeholder={notePlaceholder}
              placeholderTextColor={theme.quietForeground}
              value={noteDraft}
              onChangeText={setNoteDraft}
              editable={note.pending === false}
              style={[...inputStyle, styles.rowInput, styles.noteInput, { maxHeight: multilineMaxHeight(notePlaceholder, fontScale) }]}
            /> : note.checkFailed ? <SavedWorkCheckFailed /> : <Body muted style={styles.rowInput}>{t('Loading quick capture…')}</Body>}
            {note.shown || recording || recordingStarting ? <Pressable
              accessibilityRole="button"
              accessibilityLabel={recording ? t('Stop recording') : t('Record a voice note')}
              disabled={noteBusy || recordingStarting}
              accessibilityState={{ disabled: noteBusy || recordingStarting }}
              onPress={() => { void (recording ? stopRecording() : startRecording()); }}
              style={({ pressed }) => [
                styles.circleButton,
                { backgroundColor: recording ? theme.destructive : theme.secondary, opacity: pressed ? 0.82 : 1 },
              ]}
            >
              <Ionicons
                name={recording ? 'stop' : 'mic-outline'}
                size={22}
                color={recording ? theme.destructiveForeground : theme.secondaryForeground}
              />
            </Pressable> : null}
          </View>
          {recording ? (
            <View style={styles.metaRow}>
              <View style={[styles.recordingDot, { backgroundColor: theme.destructive }]} />
              <Body muted>{t('Recording… tap stop to attach.')}</Body>
            </View>
          ) : null}
          {voiceMemo ? (
            <View style={[styles.memoChip, { backgroundColor: theme.card, borderColor: theme.border }]}>
              <Pressable
                accessibilityRole="button"
                accessibilityLabel={t('Play voice memo, {duration}', { duration: formatDuration(voiceMemo.durationMs) })}
                onPress={() => playMemo(voiceMemo.uri)}
                style={styles.memoAction}
              >
                <Ionicons name="play" size={18} color={theme.primary} />
                <Text style={[styles.memoText, { color: theme.cardForeground }]}>{t('Voice memo · {duration}', { duration: formatDuration(voiceMemo.durationMs) })}</Text>
              </Pressable>
              <Pressable
                accessibilityRole="button"
                accessibilityLabel={t('Discard voice memo')}
                disabled={noteBusy || recording}
                accessibilityState={{ disabled: noteBusy || recording }}
                onPress={discardVoiceMemo}
                style={styles.memoAction}
              >
                <Ionicons name="close" size={18} color={theme.mutedForeground} />
              </Pressable>
            </View>
          ) : null}
          {voiceError ? <Body style={{ color: theme.destructive }}>{voiceError}</Body> : null}
          {noteMessage ? <Body style={{ color: theme.destructive }}>{noteMessage}</Body> : null}
          {note.shown ? <Button label={noteBusy ? t('Saving…') : t('Save note')} variant="secondary" disabled={noteBusy || recordingStarting || (!noteDraft.trim() && !voiceMemo && !recording)} onPress={() => { void saveNote(); }} /> : null}
        </View>
        {notes.map((note) => (
          <View key={note.id} style={[styles.itemRow, { borderColor: theme.border }]}>
            <View style={styles.itemBody}>
              {note.body ? (
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel={expandedNoteId === note.id ? t('Collapse note') : t('Show the full note')}
                  onPress={() => setExpandedNoteId(expandedNoteId === note.id ? null : note.id)}
                  style={styles.noteAction}
                >
                  <Text numberOfLines={expandedNoteId === note.id ? undefined : 2} style={[styles.noteBody, { color: theme.foreground }]}>{note.body}</Text>
                </Pressable>
              ) : null}
              {note.voiceUri ? (
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel={note.voiceDurationMs ? t('Play voice note, {duration}', { duration: formatDuration(note.voiceDurationMs) }) : t('Play voice note')}
                  onPress={() => playMemo(note.voiceUri!)}
                  style={styles.memoAction}
                >
                  <Ionicons name="play-circle-outline" size={20} color={theme.primary} />
                  <Text style={[styles.memoText, { color: theme.mutedForeground }]}>
                    {note.voiceDurationMs ? t('Voice · {duration}', { duration: formatDuration(note.voiceDurationMs) }) : t('Voice')}
                  </Text>
                </Pressable>
              ) : null}
            </View>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={t('Delete note')}
              onPress={() => { void deleteNote(note.id); }}
              style={styles.itemAction}
            >
              <Ionicons name="trash-outline" size={18} color={theme.mutedForeground} />
            </Pressable>
          </View>
        ))}

        <Text style={[styles.sectionLabel, { color: theme.mutedForeground }]}>{t('Quick task').toLocaleUpperCase(locale)}</Text>
        <Body muted>{t('Holds up to {count} tasks.', { count: MAX_QUICK_TASKS })}</Body>
        <View ref={taskRowRef} style={styles.composerRow}>
          {task.shown ? <><TextInput
            accessibilityLabel={t('New task title')}
            onFocus={() => { taskFocusedRef.current = true; keyboardReveal.reveal(taskRowRef.current); }}
            onBlur={() => { taskFocusedRef.current = false; keyboardReveal.release(taskRowRef.current); }}
            maxLength={QUICK_TASK_TITLE_LIMIT}
            keyboardAppearance={theme.appearance}
            selectionColor={theme.primary}
            placeholder={taskPlaceholder}
            placeholderTextColor={theme.quietForeground}
            onLayout={(event) => setTaskLineWidth(Math.round(event.nativeEvent.layout.width - INPUT_HORIZONTAL_CHROME))}
            maxFontSizeMultiplier={placeholderFitMultiplier(taskPlaceholder, INPUT_FONT_SIZE, taskLineWidth)}
            value={taskDraft}
            onChangeText={setTaskDraft}
            editable={task.pending === false}
            onSubmitEditing={() => { void addTask(); }}
            returnKeyType="done"
            style={[...inputStyle, styles.rowInput]}
          />
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={t('Create task')}
            accessibilityState={{ disabled: taskBusy || !taskDraft.trim() }}
            disabled={taskBusy || !taskDraft.trim()}
            onPress={() => { void addTask(); }}
            style={({ pressed }) => [
              styles.circleButton,
              { backgroundColor: taskDraft.trim() ? theme.primary : theme.muted, opacity: pressed ? 0.82 : 1 },
            ]}
          >
            <Ionicons name="add" size={24} color={taskDraft.trim() ? theme.primaryForeground : theme.mutedForeground} />
          </Pressable></> : task.checkFailed ? null : <Body muted style={styles.rowInput}>{t('Loading quick capture…')}</Body>}
        </View>
        {taskMessage ? <Body style={{ color: theme.destructive }}>{taskMessage}</Body> : null}
        {tasks.map((task) => (
          <View key={task.id} style={[styles.itemRow, { borderColor: theme.border }]}>
            <Pressable
              accessibilityRole="checkbox"
              accessibilityState={{ checked: task.done, disabled: taskSaving }}
              disabled={taskSaving}
              accessibilityLabel={task.title}
              onPress={() => { void toggleTask(task.id); }}
              style={styles.taskToggle}
            >
              <Ionicons
                name={task.done ? 'checkmark-circle' : 'ellipse-outline'}
                size={24}
                color={task.done ? theme.primary : theme.mutedForeground}
              />
              <Body style={task.done ? { textDecorationLine: 'line-through', color: theme.mutedForeground } : null}>
                {task.title}
              </Body>
            </Pressable>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={t('Delete task')}
              accessibilityState={{ disabled: taskSaving }}
              disabled={taskSaving}
              onPress={() => { void deleteTask(task.id); }}
              style={styles.itemAction}
            >
              <Ionicons name="trash-outline" size={18} color={theme.mutedForeground} />
            </Pressable>
          </View>
        ))}

    </View>
  );
}

const styles = StyleSheet.create({
  section: { gap: spacing.md },
  sectionLabel: { fontSize: 11, ...typeface.controlStrong, letterSpacing: 1.5, marginTop: spacing.md },
  composerRow: { flexDirection: 'row', alignItems: 'flex-end', gap: spacing.sm },
  rowInput: { flex: 1 },
  input: {
    minHeight: minimumTouchTarget,
    borderWidth: INPUT_BORDER,
    borderRadius: radii.md,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    fontSize: INPUT_FONT_SIZE,
    lineHeight: INPUT_LINE_HEIGHT,
  },
  noteInput: { maxHeight: MULTILINE_MAX_HEIGHT, paddingTop: spacing.sm },
  circleButton: {
    width: minimumTouchTarget,
    height: minimumTouchTarget,
    borderRadius: radii.pill,
    alignItems: 'center',
    justifyContent: 'center',
  },
  metaRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm, minHeight: minimumTouchTarget },
  recordingDot: { width: 10, height: 10, borderRadius: 5 },
  memoChip: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    borderWidth: 1,
    borderRadius: radii.md,
    paddingHorizontal: spacing.md,
  },
  memoAction: { flexDirection: 'row', alignItems: 'center', gap: spacing.xs, minHeight: minimumTouchTarget, minWidth: minimumTouchTarget },
  noteAction: { minHeight: minimumTouchTarget, justifyContent: 'center' },
  memoText: { fontSize: 14, lineHeight: 19, ...typeface.control },
  itemRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    borderBottomWidth: StyleSheet.hairlineWidth,
    paddingVertical: spacing.xs,
  },
  itemBody: { flex: 1, gap: 2 },
  noteBody: { fontSize: 16, lineHeight: 23 },
  itemAction: {
    width: minimumTouchTarget,
    height: minimumTouchTarget,
    alignItems: 'center',
    justifyContent: 'center',
  },
  taskToggle: { flex: 1, flexDirection: 'row', alignItems: 'center', gap: spacing.sm, minHeight: minimumTouchTarget },
});
