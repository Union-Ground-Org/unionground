import { useNativeUi } from "../../src/lib/useNativeUi";
import { Ionicons } from '@expo/vector-icons';
import { useIsFocused, useRouter } from 'expo-router';
import { Fragment, useEffect, useMemo, useState, useSyncExternalStore } from 'react';
import { Platform, Pressable, StyleSheet, useWindowDimensions, View } from 'react-native';
import { Text } from '../../src/components/Text';

import { ChapterRail } from '../../src/components/ChapterRail';
import { StewardFinderSheet } from '../../src/features/StewardFinderSheet';
import { HomeNudge } from '../../src/features/home/HomeNudge';
import { OnboardingGuideHomeSlot } from '../../src/features/onboardingGuide/OnboardingGuideCard';
import { useOnboardingGuide } from '../../src/features/onboardingGuide/useOnboardingGuide';
import { homeOnboardingGuidePresentation } from '../../src/lib/onboardingGuide';
import { LearningHomeCard } from '../../src/features/learning/LearningHomeCard';
import { HomeTakeoverCards, HomeTakeoverUpdates } from '../../src/features/home/HomeTakeoverCards';
import { StaffDeskHomeCard } from '../../src/features/home/StaffDeskHomeCard';
import { useStaffDeskNumbers } from '../../src/features/home/useStaffDeskNumbers';
import { useMemberRecruitedCount } from '../../src/features/home/useMemberRecruitedCount';
import { REFERRAL_COPY } from '../../src/lib/memberReferral';
import { IssueSignalHomeCard } from '../../src/features/IssueSignalHomeCard';
import { LegalAcceptanceCard } from '../../src/features/LegalAcceptanceCard';
import { NativeLearningPeriodBanner } from '../../src/features/NativeLearningPeriod';
import { StaffTwoStepNotice } from '../../src/components/StaffTwoStepNotice';
import { HomeCarousel } from '../../src/components/HomeCarousel';
import { HomeHandleRow } from '../../src/components/HomeHandleRow';
import { createPersonalCaseCards, WhatMattersNowSection, useWhatMattersNow } from '../../src/features/home/WhatMattersNow';
import { MostUsedRow, useNativeNavUsage } from '../../src/features/home/NavUsage';
import { useMemberSummaryColumnWidth } from '../../src/features/home/useMemberSummaryColumnWidth';
import { orderByUsage } from '../../src/lib/navUsageShared';
import { WelcomeBackView, useNativeWelcomeBack } from '../../src/features/home/WelcomeBack';
import { NumberFlow } from '../../src/components/NumberFlow';
import { Body, Button, Card, Heading, Notice, Screen, StateMessage } from '../../src/components/ui';
import { channelStore } from '../../src/data/demoChannels';
import { useChannelStore } from '../../src/data/useChannels';
import { PREVIEW_CHAPTER_ACTIVITY, PREVIEW_HATS, PREVIEW_STEWARD_ROSTER, type PreviewHatKey } from '../../src/data/preview';
import { chapterIdentityPresentation } from '../../src/lib/chapterIdentity';
import { useNativeTabContentInset } from '../../src/lib/chrome';
import { caseStepInReview, memberCaseStep } from '../../src/lib/caseStepLabels';
import { FEATURE_TITLES, canOpenFeature } from '../../src/lib/featureCatalog';
import { LIVE_STAFF_ROLE_LABELS, staffDeskHomeRole } from '../../src/lib/hatFunctions';
import { staffDeskNumberDestination, staffDeskNumberLabels } from '../../src/lib/staffDeskNumbers';
import { SUMMARY_LABEL_FONT_SIZE, type SummaryColumnWidth } from '../../src/lib/homeSummaryLayout';
import { wordFitMultiplier } from '../../src/lib/wordFit';
import { casesByDeadline, dashboardMetrics, nextActiveCase, type MemberCase } from '../../src/models/member';
import { haptics } from '../../src/services/haptics';
import { homeGreetingShown, homeGreetingText, subscribeHomeGreeting, type HomeGreeting } from '../../src/services/homeGreeting';
import { useApp } from '../../src/state/AppProvider';
import { SavedPulseProvider, SavedChartSlot } from '../../src/features/SavedPulseCharts';
import { elevation } from '../../src/theme/elevation';
import { useTheme } from '../../src/theme/ThemeProvider';
import { minimumTouchTarget, radii, spacing, type ThemeTokens } from '../../src/theme/tokens';
import { NativeCoachMark } from '../../src/features/guideLayers/GuideLayers';
import { ChoosePasswordNudge } from '../../src/features/home/ChoosePasswordNudge';

import { typeface } from '../../src/theme/typeface';

const STAT_LABELS = ['Open issues', 'Due this week', 'Unread', 'Actions taken'] as const;

// Each word of a stat label is its own one-line text: see the band below.
function statLabelWords(label: string): string[] {
  return label.trim().split(/\s+/);
}

// Live Home's Member summary labels, in row order: the row takes four, two or
// one column, whichever lets the longest word fit at the current text size
// (BUG-UG-NATIVE-HOME-SUMMARY-LABELS-BREAK-MID-WORD-20261103).
const SUMMARY_LABELS: readonly string[] = ['Open issues', 'Activity', 'Unread messages', 'This week'];

// "Open cases" and the My cases tile open the member's own case list, not the
// Work tab (which asks a staff account to choose a role first)
// (BUG-UG-NATIVE-STAFF-AND-NOTICE-LINKS-OPEN-GENERIC-SCREENS-20261111).
const MY_CASES_PATH = '/feature/cases';
const STAT_ROUTES = [MY_CASES_PATH, '/work', '/messages', '/work'] as const;

// One hero object per scrolling surface (brief §B), named once so the source
// cannot grow a second declaration of it. Which object wears it is decided by
// hat below — never both at the same time.
const HERO_PASS = elevation.level1HeroLift;

type HomeTile = {
  key: string;
  color: string;
  glyph: string;
  icon: keyof typeof Ionicons.glyphMap;
  label: string;
  sub: string;
  onPress: () => void;
};

// b03a-6: on a staff hat there was no route at all from Home to the desk the
// worker had just put on, so the hat switch changed the numbers and stranded
// the work. The shortcut is the one hat-conditional object on Home: a 72px hero
// row that reuses the desk's own status sentence rather than inventing a second
// description of it.
const DESK_SHORTCUT_HEIGHT = 72;
// Two bold initials at 15 pt times 1.4 still fit the 44 pt Account circle; at
// the largest text sizes they were cut to a dot .
const AVATAR_INITIALS_MAX_SCALE = 1.4;
const QUICK_TWO_COLUMN_WIDTH = '48%';
const QUICK_TWO_COLUMN_RATIO = Number.parseFloat(QUICK_TWO_COLUMN_WIDTH) / 100;
const QUICK_LABEL_FONT_SIZE = 15;
const QUICK_LABEL_LINE_HEIGHT = 20;

