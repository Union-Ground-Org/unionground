import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

describe('Prototype-parity Home (union-ground-redesign.html, owner request 2026-08-20)', () => {
  it('renders the prototype Home: greeting header, stat row, My campaign tiles, Today checklist', () => {
    const home = readFileSync(fileURLToPath(new URL('../../app/(tabs)/home.tsx', import.meta.url)), 'utf8');
    expect(home).toContain(' · Harborview Care United');
    expect(home).toContain("'Open issues', 'Due this week', 'Unread', 'Actions taken'");
    expect(home).toContain('MY CAMPAIGN');
    expect(home).toContain('TODAY');
    expect(home).toContain('Organizing rights');
    expect(home).toContain('Take the workplace issues survey');
    expect(home).toContain("Platform.select({ ios: 'Georgia', default: 'serif' })");
    // Summary cards are real navigation controls, not a local-only selection.
    expect(home).not.toContain('statSel');
    expect(home).toContain('STAT_ROUTES');
    expect(home).toContain('setTodos');
  });

  it('wires the Home header and tiles inside the retained over-under swipe shell', () => {
    const home = readFileSync(fileURLToPath(new URL('../../app/(tabs)/home.tsx', import.meta.url)), 'utf8');
    const carousel = readFileSync(fileURLToPath(new URL('./HomeCarousel.tsx', import.meta.url)), 'utf8');
    expect(home).toContain('setRailOpen(true)');
    expect(home).toContain("router.push('/notifications')");
    expect(home).toContain("router.push('/account')");
    expect(home).toContain("router.push('/compass')");
    expect(home).toContain('<ChapterRail');
    expect(home).toContain('<HomeCarousel');
    expect(carousel).toContain('styles.drawerLeft');
    expect(carousel).toContain('styles.drawerRight');
    // The owner device correction keeps one full-size clipped sheet on
    // `translateX`; since #6811 it is a rounded panel with a shadow, with no
    // separator drawn down its facing edge.
    expect(carousel).toContain('transform: [{ translateX: frame.x }]');
    expect(carousel).toContain("homeCard: { position: 'absolute'");
    expect(carousel).toContain("overflow: 'hidden'");
    expect(carousel).not.toContain('DrawerFacingEdge');
    expect(carousel).not.toContain('borderWidth: 1 },');
    expect(carousel).not.toContain('{ scale: lift }');
    expect(carousel).toContain('<MemoWorkWidgets');
    expect(carousel).not.toContain('<CompassPanel');
    expect(carousel).not.toContain('Animated.ScrollView');
  });

  it('keeps compact native controls at the 48-point repository minimum', () => {
    const home = readFileSync(fileURLToPath(new URL('../../app/(tabs)/home.tsx', import.meta.url)), 'utf8');
    const notifications = readFileSync(fileURLToPath(new URL('../../app/notifications.tsx', import.meta.url)), 'utf8');
    const channel = readFileSync(fileURLToPath(new URL('../../app/channel/[id].tsx', import.meta.url)), 'utf8');
    const pulse = readFileSync(fileURLToPath(new URL('../features/PulseScreen.tsx', import.meta.url)), 'utf8');
    const hat = readFileSync(fileURLToPath(new URL('./HatSwitcher.tsx', import.meta.url)), 'utf8');
    expect(home).toContain('width: minimumTouchTarget');
    expect(home).toContain('height: minimumTouchTarget');
    expect(notifications).toContain('metaAction: { minHeight: minimumTouchTarget');
    // A message's reaction chips keep a full 48 pt target around their 36 pt chip.
    expect(readFileSync(new URL('./MessageReactions.tsx', import.meta.url), 'utf8')).toContain("chipTarget: { maxWidth: '100%', flexShrink: 1, minWidth: minimumTouchTarget, minHeight: minimumTouchTarget, justifyContent: 'center' },");
    expect(channel).toContain('send: { width: minimumTouchTarget, height: minimumTouchTarget');
    expect(pulse).toContain('segButton: { flex: 1, minHeight: minimumTouchTarget');
    // The hat pill is a 26pt floating capsule now
    // (REQ-UG-MOBILE-TOP-CHROME-PROGRESSIVE-BLUR-FLOATING-PILL-20261010).
    // Its tap target is the anchor band, 48pt wide and bounded by the capsule's
    // top edge and the content start line, so a hitSlop would push it into the
    // status bar and into content; the numbers are executed in
    // ../lib/chromeGeometry.test.ts.
    expect(hat).toContain('const PILL_HEIGHT = FLOATING_CONTROL_SIZE;');
    expect(hat).toContain('const COMPACT_PILL_WIDTH = FLOATING_CONTROL_HIT_WIDTH;');
    expect(hat).not.toMatch(/hitSlop=/);
  });

  it('ships the Discord-style campaign rail with online row and channel shortcuts', () => {
    const rail = readFileSync(fileURLToPath(new URL('./ChapterRail.tsx', import.meta.url)), 'utf8');
    expect(rail).toContain('ONLINE NOW');
    expect(rail).toContain('CHANNELS');
    expect(rail).toContain('visibleChannels');
    expect(rail).not.toContain('accessibilityLabel="Invite a coworker"');
    expect(rail).not.toContain('accessibilityLabel="Add a local"');
    expect(rail).toContain('<TextInput');
    expect(rail).toContain('/channel/');
  });

  it('disables preview campaign tiles instead of announcing inert buttons (UX-UG-MOBILE-PREVIEW-CHAPTER-RAIL-TILES-INERT-20260920)', () => {
    const rail = readFileSync(fileURLToPath(new URL('./ChapterRail.tsx', import.meta.url)), 'utf8');
    // The press handler only switches in authenticated mode, so every preview tile must be disabled.
    expect(rail).toContain("onPress={() => { if (live) void chooseChapter(chapter.key); }}");
    expect(rail).toContain('const inert = !live || chapter.selected === true || busyChapter !== null;');
    expect(rail).toContain('disabled={inert}');
    expect(rail).toContain('accessibilityState={{ disabled: inert, selected: chapter.selected === true }}');
    // A non-current preview tile (NCT, MDC) says why it cannot be activated, and looks unavailable.
    expect(rail).toContain('const previewOnly = !live && !chapter.selected;');
    expect(rail).toContain("previewOnly ? ', preview only. Sign in to switch campaigns' : ''");
    expect(rail).toContain("previewOnly ? { borderColor: theme.border, borderStyle: 'dashed' } : null");
    // Live non-current chapters stay actionable until a switch is in flight.
    expect(rail).not.toContain('disabled={live && (campaign.selected || busyChapter !== null)}');
  });

  it('keeps Guide concise with a scrolling header and compact composer', () => {
    const compass = readFileSync(fileURLToPath(new URL('./CompassPanel.tsx', import.meta.url)), 'utf8');
    expect(compass).not.toContain('Message Guide');
    expect(compass).not.toContain('Guide can be inaccurate');
    expect(compass).not.toContain('General union guidance');
    expect(compass).not.toContain('compassMark');
    expect(compass.indexOf('style={styles.header}')).toBeGreaterThan(compass.indexOf('<ScrollView'));
    expect(compass).toContain('maxHeight: 88');
    expect(compass).toContain('keyboardAppearance={theme.appearance}');
  });
});

