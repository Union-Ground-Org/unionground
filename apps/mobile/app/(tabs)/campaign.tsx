import { Ionicons } from '@expo/vector-icons';
import { useRouter } from 'expo-router';
import { Pressable, StyleSheet, View } from 'react-native';
import { Text } from '../../src/components/Text';

import { ChapterLeadershipCard } from '../../src/components/ChapterLeadershipCard';
import { functionIcons } from '../../src/components/FunctionDeck';
import { PinnedHeaderScreen } from '../../src/components/PinnedHeader';
import { Body, Button, Card, Heading, Screen, StatusPill } from '../../src/components/ui';
import { PREVIEW_CAMPAIGN } from '../../src/data/previewCampaign';
import { GuidedListToggle, OnboardingGuideCard } from '../../src/features/onboardingGuide/OnboardingGuideCard';
import { useOnboardingGuide } from '../../src/features/onboardingGuide/useOnboardingGuide';
import { useUnionCatalogCopy } from '../../src/features/UnionCatalogScreen';
import { useNativeTabContentInset } from '../../src/lib/chrome';
import { explicitLiveStaffHat, type HatFunction } from '../../src/lib/hatFunctions';
import { findNativeStewardConversation } from '../../src/lib/messageWorkflow';
import { guidedDestinations, hiddenDestinationCount, isSpotlitHref, spotlitDestinationHref } from '../../src/lib/onboardingGuide';
import { ORGANIZING_STAGES, organizingStageStatuses, shareOfEstimate } from '../../src/lib/organizingPath';
import { haptics } from '../../src/services/haptics';
import { useApp } from '../../src/state/AppProvider';
import { useTheme } from '../../src/theme/ThemeProvider';
import { minimumTouchTarget, radii, spacing } from '../../src/theme/tokens';
import { typeface } from '../../src/theme/typeface';

// Typed once, so no destination entry needs an `as const` escape to keep its
// icon key narrow (type-coverage ratchet).
type CampaignDestination = {
  title: string;
  body: string;
  href: string;
  icon: HatFunction['icon'];
  organizingHatsOnly?: boolean;
};

// The Campaign tab is Union Ground's own destination: the campaign's
// stage, its private counts, the issues coworkers share, and the tools that
// serve the campaign. It replaces a "My union" hub; existing
// union structures (chapters, stewards, a contract) do not appear here.
const destinations: CampaignDestination[] = [
  { title: 'Organizing rights', body: 'Plain-language guidance on talking with coworkers and acting together.', href: '/feature/rights', icon: 'shield' },
  { title: 'Recognition paths', body: 'Election and voluntary recognition, side by side.', href: '/recognition', icon: 'flag' },
  { title: 'Meetings', body: 'Committee meetings, open meetings, and check-in details.', href: '/feature/events', icon: 'calendar' },
  { title: 'Campaign pulse', body: 'Polls and campaign charts from the committee.', href: '/pulse', icon: 'pulse' },
  { title: 'Be heard', body: 'Tell the committee what you want to change.', href: '/feature/voice', icon: 'megaphone' },
  { title: 'Worker support', body: 'Getting started, accommodation questions, and mentorship.', href: '/feature/member-support', icon: 'people' },
  { title: 'Votes', body: 'Committee votes and polls. Never a recognition vote.', href: '/feature/voting', icon: 'flag' },
  { title: 'Workplace structure', body: 'Who decides what at the employer, and who is on the committee.', href: '/feature/org-structure', icon: 'business' },
  { title: 'Pay tools', body: 'Compare pay with a rate you enter.', href: '/feature/pay', icon: 'stats' },
  { title: 'Power map', body: 'Employer decision-makers, relationships, and sourced history.', href: '/feature/organization-map', icon: 'map', organizingHatsOnly: true },
  { title: 'Campaign handshakes', body: 'Requests between campaigns, signatures, and bounded sharing.', href: '/feature/partners', icon: 'link', organizingHatsOnly: true },
  { title: 'Search', body: 'Search issues, forms, and lessons you can open.', href: '/feature/search', icon: 'search' },
];

