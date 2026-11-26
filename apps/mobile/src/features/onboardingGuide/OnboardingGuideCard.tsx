// REQ-UG-PROGRESSIVE-DISCLOSURE-AND-FEATURE-DRIP-20261001 (native): the
// onboarding stage card and the guided-list escape hatch. Home mounts the card
// through OnboardingGuideHomeSlot below
// (BUG-UG-NATIVE-HOME-HIDES-ONBOARDING-GUIDE-20261018).

import { Ionicons } from '@expo/vector-icons';
import { useRouter } from 'expo-router';
import type { ReactNode } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';
import { Text } from '../../components/Text';

import { Body, Button, Card, Heading } from '../../components/ui';
import { ONBOARDING_BADGE_LABELS, ONBOARDING_CHECKLIST_HREF, homeOnboardingGuidePresentation, onboardingEntryCopy, onboardingHudCopy, type OnboardingGuide } from '../../lib/onboardingGuide';
import { useNativeUi } from '../../lib/useNativeUi';
import { haptics } from '../../services/haptics';
import { useTheme } from '../../theme/ThemeProvider';
import { minimumTouchTarget, radii, spacing } from '../../theme/tokens';

import { typeface } from '../../theme/typeface';
// `href` lets a host send the CTA somewhere other than the copy table's route.
export function OnboardingGuideCard({ guide, href }: { guide: OnboardingGuide; href?: string }) {
  const theme = useTheme();
  const router = useRouter();
  const { t, catalogLabel } = useNativeUi();
  const copy = onboardingHudCopy(guide, t);
  if (!copy) return null;
  const target = href ?? copy.href;
  const complete = guide.stage === 'complete';
  const percent = guide.totalSteps > 0 ? Math.round((guide.completedSteps / guide.totalSteps) * 100) : 100;
  const badge = guide.badge ? catalogLabel(ONBOARDING_BADGE_LABELS[guide.badge]) : null;
  return (
    <Card>
      <View style={styles.heading}>
        <Text accessibilityRole="header" style={[styles.eyebrow, { color: theme.mutedForeground }]}>{t('Getting started').toUpperCase()}</Text>
        {badge ? (
          <View accessible accessibilityLabel={t('Badge: {badge}', { badge })} style={[styles.badge, { backgroundColor: theme.secondary }]}>
            <Text style={[styles.badgeText, { color: theme.secondaryForeground }]}>{badge}</Text>
          </View>
        ) : null}
      </View>
      <Heading level={2} fitWords>{copy.title}</Heading>
      <Body fitWords>{copy.body}</Body>
      {!complete && guide.nextStep ? <Body fitWords style={styles.next}>{t('Next step: {title}', { title: guide.nextStep.title })}</Body> : null}
      {!complete && guide.totalSteps > 0 ? (
        <View
          accessible
          accessibilityRole="progressbar"
          accessibilityLabel={t('Onboarding progress')}
          accessibilityValue={{ min: 0, max: guide.totalSteps, now: guide.completedSteps, text: t('{done} of {total} steps complete', { done: guide.completedSteps, total: guide.totalSteps }) }}
          style={[styles.track, { backgroundColor: theme.muted }]}
        >
          <View style={[styles.fill, { width: `${percent}%`, backgroundColor: theme.primary }]} />
        </View>
      ) : null}
      <Button fitWords label={copy.cta} onPress={() => { void haptics.select(); router.push(target as never); }} />
    </Card>
  );
}

// BUG-UG-NATIVE-HOME-HIDES-ONBOARDING-GUIDE-20261018: with the guide
// on, the server suppresses the Home onboarding nudge and the stage card lived
// only on the Union screen, so Home went quiet. Home renders exactly one guide
// object here (homeOnboardingGuidePresentation): the stage card while the HUD
// switch is on, otherwise a compact entry row into the checklist. Nothing when
// no guide applies or once onboarding is complete. On Home the card's CTA
// opens the checklist itself (FeatureScreen opens it only for
// ?source=onboarding; the plain route lands on the Rights tab).
export function OnboardingGuideHomeSlot({ guide, loadFailed = false, onRetry, children = null }: { guide: OnboardingGuide; loadFailed?: boolean; onRetry?: () => void; children?: ReactNode }) {
  if (loadFailed) return <OnboardingGuideLoadFailedCard onRetry={onRetry} />;
  const presentation = homeOnboardingGuidePresentation(guide);
  if (presentation === 'card') return <OnboardingGuideCard guide={guide} href={ONBOARDING_CHECKLIST_HREF} />;
  if (presentation === 'entry') return <OnboardingGuideEntry guide={guide} />;
  return <>{children}</>;
}

