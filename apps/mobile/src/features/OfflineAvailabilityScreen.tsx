import { useEffect, useRef, useState } from 'react';
import { AppState, Platform, StyleSheet, Switch, View } from 'react-native';
import { TextInput } from '../components/Text';

import { DisabledStateBoundary } from '../components/DisabledStateBoundary';
import { PinnedHeaderScreen } from '../components/PinnedHeader';
import { Body, Button, Card, Heading, Notice, Screen } from '../components/ui';
import { PUBLIC_LEARNING_GUIDES, PUBLIC_LEARNING_MAX_AGE_MS, savedAge, type PublicLearningLibrary } from '../lib/publicLearning';
import { OFFLINE_LIMITS, type OfflineAvailabilitySnapshot, type OfflineScope } from '../lib/offlineAvailability';
import { learningEditorForScope, reconcileLearningEditor, emptyLearningNoteEditor, type LearningNoteEditor, type ScopedLearningNoteEditor } from '../lib/learningNoteEditor';
import {
  readOfflineAvailability, setOfflineAvailability, saveOfflineLearningDraft,
  deleteOfflineLearningDraft,
} from '../services/offlineAvailability';
import {
  readPublicLearningLibrary, setPublicLearningEnabled, downloadPublicLearningGuide,
  clearPublicLearningDownloads,
} from '../services/publicLearningDownloads';
import { nativeUiSpanish, type NativeUiKey } from '../lib/nativeUiCopy';
import { useNativeUi } from '../lib/useNativeUi';
import { useApp } from '../state/AppProvider';
import { useLowData } from '../state/useLowData';
import { useTheme } from '../theme/ThemeProvider';
import { minimumTouchTarget, radii, spacing } from '../theme/tokens';
import { storageSize } from '../lib/storageSize';
import { useAccessibilityAnnouncementQueue } from '../lib/announce';

function failureCopy(error: unknown, fallback: NativeUiKey): NativeUiKey {
  if (!(error instanceof Error)) return fallback;
  if (error.message === `A learning note can hold up to ${OFFLINE_LIMITS.maxDraftBodyChars} characters.`) {
    return 'A learning note can hold up to {count} characters.';
  }
  if (error.message === `This phone can hold ${OFFLINE_LIMITS.maxDrafts} learning notes. Delete one to write another.`) {
    return 'This phone can hold {count} learning notes. Delete one to write another.';
  }
  return Object.hasOwn(nativeUiSpanish, error.message) ? error.message as NativeUiKey : fallback;
}

export function OfflineAvailabilityScreen() {
  const { t, language } = useNativeUi();
  const title = t('Saved guides and notes');
  const { mode, session, dashboard, organizationID, locked, privacyCovered, offlineDraftsReady } = useApp();
  const [composer, setComposer] = useState<ScopedLearningNoteEditor | null>(null);
  // Retain only the unsaved editor in memory during a privacy cover or fresh
  // authorization. It is never rendered until this exact scope is authorized.
  useEffect(() => {
    setComposer((previous) => previous && (mode === 'signedOut' || mode === 'preview'
      || (session?.user.id && session.user.id !== previous.accountID)
      || (organizationID && organizationID !== previous.organizationID)) ? null : previous);
  }, [mode, session?.user.id, organizationID]);
  const scope = offlineDraftsReady && !locked && !privacyCovered && mode === 'authenticated' && session && dashboard && organizationID
    ? { accountID: session.user.id, organizationID } : null;
  return <PinnedHeaderScreen title={title} screenName={title} language={language}>
    <Screen>
      <PublicDownloads readOnly={locked || privacyCovered} />
      {scope ? <LearningNotes key={`${scope.accountID}:${scope.organizationID}`} scope={scope}
        editor={learningEditorForScope(composer, scope)}
        updateEditor={(update) => setComposer((previous) => ({ ...scope, ...update(learningEditorForScope(previous, scope)) }))} /> : <Card>
        <Heading level={3} fitWords>{t('Personal learning notes')}</Heading>
        <Body muted fitWords>{session
          ? t('Notes are hidden while your session is locked or revalidating. Reconnect and refresh to unlock them. Public downloads stay available here.')
          : t('Sign in and load your campaign while connected to unlock notes for that account. Public downloads stay available here.')}</Body>
      </Card>}
      <Card>
        <Heading level={3} fitWords>{t('What needs a connection?')}</Heading>
        <Body fitWords>{t('Sign-in, private records, messages, votes, issue evidence, uploads and changes saved to your campaign need a connection. They are not queued here.')}</Body>
        <Body muted fitWords>{t('Downloaded public guides expire after 30 days. Learning notes stay on this phone for up to seven days.')}</Body>
      </Card>
    </Screen>
  </PinnedHeaderScreen>;
}