function staffHatKey(hat: PreviewHatKey | null): Exclude<PreviewHatKey, 'member'> | null {
  return hat && hat !== 'member' ? hat : null;
}

// b03a-3, the half deferred from: the role noun wins wherever a hat is
// named, and a desk carries it as an 11px eyebrow over the work noun.
function deskEyebrow(hat: Exclude<PreviewHatKey, 'member'>): string {
  const label = PREVIEW_HATS.find((item) => item.key === hat)?.label ?? hat;
  return `${label.toUpperCase()} DESK`;
}

// Seeded "Today" checklist, same rows as the prototype (demo-only, in-memory).
const TODAY_SEED = [
  { title: 'Take the workplace issues survey', sub: 'Closes Friday · 2 min', due: 'Today', done: false },
  { title: 'Confirm Thursday tabling shift', sub: 'Maria asked in #meeting-planning', due: 'Thu', done: false },
  { title: 'Read July committee minutes', sub: 'Posted by Dana Whitfield', due: null, done: true },
];

export default function HomeScreen() {
  const { mode, previewHat } = useApp();
  const home = mode === 'preview'
    ? <PrototypeHome key={previewHat ?? 'member'} />
    : <AuthenticatedHome />;
  return <HomeCarousel key={`${mode}:${previewHat ?? 'member'}`}>{home}</HomeCarousel>;
}

function greetingWord() {
  const hour = new Date().getHours();
  if (hour < 12) return 'Morning';
  if (hour < 17) return 'Afternoon';
  return 'Evening';
}

function dueThisWeek(cases: MemberCase[]) {
  const now = Date.now();
  const week = now + 7 * 24 * 60 * 60 * 1000;
  return cases.filter((item) => {
    if (item.status.toLowerCase() !== 'active' || !item.deadline) return false;
    const due = new Date(`${item.deadline}T12:00:00`).getTime();
    return due >= now - 24 * 60 * 60 * 1000 && due <= week;
  }).length;
}

