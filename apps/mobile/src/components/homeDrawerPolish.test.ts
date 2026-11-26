import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import { PREVIEW_HATS, previewDeskFor } from '../data/preview';
import { featureGroupsForHat } from '../lib/hatFunctions';

// Source contract for the 2026-09-04 Home drawer polish: the defects read off
// the Pixel screenshots of the Advisor hat with each drawer open. Every pin
// names the defect it closes so the next wave cannot quietly reintroduce it.
// The geometry itself is asserted numerically in drawerEdgeGeometry.test.ts
// and the copy helpers in deskCopy.test.ts; these pins only tie the
// components to those helpers.

function read(relative: string) {
  return readFileSync(fileURLToPath(new URL(relative, import.meta.url)), 'utf8');
}

describe('Home drawer polish (2026-09-04)', () => {
  const carousel = read('./HomeCarousel.tsx');
  const chrome = read('../lib/chrome.ts');
  const hats = read('./HatSwitcher.tsx');
  const deck = read('./FunctionDeck.tsx');
  const widgets = read('./WorkWidgets.tsx');
  const home = read('../../app/(tabs)/home.tsx');
  const handleRowSource = read('./HomeHandleRow.tsx');
  const preview = read('../data/preview.ts');

  it('paints only the revealed drawer beneath the sheet (third-page residue)', () => {
    // The inactive drawer showed through the facing corners as a white block
    // of its own cards, with its row text bleeding past the bottom curve.
    expect(carousel).toContain("opacity: visibleDrawer === 'features' ? 1 : 0,");
    expect(carousel).toContain("opacity: visibleDrawer === 'work' ? 1 : 0,");
  });

  // BUG-UG-NATIVE-HOME-DRAWER-FRAME-SEAMS-20261102 (owner ruling,
  // November 3): the sheet is a rounded panel with a shadow. Its radius and
  // shadow are the level-3 tokens, the shadow grows with the reveal, and no
  // hairline or painted fade runs down its facing edge.
  it('makes the moving Home sheet a rounded level-3 panel with a shadow', () => {
    expect(carousel).not.toContain("from 'react-native-svg'");
    expect(carousel).toContain("import { drawerFrame, interactiveDrawer, type OpenDrawer } from '../lib/drawerEdgeGeometry';");
    expect(carousel).toContain('const HOME_CARD_RADIUS = radii.sheetRadius;');
    expect(carousel).not.toContain('DRAWER_EDGE_');
    expect(carousel).toContain("revealedShadow(elevation.level3, frame.reveal, visibleDrawer === 'features' ? 'left' : 'right'),");
    // The shadow host does not clip (iOS drops the shadow of a clipped view);
    // the inner view clips the feed to the same corners.
    expect(carousel).toContain("homeCard: { position: 'absolute', top: 0, right: 0, bottom: 0, left: 0, zIndex: 2 },");
    expect(carousel).toContain('<View style={[styles.homeCardClip, edgeRadiusStyle]}>');
    // The corner radius is derived from the reveal that moves the sheet.
    expect(carousel).toContain('const frame = drawerFrame(renderOffset, drawerWidth, HOME_CARD_RADIUS);');
    expect(carousel).toContain('transform: [{ translateX: frame.x }]');
    // The sheet and its facing edges are never Animated.Views. The only two in
    // the file are the drawer open handles, which ride Home's animated scroll
    // offset on their measured row (gate round 2 on PR #4266).
    expect(carousel.match(/<Animated\.View/g)).toHaveLength(2);
    // A hidden handle takes no tap (#9607).
    // A hidden handle is also hidden from screen readers (#9630 final, r3g2).
    // Each pill has its own state and fade.
    expect(carousel).toContain('{...handleState(handlesDrawn.features)}\n            style={[styles.drawerOpenHandleColumn, styles.drawerOpenHandleLeft, handleRow(featuresOpacity)]}');
    expect(carousel).toContain('{...handleState(handlesDrawn.work)}\n            style={[styles.drawerOpenHandleColumn, styles.drawerOpenHandleRight, handleRow(workOpacity)]}');
    expect(carousel).toContain("? { pointerEvents: 'box-none' }\n    : { pointerEvents: 'none', accessibilityElementsHidden: true, importantForAccessibility: 'no-hide-descendants' };");
    expect(carousel).not.toContain('DrawerFacingEdge');
    expect(carousel).not.toContain('stroke={theme.border}');
    expect(carousel).not.toContain('ClipPath');
  });

  it('veils the peeked Home sheet so the drawer owns attention', () => {
    expect(carousel).toContain('const HOME_VEIL_OPACITY = 0.55;');
    expect(carousel).toContain('const veilOpacity = frame.reveal * HOME_VEIL_OPACITY;');
    expect(carousel).toContain('styles.homeVeil');
    // The sheet still keeps its full size: no scale, no clipping change.
    expect(carousel).not.toMatch(/transform: \[\{ translateX \}, \{ scale:/);
  });

  it('publishes the drawer reveal so root chrome stands down with the sheet', () => {
    expect(chrome).toContain('export const homeDrawerReveal = new Animated.Value(0);');
    expect(chrome).toContain('export function syncHomeDrawerReveal(progress: number): void');
    expect(carousel).toContain('syncHomeDrawerReveal(frame.reveal);');
    // Leaving Home resets the reveal so the pill never stays faded elsewhere.
    expect(carousel).toMatch(/setDockSuppressed\(false\);\s*syncHomeDrawerReveal\(0\);/);
  });

  it('fades the PREVIEW hat pill with the drawer instead of floating it over the open drawer', () => {
    expect(hats).toContain('const drawerOpen = useDockSuppressed();');
    expect(hats).toContain('const pillDim = Animated.subtract(1, homeDrawerReveal);');
    expect(hats).toContain("pointerEvents={drawerOpen || pillOffScreen ? 'none' : 'box-none'}");
    expect(hats).toContain('accessibilityElementsHidden={drawerOpen || open}');
    // Opening the dropdown keeps its trigger outside the modal accessibility tree.
    expect(hats).toContain('opacity: pillOpacity,');
    expect(hats).toContain('scrollsWithHome ? Animated.multiply(pillDim, homePillVisibility) : pillDim');
  });

  it('starts both drawers on the shared content line, under their own ramp', () => {
    // REQ-UG-MOBILE-TOP-CHROME-PROGRESSIVE-BLUR-FLOATING-PILL-20261010:
    // the drawers used to paint nothing behind the status bar, so their rows
    // collided with the clock and the SOS / Wi-Fi / battery cluster.
    expect(carousel).toContain('const topPad = contentStartInset(insets.top);');
    expect(carousel).not.toContain('floatingChromeTopInset');
    expect(carousel).not.toContain('insets.top + spacing.sm');
    // No drawer draws a band at its top any more: scrolled rows pass behind
    // the clock (owner ruling, Nov 22-23, 2026, #9607).
    expect(carousel).not.toContain('TopRamp');
    expect(carousel).not.toContain('statusBacked');
  });

  it('puts the drawer open handles on their own row below Home\'s stat band', () => {
    // They sat over the band's rounded corners in the October 9 capture
    // (item 5). Home measures the band and publishes its bottom; the handles
    // are a row at that offset, not a full-height centred column.
    // The row is reserved in the feed, so the handles never cover the next
    // section, and its own top is what is published (gate round 1 on PR #4266).
    expect(handleRowSource).toContain('onLayout={(event) => syncHomeHandleRowTop(event.nativeEvent.layout.y)}');
    expect(handleRowSource).toContain('handleRow: { height: minimumTouchTarget },');
    expect(carousel).toContain('const handleRowTop = useHomeHandleRowTop();');
    expect(carousel).toContain('styles.drawerOpenHandleLeft, handleRow(featuresOpacity)]');
    expect(carousel).toContain('styles.drawerOpenHandleRight, handleRow(workOpacity)]');
    // A Home with no row publishes nothing: a zero row keeps the handles
    // centred rather than under the status bar, and each row clears itself
    // when it unmounts. Both Homes reserve one
    // (BUG-UG-NATIVE-HOME-EDGE-PILLS-COVER-SECTION-HEADING-20261103).
    expect(carousel).toContain(': styles.drawerOpenHandleCentred;');
    // The measured row rides the feed's scroll, like the PREVIEW hat pill (gate
    // round 2 on PR #4266), and never leaves the accessibility tree on Home's
    // 1pt away-from-top flag while it is still on screen (gate round 3).
    // The handles never leave that row: a row below the shortened Android box
    // is clipped by it, not pinned over the desk card (#7814).
    // Its opacity hides a handle that would be cut by the clip (#9607).
    expect(carousel).toContain('? { top: handleRowTop, opacity: handleOpacity, transform: [{ translateY: handleTravel }] }');
    expect(carousel).toContain('const handleTravel = useMemo(() => Animated.multiply(homeScrollOffset, -1), []);');
    expect(carousel).not.toContain('handleScrollLift');
    // The away-from-top flag shortens the box (#7756). It must not drop the
    // handles out of the tree while their row is still on screen.
    expect(carousel).toContain('const homeAwayFromTop = useHomeAwayFromTop()');
    expect(carousel).not.toContain('homeAwayFromTop ? null');
    expect(carousel).not.toContain('handleRowHidden');
    expect(carousel).toContain("drawerOpenHandleCentred: { top: '50%', marginTop: -minimumTouchTarget / 2 },");
    expect(handleRowSource).toContain('useEffect(() => claimHomeHandleRow(), []);');
    expect(home.match(/<HomeHandleRow \/>/g)).toHaveLength(2);
    expect(carousel).toMatch(/drawerOpenHandleColumn: \{[\s\S]*?height: minimumTouchTarget,/);
    expect(carousel).not.toMatch(/drawerOpenHandleColumn: \{[\s\S]*?bottom: 0,/);
    expect(chrome).toContain('export function syncHomeHandleRowTop(top: number): void');
    expect(chrome).toContain('export function useHomeHandleRowTop(): number');
  });

  // Platform inset painting and the visible customization control are executed
  // by homeDrawerSurface.test.ts, rather than checked as source strings here.

  it('keeps the Home notification badge inside its chip', () => {
    expect(home).toMatch(/badge: \{[\s\S]*?top: 2,\s*right: 2,/);
  });

  it('gives the features deck an unambiguous close control, readable shortcut labels, and clear corners', () => {
    expect(deck).toContain('<Ionicons name="close" size={20} color={theme.secondaryForeground} />');
    expect(deck).toContain("accessibilityLabel={t(\"Close and return to home\")}");
    // Whole labels at every size; real font measurements choose cell widths
    // (#9312), rather than a line cap hiding a split or truncated word.
    expect(deck).toContain("<Text style={[styles.railLabel, { width: '100%', color: theme.foreground }]} maxFontSizeMultiplier={labelScaleLimit}>{catalogLabel(item.label)}</Text>");
    expect(deck).toContain('const railColumns = shortcutRailColumns(availableWidth, measuredWordWidth);');
    expect(deck).toMatch(/groupCard: \{[\s\S]*?paddingVertical: spacing\.xs,/);
    expect(deck).toMatch(/rowDivider: \{[\s\S]*?marginRight: spacing\.md,/);
    // Reconcile saved keys and select defaults from the displayed catalogue.
    expect(deck).toContain('reconcileShortcutKeys(stored, [...byKey.keys()], defaultShortcutKeys(drawerGroups, MAX_SHORTCUTS), MAX_SHORTCUTS)');
  });

  it('gives every Work widget a straight rail, inset row rules, a venue line, and an honest empty state', () => {
    expect(widgets).toContain('styles.accentRail');
    expect(widgets).toContain("accentRail: { position: 'absolute', left: 0, width: 3 }");
    expect(widgets).toContain('straightRailInsets(radii.md)');
    expect(widgets).not.toContain('borderLeftWidth: 3');
    expect(widgets).toContain('const railColor = staffDesk ? theme.compass : theme.primary;');
    // The rail paints after the interactive content so a pressed header
    // cannot cover it.
    expect(widgets.indexOf('style={[styles.accentRail')).toBeGreaterThan(widgets.indexOf('{widget.empty ?? `Nothing in ${item.label} yet.`}'));
    expect(widgets).toContain("rowDivider: { height: StyleSheet.hairlineWidth, marginHorizontal: spacing.md }");
    expect(widgets).toContain('meta: entry.place,');
    expect(widgets).toContain("secondary: isPastEvent(entry, previewClock) ? `Past · ${entry.when}` : entry.when,");
    expect(widgets).toContain('secondary: statusLabel(entry.status),');
    expect(widgets).toContain("secondary: `Agreement ${entry.status.replaceAll('_', ' ')}`,");
    expect(widgets).toContain("const openTasks = (desk?.tasks ?? []).filter((entry) => isOpenTaskStatus(entry.status));");
    expect(widgets).toContain('badge: openTasks.length ? `${openTasks.length} open` : undefined,');
    expect(widgets).toContain('rows: openTasks.slice(0, 3).map((entry): WidgetRow => ({');
    expect(widgets).toContain('<Ionicons name="file-tray-outline"');
    expect(widgets).toContain('{widget.empty ?? `Nothing in ${item.label} yet.`}');
    expect(widgets).not.toContain('checkmark-done-outline');
    expect(widgets).not.toContain("'Nothing here yet.'");
  });

  it('renders each Work widget source from its own dataset, never another widget\'s rows', () => {
    // "Support trend", "Broadcasts" and "Campaign memberships" have no
    // collection on the desk. Without this branch they fall through to a
    // donor's rows under their own title.
    expect(widgets).toMatch(/if \(source === 'trend' \|\| source === 'broadcasts' \|\| source === 'memberships' \|\| source === 'invitations'\) \{\n(?:\s*\/\/.*\n)*\s*return \{ href: item\.href, rows: \[\], hideBody: true, empty: VIEW_EMPTY_LINE\[source\] \};/);
    // A view with no dataset says what is absent; "yet" promised rows.
    expect(widgets).toContain("trend: 'No support trend is recorded here.',");
    expect(widgets).toContain("broadcasts: 'Sent broadcasts are not listed here.',");
    expect(widgets).toContain("memberships: 'Campaign memberships open on an authorized session.',");
    expect(widgets).toContain("invitations: 'Invitations are listed on the full screen.',");
    const emptyLines = widgets.match(/^const VIEW_EMPTY_LINE: [^\n]* = \{[\s\S]*?\n\};/m)?.[0].split('\n').slice(1, -1) ?? [];
    // One line per empty source, so a reformatted declaration the pattern
    // misses fails here instead of passing an empty loop.
    expect(emptyLines.length).toBeGreaterThanOrEqual(3);
    for (const line of emptyLines) {
      expect(line).not.toMatch(/\byet\b/i);
    }
    // The KPI rows belong to the kpis source alone, and the function ends on
    // an exhaustiveness guard: a source with no branch fails the typecheck
    // instead of borrowing the desk KPIs.
    expect(widgets).toMatch(/if \(source === 'kpis'\) \{\n\s*return \{\n\s*href: item\.href,\n\s*rows: \(desk\?\.kpis \?\? \[\]\)\.slice\(0, 3\)/);
    expect(widgets.match(/desk\?\.kpis \?\? \[\]/g)).toHaveLength(1);
    expect(widgets).toMatch(/source satisfies never;\n\s*return \{ href: item\.href, rows: \[\] \};\n\}\n/);
    // "Upcoming deadlines" is the dated slice of the desk queue, not the
    // chapter tasks "Chapter work" already lists on the same desk.
    expect(widgets).toContain("rows: (desk?.queue ?? []).filter((entry) => entry.status === 'overdue' || entry.status === 'due soon').slice(0, 3).map((entry): WidgetRow => ({");
    expect(widgets).toContain('id: `deadline-${entry.id}`,');
    const coordinator = previewDeskFor('coordinator');
    const deadlines = coordinator.queue.filter((entry) => entry.status === 'overdue' || entry.status === 'due soon');
    expect(deadlines.map((entry) => entry.title)).toEqual(['HCU-121 · Mandated overtime on weekends', 'HCU-133 · Schedule changes without notice']);
    const taskTitles = new Set(coordinator.tasks.map((entry) => entry.title));
    expect(deadlines.some((entry) => taskTitles.has(entry.title))).toBe(false);
  });

  it('dates every preview meeting with an offset-aware Eastern instant and one derived grammar', () => {
    expect(preview).toContain('  startsAt: string;');
    expect(preview).toContain("import { EVENT_TIME_ZONE, formatEventWhen } from '../lib/deskCopy';");
    expect(preview).toContain('return { id, title, startsAt, when: formatEventWhen(startsAt, new Date(now)), place, summary };');
    // No event literal keeps a hand-written `when` (appointments carry
    // `withName` before theirs and are a different fixture shape).
    expect(preview).not.toMatch(/title: '[^']+', when: '/);
    for (const hat of PREVIEW_HATS) {
      for (const event of previewDeskFor(hat.key).events) {
        expect(event.startsAt, `${hat.key} / ${event.id}`).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}-0[45]:00$/);
        expect(Number.isNaN(new Date(event.startsAt).getTime()), `${hat.key} / ${event.id}`).toBe(false);
        expect(event.when, `${hat.key} / ${event.id}`).toMatch(/^[A-Z][a-z]{2}, [A-Z][a-z]{2} \d{1,2}(, \d{4})? · \d{1,2}:\d{2} [AP]M$/);
      }
    }
  });

  it('gives every destination inside a deck group its own glyph', () => {
    for (const hat of PREVIEW_HATS) {
      for (const group of featureGroupsForHat(hat.key)) {
        const icons = group.items.map((item) => item.icon);
        expect(new Set(icons).size, `${hat.key} / ${group.label}: ${icons.join(', ')}`).toBe(icons.length);
      }
    }
  });

  it('leads every organizing hat\'s Campaign group with dated Campaign work', () => {
    for (const hat of PREVIEW_HATS) {
      if (hat.key === 'member') continue;
      const chapter = featureGroupsForHat(hat.key).find((group) => group.key === 'chapter');
      expect(chapter?.items[0]?.label, hat.key).toBe('Campaign work');
    }
  });

  it('exposes VoiceOver actions and a visible control to open All tools and Campaign work', () => {
    expect(carousel).toContain("{ name: 'openFeatures', label: t(\"Open All tools\") }");
    expect(carousel).toContain("{ name: 'openWork', label: t(\"Open Campaign work\") }");
    expect(carousel).toContain('onAccessibilityAction={(event) => {');
    expect(carousel).toContain("if (event.nativeEvent.actionName === 'openFeatures') openFeatures();");
    expect(carousel).toContain("else if (event.nativeEvent.actionName === 'openWork') openWork();");
    expect(carousel).toContain('accessibilityRole="button"');
    expect(carousel).toContain("accessibilityLabel={t(\"Open All tools\")}");
    expect(carousel).toContain("accessibilityLabel={t(\"Open Campaign work\")}");
    expect(carousel).toContain("accessibilityLabel={t(\"Close drawer and return to Home\")}");
    // The visible handles act only while whole (#9630 final, r3g2).
    expect(carousel).toContain('onPress={openFeaturesHandle}');
    expect(carousel).toContain('onPress={openWorkHandle}');
    expect(carousel).toContain('const openFeaturesHandle = useCallback(() => { if (homeHandleDrawn(handleOffset.current, handleWholeFromRef.current.features)) openFeatures(); }, [openFeatures]);');
    expect(carousel).toContain('const openWorkHandle = useCallback(() => { if (homeHandleDrawn(handleOffset.current, handleWholeFromRef.current.work)) openWork(); }, [openWork]);');
    expect(carousel).toContain('onPress={returnHome}');
    expect(carousel).toContain('snapTo(drawerWidth)');
    expect(carousel).toContain('snapTo(-drawerWidth)');
  });

  it('closes an open drawer on Android Back instead of leaving the app, only while Home is focused', () => {
    expect(carousel).toContain('useFocusEffect(useCallback(() => {\n    if (activeDrawer == null) return undefined;');
    expect(carousel).toContain("BackHandler.addEventListener('hardwareBackPress', () => {\n      returnHome();\n      return true;\n    });");
    expect(carousel).toContain('return () => subscription.remove();');
  });

  it('attaches drawer custom actions to a dedicated VoiceOver target without grouping Home', () => {
    const fillOpen = carousel.indexOf('style={[styles.homeBox, { backgroundColor: theme.muted, marginBottom: minimizedReserve }]}');
    expect(fillOpen).toBeGreaterThan(-1);
    const fillTag = carousel.slice(fillOpen, carousel.indexOf('>', fillOpen) + 1);
    expect(fillTag).not.toContain('accessibilityActions');
    expect(fillTag).not.toContain('accessible');
    expect(carousel).toContain('accessible\n          accessibilityRole="summary"');
    expect(carousel).toContain("accessibilityLabel={t(\"Home navigation\")}");
    expect(carousel).toContain('importantForAccessibility="yes"');
    expect(carousel).toContain('style={styles.homeDrawerActions}');
    expect(carousel).toContain("homeDrawerActions: { position: 'absolute', width: 1, height: 1 }");
    expect(carousel).toContain('pointerEvents="none"\n          style={styles.homeDrawerActions}');
    expect(carousel).toContain('accessibilityElementsHidden={visibleDrawer != null || isMoving}');
    expect(carousel).not.toMatch(/accessible\n          accessibilityRole="summary"[\s\S]{0,400}\{children\}/);
  });
});