function PublicDownloads({ readOnly }: { readOnly: boolean }) {
  const { t, catalogLabel } = useNativeUi();
  const theme = useTheme();
  const policy = useLowData();
  const [library, setLibrary] = useState<PublicLearningLibrary | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<NativeUiKey | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const [confirmClear, setConfirmClear] = useState(false);
  const [now, setNow] = useState(Date.now());
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    const reload = () => {
      setNow(Date.now());
      void readPublicLearningLibrary().then((next) => { if (mounted.current) setLibrary(next); })
        .catch(() => { if (mounted.current) setError('Downloads are unavailable in this build.'); });
    };
    reload();
    const timer = setInterval(reload, 60_000);
    const subscription = AppState.addEventListener('change', (state) => { if (state === 'active') reload(); });
    return () => { mounted.current = false; clearInterval(timer); subscription.remove(); };
  }, []);

  useEffect(() => {
    const remaining = (library?.downloads ?? []).map((item) => item.downloadedAt + PUBLIC_LEARNING_MAX_AGE_MS - Date.now()).filter((age) => age > 0);
    if (!remaining.length) return;
    const nextExpiry = Math.min(...remaining);
    if (nextExpiry > 60_000) return;
    const timer = setTimeout(() => setNow(Date.now()), nextExpiry);
    return () => clearTimeout(timer);
  }, [library, now]);

  async function run(label: string, action: () => Promise<PublicLearningLibrary>) {
    if (busy || readOnly) return;
    setBusy(label); setError(null);
    try {
      const next = await action();
      if (mounted.current) { setLibrary(next); setNow(Date.now()); }
    } catch (nextError) {
      if (mounted.current) setError(failureCopy(nextError, 'The download could not be saved. Try again.'));
    } finally { if (mounted.current) setBusy(null); }
  }

  const saveGuidesLabel = t('Save public guides on this phone');
  const visibleDownloads = library?.downloads.filter((item) => now >= item.downloadedAt && now - item.downloadedAt < PUBLIC_LEARNING_MAX_AGE_MS) ?? [];
  return <>
    <Card>
      <Heading level={2} fitWords>{t('Public learning downloads')}</Heading>
      <View style={styles.switchRow}>
        <Body fitWords>{t('Save guides on this phone')}</Body>
        <DisabledStateBoundary disabled={readOnly || Boolean(busy) || !library} accessibilityRole="switch"
          accessibilityLabel={saveGuidesLabel} checked={library?.enabled ?? false}>
        <Switch style={{ minWidth: minimumTouchTarget, minHeight: minimumTouchTarget }} accessibilityLabel={saveGuidesLabel} disabled={readOnly || Boolean(busy) || !library}
          accessibilityState={{ disabled: readOnly || Boolean(busy) || !library, checked: library?.enabled ?? false }}
          value={library?.enabled ?? false}
          onValueChange={(enabled) => {
            if (!enabled && visibleDownloads.length) { setConfirmClear(true); return; }
            void run('settings', () => setPublicLearningEnabled(enabled));
          }}
          trackColor={{ false: theme.border, true: theme.primary }} />
        </DisabledStateBoundary>
      </View>
      {readOnly ? <Body muted fitWords>{t('Unlock your session to change downloads. Saved public guides can still be read.')}</Body> : null}
      <Body muted fitWords>{t('Download while connected. Read without signing in. These public guides contain no campaign records.')}</Body>
      <Body fitWords>{t(visibleDownloads.length === 1 ? '{count} guide · {size} stored' : '{count} guides · {size} stored', {
        count: visibleDownloads.length, size: storageSize(visibleDownloads.reduce((total, item) => total + item.bytes, 0)),
      })}</Body>
      {error ? <Notice>{t(error)}</Notice> : null}
      {busy ? <Body fitWords>{t(busy === 'settings' ? 'Updating…' : busy === 'clear' ? 'Clearing…' : 'Downloading…')}</Body> : null}
      <Button fitWords label={t('Clear downloads')} variant="secondary" disabled={readOnly || Boolean(busy) || !visibleDownloads.length} onPress={() => setConfirmClear(true)} />
      {confirmClear ? <>
        <Body fitWords>{t('Remove every public guide and turn off downloads on this phone?')}</Body>
        <Button fitWords label={t('Remove downloads')} variant="danger" disabled={readOnly || Boolean(busy)} onPress={() => {
          setOpen(null);
          void run('clear', async () => { await clearPublicLearningDownloads(); const next = await setPublicLearningEnabled(false); setConfirmClear(false); return next; });
        }} />
        <Button fitWords label={t('Keep downloads')} variant="secondary" onPress={() => setConfirmClear(false)} />
      </> : null}
    </Card>
    {PUBLIC_LEARNING_GUIDES.map((guide) => {
      const download = visibleDownloads.find((item) => item.id === guide.id);
      const title = catalogLabel(guide.title);
      return <Card key={guide.id}>
        <Heading level={3} fitWords>{title}</Heading>
        <Body muted fitWords>{download
          ? `${savedAge(t, download.downloadedAt, now)} · ${storageSize(download.bytes)}`
          : t('Not downloaded')}</Body>
        <Body muted fitWords>{t('Public app guide · revision {revision} · reviewed {date}', { revision: guide.revision, date: guide.reviewedAt })}</Body>
        {download ? <Button fitWords label={open === guide.id ? t('Close guide') : t('Read {title}', { title })} variant="secondary" onPress={() => setOpen(open === guide.id ? null : guide.id)} /> : null}
        {open === guide.id && download ? <Body fitWords>{catalogLabel(guide.body)}</Body> : null}
        <Button fitWords label={t(download ? 'Update {title}' : 'Download {title}', { title })} variant="secondary"
          disabled={readOnly || !library?.enabled || Boolean(busy) || policy.signals.connected === false}
          onPress={() => { void run(guide.id, () => downloadPublicLearningGuide(guide.id)); }} />
      </Card>;
    })}
    {policy.signals.connected === false ? <Body muted fitWords>{t('You’re offline. Saved public guides remain available.')}</Body> : null}
  </>;
}