function PrototypeHome() {
  const { t, locale, catalogLabel } = useNativeUi();
  const router = useRouter();
  const theme = useTheme();
  const styles = useHomeStyles();
  // PREVIEW Home is a finite, deeply seeded feed. It keeps an honest top and
  // bottom while `previewDesk` feeds the hat-aware KPI band and staff shortcut.
  const { dashboard, error, previewDesk, previewHat } = useApp();
  const bottomInset = useNativeTabContentInset(true);
  const [railOpen, setRailOpen] = useState(false);
  const [stewardFinderOpen, setStewardFinderOpen] = useState(false);
  const [todos, setTodos] = useState(TODAY_SEED);
  useSyncExternalStore(channelStore.subscribe, channelStore.getVersion);

  if (!dashboard) {
    return (
      <Screen tabRoot bottomInset={bottomInset} scrollsTopChrome>
        <StateMessage title={t("Your home is getting ready")} body={error ?? t("Loading the demo workspace.")} />
      </Screen>
    );
  }

  const metrics = dashboardMetrics(dashboard);
  const channelUnread = channelStore.channels()
    .filter((channel) => previewHat !== 'member' || !channel.locked)
    .reduce((sum, channel) => sum + channel.unread, 0);
  const staffHat = staffHatKey(previewHat);
  const deskPath = staffHat ? `/feature/${staffHat}` : null;
  // b03a-13: the band was fixed worker arithmetic on every hat, so the Admin
  // Home opened on 0 open issues / 0 due / 18 unread / 1 action — four worker
  // numbers under a staff identity. On a staff hat it reports the desk's own
  // KPIs instead, from the same fixture the desk itself reads, and every cell
  // routes to that desk rather than to the worker Work tab.
  const statValues = [
    metrics.openCases,
    dueThisWeek(dashboard.cases),
    metrics.unreadNotifications + metrics.unreadMessages + channelUnread,
    dashboard.weeklyActions.length,
  ];
  const memberCells = STAT_LABELS.map((englishLabel, index) => ({
    label: catalogLabel(englishLabel),
    value: String(statValues[index] ?? 0),
    announce: `${statValues[index] ?? 0} ${catalogLabel(englishLabel)}`,
    href: STAT_ROUTES[index] ?? '/(tabs)/home',
  }));
  const deskCells = (previewDesk?.kpis ?? []).map((kpi) => ({
    label: kpi.label,
    value: kpi.value,
    announce: `${kpi.label}, ${kpi.value}`,
    href: deskPath ?? '/(tabs)/home',
  }));
  const statCells = staffHat && deskCells.length > 0 ? deskCells : memberCells;
  const reviewCase = dashboard.cases.find(caseStepInReview) ?? nextActiveCase(dashboard.cases);
  const pollTotal = channelStore.pollTotal();
  const dateLine = `${new Intl.DateTimeFormat(locale, { weekday: 'long', month: 'short', day: 'numeric' }).format(new Date())} · Harborview Care United`;

  // Typed once so no tile needs an `as const` escape for its icon key
  // (type-coverage ratchet).
  const tiles: HomeTile[] = [
    {
      key: 'cases',
      color: theme.primary,
      glyph: theme.primaryForeground,
      icon: 'briefcase-outline',
      label: t("My issues"),
      sub: reviewCase ? `${reviewCase.reference} in ${memberCaseStep(reviewCase)}` : `${metrics.openCases} open`,
      onPress: () => router.push(MY_CASES_PATH),
    },
    {
      key: 'polls',
      color: theme.accent,
      glyph: theme.accentForeground,
      icon: 'bar-chart-outline',
      label: t("Polls & surveys"),
      sub: `1 live poll · ${pollTotal} votes`,
      onPress: () => router.push('/pulse'),
    },
    {
      key: 'chapter',
      color: theme.secondary,
      glyph: theme.secondaryForeground,
      icon: 'home-outline',
      label: t("My campaign"),
      sub: 'Harborview · meets Aug 30',
      onPress: () => setRailOpen(true),
    },
    {
      key: 'rights',
      color: theme.compass,
      glyph: theme.compassForeground,
      icon: 'document-text-outline',
      label: t("Organizing rights"),
      sub: 'Talking with coworkers · documentation',
      onPress: () => router.push('/feature/rights'),
    },
    // REQ-UG-MEMBER-FIND-MY-STEWARD-HOME-ENTRY-20260922: the owner asked
    // for a find-my-contact entry on the worker home screen (labelled as the
    // web's today.findSteward), with the wider organization information
    // reachable from the same place.
    {
      key: 'steward',
      color: theme.secondary,
      glyph: theme.secondaryForeground,
      icon: 'people-outline',
      label: t("Find my committee contact"),
      sub: `${PREVIEW_STEWARD_ROSTER.length} in your campaign · org structure`,
      onPress: () => setStewardFinderOpen(true),
    },
  ];

  return (
    <>
      {/* At rest the finite feed keeps its established start below the PREVIEW
          hat switcher. Once scrolling begins, every app-owned top element
          travels with it so content can pass from the bottom edge to the top. */}
      <Screen tabRoot bottomInset={bottomInset} scrollsTopChrome>
        <View style={styles.top}>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={t("Open campaign rail")}
            onPress={() => { void haptics.select(); setRailOpen(true); }}
            style={styles.iconBtn}
          >
            <Ionicons name="menu-outline" size={20} color={theme.foreground} />
          </Pressable>
          {/* At 320 pt (Display Zoom Larger Text) this column is about 110 pt
              between the menu button, the bell and the avatar. The greeting is
              one string, not three runs, so iOS can only break at the space
              after the comma instead of orphaning the comma on its own line;
              both lines keep their declared size at 390 pt and shrink only
              when the narrow column forces it
              (BUG-UG-MOBILE-HOME-GREETING-AND-STAT-LABELS-WRAP-AT-320PT-20261010). */}
          <View style={styles.title}>
            <Text adjustsFontSizeToFit minimumFontScale={0.85} numberOfLines={2} style={styles.hi}>{dateLine}</Text>
            <Text adjustsFontSizeToFit minimumFontScale={0.7} numberOfLines={2} style={styles.greeting}>{`${catalogLabel(greetingWord())}, ${dashboard.member.firstName}`}</Text>
          </View>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={`Activity${metrics.unreadNotifications ? `, ${metrics.unreadNotifications} unread` : ''}`}
            onPress={() => { void haptics.select(); router.push('/notifications'); }}
            style={styles.iconBtn}
          >
            <Ionicons name="notifications-outline" size={20} color={theme.foreground} />
            {metrics.unreadNotifications > 0 ? (
              <View style={styles.badge}><Text style={styles.badgeText}>{metrics.unreadNotifications}</Text></View>
            ) : null}
          </Pressable>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={t("Account")}
            onPress={() => { void haptics.select(); router.push('/account'); }}
            style={[styles.avatar, { backgroundColor: theme.primary }]}
          >
            <Text style={styles.avatarText}>{dashboard.member.initials}</Text>
            <View style={styles.presence} />
          </Pressable>
        </View>

        {error ? <Notice>{t("We couldn’t refresh your workspace. The information below may be out of date.")}</Notice> : null}

        {staffHat && previewDesk && deskPath ? (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={`${deskEyebrow(staffHat)}. ${FEATURE_TITLES[staffHat]}. ${previewDesk.summary}`}
            onPress={() => { void haptics.select(); router.push(deskPath as never); }}
            style={({ pressed }) => [styles.deskHero, pressed ? styles.deskHeroPressed : null]}
          >
            <View style={styles.deskHeroCopy}>
              <Text style={styles.deskHeroEyebrow}>{deskEyebrow(staffHat)}</Text>
              <Text style={styles.deskHeroTitle}>{FEATURE_TITLES[staffHat]}</Text>
              <Text numberOfLines={2} style={styles.deskHeroSub}>{previewDesk.summary}</Text>
            </View>
            <Ionicons name="chevron-forward" size={16} color={theme.mutedForeground} accessibilityElementsHidden />
          </Pressable>
        ) : null}

        {/* The band is one hero object, not four (brief §B): the hero pass sits
            on the band, the cells are flat panes inside it separated by
            hairlines, and on a staff hat the band steps down to the contact
            shadow so the desk shortcut above it is the surface's single hero. */}
        <View style={[styles.statBand, staffHat ? elevation.level1 : HERO_PASS]}>
          <View style={styles.statRow}>
            {statCells.map((cell, index) => (
              <Fragment key={cell.label}>
                {index > 0 ? <View style={styles.statDivider} /> : null}
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel={cell.announce}
                  onPress={() => { void haptics.select(); router.push(cell.href as never); }}
                  style={({ pressed }) => [styles.stat, pressed ? styles.statPressed : null]}
                >
                  {/* A desk value can be a ratio ("213/300"), which is wider
                      than any worker count; it shrinks to the cell rather than
                      wrapping the band into two rows. A ratio stays plain
                      text and shrinks by font size; a single count rolls and
                      shrinks by scale. The cell button speaks the value. */}
                  <NumberFlow decorative adjustsFontSizeToFit numberOfLines={1} value={cell.value} style={styles.statValue} />
                  {/* A cell leaves about 44 pt of text at 320 pt, which split
                      "Unread" and "Actions taken" inside the word. iOS shrinks
                      to fit only when text overflows its line limit, and a
                      word broken across lines ("Action" / "s taken") still fits
                      two lines, so no shared line limit can stop the break.
                      Each word is its own one-line text instead: a word too
                      wide for the cell overflows its single line and shrinks
                      alone, and words that fit still share a line, so the band
                      at 390 pt reads as before. */}
                  <View style={styles.statLabelWords}>
                    {statLabelWords(cell.label).map((word, wordIndex) => (
                      <Text key={`${wordIndex}-${word}`} adjustsFontSizeToFit minimumFontScale={0.7} numberOfLines={1} style={[styles.statLabel, styles.statLabelWord]}>{word}</Text>
                    ))}
                  </View>
                </Pressable>
              </Fragment>
            ))}
          </View>
        </View>

        {/* The two drawer open handles' own row below the band, instead of
            over its rounded corners. */}
        <HomeHandleRow />

        <View style={styles.section}>
          <Text style={styles.sectionLabel}>{t("MY CAMPAIGN")}</Text>
          <View style={styles.card}>
            {tiles.map((tile, index) => (
              <Pressable
                key={tile.key}
                accessibilityRole="button"
                accessibilityLabel={`${tile.label}, ${tile.sub}`}
                onPress={() => { void haptics.select(); tile.onPress(); }}
                style={({ pressed }) => [styles.tile, index > 0 ? styles.tileDivider : null, pressed ? { backgroundColor: theme.secondary } : null]}
              >
                <View style={[styles.tileIcon, { backgroundColor: tile.color }]}>
                  <Ionicons name={tile.icon} size={18} color={tile.glyph} />
                </View>
                <View style={{ flex: 1 }}>
                  <Text style={styles.tileLabel}>{tile.label}</Text>
                  <Text style={styles.tileSub}>{tile.sub}</Text>
                </View>
                <Ionicons name="chevron-forward" size={14} color={theme.mutedForeground} />
              </Pressable>
            ))}
          </View>
        </View>

        <View style={styles.section}>
          <Text style={styles.sectionLabel}>{t("TODAY")}</Text>
          <View style={styles.card}>
            {todos.map((todo, index) => (
              <Pressable
                key={todo.title}
                accessibilityRole="checkbox"
                accessibilityState={{ checked: todo.done }}
                accessibilityLabel={todo.title}
                onPress={() => {
                  void haptics.select();
                  setTodos((current) => current.map((item, i) => (i === index ? { ...item, done: !item.done } : item)));
                }}
                style={[styles.todoRow, index > 0 ? styles.tileDivider : null]}
              >
                <View style={[styles.ring, todo.done ? styles.ringDone : null]}>
                  {todo.done ? <Ionicons name="checkmark" size={14} color={theme.compassForeground} /> : null}
                </View>
                <View style={{ flex: 1 }}>
                  <Text style={[styles.todoTitle, todo.done ? styles.todoTitleDone : null]}>{todo.title}</Text>
                  <Text style={styles.todoSub}>{todo.sub}</Text>
                </View>
                {todo.due && !todo.done ? (
                  <View style={[styles.due, todo.due === 'Today' ? styles.dueToday : null]}>
                    <Text style={[styles.dueText, todo.due === 'Today' ? styles.dueTodayText : null]}>{todo.due}</Text>
                  </View>
                ) : null}
              </Pressable>
            ))}
          </View>
        </View>

        {/* REQ-UG-QUOTES-MINI-LESSONS-20260928: one learning card,
            from the isolated fictional PREVIEW source. */}
        <LearningHomeCard heading="eyebrow" />

        {/* Campaign activity (owner feedback 2026-08-25): four years of dated
            campaign history so the finite Home feed carries pages of real
            content. Flat level-1 card like MY CAMPAIGN/TODAY — the stat band stays
            the screen's single hero. */}
        <View style={styles.section}>
          <Text style={styles.sectionLabel}>{t("CAMPAIGN ACTIVITY")}</Text>
          <View style={styles.card}>
            {PREVIEW_CHAPTER_ACTIVITY.slice(0, 40).map((item, index) => (
              <View
                key={item.id}
                accessible
                accessibilityLabel={`${item.title}, ${item.when}${item.attended ? ', attended' : ''}`}
                style={[styles.activityRow, index > 0 ? styles.tileDivider : null]}
              >
                <Ionicons
                  name={item.kind === 'broadcast' ? 'megaphone-outline' : item.kind === 'event' ? 'calendar-outline' : 'checkbox-outline'}
                  size={18}
                  color={item.kind === 'ballot' ? theme.compass : theme.primary}
                />
                <View style={{ flex: 1 }}>
                  <Text style={styles.activityTitle} numberOfLines={1}>{item.title}</Text>
                  <Text style={styles.activitySub}>{item.when} · {item.detail}</Text>
                </View>
                {item.kind === 'event' && item.attended ? (
                  <Text style={styles.activityAttended}>{t("Attended ✓")}</Text>
                ) : null}
              </View>
            ))}
          </View>
        </View>
      </Screen>
      <ChapterRail open={railOpen} onClose={() => setRailOpen(false)} />
      <StewardFinderSheet open={stewardFinderOpen} onClose={() => setStewardFinderOpen(false)} />
    </>
  );
}

