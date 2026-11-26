// REQ-UG-RIGHTS-RESUME-READING-20261029: the rights reader's one
// personal "Save my place" bookmark, kept in the device's secure storage
// under the current backend, account, organization and chapter. The rules
// (what is stored, how a resume resolves) live in lib/rightsResumeReading.
import * as SecureStore from 'expo-secure-store';
import { useCallback, useEffect, useMemo, useRef, useState, type RefObject } from 'react';
import { StyleSheet, View, type ScrollView } from 'react-native';
import { Text } from '../components/Text';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { usePinnedHeaderChrome } from '../components/PinnedHeader';
import { Body, Button, Card, Heading, Notice } from '../components/ui';
import { contentStartInset } from '../lib/chrome';
import { mobileConfig } from '../lib/config';
import { useNativeUi } from '../lib/useNativeUi';
import {
  createRightsBookmarkStore,
  rightsReadingSections,
  rightsResumeStoreKey,
  type RightsBookmark,
  type RightsReadingLesson,
  type RightsReadingScope,
} from '../lib/rightsResumeReading';
import { useApp } from '../state/AppProvider';
import { useTheme } from '../theme/ThemeProvider';
import { spacing } from '../theme/tokens';

import { typeface } from '../theme/typeface';
export const rightsBookmarks = createRightsBookmarkStore({
  getItemAsync: (key) => SecureStore.getItemAsync(key),
  setItemAsync: (key, value) => SecureStore.setItemAsync(key, value),
  deleteItemAsync: (key) => SecureStore.deleteItemAsync(key),
});

export function useRightsReadingScope(): RightsReadingScope | null {
  const { mode, session, organizationID, chapterMemberships, sessionRestricted } = useApp();
  const membership = chapterMemberships.find((entry) => entry.selected);
  const userID = session?.user.id;
  const chapterID = membership?.organizationID === organizationID ? membership?.chapterID : null;
  const backend = mobileConfig.supabaseUrl;
  return useMemo(() => mode === 'authenticated' && !sessionRestricted && backend && userID && organizationID && chapterID
    ? { backend, userID, organizationID, chapterID } : null,
  [mode, sessionRestricted, backend, userID, organizationID, chapterID]);
}

/** The bookmark for exactly this scope; a value read under another scope is never returned. */
export function useRightsBookmark(scope: RightsReadingScope | null) {
  const key = rightsResumeStoreKey(scope);
  const keyRef = useRef(key);
  keyRef.current = key;
  const scopeRef = useRef(scope);
  scopeRef.current = scope;
  const [state, setState] = useState<{ key: string | null; bookmark: RightsBookmark | null; readFailed: boolean }>({ key: null, bookmark: null, readFailed: false });
  const [reload, setReload] = useState(0);
  useEffect(() => {
    let current = true;
    setState({ key, bookmark: null, readFailed: false });
    if (!key) return undefined;
    void rightsBookmarks.read(scopeRef.current)
      .then((bookmark) => { if (current) setState({ key, bookmark, readFailed: false }); })
      .catch(() => { if (current) setState({ key, bookmark: null, readFailed: true }); });
    return () => { current = false; };
  }, [key, reload]);
  const save = useCallback(async (bookmark: RightsBookmark) => {
    const captured = keyRef.current;
    await rightsBookmarks.save(scopeRef.current, bookmark);
    if (keyRef.current === captured) setState({ key: captured, bookmark, readFailed: false });
  }, []);
  const clear = useCallback(async () => {
    const captured = keyRef.current;
    await rightsBookmarks.clear(scopeRef.current);
    if (keyRef.current === captured) setState({ key: captured, bookmark: null, readFailed: false });
  }, []);
  const refresh = useCallback(() => setReload((value) => value + 1), []);
  return {
    available: key !== null,
    bookmark: state.key === key ? state.bookmark : null,
    readFailed: state.key === key && state.readFailed,
    save,
    clear,
    refresh,
  };
}

export function ContinueReadingCard({ title, busy, onContinue, onClear }: {
  title: string | null;
  busy: boolean;
  onContinue: () => void;
  onClear: () => void;
}) {
  // The lesson title is chapter-published and stays as written.
  const { t } = useNativeUi();
  return (
    <Card>
      <Heading level={2}>{t('Continue reading')}</Heading>
      <Body muted>{title ? t('Your saved place in {title}.', { title }) : t('Your saved place in a rights lesson.')}</Body>
      <View style={styles.actions}>
        <Button label={t('Continue reading')} busy={busy} disabled={busy} onPress={onContinue} />
        <Button label={t('Clear saved place')} variant="secondary" disabled={busy} onPress={onClear} />
      </View>
    </Card>
  );
}

type ReaderLesson = RightsReadingLesson & { label: string; completedSteps: number[] };

/**
 * The lesson body as anchored sections. Each section is a direct child of the
 * Screen scroll content, so its layout y is a scroll position; the resume
 * target is scrolled to whenever its layout changes (first render, rotation,
 * text size), never restored from a stored pixel offset.
 */
export function RightsReadingSections({ lesson, scrollRef, scrollAnchor, savedAnchor, failedAnchor, saving, onSave }: {
  lesson: ReaderLesson;
  scrollRef: RefObject<ScrollView | null>;
  scrollAnchor: string | null;
  savedAnchor: string | null;
  /** Storage failure is shown at the section the member tried to save. */
  failedAnchor: string | null;
  saving: boolean;
  onSave: (anchor: string) => void;
}) {
  const theme = useTheme();
  const { t } = useNativeUi();
  const insets = useSafeAreaInsets();
  const pinned = usePinnedHeaderChrome();
  const topInset = pinned?.contentInset ?? contentStartInset(insets.top);
  const sections = rightsReadingSections(lesson);
  return <>
    {sections.map((section) => (
      <View
        key={section.anchor}
        style={styles.section}
        onLayout={(event) => {
          if (section.anchor !== scrollAnchor) return;
          scrollRef.current?.scrollTo({ y: Math.max(0, event.nativeEvent.layout.y - topInset), animated: false });
        }}
      >
        <Card>
          {section.kind === 'steps'
            ? <>
              <Text style={[styles.eyebrow, { color: theme.primary }]}>{t(lesson.steps.length === 1 ? '{label} · {done}/{total} STEP' : '{label} · {done}/{total} STEPS', { label: lesson.label.toLocaleUpperCase(), done: lesson.completedSteps.length, total: lesson.steps.length })}</Text>
              {lesson.steps.map((step, index) => <Body key={`${index}:${step}`}>{lesson.completedSteps.includes(index) ? '✓' : '○'} {step}</Body>)}
            </>
            : <Body>{section.text[0]}</Body>}
          {savedAnchor === section.anchor ? <Body muted>{t('Your saved place is here.')}</Body> : null}
        </Card>
        <Button label={t('Save my place')} variant="secondary" busy={saving} disabled={saving} onPress={() => onSave(section.anchor)} />
        {failedAnchor === section.anchor ? <Notice>{t('Your place could not be saved on this device. Try again.')}</Notice> : null}
      </View>
    ))}
  </>;
}

const styles = StyleSheet.create({
  actions: { gap: spacing.sm },
  section: { gap: spacing.sm },
  eyebrow: { fontSize: 12, lineHeight: 17, ...typeface.controlStrong, letterSpacing: 0.5 },
});