function LearningNotes({ scope, editor, updateEditor }: { scope: OfflineScope; editor: LearningNoteEditor; updateEditor: (update: (previous: LearningNoteEditor) => LearningNoteEditor) => void }) {
  const { t } = useNativeUi();
  const theme = useTheme();
  const { accountID, organizationID } = scope;
  const [snapshot, setSnapshot] = useState<OfflineAvailabilitySnapshot | null>(null);
  const { body, editing } = editor;
  const editorUpdate = useRef(updateEditor);
  editorUpdate.current = updateEditor;
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<NativeUiKey | null>(null);
  const [confirmRemove, setConfirmRemove] = useState(false);
  const mounted = useRef(true);
  // #9460 M2-13: say why Save stays unavailable once the phone holds the most
  // notes. Android reads the mounted polite region when its text appears; iOS
  // hears the sentence once, through the app's announcement queue, when the
  // count reaches the cap (not on load, not on a later render).
  const queueAnnouncement = useAccessibilityAnnouncementQueue(`learning-notes:${accountID}:${organizationID}`);
  const fullText = t('This phone can hold {count} learning notes. Delete one to write another.', { count: OFFLINE_LIMITS.maxDrafts });
  const atCap = snapshot ? snapshot.enabled && snapshot.drafts.length >= OFFLINE_LIMITS.maxDrafts : null;
  const wasAtCap = useRef<boolean | null>(null);
  useEffect(() => {
    if (atCap === null) { wasAtCap.current = null; return undefined; }
    const reached = wasAtCap.current === false && atCap;
    wasAtCap.current = atCap;
    return reached && Platform.OS === 'ios' ? queueAnnouncement(fullText) : undefined;
  }, [atCap, fullText, queueAnnouncement]);
  useEffect(() => {
    mounted.current = true;
    const reload = () => {
      void readOfflineAvailability({ accountID, organizationID }).then((next) => { if (mounted.current) { setSnapshot(next); editorUpdate.current((previous) => next.enabled ? reconcileLearningEditor(previous, next.drafts, Date.now()) : emptyLearningNoteEditor()); } })
        .catch(() => { if (mounted.current) { setSnapshot(null); setError('Notes are locked or unavailable. Reconnect and refresh your account.'); } });
    };
    reload();
    const timer = setInterval(reload, 60_000);
    return () => { mounted.current = false; clearInterval(timer); };
  }, [accountID, organizationID]);

  useEffect(() => {
    const remaining = (snapshot?.drafts ?? []).map((draft) => draft.createdAt + OFFLINE_LIMITS.draftMaxAgeMs - Date.now()).filter((age) => age > 0);
    if (!remaining.length) return;
    const timer = setTimeout(() => {
      // Remove expired text synchronously before the asynchronous disk purge.
      setSnapshot(null);
      editorUpdate.current((previous) => reconcileLearningEditor(previous, snapshot?.drafts ?? [], Date.now()));
      void readOfflineAvailability({ accountID, organizationID }).then((next) => { if (mounted.current) { setSnapshot(next); editorUpdate.current((previous) => next.enabled ? reconcileLearningEditor(previous, next.drafts, Date.now()) : emptyLearningNoteEditor()); } })
        .catch(() => { if (mounted.current) setError('Notes are locked or unavailable. Reconnect and refresh your account.'); });
    }, Math.min(...remaining));
    return () => clearTimeout(timer);
  }, [snapshot, accountID, organizationID]);

  async function act(action: () => Promise<unknown>, clearInput = false) {
    if (busy) return;
    setBusy(true); setError(null);
    let actionCompleted = false;
    try {
      await action();
      actionCompleted = true;
      const next = await readOfflineAvailability(scope);
      if (mounted.current) { setSnapshot(next); if (clearInput) { editorUpdate.current(emptyLearningNoteEditor); setConfirmRemove(false); } }
    } catch (nextError) {
      if (mounted.current) setError(actionCompleted
        ? 'The change may have been applied. Refresh and check your notes.'
        : failureCopy(nextError, 'The note could not be saved. Your text is still here.'));
    } finally { if (mounted.current) setBusy(false); }
  }

  const noteCount = snapshot?.drafts.length ?? 0;
  return <Card>
    <Heading level={3} fitWords>{t('Personal learning notes')}</Heading>
    <Body muted fitWords>{t('Only learning reminders: no issue details, evidence or vote choices. Encrypted on this phone, never sent or synced. Changing accounts or campaigns removes them.')}</Body>
    <Body fitWords>{t(noteCount === 1 ? '{count} note · {size} stored' : '{count} notes · {size} stored', { count: noteCount, size: storageSize(snapshot?.bytes ?? 0) })}</Body>
    {snapshot && !snapshot.enabled ? <Button fitWords label={t('Allow learning notes on this phone')} variant="secondary" disabled={busy} onPress={() => { void act(() => setOfflineAvailability(scope, true)); }} /> : null}
    {snapshot?.enabled ? <>
      <DisabledStateBoundary disabled={busy} accessibilityRole="text" accessibilityLabel={t('Personal learning note, saving')}>
      <TextInput accessibilityLabel={t('Personal learning note')} value={body} onChangeText={(value) => updateEditor((previous) => ({ ...previous, body: value }))}
        placeholder={t('A reminder about using the app')} placeholderTextColor={theme.quietForeground}
        maxLength={OFFLINE_LIMITS.maxDraftBodyChars} multiline editable={!busy} keyboardAppearance={theme.appearance} selectionColor={theme.primary}
        style={[styles.input, { color: theme.foreground, backgroundColor: theme.background, borderColor: theme.border }]} />
      </DisabledStateBoundary>
      {body ? <Body muted fitWords>{t('Not saved yet.')}</Body> : null}
      <View accessibilityLiveRegion="polite">{atCap && !editing ? <Body muted fitWords>{fullText}</Body> : null}</View>
      <Button fitWords label={t(busy ? 'Saving…' : editing ? 'Save note changes' : 'Save note on this phone')} disabled={busy || !body.trim() || (!editing && snapshot.drafts.length >= OFFLINE_LIMITS.maxDrafts)}
        onPress={() => { void act(() => saveOfflineLearningDraft(scope, { body, ...(editing ? { id: editing.id, expectedRevision: editing.revision } : {}) }), true); }} />
      {body || editing ? <Button fitWords label={t(editing ? 'Cancel editing' : 'Clear draft text')} variant="secondary" disabled={busy} onPress={() => updateEditor(emptyLearningNoteEditor)} /> : null}
      {snapshot.drafts.filter((draft) => Date.now() - draft.createdAt < OFFLINE_LIMITS.draftMaxAgeMs).map((draft) => <View key={draft.id} style={styles.note}>
        <Body>{draft.body}</Body>
        <Body muted fitWords>{t('{age} · expires seven days after creation · only on this phone', { age: savedAge(t, draft.createdAt) })}</Body>
        <Button fitWords label={t('Edit note')} variant="secondary" disabled={busy || Boolean(body)} onPress={() => updateEditor(() => ({ body: draft.body, editing: { id: draft.id, revision: draft.revision } }))} />
        <Button fitWords label={t('Delete note')} variant="secondary" disabled={busy} onPress={() => { void act(() => deleteOfflineLearningDraft(scope, draft.id), editing?.id === draft.id); }} />
      </View>)}
      <Button fitWords label={t('Turn off and remove learning notes')} variant="danger" disabled={busy} onPress={() => setConfirmRemove(true)} />
      {confirmRemove ? <>
        <Body fitWords>{t('Delete every learning note and unsaved reminder on this phone? This cannot be undone.')}</Body>
        <Button fitWords label={t('Delete all learning notes')} variant="danger" disabled={busy} onPress={() => { void act(() => setOfflineAvailability(scope, false), true); }} />
        <Button fitWords label={t('Keep learning notes')} variant="secondary" disabled={busy} onPress={() => setConfirmRemove(false)} />
      </> : null}
    </> : null}
    {error ? <Notice>{t(error, {
      count: error === 'A learning note can hold up to {count} characters.' ? OFFLINE_LIMITS.maxDraftBodyChars : OFFLINE_LIMITS.maxDrafts,
    })}</Notice> : null}
  </Card>;
}

const styles = StyleSheet.create({
  switchRow: { minHeight: minimumTouchTarget, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: spacing.sm },
  input: { minHeight: minimumTouchTarget * 2, borderWidth: 1, borderRadius: radii.md, padding: spacing.md, fontSize: 16, textAlignVertical: 'top' },
  note: { gap: spacing.sm, paddingVertical: spacing.sm },
});
