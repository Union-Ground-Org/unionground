// Your mentions: campaign channel posts that mention the worker or ping @here,
// newest first (REQ-UG-CHANNEL-CONTROLS-RESTORED-20261001). The server
// searches only live bodies in channels the worker can read now.
import { Redirect, useRouter } from 'expo-router';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Platform, StyleSheet, View } from 'react-native';

import { PinnedHeaderScreen } from '../src/components/PinnedHeader';
import { Body, Button, Card, Heading, Notice, Screen, SearchField, StateMessage } from '../src/components/ui';
import { channelControlsApi, useChannelControls, type MentionHit } from '../src/data/channelControls';
import { isChannelControlDisabled } from '../src/lib/channelControlsShared';
import { useApp } from '../src/state/AppProvider';
import { spacing } from '../src/theme/tokens';
import { useNativeUi } from '../src/lib/useNativeUi';

export default function MentionsRoute() {
  const { catalogLabel } = useNativeUi();
  const { mode, session, organizationID, dashboard } = useApp();
  if (mode === 'signedOut') return <Redirect href="/sign-in" />;
  if (mode === 'mfaRequired') return <Redirect href="/mfa-challenge" />;
  const scope = JSON.stringify([mode, session?.user.id, organizationID, dashboard?.member.chapterID]);
  return <PinnedHeaderScreen screenName={catalogLabel("Your mentions")}><MentionList key={scope} enabled={mode === 'authenticated'} /></PinnedHeaderScreen>;
}

function MentionList({ enabled }: { enabled: boolean }) {
  const { catalogLabel, t } = useNativeUi();
  const router = useRouter();
  const { controls, status, reload } = useChannelControls();
  const [retryingControls, setRetryingControls] = useState(false);
  const controlsRetryInFlight = useRef(false);
  const [query, setQuery] = useState('');
  const [rows, setRows] = useState<MentionHit[]>([]);
  const [state, setState] = useState<'idle' | 'loading' | 'ready' | 'error' | 'off'>('idle');
  const run = useRef(0);
  const search = useCallback(async (needle: string) => {
    const current = ++run.current;
    setState('loading');
    try {
      const found = await channelControlsApi.searchMentions(needle.trim());
      if (current !== run.current) return;
      setRows(found);
      setState('ready');
    } catch (error) {
      if (current !== run.current) return;
      setRows([]);
      setState(isChannelControlDisabled(error) ? 'off' : 'error');
    }
  }, []);
  useEffect(() => {
    if (!enabled || status !== 'ready' || !controls.switches.mentionSearch) return undefined;
    const timer = setTimeout(() => { void search(query); }, 250);
    return () => clearTimeout(timer);
  }, [controls.switches.mentionSearch, enabled, query, search, status]);

  async function retryControls() {
    if (controlsRetryInFlight.current) return;
    controlsRetryInFlight.current = true;
    setRetryingControls(true);
    try {
      await reload();
    } finally {
      controlsRetryInFlight.current = false;
      setRetryingControls(false);
    }
  }

  if (!enabled) return <Screen><StateMessage title="Sign in to see your mentions" body="Mentions come from your campaign channels." /></Screen>;
  if (status === 'loading') return <Screen><StateMessage title={t('Loading your mentions')} body={t('Checking your campaign channels.')} /></Screen>;
  if (status !== 'ready') {
    return <Screen>
      <Notice>{t('Could not check mention search.')}</Notice>
      <Button label={t('Try again')} variant="secondary" busy={retryingControls} onPress={() => { void retryControls(); }} />
    </Screen>;
  }
  if (!controls.switches.mentionSearch) {
    return <Screen><Notice>{t('Mention search is off.')}</Notice></Screen>;
  }
  return (
    <Screen>
      <View style={styles.stack}>
        <Heading>{catalogLabel("Your mentions")}</Heading>
        <Body muted>Posts in your campaign channels that mention you or use @here.</Body>
        <SearchField value={query} onChangeText={setQuery} placeholder="Search your mentions" accessibilityLabel={Platform.OS === 'ios' ? undefined : 'Search your mentions'} />
        {state === 'loading' ? <Body muted accessibilityRole="text">Searching…</Body> : null}
        {state === 'error' ? <><Notice>Mentions could not be loaded.</Notice><Button label="Try again" variant="secondary" onPress={() => { void search(query); }} /></> : null}
        {state === 'off' ? <Notice>Your organization has turned mention search off.</Notice> : null}
        {state === 'ready' && rows.length === 0 ? <Body muted>No channel posts mention you yet.</Body> : null}
        {rows.map((hit) => (
          <Card key={hit.postId}>
            <Body>{`${hit.reason === 'here' ? `${hit.authorName ?? 'Someone'} used @here` : `${hit.authorName ?? 'Someone'} mentioned you`} in ${hit.threadTitle}`}</Body>
            <Body muted>{hit.body}</Body>
            <Button label={`Open the post in ${hit.threadTitle}`} variant="secondary"
              onPress={() => router.push(`/channel/${encodeURIComponent(hit.threadId)}?post=${encodeURIComponent(hit.postId)}` as never)} />
          </Card>
        ))}
      </View>
    </Screen>
  );
}

const styles = StyleSheet.create({
  stack: { gap: spacing.md },
});