describe('Mobbin collection wave 2 (real previews from the MOBILE guides collection)', () => {
  it('wraps All-features groups in GitHub-style cards with inset dividers', () => {
    const deck = readFileSync(fileURLToPath(new URL('./FunctionDeck.tsx', import.meta.url)), 'utf8');
    expect(deck).toContain('groupCard');
    expect(deck).toContain('rowDivider');
    expect(deck).toContain('chevron-forward');
    // Shadows come from the shared elevation ladder, never per-screen
    // constants. The deck is a level-3 drawer, so its own contents sit at
    // level 0 and separate by hairline (P1 wave 2a, b02a-17).
    expect(deck).toContain('elevation.level0');
  });

  it('keeps Guide visibly ready in the scrolling thread and clears native tabs', () => {
    const compass = readFileSync(fileURLToPath(new URL('./CompassPanel.tsx', import.meta.url)), 'utf8');
    expect(compass).toContain('aiPill');
    expect(compass).toContain('assistantLabelRow');
    expect(compass).toContain("accessibilityLabel: 'Guide is ready'");
    expect(compass).toContain('Ready to search your approved campaign sources');
    expect(compass).toContain('if (reduceMotion || !compassReady)');
    expect(compass).not.toContain('Animated.loop');
    expect(compass.indexOf('accessibilityLabel={availability.accessibilityLabel}')).toBeLessThan(compass.indexOf('{visibleMessages.length === 0 ?'));
    expect(compass).toContain('<View style={styles.header}>');
    expect(compass).toContain('marginBottom: composerLift');
  });

  it('marks staff Work widgets with a distinct accent and tone dots', () => {
    const widgets = readFileSync(fileURLToPath(new URL('./WorkWidgets.tsx', import.meta.url)), 'utf8');
    expect(widgets).toContain('MEMBER_WIDGET_KEYS');
    // The accent rail is its own clipped view: a border-left on a rounded
    // card tapered into a crescent at both corners.
    expect(widgets).toContain('styles.accentRail');
    expect(widgets).toContain('toneDot');
    expect(widgets).toContain('tileRow');
  });

  it('builds a texting-style Messages inbox and anchored bubble thread', () => {
    const messages = readFileSync(fileURLToPath(new URL('../../app/messages.tsx', import.meta.url)), 'utf8');
    expect(messages).toContain('SearchField');
    expect(messages).toContain('<Avatar');
    expect(messages).toContain('styles.recentSection');
    expect(messages).toContain('styles.inboxList');
    expect(messages).toContain('composerRow');
    expect(messages).toContain('copy.unreadCount(item.unread)');
    expect(messages).toContain('onPress={openSteward}');
    expect(messages).not.toContain('rowPresence');
    expect(messages).not.toContain('styles.presence');
    const thread = readFileSync(fileURLToPath(new URL('../../app/conversation/[id].tsx', import.meta.url)), 'utf8');
    expect(thread).toContain('dayDivider');
    expect(thread).toContain('senderRow');
    expect(thread).toContain('styles.bubbleMine');
    expect(thread).toContain('styles.bubbleTheirs');
    expect(thread).toContain('<KeyboardAvoidingView');
    expect(thread).toContain('styles.composerDock');
    expect(thread).toContain('{draft.length}/4,000');
    // Preview leaves the visible title to the thread's own chrome.
    expect(thread).toContain("<PinnedHeaderScreen title={mode === 'preview' ? undefined : title} screenName={title}>");
    expect(thread).toContain("onTitleChange(mode === 'authenticated' && !loading ? thread?.conversation.title ?? 'Messages' : 'Messages')");
    expect(thread).toContain('previous.senderName === message.senderName');
  });

  it('removes repeated implementation and safety explanations from routine screens', () => {
    const messages = readFileSync(fileURLToPath(new URL('../../app/messages.tsx', import.meta.url)), 'utf8');
    const thread = readFileSync(fileURLToPath(new URL('../../app/conversation/[id].tsx', import.meta.url)), 'utf8');
    const pulse = readFileSync(fileURLToPath(new URL('../features/PulseScreen.tsx', import.meta.url)), 'utf8');
    expect(messages).not.toContain('Messages are reloaded from the authorized backend');
    expect(messages).not.toContain('Do not use this channel for emergencies');
    expect(thread).not.toContain('Do not use messages for emergencies');
    expect(thread).not.toContain('Protected content is loaded only after');
    expect(pulse).not.toContain('Pulse charts summarize this seeded demo workspace');
  });

  it('partitions Updates into New cards and an Earlier group with kind icons', () => {
    const notifications = readFileSync(fileURLToPath(new URL('../../app/notifications.tsx', import.meta.url)), 'utf8');
    expect(notifications).toContain('kindIcons');
    expect(notifications).toContain('{copy.earlier}');
    expect(notifications).toContain('<Group>');
    expect(notifications).toContain('emptyBadge');
  });

  it('applies the notes visual language to Union and issue detail', () => {
    const union = readFileSync(fileURLToPath(new URL('../../app/(tabs)/campaign.tsx', import.meta.url)), 'utf8');
    expect(union).toContain('StatusPill');
    expect(union).toContain('sectionLabel');
    const caseDetail = readFileSync(fileURLToPath(new URL('../../app/issue/[id].tsx', import.meta.url)), 'utf8');
    expect(caseDetail).toContain('styles.chips');
    expect(caseDetail).toContain('StatusPill');
  });

  it('uses the native tab host with exactly the five organizing destinations', () => {
    const tabs = readFileSync(fileURLToPath(new URL('../../app/(tabs)/_layout.tsx', import.meta.url)), 'utf8');
    expect(tabs).toContain("from 'expo-router/unstable-native-tabs'");
    expect(tabs).toContain('<NativeTabs');
    expect(tabs).not.toContain('CapsuleTabBar');
    expect(tabs).not.toContain('DockScrim');
    // Messages is not a dock root; its settled unread count rides on Home.
    expect(tabs).toContain('<NativeTabs.Trigger.Badge');
    expect(tabs).toContain('unreadMessages');
    expect(tabs).toContain('nativeInboxUnreadItemCount');
    expect(tabs).toContain("mode !== 'preview' || previewHat !== 'member' || !channel.locked");
    expect(tabs).not.toContain('conversation.unreadCount');
    expect([...tabs.matchAll(/<NativeTabs.Trigger name="([^"]+)"/g)].map((match) => match[1]))
      .toEqual(['home', 'work', 'compass', 'campaign', 'account']);
    const homeTrigger = tabs.slice(tabs.indexOf('<NativeTabs.Trigger name="home"'), tabs.indexOf('<NativeTabs.Trigger name="work"'));
    expect(homeTrigger).toContain('<NativeTabs.Trigger.Badge');
    for (const retired of ['messages', 'pulse', 'union']) {
      expect(tabs).not.toContain(`name="${retired}"`);
    }
    // Content scroll ends must clear the system tab bar.
    const ui = readFileSync(fileURLToPath(new URL('./ui.tsx', import.meta.url)), 'utf8');
    expect(ui).toContain('{ paddingTop: topPadding, paddingBottom: bottomPadding }');
    const home = readFileSync(fileURLToPath(new URL('../../app/(tabs)/home.tsx', import.meta.url)), 'utf8');
    expect(home).toContain('useNativeTabContentInset(true)');
    // Guide, Campaign and Account are dock roots: pinned name, no Back control.
    for (const [name, title] of [['compass', 'Guide'], ['campaign', 'Campaign'], ['account', 'Account']]) {
      expect(existsSync(fileURLToPath(new URL(`../../app/${name}.tsx`, import.meta.url)))).toBe(false);
      const root = readFileSync(fileURLToPath(new URL(`../../app/(tabs)/${name}.tsx`, import.meta.url)), 'utf8');
      expect(root).toContain(name === 'account' ? '<PinnedHeaderScreen screenName={t("Account")} onBack={null}>' : `<PinnedHeaderScreen screenName="${title}" onBack={null}>`);
    }
    // Messages and Campaign pulse are pushed screens with a pinned header.
    const rootLayout = readFileSync(fileURLToPath(new URL('../../app/_layout.tsx', import.meta.url)), 'utf8');
    for (const [name, title] of [['messages', 'Messages'], ['pulse', 'Campaign pulse']]) {
      expect(rootLayout).toContain(`<Stack.Screen name="${name}"`);
      expect(existsSync(fileURLToPath(new URL(`../../app/(tabs)/${name}.tsx`, import.meta.url)))).toBe(false);
      const pushed = readFileSync(fileURLToPath(new URL(`../../app/${name}.tsx`, import.meta.url)), 'utf8');
      expect(pushed).toContain(name === 'account' ? '<PinnedHeaderScreen screenName={t("Account")}>'
        : name === 'union' ? "<PinnedHeaderScreen screenName={t('My campaign')} language={language}>"
          : `<PinnedHeaderScreen screenName="${title}">`);
    }
  });

  it('hosts Work once inside NativeTabs, without a pushed Back control', () => {
    expect(existsSync(fileURLToPath(new URL('../../app/work.tsx', import.meta.url)))).toBe(false);
    const tab = readFileSync(fileURLToPath(new URL('../../app/(tabs)/work.tsx', import.meta.url)), 'utf8');
    expect(tab).toContain("from '../../src/features/WorkScreen'");
    expect(tab).toContain('<WorkScreen />');
    expect(tab).not.toContain('PinnedHeaderScreen');
  });

  it('keeps Account on both Home avatars and offers the Guide through the rights index', () => {
    const home = readFileSync(fileURLToPath(new URL('../../app/(tabs)/home.tsx', import.meta.url)), 'utf8');
    expect(home.match(/accessibilityLabel=\{t\("Account"\)\}/g)).toHaveLength(2);
    // UX-UG-SHOW-ACCOUNT-AVATAR-NATIVE-WELCOME-BACK-HOME-SCREEN-20261013:
    // the authenticated avatar is one element rendered by both Home returns,
    // the welcome-back one included.
    expect(home).toMatch(/const accountRow = \(\s*<View style=\{styles\.accountRow\}>\s*<Pressable\s+accessibilityRole="button"\s+accessibilityLabel=\{t\("Account"\)\}/);
    expect(home).toMatch(/\{accountRow\}\s*<WelcomeBackView onDismiss=\{welcome\.dismiss\} \/>/);
    expect(home.match(/\{accountRow\}/g)).toHaveLength(2);
    const campaign = readFileSync(fileURLToPath(new URL('../../app/(tabs)/campaign.tsx', import.meta.url)), 'utf8');
    for (const item of campaign.matchAll(/title: 'Organizing rights'[^\n]+/g)) {
      expect(item[0]).toContain("href: '/feature/rights'");
    }
    for (const feature of ['FeatureScreen', 'LiveLivedInScreens']) {
      const source = readFileSync(fileURLToPath(new URL(`../features/${feature}.tsx`, import.meta.url)), 'utf8');
      expect(source).toMatch(/<Heading>\{t\("Organizing rights"\)\}<\/Heading>\s*<AskCompassButton \/>/);
    }
    const compassEntry = readFileSync(fileURLToPath(new URL('./AskCompassButton.tsx', import.meta.url)), 'utf8');
    expect(compassEntry).toContain("label={t(\"Ask the Guide\")}");
    expect(compassEntry).toContain("router.push('/compass')");
    const carousel = readFileSync(fileURLToPath(new URL('./HomeCarousel.tsx', import.meta.url)), 'utf8');
    expect(carousel).toContain('withMyCampaignGroup(');
  });

  it('keeps the hat switcher SAMPLE-labelled without haze artifacts', () => {
    const hat = readFileSync(fileURLToPath(new URL('./HatSwitcher.tsx', import.meta.url)), 'utf8');
    // The opaque card fill moved into FrostedCapsule's Reduce Transparency and
    // Android branch; the keyline still carries the contrast on every theme.
    expect(hat).toContain('<FrostedCapsule style={[styles.pill');
    expect(hat).toContain('borderColor: theme.border');
    expect(hat).toContain('pill: { height: PILL_HEIGHT');
    expect(hat).toContain('PREVIEW · {current.label}');
    expect(hat).not.toContain('shimmerBand');
    expect(hat).toContain('reduceMotion');
  });

  it('restores native tabs when a Home drawer destination takes focus', () => {
    const carousel = readFileSync(fileURLToPath(new URL('./HomeCarousel.tsx', import.meta.url)), 'utf8');
    expect(carousel).toContain('useFocusEffect(useCallback(() => () => {');
    expect(carousel).toContain('setDockSuppressed(false);');
    expect(carousel).toContain('setSettledDrawer(null);');
  });

  it('opens seeded channels at current work instead of the archive top', () => {
    const channel = readFileSync(fileURLToPath(new URL('../../app/channel/[id].tsx', import.meta.url)), 'utf8');
    expect(channel).toMatch(/<Screen\s+scrollRef={channelScrollRef}/);
    expect(channel).toContain('scrollToEnd({ animated: false })');
    expect(channel).toContain('anchoredChannel.current === channelID');
  });

  it('lets workers customize the four deck shortcuts and drops the preview tag', () => {
    const deck = readFileSync(fileURLToPath(new URL('./FunctionDeck.tsx', import.meta.url)), 'utf8');
    expect(deck).toContain('SHORTCUT_STORE_KEY');
    expect(deck).toContain('Customize shortcuts');
    expect(deck).toContain('MAX_SHORTCUTS');
    expect(deck).not.toMatch(/Fictional [A-Za-z ]+ preview/);
  });

  it('keeps notification tests and biometrics usable in the demo', () => {
    const account = readFileSync(fileURLToPath(new URL('../../app/(tabs)/account.tsx', import.meta.url)), 'utf8');
    expect(account).toContain('sendTestNotification');
    expect(account).toContain('setLocalNotificationsEnabled');
    expect(account).not.toContain("disabled={!biometricAvailable || mode === 'preview'}");
  });
});