function AuthenticatedHome() {
  const { t, locale, catalogLabel, language } = useNativeUi();
  const router = useRouter();
  const theme = useTheme();
  const styles = useHomeStyles();
  const { chapterMemberships, dashboard, error, refreshing, refresh, session, locked, privacyCovered } = useApp();
  const bottomInset = useNativeTabContentInset(true);
  const dimensions = useWindowDimensions();
  const { fontScale } = dimensions;
  const [quickGridLayout, setQuickGridLayout] = useState({ windowWidth: dimensions.width, gridWidth: 0 });
  const gridLayoutIsCurrent = quickGridLayout.windowWidth === dimensions.width;
  if (!gridLayoutIsCurrent) setQuickGridLayout({ windowWidth: dimensions.width, gridWidth: 0 });
  const [legalAcceptancePending, setLegalAcceptancePending] = useState(false);
  // REQ-UNION-BASE-MULTI-CHAPTER-MEMBERSHIP-20260818 (F3): the live campaign
  // rail was reachable only from PrototypeHome. The identity control below
  // opens it in authenticated mode; switching goes through
  // AppProvider.switchChapter, which resets the channel store and refetches
  // the dashboard under the new campaign's row-level security.
  const [railOpen, setRailOpen] = useState(false);
  const chapterIdentity = chapterIdentityPresentation(chapterMemberships, language);
  // BUG-UG-MOBILE-HOME-MESSAGES-METRIC-COUNTS-CONVERSATIONS-ONLY-20260915:
  // the same store, subscribed the same way, that the Messages tab badge reads
  // in app/(tabs)/_layout.tsx. The badge's member-preview lock filter has
  // nothing to remove here — AuthenticatedHome never renders under preview.
  const channelStoreForMetrics = useChannelStore();
  const [stewardFinderOpen, setStewardFinderOpen] = useState(false);
  useSyncExternalStore(channelStoreForMetrics.subscribe, channelStoreForMetrics.getVersion);
  // REQ-UG-USAGE-BASED-NAVIGATION-20261001: device-only ranking.
  const navUsage = useNativeNavUsage();
  // REQ-UG-REACTIVATION-WELCOME-BACK-20261001: one calm welcome-back view
  // after a long absence, decided by the server once per app run.
  const welcome = useNativeWelcomeBack();
  // First Home on this phone says Welcome, later ones Welcome back
  // (UX-UG-NATIVE-FIRST-HOME-WELCOME-BACK-20261018).
  const [greeting, setGreeting] = useState<HomeGreeting | null>(null);
  // Read (and so record) the greeting only when the intro line will be shown:
  // a dashboard is loaded, this run's long-absence decision is known, the
  // welcome-back takeover is not covering Home, and neither the biometric lock
  // nor the privacy cover stands in front of the tab tree.
  // A read behind the loading or error screen, under the lock modal, or while
  // another tab or Account is on top of this retained Home, would spend the
  // one "Welcome" unseen (gate rounds 1, 4 and 5 on). The subscription
  // withdraws when the gate flips, so an attempt still reading or writing
  // takes back its own marker.
  const greetingUserID = session?.user.id ?? null;
  const focused = useIsFocused();
  const greetingShown = homeGreetingShown({ userID: greetingUserID, dashboardLoaded: dashboard !== null, decided: welcome.decided, takeover: welcome.show, locked, privacyCovered, focused });
  useEffect(() => {
    if (!greetingShown || !greetingUserID) { setGreeting(null); return undefined; }
    return subscribeHomeGreeting(greetingUserID, setGreeting);
  }, [greetingShown, greetingUserID]);
  // BUG-UG-NATIVE-HOME-HIDES-ONBOARDING-GUIDE-20261018: the member's
  // own onboarding guide, re-read on focus; inactive outside a live session.
  // BUG-UG-GUIDE-LOAD-FAILURE-HIDES-GUIDANCE-20261018: a failed read
  // takes the same slot with a retry card.
  const { guide, loadFailed, retry } = useOnboardingGuide();
  // UX-UG-NATIVE-STAFF-WORK-TAB-BURIES-DESKS-UNDER-MEMBER-QUICK-CAPTURE-20261108:
  // a staff role's summary is its desk's numbers, behind the same scope check
  // as the desk card above it, in place of the member strip.
  const { mode, chosenStaffRole, authorizedRoles, chapterRoles, organizationRoles, sessionRestricted, memberLanguage } = useApp();
  const staffRole = staffDeskHomeRole({ mode, sessionRestricted, chosenStaffRole, authorizedRoles });
  const deskRole = staffRole && canOpenFeature(mode, staffRole, null, chapterRoles, organizationRoles) ? staffRole : null;
  // Only a desk that can open changes the member Home layout and ranking.
  const whatMatters = useWhatMattersNow({ includePersonalCases: deskRole === null });
  const deskNumbers = useStaffDeskNumbers(deskRole);
  //: the member's own recruited count, only when the rewards summary
  // returned one. Include it in the grid's width and text-size budget.
  const recruitedYtd = useMemberRecruitedCount(deskRole === null);
  const summaryLabels = deskRole ? staffDeskNumberLabels(deskRole) : recruitedYtd === null ? SUMMARY_LABELS : [...SUMMARY_LABELS, REFERRAL_COPY.homeLabel];
  const summaryWidth = useMemberSummaryColumnWidth(summaryLabels.map((label) => label === REFERRAL_COPY.homeLabel ? t(REFERRAL_COPY.homeLabel) : catalogLabel(label)));
  if (!dashboard) {
    return (
      <Screen tabRoot bottomInset={bottomInset} scrollsTopChrome>
        <StateMessage
          title={t("Your home is getting ready")}
          body={error ?? t("Loading your home.")}
          action={error ? <Button label={refreshing ? t("Retrying…") : t("Try again")} disabled={refreshing} onPress={() => { void refresh('user-refresh'); }} /> : null}
        />
      </Screen>
    );
  }
  // One Account control for both Home returns, so the welcome-back view
  // keeps the avatar the ordinary Home has
  // (UX-UG-SHOW-ACCOUNT-AVATAR-NATIVE-WELCOME-BACK-HOME-SCREEN-20261013).
  const accountRow = (
    <View style={styles.accountRow}>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={t("Account")}
        onPress={() => { void haptics.select(); router.push('/account'); }}
        style={[styles.avatar, { backgroundColor: theme.primary }]}
      >
        {/* The initials are the Account control's mark in a fixed 44 pt
            circle and its label already names it, so they grow only as far
            as the circle holds (#6863). */}
        <Text maxFontSizeMultiplier={AVATAR_INITIALS_MAX_SCALE} style={styles.avatarText}>{dashboard.member.initials}</Text>
      </Pressable>
    </View>
  );
  if (welcome.show) {
    return (
      <Screen tabRoot bottomInset={bottomInset} refreshing={refreshing} onRefresh={() => { void refresh('user-refresh'); }} scrollsTopChrome>
        {accountRow}
        <WelcomeBackView onDismiss={welcome.dismiss} />
      </Screen>
    );
  }
  const metrics = dashboardMetrics(dashboard, channelStoreForMetrics.channels());
  const ownCases = dashboard.cases;
  const nextCase = nextActiveCase(ownCases);
  const nextUpDeadline = nextCase?.deadline;
  // Most used first, with the designed order breaking ties.
  const quickActions = orderByUsage<QuickActionItem>([
    { key: 'notifications', label: t("Activity"), icon: 'notifications-outline', onPress: () => router.push('/notifications') },
    { key: 'messages', label: t("Messages"), icon: 'chatbubbles-outline', onPress: () => router.push('/messages') },
    { key: 'compass', label: t("Ask the Guide"), icon: 'compass-outline', onPress: () => router.push('/compass'), compass: true },
    { key: 'work', label: t("My work"), icon: 'briefcase-outline', onPress: () => router.push('/work') },
    { key: 'union', label: t("Union resources"), icon: 'people-outline', onPress: () => router.push('/campaign') },
    { key: 'account', label: t("Account security"), icon: 'shield-checkmark-outline', onPress: () => router.push('/account') },
    // REQ-UG-MEMBER-FIND-MY-STEWARD-HOME-ENTRY-20260922
    { key: 'find-steward', label: t("Find my committee contact"), icon: 'person-circle-outline', onPress: () => setStewardFinderOpen(true) },
  ], navUsage.enabled ? navUsage.weights : []);
  // Widen the tiles before fitting any individual word on a narrow screen.
  // Use the screen inset until the grid reports its own layout width.
  const measuredGridWidth = gridLayoutIsCurrent ? quickGridLayout.gridWidth : 0;
  const gridWidth = measuredGridWidth || dimensions.width - spacing.lg * 2;
  const twoColumnWidth = gridWidth * QUICK_TWO_COLUMN_RATIO;
  const twoColumnLabelWidth = twoColumnWidth - spacing.md * 2;
  const twoColumns = twoColumnWidth * 2 + spacing.sm <= gridWidth && quickActions.every(({ label }) =>
    fontScale <= (wordFitMultiplier(label, QUICK_LABEL_FONT_SIZE, twoColumnLabelWidth) ?? 1));
  const tileWidth = twoColumns ? QUICK_TWO_COLUMN_WIDTH : '100%';
  const labelWidth = (twoColumns ? twoColumnWidth : gridWidth) - spacing.md * 2;
  const savedPulse = !sessionRestricted ? <SavedPulseProvider><SavedChartSlot position="home" /></SavedPulseProvider> : null;

  // Reuse the legacy Next up card when the organization disables the ranking.
  const nextUpCard = nextCase ? (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={t('Open {reference}, {title}', { reference: nextCase.reference, title: nextCase.title })}
      onPress={() => { void haptics.select(); router.push(`/issue/${nextCase.id}`); }}
    >
      {({ pressed }) => (
        // The authenticated surface's single hero: the Next-up case.
        <Card hero pressed={pressed}>
          <View style={styles.row}>
            <Text style={[styles.eyebrow, { color: theme.primary }]}>{nextCase.reference}</Text>
            <Ionicons name="chevron-forward" size={20} color={theme.mutedForeground} />
          </View>
          <Heading level={3}>{nextCase.title}</Heading>
          <Body muted>{memberCaseStep(nextCase)}{nextUpDeadline ? ` · ${t('Due {date}', { date: formatDate(nextUpDeadline, locale) })}` : ''}</Body>
        </Card>
      )}
    </Pressable>
  ) : <Card><Body muted>{t("No active issue deadlines.")}</Body></Card>;

  const personalCards = deskRole && whatMatters.enabled ? createPersonalCaseCards(casesByDeadline(ownCases), whatMatters.now) : null;
  const hasPersonalCaseCard = Boolean(personalCards?.cards.length);
  const failedCaseRead = false;

  return (
    <>
    <Screen tabRoot bottomInset={bottomInset} refreshing={refreshing} onRefresh={() => { void refresh('user-refresh'); }} scrollsTopChrome
      bottomClearance={Platform.OS === 'android' && legalAcceptancePending ? bottomInset : 0}>
      {accountRow}
      <View style={styles.intro}>
        {/* BUG-UG-NATIVE-HOME-GREETING-LAYOUT-SHIFT-20261020: the line
            is always laid out; until the device-local read answers it holds a
            blank of the same height, so the name and everything under it never
            move when the words arrive. A leaf Text is itself the iOS
            accessibility element, so accessible={false} is what keeps VoiceOver
            off the blank; the other two props cover Android.
            BUG-UG-NATIVE-HOME-GREETING-LARGE-TEXT-WRAP-SHIFT-20261021: at
            the largest text sizes on a narrow phone "Welcome back" would wrap to
            two lines while the blank holds one, so the line is one line in every
            state and the words shrink to fit it instead of wrapping. */}
        <Body muted numberOfLines={1} adjustsFontSizeToFit accessible={Boolean(greeting)} importantForAccessibility={greeting ? 'auto' : 'no-hide-descendants'} accessibilityElementsHidden={!greeting}>{greeting ? catalogLabel(homeGreetingText(greeting)) : '\u00A0'}</Body>
        <Heading>{dashboard.member.firstName}</Heading>
        {/* A job title's longest word ("Transportation") must not split at the
            largest text size (#8928: it did in Public Sans at iOS AX5). */}
        <Body muted fitWords>{dashboard.member.roleLine}</Body>
      </View>
      {/* One prompt at the first sign-in after a material
          change to a published legal instrument. Renders nothing otherwise. */}
      <LegalAcceptanceCard onRequiredChange={setLegalAcceptancePending} language={memberLanguage} />
      <StaffTwoStepNotice />
      <NativeLearningPeriodBanner />
      {/* The takeover supplies both cards once; their slots follow the open desk. */}
      <HomeTakeoverCards enabled={!sessionRestricted} render={({ message, broadcast, broadcastID, isBroadcastDismissed }) => {
        const hasPersonalAlert = Boolean(deskRole && (message || failedCaseRead
          || (whatMatters.enabled ? personalCards?.hasAlert : nextUpDeadline)));
        const hasPersonalItems = hasPersonalAlert || hasPersonalCaseCard;
        const ranking = whatMatters.rank(isBroadcastDismissed);
        const rankedItem = ranking.item;
        const duplicateBroadcast = hasPersonalCaseCard && rankedItem?.kind === 'unread_notice'
          && rankedItem.notice.id === broadcastID;
        const membership = deskRole && (message || ownCases.length > 0) ? (
          <View style={styles.section}>
            <Heading level={2}>{t('Your own membership')}</Heading>
            {message}
            {whatMatters.enabled ? personalCards?.cards : ownCases.length > 0 ? nextUpCard : null}
            {ownCases.length > 0 ? <Button label={t('My issues')} variant="secondary" onPress={() => router.push(MY_CASES_PATH)} /> : null}
          </View>
        ) : null;
        return (
          <>
            {!deskRole ? <HomeTakeoverUpdates message={message} broadcast={broadcast} /> : null}
            {!deskRole ? savedPulse : null}
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={chapterIdentity.accessibilityLabel}
              accessibilityHint={chapterIdentity.accessibilityHint}
              onPress={() => { void haptics.select(); setRailOpen(true); }}
              style={({ pressed }) => [styles.chapterIdentity, { backgroundColor: theme.secondary, opacity: pressed ? 0.85 : 1 }]}
            >
              <View style={[styles.chapterIdentityMark, { backgroundColor: theme.primary }]}>
                <Ionicons name="people-outline" size={18} color={theme.primaryForeground} accessibilityElementsHidden />
              </View>
              <View style={styles.chapterIdentityCopy}>
                <Text style={[styles.chapterIdentityTitle, { color: theme.foreground }]} numberOfLines={1}>{chapterIdentity.title}</Text>
                <Body muted>{chapterIdentity.subtitle}</Body>
              </View>
              <Ionicons name="chevron-forward" size={18} color={theme.mutedForeground} accessibilityElementsHidden />
            </Pressable>
            {/* REQ-UG-LOVABLE-NATIVE-SCREENS-BATCH-C-PORT-20261103: the
                Batch C role Home leads with the desk of the role in use. */}
            <StaffDeskHomeCard />
            {error ? (
              <Notice>{t("We couldn’t refresh your workspace. The information below may be out of date.")}</Notice>
            ) : null}
            {deskRole && deskNumbers ? (
              <>
                <View style={[styles.metrics, { backgroundColor: theme.muted }]} accessibilityLabel={t('{role} desk summary', { role: catalogLabel(LIVE_STAFF_ROLE_LABELS[deskRole]) })}>
                  {deskNumbers.numbers.map((item) => {
                    const destination = staffDeskNumberDestination(deskRole, item.label);
                    return (
                      <Metric
                        key={item.label}
                        value={item.value ?? '—'}
                        label={catalogLabel(item.label)}
                        spokenLabel={item.value === null ? t(deskNumbers.status === 'failed' ? '{label}, unavailable' : '{label}, loading', { label: catalogLabel(item.label) }) : undefined}
                        hint={destination.name ? t('Opens {name}.', { name: catalogLabel(destination.name) }) : t('Opens the {role} desk.', { role: catalogLabel(LIVE_STAFF_ROLE_LABELS[deskRole]) })}
                        width={summaryWidth}
                        onPress={() => router.push(destination.href as never)}
                      />
                    );
                  })}
                </View>
                {deskNumbers.status === 'failed' ? <Body muted>{t("Your desk numbers could not load. Pull down to try again.")}</Body> : null}
              </>
            ) : (
              <View style={[styles.metrics, { backgroundColor: theme.muted }]} accessibilityLabel={t("Worker summary")}>
                <Metric value={metrics.openCases} label={t("Open issues")} width={summaryWidth} onPress={() => router.push(MY_CASES_PATH)} />
                <Metric value={metrics.unreadNotifications} label={t("Activity")} width={summaryWidth} onPress={() => router.push('/notifications')} />
                <Metric value={metrics.unreadInboxItems} label={t("Unread messages")} width={summaryWidth} onPress={() => router.push('/messages')} />
                <Metric value={metrics.completedThisWeek} label={t("This week")} width={summaryWidth} onPress={() => router.push('/work')} />
                {recruitedYtd !== null ? (
                  <Metric value={recruitedYtd} label={t(REFERRAL_COPY.homeLabel)} hint={t('Opens Contributions.')} width={summaryWidth} onPress={() => router.push('/feature/rewards' as never)} />
                ) : null}
              </View>
            )}
            {hasPersonalAlert ? membership : null}
            {/* Live Home reserves the same handle row under its member summary, so
                the All features and Work handles no longer fall back to the screen's
                centre over the summary and the section heading below it
                (BUG-UG-NATIVE-HOME-EDGE-PILLS-COVER-SECTION-HEADING-20261103). */}
            <HomeHandleRow />
            {deskRole ? (
              <>
                <HomeTakeoverUpdates message={null} broadcast={broadcast} />
                {savedPulse}
              </>
            ) : null}
            {/* Member Home retains the combined ranking and its Next up fallback. */}
            {whatMatters.enabled && !duplicateBroadcast
              ? <WhatMattersNowSection item={ranking.item} status={ranking.status} onRetry={whatMatters.retry} hasPersonalItems={hasPersonalItems} />
              : !deskRole && !whatMatters.enabled ? (
                <View style={styles.section}>
                  <Heading level={2}>{t("Next up")}</Heading>
                  {nextUpCard}
                </View>
              ) : null}
            {!hasPersonalAlert ? membership : null}
          </>
        );
      }} />
      {/* BUG-UG-NATIVE-HOME-HIDES-ONBOARDING-GUIDE-20261018: the
          guide card (or its compact entry) takes the nudge slot while the
          guide applies and onboarding is unfinished. HomeNudge stays off the
          screen in that state so Home never shows two competing nudges
          (feature drip or spotlight alone are not a guided first run to the
          server, which would still send an onboarding or passkey nudge). */}
      {/* REQ-UG-TEMPORARY-PASSWORD-CHANGE-PROMPT-20261018: first,
          for a member still on the emailed password. */}
      <ChoosePasswordNudge>
        <OnboardingGuideHomeSlot guide={guide} loadFailed={loadFailed} onRetry={retry}>
          <HomeNudge />
        </OnboardingGuideHomeSlot>
        {/* REQ-UG-ONBOARDING-GUIDE-ENGINE-PORT-STEP3-20261029: the
            coach mark sits under the onboarding card's next-step control, so
            it shows only while that card is on screen; the password prompt
            replaces both. */}
        {!loadFailed && homeOnboardingGuidePresentation(guide) === 'card' && guide.nextStep ? <NativeCoachMark stepId={guide.nextStep.id} stepTitle={guide.nextStep.title} /> : null}
      </ChoosePasswordNudge>
      {/* REQ-UG-ISSUE-INTELLIGENCE-SIGNALS-20261001: member issue banner;
          re-read whenever the dashboard refreshes. */}
      <IssueSignalHomeCard refreshKey={dashboard} />
      {/* REQ-UG-QUOTES-MINI-LESSONS-20260928: at most one learning
          card, read through the captured session for this campaign. */}
      <LearningHomeCard />
      {/* REQ-UG-USAGE-BASED-NAVIGATION-20261001: the four most-used
          destinations, counted on this phone only. */}
      {navUsage.enabled ? <MostUsedRow weights={navUsage.weights} /> : null}
      <View style={styles.section}>
        <Heading level={2}>{t("Quick actions")}</Heading>
        <View style={styles.quickGrid} onLayout={(event) => {
          const measuredWidth = event.nativeEvent.layout.width;
          setQuickGridLayout((layout) => layout.windowWidth === dimensions.width && layout.gridWidth !== measuredWidth
            ? { ...layout, gridWidth: measuredWidth }
            : layout);
        }}>
          {quickActions.map(({ key, ...action }) => {
            const cap = wordFitMultiplier(action.label, QUICK_LABEL_FONT_SIZE, labelWidth);
            return <QuickAction key={key} {...action} width={tileWidth} labelScale={cap !== undefined && cap < fontScale ? cap : undefined} />;
          })}
        </View>
      </View>
    </Screen>
    <StewardFinderSheet open={stewardFinderOpen} onClose={() => setStewardFinderOpen(false)} />
    <ChapterRail open={railOpen} onClose={() => setRailOpen(false)} />
    </>
  );
}