export default function CampaignScreen() {
  return <PinnedHeaderScreen screenName="Campaign" onBack={null}><CampaignScreenContent /></PinnedHeaderScreen>;
}

function CampaignScreenContent() {
  const theme = useTheme();
  const router = useRouter();
  const bottomInset = useNativeTabContentInset();
  const { dashboard, mode, previewDesk, previewHat, authorizedRoles, chapterMemberships } = useApp();
  const catalogCopy = useUnionCatalogCopy();
  const organizingHat = mode === 'preview'
    ? previewHat && previewHat !== 'member' ? previewHat : null
    : mode === 'authenticated' ? explicitLiveStaffHat(authorizedRoles) : null;
  const preview = mode === 'preview';
  // Live campaigns have no counts source yet; only the fictional preview shows
  // numbers, so no live screen can present an invented tally.
  const campaign = preview ? PREVIEW_CAMPAIGN : null;
  const campaignName = preview
    ? previewDesk?.chapterName ?? PREVIEW_CAMPAIGN.name
    : chapterMemberships.find((membership) => membership.selected)?.name ?? 'Your campaign';
  const statuses = organizingStageStatuses(campaign?.stage ?? null);
  const issues = (dashboard?.cases ?? []).slice(0, 4);
  const visible = destinations.filter((item) => !item.organizingHatsOnly || organizingHat);
  // While a live worker onboards (and the organization turned the guided view
  // on), only the core destinations show, with a visible Show everything control.
  const { guide, showAll, setShowAll } = useOnboardingGuide();
  const guided = guide.progressiveDisclosureActive && !showAll;
  const shownDestinations = guidedDestinations(visible, guide, showAll);
  const hiddenCount = hiddenDestinationCount(visible, guide) + (guide.progressiveDisclosureActive ? 1 : 0);

  return (
    <Screen bottomInset={bottomInset}>
      <View style={styles.titleRow}>
        <View style={styles.titleCopy}>
          <Text style={[styles.eyebrow, { color: theme.primary }]}>CAMPAIGN</Text>
          <Heading>{campaignName}</Heading>
          {campaign ? <Body muted>{campaign.employerName}</Body> : null}
        </View>
        <View style={[styles.flag, { backgroundColor: theme.primary }]} accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
          <Ionicons name="flag" size={24} color={theme.primaryForeground} />
        </View>
      </View>
      <OnboardingGuideCard guide={guide} />

      {campaign ? (
        <Card>
          <Text style={[styles.eyebrow, { color: theme.primary }]}>PRIVATE COUNTS</Text>
          <View style={styles.countGrid}>
            <CountCell value={`${shareOfEstimate(campaign.contactedCount, campaign.eligibleEstimate) ?? 0}%`} label="reached" />
            <CountCell value={`${shareOfEstimate(campaign.cardsSigned, campaign.eligibleEstimate) ?? 0}%`} label="cards" />
            <CountCell value={String(campaign.committeeCount)} label="committee" />
          </View>
          <Body muted>These fictional counts stay inside this PREVIEW workspace. A card majority is not certification.</Body>
          <Body>Next: {campaign.nextAction}</Body>
        </Card>
      ) : (
        <Card>
          <Heading level={3}>Campaign counts</Heading>
          <Body muted>Counts appear once your committee records them. They stay private to the campaign.</Body>
        </Card>
      )}

      <Text accessibilityRole="header" style={[styles.sectionLabel, { color: theme.mutedForeground }]}>Path to a first contract</Text>
      <View>
        {ORGANIZING_STAGES.map((stage, index) => {
          const status = statuses[index]!;
          return (
            <View
              key={stage.key}
              accessible
              accessibilityLabel={`${stage.title}, ${status === 'complete' ? 'done' : status === 'current' ? 'current stage' : 'upcoming'}. ${stage.body}`}
              style={styles.stageRow}
            >
              <View style={styles.stageTrack}>
                <View
                  style={[
                    styles.stageDot,
                    { borderColor: theme.border, backgroundColor: theme.background },
                    status === 'complete' ? { borderColor: theme.primary, backgroundColor: theme.primary } : null,
                    status === 'current' ? { borderColor: theme.accent, backgroundColor: theme.accent } : null,
                  ]}
                >
                  {status === 'complete' ? <Ionicons name="checkmark" size={14} color={theme.primaryForeground} /> : null}
                </View>
                {index < ORGANIZING_STAGES.length - 1 ? <View style={[styles.stageLine, { backgroundColor: theme.border }]} /> : null}
              </View>
              <View style={styles.stageCopy}>
                <View style={styles.stageTitleRow}>
                  <Text style={[styles.stageTitle, { color: theme.foreground }]}>{stage.title}</Text>
                  {status === 'current' ? <StatusPill label="Current" /> : null}
                </View>
                <Body muted>{stage.body}</Body>
              </View>
            </View>
          );
        })}
      </View>

      <Text accessibilityRole="header" style={[styles.sectionLabel, { color: theme.mutedForeground }]}>What coworkers want to change</Text>
      {issues.length ? issues.map((issue) => (
        <Pressable
          key={issue.id}
          accessibilityRole="button"
          accessibilityLabel={`${issue.title}, ${issue.status}. ${issue.step}`}
          onPress={() => { void haptics.select(); router.push(`/issue/${issue.id}` as never); }}
        >
          {({ pressed }) => (
            <Card pressed={pressed}>
              <Text style={[styles.eyebrow, { color: theme.primary }]}>{issue.status.toUpperCase()}</Text>
              <Heading level={3}>{issue.title}</Heading>
              <Body muted>{issue.step}</Body>
            </Card>
          )}
        </Pressable>
      )) : (
        <Card><Body muted>No shared issues yet. Raise one from My issues or tell the committee through Be heard.</Body></Card>
      )}
      <Button label="All my issues" variant="secondary" onPress={() => router.push('/feature/cases' as never)} />

      <Pressable
        accessibilityRole="button"
        accessibilityLabel="Workplace log. Record facts, not legal conclusions."
        onPress={() => { void haptics.select(); router.push('/feature/workload' as never); }}
      >
        {({ pressed }) => (
          <Card pressed={pressed} style={{ borderColor: theme.compass, borderWidth: 1 }}>
            <Text style={[styles.eyebrow, { color: theme.primary }]}>EMPLOYER RESPONSE LOG</Text>
            <Heading level={3}>Record facts, not legal conclusions</Heading>
            <Body>Capture the date, place, witnesses, and exact words. A qualified organizer or labor professional can review what the facts may mean.</Body>
          </Card>
        )}
      </Pressable>

      <ChapterLeadershipCard />

      <Text accessibilityRole="header" style={[styles.sectionLabel, { color: theme.mutedForeground }]}>Campaign tools</Text>
      {!guided ? (
        <Card>
          <Heading level={2}>{catalogCopy.title}</Heading>
          <Body muted>{catalogCopy.disclaimer}</Body>
          <Button label={catalogCopy.go} variant="secondary" onPress={() => router.push('/public/unions')} />
        </Card>
      ) : null}
      {shownDestinations.map((item) => {
        const spotlit = isSpotlitHref(item.href, guide);
        return (
          <Pressable
            key={item.href}
            accessibilityRole="button"
            accessibilityLabel={`${item.title}, ${item.body}`}
            accessibilityHint={spotlit ? 'Next step in your onboarding.' : undefined}
            onPress={() => { void haptics.select(); router.push(spotlitDestinationHref(item.href, guide) as never); }}
          >
            {({ pressed }) => (
              <Card pressed={pressed} style={[styles.resource, spotlit ? { borderColor: theme.primary, borderWidth: 2 } : null]}>
                <View style={[styles.icon, { backgroundColor: theme.secondary }]}>
                  <Ionicons name={functionIcons[item.icon]} size={22} color={theme.secondaryForeground} />
                </View>
                <View style={styles.copy}>
                  <Heading level={3}>{item.title}</Heading>
                  <Body muted>{item.body}</Body>
                  {spotlit ? <Text style={[styles.eyebrow, { color: theme.primary }]}>Next step</Text> : null}
                </View>
                <Ionicons name="chevron-forward" size={20} color={theme.mutedForeground} />
              </Card>
            )}
          </Pressable>
        );
      })}
      <GuidedListToggle guide={guide} showAll={showAll} hiddenCount={hiddenCount} onToggle={setShowAll} />

      <View style={[styles.notice, { backgroundColor: theme.muted }]}>
        <Heading level={3}>Worried about retaliation?</Heading>
        <Body muted>Write down what happened and talk with your organizer or committee. The Guide and this app are not emergency services or legal advice.</Body>
        {!organizingHat ? (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Message the committee"
            onPress={() => {
              const committeeConversation = findNativeStewardConversation(dashboard?.conversations ?? []);
              void haptics.select();
              router.push((committeeConversation ? `/conversation/${committeeConversation.id}` : '/messages') as never);
            }}
            style={({ pressed }) => [styles.noticeAction, { opacity: pressed ? 0.82 : 1 }]}
          >
            <Text style={[styles.noticeActionText, { color: theme.primary }]}>Message the committee</Text>
          </Pressable>
        ) : null}
      </View>
    </Screen>
  );
}

