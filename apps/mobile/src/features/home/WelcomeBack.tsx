// REQ-UG-REACTIVATION-WELCOME-BACK-20261001, native half: a worker whose
// previous visit was longer ago than the organization's limit (21 days by
// default) opens the live Home on one calm welcome-back view with a single
// picked next step, and can go straight to the full Home.

import { useNativeUi } from '../../lib/useNativeUi';
import { Ionicons } from '@expo/vector-icons';
import { useRouter } from 'expo-router';
import { useEffect, useState } from 'react';
import { AppState, StyleSheet, View } from 'react-native';

import { Body, Button, Card, Heading } from '../../components/ui';
import { welcomeBackStepCopy, welcomeBackText } from '../../lib/welcomeBackCopy';
import { resolveWelcomeBackStep } from '../../lib/welcomeBackShared';
import { dismissHomeReturn, homeReturnDecision, loadWelcomeBackExtras, recordMemberHomeReturn, type WelcomeBackExtras } from '../../services/memberHomeReturn';
import { useApp } from '../../state/AppProvider';
import { useTheme } from '../../theme/ThemeProvider';
import { spacing } from '../../theme/tokens';

// `decided` is false until this run's long-absence decision is known, so a
// caller that must not act before the takeover is settled (the first-view
// greeting) can wait (gate on #5056).
export function useNativeWelcomeBack(): { show: boolean; decided: boolean; dismiss: () => void } {
  const { mode, session } = useApp();
  const userID = mode === 'authenticated' ? session?.user.id ?? null : null;
  const [decision, setDecision] = useState(() => (userID ? homeReturnDecision(userID) : null));
  // BUG-UG-WELCOME-BACK-ACTIVITY-CACHE-20261002: every return to the
  // foreground asks again; the service records at most once per day.
  const [resumes, setResumes] = useState(0);
  useEffect(() => {
    const subscription = AppState.addEventListener('change', (next) => {
      if (next === 'active') setResumes((count) => count + 1);
    });
    return () => subscription.remove();
  }, []);
  useEffect(() => {
    if (!userID || !session) { setDecision(null); return undefined; }
    let active = true;
    setDecision(homeReturnDecision(userID));
    void recordMemberHomeReturn(session).then((next) => { if (active) setDecision(next); });
    return () => { active = false; };
  }, [userID, session, resumes]);
  return {
    show: decision === 'welcome',
    decided: decision !== null,
    dismiss: () => { if (userID) dismissHomeReturn(userID); setDecision('seen'); },
  };
}

export function WelcomeBackView({ onDismiss }: { onDismiss: () => void }) {
  const { language } = useNativeUi();
  const tr = (key: Parameters<typeof welcomeBackText>[1], values?: Record<string, string | number>) => welcomeBackText(language, key, values);
  const router = useRouter();
  const theme = useTheme();
  const { dashboard } = useApp();
  const [extras, setExtras] = useState<WelcomeBackExtras>({ openPolls: [], events: [] });
  const chapterID = dashboard?.member.chapterID ?? null;
  useEffect(() => {
    let active = true;
    void loadWelcomeBackExtras(chapterID).then((value) => { if (active) setExtras(value); }).catch(() => {});
    return () => { active = false; };
  }, [chapterID]);
  if (!dashboard) return null;
  const unread = dashboard.notifications.filter((item) => !item.readAt);
  const step = resolveWelcomeBackStep({
    unreadUpdates: unread.length,
    newestUpdateTitle: unread[0]?.title ?? null,
    openPolls: extras.openPolls,
    events: extras.events,
    activeCases: dashboard.cases.filter((item) => item.status.toLowerCase() === 'active'),
    now: new Date(),
  });
  const copy = welcomeBackStepCopy(step, language);
  const nextEvent = extras.events[0] ?? null;
  const name = dashboard.member.firstName.trim() || tr('welcomeBack.friend');
  return (
    <View style={styles.wrap}>
      <Body muted>{tr('welcomeBack.eyebrow')}</Body>
      <Heading>{tr('welcomeBack.title', { name })}</Heading>
      <Body muted>{tr('welcomeBack.lede')}</Body>
      <Card>
        <Heading level={3}>{tr(unread.length === 1 ? 'welcomeBack.factUpdatesOne' : 'welcomeBack.factUpdates', { count: unread.length })}</Heading>
        <Body muted>{unread[0]?.title ? tr('welcomeBack.factUpdatesNewest', { title: unread[0].title }) : tr('welcomeBack.factUpdatesBody')}</Body>
      </Card>
      <Card>
        <Heading level={3}>{tr(nextEvent ? 'welcomeBack.factActiveTitle' : 'welcomeBack.factMovingTitle')}</Heading>
        <Body muted>{nextEvent
          ? tr('welcomeBack.factActiveEvent', { title: nextEvent.title, date: new Intl.DateTimeFormat(language === 'es' ? 'es-US' : 'en-US', { month: 'short', day: 'numeric' }).format(new Date(nextEvent.startsAt)) })
          : extras.openPolls[0] ? tr('welcomeBack.factActivePoll', { title: extras.openPolls[0].title }) : tr('welcomeBack.factMovingBody')}</Body>
      </Card>
      <Card>
        <Heading level={3}>{tr('welcomeBack.factBenefitsTitle')}</Heading>
        <Body muted>{tr('welcomeBack.factBenefitsBody')}</Body>
      </Card>
      <Card hero>
        <View style={styles.stepHead}>
          <Ionicons name="sparkles-outline" size={18} color={theme.primary} accessibilityElementsHidden />
          <Heading level={3}>{tr('welcomeBack.stepTitle')}</Heading>
        </View>
        <Body>{copy.detail}</Body>
        <Button label={copy.label} onPress={() => { onDismiss(); router.push(copy.href as never); }} />
      </Card>
      <Button label={tr('welcomeBack.showHome')} variant="secondary" onPress={onDismiss} />
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { gap: spacing.md },
  stepHead: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
});
