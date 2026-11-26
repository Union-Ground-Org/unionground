import { useCallback, useMemo, useRef, useState } from 'react';
import * as React from 'react';
import { useFocusEffect } from 'expo-router';
import { AppState, View } from 'react-native';
import { ANNOUNCEMENT_PAGE, announcementScope, createAnnouncementApi, type AnnouncementApi, type FollowSettings } from '../../../../src/features/platformAnnouncements/api.js';
import { useAnnouncementFeedWith } from '../../../../src/features/platformAnnouncements/useAnnouncementFeed.js';
import { Body, Button, Card, Heading, Notice } from '../components/ui';
import { createCapturedSessionRpcClient } from '../services/supabase';
import { useApp } from '../state/AppProvider';
import { spacing } from '../theme/tokens';

const notice = "Receive Union Ground product updates in your organization's workspace. Workers can hide these updates. Union Ground sees your organization's follow status, not worker lists or reading activity. Your administrator can stop following at any time.";

function announcementContext(app: ReturnType<typeof useApp>) {
  const { mode, session, organizationID, dashboard, chosenStaffRole, sessionRestricted, locked, privacyCovered, assuranceUnavailable } = app;
  const scope = announcementScope({ session, organizationId: organizationID, chapterId: dashboard?.member?.chapterID ?? null,
    hat: chosenStaffRole ?? 'member', locale: 'en' });
  const enabled = mode === 'authenticated' && !sessionRestricted && !locked && !privacyCovered && !assuranceUnavailable;
  return { scope, enabled, session, organizationID };
}

export function NativeAnnouncementToggle({ query }: { query: string }) {
  const { scope, enabled } = announcementContext(useApp());
  const [expanded, setExpanded] = useState(false);
  if (!scope || !enabled || query.trim()) return null;
  return <>
    <Button label={expanded ? 'Close product updates' : 'Union Ground updates'} variant="secondary" onPress={() => setExpanded(value => !value)} />
    {expanded ? <NativePlatformAnnouncements /> : null}
  </>;
}

export function NativePlatformAnnouncements({ settings = false }: { settings?: boolean }) {
  const { scope, enabled, session, organizationID } = announcementContext(useApp());
  const api = useMemo(() => scope && enabled && session && organizationID ? createAnnouncementApi(createCapturedSessionRpcClient(session), organizationID) : null, [scope, enabled, session, organizationID]);
  if (!scope || !api) return null;
  return settings ? <NativeAnnouncementFollow key={scope} api={api} /> : <NativeAnnouncementReader key={scope} api={api} />;
}

export function NativeAnnouncementReader({ api }: { api: AnnouncementApi }) {
  const { state, refresh, clear, preference } = useAnnouncementFeedWith(React, api, 'en', false);
  useFocusEffect(useCallback(() => {
    let focused = true;
    void refresh();
    const listener = AppState.addEventListener('change', next => {
      if (!focused) return;
      if (next === 'active') void refresh(); else clear();
    });
    return () => { focused = false; listener.remove(); clear(); };
  }, [refresh, clear]));
  return <Card>
    <Heading level={2}>Union Ground updates</Heading>
    <Body>{notice}</Body>
    <Button label="Refresh updates" variant="secondary" disabled={state.loading || state.busy} onPress={() => { void refresh(); }} />
    <Button label={state.hidden ? 'Show these updates' : 'Hide these updates'} variant="secondary" disabled={state.loading || state.busy} onPress={() => { void preference(!state.hidden); }} />
    {state.loading ? <Body>Loading updates…</Body> : null}
    {state.error ? <Notice>Updates are unavailable. Refresh to try again.</Notice> : null}
    {state.hidden ? <Body>Product updates are hidden for you.</Body> : null}
    {state.expired ? <Body>Refresh to check for current updates.</Body> : null}
    {!state.loading && !state.error && !state.hidden && !state.expired && !state.items.length ? <Body>No product updates to show.</Body> : null}
    {state.items.map(item => <View key={`${state.generation}:${item.id}`} style={{ gap: spacing.sm }}>
      <Heading level={3}>{item.title}</Heading><Body>{item.body}</Body><Body muted>{new Date(item.publishedAt).toLocaleDateString('en-US')}</Body>
    </View>)}
    {state.items.length === ANNOUNCEMENT_PAGE ? <Button label="Older updates" variant="secondary" onPress={() => { void refresh(state.items.at(-1)); }} /> : null}
  </Card>;
}