function CountCell({ value, label }: { value: string; label: string }) {
  const theme = useTheme();
  return (
    <View accessible accessibilityLabel={`${value} ${label}`} style={[styles.countCell, { backgroundColor: theme.card, borderColor: theme.border }]}>
      <Text style={[styles.countValue, { color: theme.foreground }]}>{value}</Text>
      <Text style={[styles.countLabel, { color: theme.mutedForeground }]}>{label}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  titleRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.md },
  titleCopy: { flex: 1, gap: spacing.xs },
  eyebrow: { fontSize: 12, lineHeight: 16, ...typeface.heading, letterSpacing: 1.1 },
  flag: { width: 52, height: 52, alignItems: 'center', justifyContent: 'center', borderRadius: 26 },
  countGrid: { flexDirection: 'row', gap: spacing.sm },
  countCell: { flex: 1, minHeight: 92, justifyContent: 'center', borderRadius: radii.md, borderWidth: StyleSheet.hairlineWidth, padding: spacing.sm },
  countValue: { fontSize: 28, lineHeight: 34, ...typeface.heading },
  countLabel: { fontSize: 12, lineHeight: 16, ...typeface.controlStrong },
  sectionLabel: { fontSize: 13, lineHeight: 18, ...typeface.heading, letterSpacing: 0.4, textTransform: 'uppercase' },
  stageRow: { minHeight: 96, flexDirection: 'row', gap: spacing.md },
  stageTrack: { width: 28, alignItems: 'center' },
  stageDot: { width: 22, height: 22, zIndex: 2, alignItems: 'center', justifyContent: 'center', borderWidth: 2, borderRadius: 11 },
  stageLine: { width: 2, flex: 1 },
  stageCopy: { flex: 1, gap: spacing.xs, paddingBottom: spacing.lg },
  stageTitleRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm, flexWrap: 'wrap' },
  stageTitle: { fontSize: 17, lineHeight: 23, ...typeface.heading },
  resource: { flexDirection: 'row', alignItems: 'center', minHeight: 92 },
  icon: { width: minimumTouchTarget, height: minimumTouchTarget, borderRadius: radii.md, alignItems: 'center', justifyContent: 'center' },
  copy: { flex: 1, gap: spacing.xs },
  notice: { borderRadius: radii.md, padding: spacing.lg, gap: spacing.sm },
  noticeAction: { minHeight: minimumTouchTarget, justifyContent: 'center' },
  noticeActionText: { fontSize: 16, lineHeight: 22, ...typeface.controlStrong },
});
