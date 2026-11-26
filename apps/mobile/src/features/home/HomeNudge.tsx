// REQ-UG-HOME-NUDGES-20261001, native half: at most one Home nudge
// (onboarding first, then the Union Ground starting list for an organization
// with no checklist of its own, then passkey), never during the guided first
// run (the server folds 's onboarding guide into its answer), with Not
// now. Opening the starting list retires its card on this phone.

import { Ionicons } from '@expo/vector-icons';
import { useRouter } from 'expo-router';
import { useEffect, useState } from 'react';
import { StyleSheet, View } from 'react-native';

import { Body, Button, Card, Heading } from '../../components/ui';
import { chooseHomeNudge, type HomeNudgeHistory, type HomeNudgeServer } from '../../lib/nudgesShared';
import { haptics } from '../../services/haptics';
import { dismissHomeNudge, loadHomeNudges, markHomeNudgeShown, readHomeNudgeHistory } from '../../services/homeNudges';
import { useApp } from '../../state/AppProvider';
import { useTheme } from '../../theme/ThemeProvider';
import { spacing } from '../../theme/tokens';

const PASSKEY_DELAY_MS = 10 * 60 * 1000;

export function HomeNudge() {
  const router = useRouter();
  const theme = useTheme();
  const { mode, session } = useApp();
  const userID = mode === 'authenticated' ? session?.user.id ?? null : null;
  const [server, setServer] = useState<HomeNudgeServer | null>(null);
  const [history, setHistory] = useState<HomeNudgeHistory>({});
  const hasPasskey = null;
  const [now, setNow] = useState(() => Date.now());
  const signedInAt = Date.parse(session?.user.last_sign_in_at ?? '');

  useEffect(() => {
    if (!userID || !session) { setServer(null); return undefined; }
    let active = true;
    void loadHomeNudges(session).then((value) => { if (active) setServer(value); }).catch(() => { if (active) setServer(null); });
    void readHomeNudgeHistory(userID).then((value) => { if (active) setHistory(value); });
    return () => { active = false; };
  }, [userID, session]);

  useEffect(() => {
    if (!Number.isFinite(signedInAt)) return undefined;
    const wait = signedInAt + PASSKEY_DELAY_MS - Date.now();
    if (wait <= 0) return undefined;
    const timer = setTimeout(() => setNow(Date.now()), wait + 1);
    return () => clearTimeout(timer);
  }, [signedInAt]);

  const nudge = chooseHomeNudge({
    server,
    welcomeTourActive: false,
    // Union Ground offers no passkey sign-in, so only the onboarding nudge runs.
    passkeySupported: false,
    hasPasskey,
    signedInAt: Number.isFinite(signedInAt) ? signedInAt : null,
    history,
    now: Math.max(now, Date.now()),
  });

  useEffect(() => {
    if (!nudge || !userID) return;
    void markHomeNudgeShown(userID, nudge.kind);
  }, [nudge?.kind, userID]);

  if (!nudge || !userID) return null;
  const onboarding = nudge.kind === 'onboarding';
  const starter = nudge.kind === 'starter';
  const retire = () => {
    setHistory((current) => ({ ...current, [nudge.kind]: { ...(current[nudge.kind] ?? {}), dismissedAt: Date.now() } }));
    void dismissHomeNudge(userID, nudge.kind);
  };
  const notNow = () => {
    void haptics.select();
    retire();
  };
  const copy = starter
    ? {
        title: 'New here? Start with these 4 steps',
        body: 'Your campaign has not added its own onboarding checklist yet, so here is where most new workers start.',
        action: 'See the 4 steps',
      }
    : onboarding
      ? {
          title: 'Complete your onboarding',
          body: `Step ${nudge.completed + 1} of ${nudge.total}. Pick up your checklist where you left off.`,
          action: 'Continue onboarding',
        }
      : {
          title: 'Sign in faster with a passkey',
          body: 'Use Face ID, Touch ID or a security key instead of typing your password.',
          action: 'Add a passkey',
        };
  return (
    <Card>
      <View style={styles.head}>
        <Ionicons name={starter || onboarding ? 'list-outline' : 'key-outline'} size={18} color={theme.primary} accessibilityElementsHidden />
        <Heading level={3}>{copy.title}</Heading>
      </View>
      <Body muted>{copy.body}</Body>
      <View style={styles.actions}>
        <Button
          label={copy.action}
          onPress={() => {
            if (starter) retire();
            router.push((starter || onboarding ? '/feature/member-support?source=onboarding' : '/account') as never);
          }}
        />
        <Button label="Not now" variant="secondary" onPress={notNow} />
      </View>
    </Card>
  );
}

const styles = StyleSheet.create({
  head: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  actions: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm },
});
