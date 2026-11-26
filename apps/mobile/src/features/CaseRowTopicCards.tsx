import { checkBusinessContinuation } from '../lib/businessWriteContinuation';
// REQ-UG-LIST-ROW-DETAIL-TOGGLE-CHAPTER-AND-STEWARD-20261104 (#7043):
// case lists name a case by reference, type and step (#7015). The chapter's
// leadership can show case topics in the chapter's lists, and a case's
// assigned steward can show that case's topic in their own lists. Each card
// renders only for the person the server says may change it.
import { useEffect } from 'react';
import { useBusinessWriter, useBusinessState, useBusinessRequests, useBusinessSubjectState, useBusinessOperationCache, useBusinessOperation } from '../lib/useBusinessWriter';
import type { MobileSessionWriter } from '../services/supabase';
import { Switch, View } from 'react-native';

import { Body, Card, Heading } from '../components/ui';
import { DisabledStateBoundary } from '../components/DisabledStateBoundary';
import { loadCaseRowTopic, loadChapterCaseRowTopic, saveCaseRowTopic, saveChapterCaseRowTopic } from '../services/caseRowTopic';
import { caseTopicNote, SAVE_FAILURE_MESSAGES, saveThenReload, type SaveFailure } from './caseRowTopicModel';
import { useApp } from '../state/AppProvider';
import { useTheme } from '../theme/ThemeProvider';
import { minimumTouchTarget, spacing } from '../theme/tokens';

type Setting = { value: boolean; note: string };

function useSetting(key: string | null | undefined, load: (key: string) => Promise<Setting | null>, save: (writer: MobileSessionWriter, key: string, value: boolean) => Promise<void>) {
  const writer = useBusinessWriter();
  const requests = useBusinessRequests(writer, key);
  const { mode, sessionRestricted } = useApp();
  const [setting, setSetting] = useBusinessSubjectState<Setting | null>(key ?? null, null);
  const [busy, setBusy] = useBusinessState(false);
  const [operate] = useBusinessOperation<boolean>(setBusy, false);
  const [failure, setFailure] = useBusinessSubjectState<SaveFailure | null>(key ?? null, null);
  // Each person/subject owns its reads. An accepted save invalidates that
  // subject's older reload even after a grant retires the write's ticket;
  // it cannot invalidate another person's or another case's current load.
  const generation = useBusinessOperationCache(key ?? null, () => ({ current: 0 }));
  useEffect(() => () => { generation.current += 1; }, [generation]);
  const live = mode === 'authenticated' && !sessionRestricted && Boolean(key);
  useEffect(() => { setSetting(null); setFailure(null); }, [requests, setSetting, setFailure]);
  useEffect(() => {
    const current = ++generation.current;
    const ticket = requests.capture();
    if (!live || !key) return;
    // A caller outside the role, or an older backend, gets no card.
    void load(key).then((value) => { if (ticket.isCurrent() && current === generation.current) setSetting(value); }).catch(() => undefined);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, live, requests, setSetting, setFailure, setBusy]);
  async function change(value: boolean) {
    if (!key || busy || !setting) return;
    const current = requests.capture().isCurrent;
    await operate(true, async () => {
        setFailure(null);
        let ownedGeneration: number | null = null;
        const outcome = await saveThenReload(async () => {
          await save(writer, key, value);
          ownedGeneration = ++generation.current;
          setSetting({ ...setting, value });
        }, async () => {
          if (await checkBusinessContinuation(writer, current) !== 'current') throw new Error('Saved; refresh unavailable');
          const reading = ++generation.current;
          ownedGeneration = reading;
          const loaded = await load(key);
          if (reading !== generation.current || !current()) throw new Error('Saved; reread superseded');
          return loaded;
        }, { ...setting, value });
        if (outcome.failure === 'save') setFailure('save');
        else if (ownedGeneration === generation.current) {
          setSetting(outcome.setting);
          setFailure(outcome.failure);
        }
    });
  }
  return { setting: live ? setting : null, busy, failure, change };
}

function SettingCard({ title, label, setting, busy, failure, change }: { title: string; label: string; setting: Setting; busy: boolean; failure: SaveFailure | null; change: (value: boolean) => Promise<void> }) {
  const theme = useTheme();
  return <Card>
    <Heading level={2}>{title}</Heading>
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: spacing.md, minHeight: minimumTouchTarget }}>
      <View style={{ flex: 1 }}><Body>{label}</Body></View>
      <DisabledStateBoundary disabled={busy} accessibilityRole="switch" accessibilityLabel={`${label}, saving`} checked={setting.value}>
        <Switch accessibilityLabel={label} accessibilityState={{ disabled: busy, busy }} disabled={busy} value={setting.value} onValueChange={(value) => { void change(value); }} trackColor={{ false: theme.muted, true: theme.primary }} thumbColor={setting.value ? theme.primaryForeground : theme.mutedForeground} hitSlop={12} />
      </DisabledStateBoundary>
    </View>
    <Body muted>{setting.note}</Body>
    {failure ? <Body>{SAVE_FAILURE_MESSAGES[failure]}</Body> : null}
  </Card>;
}

const CHAPTER_NOTE = 'Off by default: lists name an issue by reference, type and step. When on, people who can already read an issue also see its topic in lists. Restricted and private-identity issues stay neutral.';

async function loadChapter(chapterID: string): Promise<Setting | null> {
  const value = await loadChapterCaseRowTopic(chapterID);
  return value.canChange ? { value: value.enabled, note: CHAPTER_NOTE } : null;
}

async function loadCase(caseID: string): Promise<Setting | null> {
  const value = await loadCaseRowTopic(caseID);
  if (!value.canChange) return null;
  return { value: value.shown, note: caseTopicNote(value.chapterShown) };
}

export function ChapterCaseRowTopicCard({ chapterID }: { chapterID: string | null | undefined }) {
  const { setting, busy, failure, change } = useSetting(chapterID, loadChapter, saveChapterCaseRowTopic);
  if (!setting) return null;
  return <SettingCard title="Issue topics in lists" label="Show issue topics in this campaign's issue lists and search results" setting={setting} busy={busy} failure={failure} change={change} />;
}

export function CaseRowTopicCard({ caseID }: { caseID: string | null | undefined }) {
  const { setting, busy, failure, change } = useSetting(caseID, loadCase, saveCaseRowTopic);
  if (!setting) return null;
  return <SettingCard title="Issue topic in my lists" label="Show this issue's topic in my own issue lists" setting={setting} busy={busy} failure={failure} change={change} />;
}