function Metric({ value, label, spokenLabel, hint, width, onPress }: { value: number | string; label: string; spokenLabel?: string; hint?: string; width: SummaryColumnWidth | `${number}%`; onPress: () => void }) {
  const theme = useTheme();
  const styles = useHomeStyles();
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={spokenLabel ?? `${value} ${label}`}
      accessibilityHint={hint}
      onPress={() => { void haptics.select(); onPress(); }}
      style={({ pressed }) => [styles.metric, { width, opacity: pressed ? 0.6 : 1 }]}
    >
      <NumberFlow decorative value={String(value)} style={[styles.metricValue, { color: theme.foreground }]} />
      <Text style={[styles.metricLabel, { color: theme.mutedForeground }]}>{label}</Text>
    </Pressable>
  );
}

type QuickActionItem = {
  key: string;
  label: string;
  icon: keyof typeof Ionicons.glyphMap;
  onPress: () => void;
  compass?: boolean;
};

function QuickAction({ label, icon, onPress, compass = false, width, labelScale }: Omit<QuickActionItem, 'key'> & {
  width: typeof QUICK_TWO_COLUMN_WIDTH | '100%';
  labelScale?: number;
}) {
  const theme = useTheme();
  const styles = useHomeStyles();
  return (
    <Pressable accessibilityRole="button" accessibilityLabel={label} onPress={() => { void haptics.impact(); onPress(); }} style={({ pressed }) => [styles.quick, { width, backgroundColor: compass ? theme.compass : theme.secondary, opacity: pressed ? 0.82 : 1 }]}>
      <Ionicons name={icon} size={24} color={compass ? theme.compassForeground : theme.secondaryForeground} />
      {/* Explicit scaled metrics keep native text measurement and drawing in sync. */}
      <Text
        allowFontScaling={labelScale === undefined}
        style={[
          styles.quickLabel,
          { color: compass ? theme.compassForeground : theme.secondaryForeground },
          labelScale === undefined ? undefined : { fontSize: QUICK_LABEL_FONT_SIZE * labelScale, lineHeight: QUICK_LABEL_LINE_HEIGHT * labelScale },
        ]}
      >{label}</Text>
    </Pressable>
  );
}