// BUG-UG-GUIDE-LOAD-FAILURE-HIDES-GUIDANCE-20261018: the guide read
// failed. The full list stays open; this card says so and offers a re-read, so
// a failed read never looks like finished onboarding.
export function OnboardingGuideLoadFailedCard({ onRetry }: { onRetry?: () => void }) {
  const theme = useTheme();
  const { t } = useNativeUi();
  return (
    <Card>
      <Text accessibilityRole="header" style={[styles.eyebrow, { color: theme.mutedForeground }]}>{t('Getting started').toUpperCase()}</Text>
      <Heading level={2} fitWords>{t('Getting started could not load')}</Heading>
      <Body fitWords>{t('Your full list is open. Try again to see your next onboarding step.')}</Body>
      {onRetry ? <Button fitWords label={t('Try again')} onPress={() => { void haptics.select(); onRetry(); }} /> : null}
    </Card>
  );
}

export function OnboardingGuideEntry({ guide }: { guide: OnboardingGuide }) {
  const theme = useTheme();
  const router = useRouter();
  const { t } = useNativeUi();
  const copy = onboardingEntryCopy(guide, t);
  if (!copy) return null;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={copy.accessibilityLabel}
      onPress={() => { void haptics.select(); router.push(copy.href as never); }}
      style={styles.entry}
    >
      {({ pressed }) => (
        <Card pressed={pressed}>
          <View style={styles.entryRow}>
            <View style={[styles.entryMark, { backgroundColor: theme.primary }]}>
              <Ionicons name="list-outline" size={18} color={theme.primaryForeground} accessibilityElementsHidden />
            </View>
            <View style={styles.entryCopy}>
              <Text style={[styles.eyebrow, { color: theme.mutedForeground }]}>{copy.title.toUpperCase()}</Text>
              <Text style={[styles.entryTitle, { color: theme.foreground }]}>{copy.cta}</Text>
              <Body muted fitWords>{copy.body}</Body>
            </View>
            <Ionicons name="chevron-forward" size={20} color={theme.mutedForeground} accessibilityElementsHidden />
          </View>
        </Card>
      )}
    </Pressable>
  );
}

export function GuidedListToggle({ guide, showAll, hiddenCount, onToggle }: {
  guide: OnboardingGuide;
  showAll: boolean;
  hiddenCount: number;
  onToggle: (value: boolean) => void;
}) {
  const { t } = useNativeUi();
  if (!guide.progressiveDisclosureActive) return null;
  return (
    <View style={styles.toggle}>
      {!showAll ? <Body muted fitWords>{t('Showing the essentials while you finish onboarding.')}</Body> : null}
      <Button
        fitWords
        variant="secondary"
        label={showAll ? t('Show the guided view') : t('Show everything ({count} more)', { count: hiddenCount })}
        onPress={() => { void haptics.select(); onToggle(!showAll); }}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  heading: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', justifyContent: 'space-between', gap: spacing.sm },
  eyebrow: { fontSize: 13, lineHeight: 18, ...typeface.controlStrong, letterSpacing: 0.4 },
  badge: { borderRadius: radii.md, paddingHorizontal: spacing.sm, paddingVertical: 2 },
  badgeText: { fontSize: 13, lineHeight: 18, ...typeface.controlStrong },
  next: { fontSize: 16, lineHeight: 22, ...typeface.controlStrong },
  track: { height: 8, borderRadius: 4, overflow: 'hidden' },
  fill: { height: '100%' },
  toggle: { gap: spacing.sm },
  entry: { minHeight: minimumTouchTarget },
  entryRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.md },
  entryMark: { width: 36, height: 36, borderRadius: radii.md, alignItems: 'center', justifyContent: 'center' },
  entryCopy: { flex: 1, gap: 2 },
  entryTitle: { fontSize: 17, lineHeight: 23, ...typeface.heading },
});