export function NativeAnnouncementFollow({ api }: { api: AnnouncementApi }) {
  const [settings, setSettings] = useState<FollowSettings | null>(null);
  const [error, setError] = useState(false);
  const [busy, setBusy] = useState(false);
  // The generation a follow answer produced; its acknowledgement shows only
  // while that state is the one on screen.
  const [savedGeneration, setSavedGeneration] = useState<number | null>(null);
  const [confirm, setConfirm] = useState(false);
  // The settings read is keyed to the api, so a renewed api (a refreshed token
  // for the same scope) reads again. The follow write has its own run that
  // only leaving the screen retires, so that read never drops a follow still
  // writing or its acknowledgement.
  const run = useRef(0);
  const followRun = useRef(0);
  const working = useRef(false);
  // The server's generation only grows (a follow makes it odd, a revoke the
  // next even number), so every read, follow answer and failure reload installs
  // its settings only when they are not older than the newest already
  // installed: a late answer never replaces another administrator's newer
  // change (round 1 r1s1 of #9391), and an equal one is the same state.
  const newest = useRef(-1);
  const install = useCallback((next: FollowSettings) => {
    if (next.generation < newest.current) return false;
    newest.current = next.generation;
    setSettings(next);
    return true;
  }, []);
  const load = useCallback(async () => {
    const current = ++run.current;
    setSettings(null); setError(false);
    try { const result = await api.settings(); if (run.current === current) install(result); }
    catch (cause) { if (run.current === current && !(cause as { denied?: boolean })?.denied) setError(true); }
  }, [api, install]);
  const latestLoad = useRef(load);
  latestLoad.current = load;
  useFocusEffect(useCallback(() => { void load(); return () => { run.current += 1; setSettings(null); }; }, [load]));
  useFocusEffect(useCallback(() => () => { followRun.current += 1; }, []));
  async function follow(enabled: boolean) {
    if (working.current || !settings) return;
    working.current = true; setBusy(true); setSavedGeneration(null); setConfirm(false);
    const current = ++followRun.current;
    try {
      const result = await api.follow(enabled, settings.generation);
      // An answer older than the state on screen installs nothing and shows no
      // acknowledgement: the write happened, but a newer change replaced it.
      if (followRun.current === current) { if (install(result)) setSavedGeneration(result.generation); setError(false); }
    }
    // Leaving the screen during the reload retires the failure line with it.
    catch { if (followRun.current === current) { await latestLoad.current(); if (followRun.current === current) setError(true); } }
    finally { working.current = false; setBusy(false); }
  }
  if (!settings && !error) return null;
  return <Card>
    <Heading level={2}>Organization product updates</Heading>
    <Body>{notice}</Body>
    {error ? <Notice>Updates are unavailable. Refresh to try again.</Notice> : null}
    {settings ? <>
      <Body>{settings.enabled ? 'Your organization is following product updates.' : 'Your organization is not following product updates.'}</Body>
      {confirm ? <>
        <Body>Stop following for everyone in your organization? Previous updates will no longer be available and new deliveries will stop.</Body>
        <Button label="Stop following for everyone" disabled={busy} onPress={() => { void follow(false); }} />
        <Button label="Cancel" variant="secondary" disabled={busy} onPress={() => setConfirm(false)} />
      </> : <Button label={settings.enabled ? 'Stop following' : 'Follow product updates'} disabled={busy} onPress={() => settings.enabled ? setConfirm(true) : void follow(true)} />}
    </> : null}
    {settings && savedGeneration === settings.generation ? <Body>Preference saved.</Body> : null}
    <Button label="Refresh updates" variant="secondary" disabled={busy} onPress={() => { void load(); }} />
  </Card>;
}