function formatDate(value: string, locale = 'en-US') {
  return new Intl.DateTimeFormat(locale, { month: 'short', day: 'numeric' }).format(new Date(`${value}T12:00:00`));
}

function useHomeStyles() {
  const theme = useTheme();
  return useMemo(() => stylesForHomeTheme(theme), [theme]);
}

const homeStylesByTheme = new WeakMap<ThemeTokens, ReturnType<typeof createStyles>>();

function stylesForHomeTheme(theme: ThemeTokens) {
  const cached = homeStylesByTheme.get(theme);
  if (cached) return cached;
  const styles = createStyles(theme);
  homeStylesByTheme.set(theme, styles);
  return styles;
}

function createStyles(theme: ThemeTokens) {
  return StyleSheet.create({
  // Prototype Home (preview mode)
  top: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingVertical: 2 },
  iconBtn: {
    width: minimumTouchTarget,
    height: minimumTouchTarget,
    borderRadius: radii.pill,
    backgroundColor: theme.card,
    alignItems: 'center',
    justifyContent: 'center',
    ...elevation.level1,
  },
  badge: {
    // Inside the chip's bounds: an overhanging badge was the first thing the
    // drawer mask severed when the sheet slid aside.
    position: 'absolute',
    top: 2,
    right: 2,
    minWidth: 17,
    height: 17,
    borderRadius: 99,
    backgroundColor: theme.destructive,
    borderWidth: 2,
    borderColor: theme.background,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 3,
  },
  badgeText: { color: theme.destructiveForeground, fontSize: 10, ...typeface.heading },
  title: { flex: 1 },
  hi: { fontSize: 12.5, color: theme.mutedForeground, ...typeface.control },
  greeting: { fontFamily: Platform.select({ ios: 'Georgia', default: 'serif' }), fontWeight: '600', fontSize: 23, color: theme.foreground, lineHeight: 26 },
  accountRow: { alignItems: 'flex-end' },
  avatar: { width: minimumTouchTarget, height: minimumTouchTarget, borderRadius: radii.pill, alignItems: 'center', justifyContent: 'center' },
  avatarText: { color: theme.primaryForeground, ...typeface.controlStrong, fontSize: 15 },
  presence: { position: 'absolute', right: -2, bottom: -2, width: 11, height: 11, borderRadius: 6, backgroundColor: theme.compass, borderWidth: 2.5, borderColor: theme.background },
  // The stat band is one object in the top third, and the hero pass is declared
  // on the band rather than repeated on each cell — four identical hero cards
  // were four competing heroes, which is what the brief §B one-hero rule and
  // the p1-wave2a "statRow-level hero" disposition both rule out. The cells are
  // flat panes inside it; every other card below stays on the contact-only
  // level 1, so the ladder still reads L1 card < hero < L2 < L3.
  statBand: { backgroundColor: theme.card, borderRadius: radii.cardRadius },
  statRow: { flexDirection: 'row', borderRadius: radii.cardRadius, overflow: 'hidden' },
  statDivider: { width: StyleSheet.hairlineWidth, backgroundColor: theme.border },
  stat: { flex: 1, borderWidth: 2, borderColor: 'transparent', paddingHorizontal: 12, paddingTop: 12, paddingBottom: 10 },
  statPressed: { borderColor: theme.primary, backgroundColor: theme.secondary },
  // b03a-6: the desk shortcut, 72px, and on a staff hat the surface's one hero.
  deskHero: {
    minHeight: DESK_SHORTCUT_HEIGHT,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    backgroundColor: theme.card,
    borderRadius: radii.cardRadius,
    borderWidth: 2,
    borderColor: 'transparent',
    paddingHorizontal: 16,
    paddingVertical: 12,
    ...HERO_PASS,
  },
  deskHeroPressed: { borderColor: theme.primary, backgroundColor: theme.secondary },
  deskHeroCopy: { flex: 1, gap: 1 },
  deskHeroEyebrow: { fontSize: 11, ...typeface.heading, letterSpacing: 1.5, color: theme.primary },
  deskHeroTitle: { fontSize: 16, ...typeface.controlStrong, color: theme.foreground, lineHeight: 21 },
  deskHeroSub: { fontSize: 12, lineHeight: 16, color: theme.mutedForeground, ...typeface.bodyMedium },
  statValue: { fontSize: 24, color: theme.foreground, ...typeface.heading, letterSpacing: -0.4 },
  statLabel: { fontSize: 10.5, color: theme.mutedForeground, ...typeface.control, lineHeight: 13, marginTop: 2 },
  statLabelWords: { flexDirection: 'row', flexWrap: 'wrap', columnGap: 3, marginTop: 2 },
  statLabelWord: { marginTop: 0 },
  sectionLabel: { fontSize: 11, ...typeface.heading, letterSpacing: 1.5, color: theme.mutedForeground, marginHorizontal: 4 },
  card: { backgroundColor: theme.card, borderRadius: radii.controlRadius, paddingVertical: 4, overflow: 'hidden', ...elevation.level1 },
  tile: { flexDirection: 'row', alignItems: 'center', gap: 13, paddingVertical: 12.5, paddingHorizontal: 16 },
  tileDivider: { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: theme.border },
  tileIcon: { width: 36, height: 36, borderRadius: 10, alignItems: 'center', justifyContent: 'center' },
  tileLabel: { fontSize: 15.5, ...typeface.control, color: theme.foreground },
  tileSub: { fontSize: 12, color: theme.mutedForeground, ...typeface.bodyMedium, marginTop: 1 },
  todoRow: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingVertical: 13, paddingHorizontal: 16 },
  ring: { width: 24, height: 24, borderRadius: 12, borderWidth: 2, borderColor: theme.border, alignItems: 'center', justifyContent: 'center' },
  ringDone: { backgroundColor: theme.compass, borderColor: theme.compass },
  todoTitle: { fontSize: 14.5, ...typeface.control, color: theme.foreground },
  todoTitleDone: { textDecorationLine: 'line-through', color: theme.mutedForeground },
  todoSub: { fontSize: 12, color: theme.mutedForeground },
  activityRow: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingVertical: 11, paddingHorizontal: 16 },
  activityTitle: { fontSize: 14, ...typeface.control, color: theme.foreground },
  activitySub: { fontSize: 12, color: theme.mutedForeground, marginTop: 1 },
  activityAttended: { fontSize: 11.5, ...typeface.heading, color: theme.primary },
  due: { borderRadius: 99, paddingHorizontal: 10, paddingVertical: 4, backgroundColor: theme.accent },
  dueToday: { backgroundColor: theme.destructive },
  dueText: { fontSize: 12, ...typeface.controlStrong, color: theme.accentForeground },
  dueTodayText: { color: theme.destructiveForeground },

  // Authenticated (live-data) Home
  intro: { gap: spacing.xs },
  chapterIdentity: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm, minHeight: minimumTouchTarget, borderRadius: radii.md, paddingVertical: spacing.sm, paddingHorizontal: spacing.md },
  chapterIdentityMark: { width: 36, height: 36, borderRadius: radii.pill, alignItems: 'center', justifyContent: 'center' },
  chapterIdentityCopy: { flex: 1, gap: 2 },
  chapterIdentityTitle: { fontSize: 15, lineHeight: 20, ...typeface.heading },
  section: { gap: spacing.sm },
  metrics: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'flex-start', rowGap: spacing.md, borderRadius: radii.md, paddingVertical: spacing.md, paddingHorizontal: spacing.sm },
  metric: { minHeight: minimumTouchTarget, paddingHorizontal: spacing.sm, gap: 2 },
  metricValue: { fontSize: 20, lineHeight: 24, ...typeface.controlStrong },
  metricLabel: { fontSize: SUMMARY_LABEL_FONT_SIZE, lineHeight: 16, ...typeface.control },
  row: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  eyebrow: { fontSize: 13, lineHeight: 18, ...typeface.controlStrong, letterSpacing: 0.4 },
  quickGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm },
  quick: { minHeight: 104, borderRadius: radii.md, padding: spacing.md, justifyContent: 'space-between' },
  quickLabel: { fontSize: QUICK_LABEL_FONT_SIZE, lineHeight: QUICK_LABEL_LINE_HEIGHT, ...typeface.controlStrong },
  });
}
