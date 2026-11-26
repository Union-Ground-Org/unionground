import { useNativeUi } from "../lib/useNativeUi";
import { Ionicons } from '@expo/vector-icons';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useEffect, useState, useSyncExternalStore } from 'react';
import { Pressable, ScrollView, StyleSheet, View } from 'react-native';
import { Text } from '../components/Text';

import { CaseRowPressable } from '../components/CaseRowPressable';
import { StaffQuickCapture } from '../components/StaffQuickCapture';
import { StaffRolePicker } from '../components/StaffRolePicker';
import { StatusPill } from '../components/StatusPill';
import { Body, Button, Card, Heading, Screen, StateMessage } from '../components/ui';
import { WorkWidgets } from '../components/WorkWidgets';
import { useChannelStore } from '../data/useChannels';
import { useAccessibilityAnnouncementQueue } from '../lib/announce';
import { useNativeTabContentInset } from '../lib/chrome';
import { workSurfaceState } from '../lib/workSurfaceState';
import { caseStepInReview, memberCaseStep } from '../lib/caseStepLabels';
import { LIVE_STAFF_ROLE_LABELS, WORK_WIDGET_KEYS, explicitLiveStaffHat, hatFunctionBlurb, rightPaneKindForHat, staffDeskHomeRole, workItemsForHat, workItemsForRoles, workItemsWithRoleDeskFirst } from '../lib/hatFunctions';
import type { MemberCase } from '../models/member';
import { haptics } from '../services/haptics';
import { useMemberSwitchRead } from '../services/memberSwitches';
import { useApp } from '../state/AppProvider';
import type { StatusState } from '../theme/statusRamp';
import { useTheme } from '../theme/ThemeProvider';
import { minimumTouchTarget, radii, spacing } from '../theme/tokens';
import { NativeOrgStartGuide } from './guideLayers/GuideLayers';
import { NativeStaffGuides } from './guideLayers/StaffGuides';
import { NEURO_MAP_SWITCH_KEY } from './mi1/neuroMapSwitch';

import { typeface } from '../theme/typeface';
const BOARD_COLUMN_WIDTH = 260;
const MEMBER_WORK_WIDGET_KEYS = new Set<string>(WORK_WIDGET_KEYS);

type WorkView = 'list' | 'board';

// Board columns are status states, so their headers take the shared ramp
// (brief §C: "same hue for row dot, column header dot, chart segment"). The
// three saturated pill fills they used to carry are gone: one board header can
// no longer put a gold fill, a lavender fill and an aubergine fill in the same
// horizontal scroll.
function boardColumns(cases: MemberCase[]): { key: string; label: string; state: StatusState; cases: MemberCase[] }[] {
  const isActive = (item: MemberCase) => item.status.toLowerCase() === 'active';
  const inReview = (item: MemberCase) => isActive(item) && caseStepInReview(item);
  return [
    { key: 'review', label: 'Committee review', state: 'attention', cases: cases.filter(inReview) },
    { key: 'active', label: 'Organizing', state: 'active', cases: cases.filter((item) => isActive(item) && !inReview(item)) },
    { key: 'done', label: 'Resolved', state: 'done', cases: cases.filter((item) => !isActive(item)) },
  ];
}

function CaseBoard({ cases }: { cases: MemberCase[] }) {
  const { t, locale, catalogLabel } = useNativeUi();
  const router = useRouter();
  const theme = useTheme();
  const columns = boardColumns(cases).map((column) => ({ ...column, label: catalogLabel(column.label) }));
  return (
    <ScrollView
      horizontal
      showsHorizontalScrollIndicator={false}
      snapToInterval={BOARD_COLUMN_WIDTH + spacing.md}
      decelerationRate="fast"
      contentContainerStyle={styles.board}
      style={styles.boardScroll}
      accessibilityLabel={t("Issue board grouped by organizing stage")}
    >
      {columns.map((column) => (
        <View key={column.key} style={[styles.boardColumn, { backgroundColor: theme.muted }]}>
          <View style={styles.boardColumnHead}>
            <StatusPill label={column.label} state={column.state} />
            <Text style={[styles.boardCount, { color: theme.mutedForeground }]}>{column.cases.length}</Text>
          </View>
          {column.cases.length === 0 ? (
            <View style={[styles.boardCard, { backgroundColor: theme.card }]}>
              <Body muted>{t("Nothing in this stage.")}</Body>
            </View>
          ) : column.cases.map((item) => {
            const settled = item.status.toLowerCase() !== 'active';
            return (
              <Pressable
                key={item.id}
                accessibilityRole="button"
                accessibilityLabel={t('Open {reference}, {title}', { reference: item.reference, title: item.title })}
                onPress={() => { void haptics.select(); router.push(`/issue/${item.id}`); }}
                style={({ pressed }) => [styles.boardCard, { backgroundColor: theme.card, opacity: pressed ? 0.82 : 1 }]}
              >
                <Text style={[styles.boardCardTitle, settled ? styles.boardCardTitleDone : null, { color: settled ? theme.mutedForeground : theme.cardForeground }]}>{item.title}</Text>
                <View style={styles.boardCardMeta}>
                  <Text style={[styles.boardCardKey, { color: theme.primary }]}>{item.reference}</Text>
                  <Text style={[styles.boardCardStep, { color: theme.mutedForeground }]} numberOfLines={1}>{memberCaseStep(item)}</Text>
                </View>
                {item.deadline ? (
                  <View style={[styles.dueChip, { backgroundColor: theme.secondary }]}>
                    <Ionicons name="calendar-outline" size={12} color={theme.secondaryForeground} accessibilityElementsHidden />
                    <Text style={[styles.dueChipText, { color: theme.secondaryForeground }]}>{formatDeadline(item.deadline, locale)}</Text>
                  </View>
                ) : null}
              </Pressable>
            );
          })}
        </View>
      ))}
    </ScrollView>
  );
}

function formatDeadline(value: string, locale = 'en-US') {
  return new Intl.DateTimeFormat(locale, { month: 'short', day: 'numeric' }).format(new Date(`${value}T12:00:00`));
}

export default function WorkScreen() {
  const { t, locale, catalogLabel } = useNativeUi();
  const router = useRouter();
  const theme = useTheme();
  const params = useLocalSearchParams<{ section?: string; view?: string }>();
  const { dashboard, mode, refreshing, refresh, error, previewDesk, previewHat, previewWidgetLayout, setPreviewWidgetLayout, authorizedRoles, chapterRoles, organizationRoles, chosenStaffRole, staffRoleChoices, sessionRestricted } = useApp();
  // The Organization map row names the Neuro Map only once a read says it is on.
  const neuroMapOn = useMemberSwitchRead(NEURO_MAP_SWITCH_KEY, true) === true;
  const channelStore = useChannelStore();
  useSyncExternalStore(channelStore.subscribe, channelStore.getVersion);
  const inboxChannels = channelStore.channels().filter((channel) => (
    mode !== 'preview' || previewHat !== 'member' || !channel.locked
  ));
  const bottomInset = useNativeTabContentInset();
  const [view, setView] = useState<WorkView>(params.view === 'board' ? 'board' : 'list');
  useEffect(() => {
    if (params.view === 'board' || params.view === 'list') setView(params.view);
  }, [params.view]);
  const memberWork = rightPaneKindForHat(previewHat) === 'compass';
  const liveStaffHat = explicitLiveStaffHat(authorizedRoles);
  const workRole = staffDeskHomeRole({ mode, sessionRestricted, chosenStaffRole, authorizedRoles });
  const workItems = mode === 'preview' ? workItemsForHat(previewHat) : workItemsForRoles(chapterRoles, organizationRoles);
  // #9463: a failed refresh (AppProvider fetchDashboard's words) says the list
  // may be old; any other failure keeps its own words. Read out by the queue.
  const statusLine = dashboard && error
    ? (error === 'Your worker workspace could not be loaded securely. Check your connection and try again.' ? t('Some workspace records may be out of date. Refresh to recheck them.') : catalogLabel(error))
    : null;
  const announce = useAccessibilityAnnouncementQueue('work-tab-status');
  useEffect(() => (statusLine ? announce(statusLine) : undefined), [announce, statusLine]);
  const section = typeof params.section === 'string' ? params.section : null;

  if (!dashboard) {
    // A null dashboard is not proof of a signed-out session: an authenticated
    // session can be mid-load or recovering from a failed campaign refresh, and
    // that state gets recovery guidance with the existing refresh action —
    // never sign-in copy, and a disabled-while-refreshing Try again control so
    // repeated activation cannot stack refreshes or duplicate work items.
    const surfaceState = workSurfaceState({ mode, hasDashboard: false, refreshing });
    const recoveryMessage = surfaceState === 'loading'
      ? { title: t("Loading your work"), body: t("Your issues are on their way.") }
      : surfaceState === 'refreshFailed'
        ? { title: t("Work could not load"), body: t("Your issues did not load. Check your connection and try again.") }
        : surfaceState === 'mfaRequired'
          ? { title: t("Two-step verification is required"), body: t("Complete two-step verification to see your issues.") }
          : { title: t("No work to show"), body: t("Sign in to see your issues.") };
    // The recovery controls only work once bootstrap has finished: AppProvider
    // refresh() acts on a preview session or an established session, and a
    // cold-launch restore has neither, so offering them in the booting window
    // would be a dead control. The loading copy still renders while booting.
    const showRecovery = mode !== 'booting' && (surfaceState === 'loading' || surfaceState === 'refreshFailed');
    return (
      <Screen tabRoot bottomInset={bottomInset} refreshing={showRecovery ? refreshing : undefined} onRefresh={showRecovery ? () => { void refresh(); } : undefined}>
        <StateMessage
          title={recoveryMessage.title}
          body={recoveryMessage.body}
          action={showRecovery ? <Button label={t("Try again")} variant="secondary" disabled={refreshing} busy={refreshing} onPress={() => { void refresh(); }} /> : undefined}
        />
        <StaffQuickCapture />
      </Screen>
    );
  }

  const headerRow = (
    <View style={styles.headerRow}>
      <Heading>{t("My work")}</Heading>
      <View style={[styles.viewSeg, { backgroundColor: theme.muted }]} accessibilityRole="tablist">
        {(['list', 'board'] as const).map((key) => {
          const selected = view === key;
          return (
            <Pressable
              key={key}
              accessibilityRole="button"
              accessibilityState={{ selected }}
              accessibilityLabel={key === 'list' ? t("List view") : t("Board view")}
              onPress={() => { void haptics.select(); setView(key); }}
              hitSlop={{ top: 8, bottom: 8, left: 4, right: 4 }}
              style={[styles.viewSegButton, selected ? { backgroundColor: theme.card } : null]}
            >
              <Ionicons name={key === 'list' ? 'list-outline' : 'grid-outline'} size={15} color={selected ? theme.foreground : theme.mutedForeground} accessibilityElementsHidden />
              <Text style={[styles.viewSegText, { color: selected ? theme.foreground : theme.mutedForeground }]}>{key === 'list' ? t("List") : t("Board")}</Text>
            </Pressable>
          );
        })}
      </View>
    </View>
  );

  const pulseLink = (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={t("Open Campaign Pulse charts")}
      onPress={() => { void haptics.select(); router.push('/pulse' as never); }}
      style={({ pressed }) => [styles.pulseLink, { backgroundColor: theme.card, borderColor: theme.border, opacity: pressed ? 0.82 : 1 }]}
    >
      <View style={[styles.pulseIcon, { backgroundColor: theme.accent }]}>
        <Ionicons name="stats-chart" size={16} color={theme.accentForeground} accessibilityElementsHidden />
      </View>
      <View style={styles.pulseCopy}>
        <Text style={[styles.pulseTitle, { color: theme.cardForeground }]}>{t("Campaign pulse")}</Text>
        <Text style={[styles.pulseSub, { color: theme.mutedForeground }]}>{t("Polls, engagement, and issue charts")}</Text>
      </View>
      <Ionicons name="chevron-forward" size={18} color={theme.mutedForeground} accessibilityElementsHidden />
    </Pressable>
  );

  if (mode !== 'preview') {
    return (
      <Screen tabRoot bottomInset={bottomInset} refreshing={refreshing} onRefresh={() => { void refresh(); }}>
        {headerRow}
        {statusLine ? <Body muted>{statusLine}</Body> : null}
        <StaffRolePicker />
        {/* REQ-UG-LOVABLE-NATIVE-SCREENS-BATCH-C-PORT-20261103: the
            Batch C role Work names the role in use and leads with its desk.
            With several roles the picker above already names the choice.
            UX-UG-NATIVE-STAFF-WORK-TAB-BURIES-DESKS-UNDER-MEMBER-QUICK-CAPTURE-20261108:
            the desks come first, as every staff role's desk does on the web;
            quick capture and the feature guides follow the work. */}
        {workRole && staffRoleChoices.length < 2 ? <Body muted>{t('Working as {role}', { role: catalogLabel(LIVE_STAFF_ROLE_LABELS[workRole]) })}</Body> : null}
        {liveStaffHat !== null ? (
          <View style={styles.section}>
            <Text style={[styles.sectionLabel, { color: theme.mutedForeground }]}>{t("Your staff desks")}</Text>
            {workItemsWithRoleDeskFirst(workItems.filter((item) => !MEMBER_WORK_WIDGET_KEYS.has(item.key)), workRole).map((item) => ({ ...item, blurb: hatFunctionBlurb(item, neuroMapOn) })).map((item) => (
              <Pressable key={item.key} accessibilityRole="button" accessibilityLabel={t('Open {name}', { name: catalogLabel(item.label) })} onPress={() => router.push(item.href as never)}>
                {({ pressed }) => <Card pressed={pressed}><Heading level={3}>{catalogLabel(item.label)}</Heading><Body muted>{item.blurb ? catalogLabel(item.blurb) : t("Staff work for your campaign.")}</Body></Card>}
              </Pressable>
            ))}
          </View>
        ) : null}
        <Body muted>{t("Only records you can open appear here.")}</Body>
        {view === 'board' ? (
          dashboard.cases.length === 0
            ? <StateMessage title={t("Nothing active")} body={t("Your active issues and deadlines will appear here.")} />
            : <CaseBoard cases={dashboard.cases} />
        ) : (
          <>
            <Card>
              <Heading level={3}>{t("Questions and issue follow-up")}</Heading>
              <Body muted>{t("Use your private committee conversation without changing an issue record.")}</Body>
              <Button label={t("Open messages")} variant="secondary" onPress={() => router.push('/messages')} />
            </Card>
            {dashboard.cases.length === 0 ? <StateMessage title={t("Nothing active")} body={t("Your active issues and deadlines will appear here.")} /> : (
              [
                { label: t("Active"), cases: dashboard.cases.filter((item) => item.status.toLowerCase() === 'active') },
                { label: t("Resolved"), cases: dashboard.cases.filter((item) => item.status.toLowerCase() !== 'active') },
              ].filter((group) => group.cases.length > 0).map((group) => (
                <View key={group.label} style={styles.section}>
                  <Text style={[styles.sectionLabel, { color: theme.mutedForeground }]}>{group.label}</Text>
                  {group.cases.map((item) => {
                    const active = item.status.toLowerCase() === 'active';
                    return (
                      <CaseRowPressable key={item.id} reference={item.reference} visible={[item.status, item.title, `${item.caseType} · ${memberCaseStep(item)}`]} onPress={() => { void haptics.select(); router.push(`/issue/${item.id}`); }}>
                        {({ pressed }) => (
                          <Card pressed={pressed}>
                            <View style={styles.row}>
                              <Text style={[styles.reference, { color: theme.primary }]}>{item.reference}</Text>
                              <View style={[styles.badge, { backgroundColor: active ? theme.secondary : theme.muted }]}>
                                <Ionicons name={active ? 'time-outline' : 'checkmark-circle-outline'} size={14} color={active ? theme.secondaryForeground : theme.mutedForeground} accessibilityElementsHidden />
                                <Text style={[styles.badgeText, { color: active ? theme.secondaryForeground : theme.mutedForeground }]}>{item.status}</Text>
                              </View>
                            </View>
                            <Heading level={3}>{item.title}</Heading>
                            <Body muted>{item.caseType} · {memberCaseStep(item)}</Body>
                          </Card>
                        )}
                      </CaseRowPressable>
                    );
                  })}
                </View>
              ))
            )}
          </>
        )}
        <StaffQuickCapture />
        {/* REQ-UG-ONBOARDING-GUIDE-ENGINE-PORT-STEP3-20261029: guide 1
            for organization-wide roles; the server decides who sees it. */}
        {(organizationRoles ?? []).length > 0 ? <NativeOrgStartGuide /> : null}
        {/* REQ-UG-ONBOARDING-GUIDE-ENGINE-PORT-STEP4-20261029: guide 2
            for the staff hat worn; the server confirms the role. */}
        <NativeStaffGuides />
      </Screen>
    );
  }

  return (
    <Screen tabRoot bottomInset={bottomInset} refreshing={refreshing} onRefresh={() => { void refresh(); }}>
      {headerRow}
      {statusLine ? <Body muted>{statusLine}</Body> : null}
      <StaffRolePicker />
      {/* REQ-UG-LOVABLE-NATIVE-SCREENS-BATCH-C-PORT-20261103: the
          Batch C role Work names the role in use and leads with its desk.
          With several roles the picker above already names the choice.
          UX-UG-NATIVE-STAFF-WORK-TAB-BURIES-DESKS-UNDER-MEMBER-QUICK-CAPTURE-20261108:
          the desks come first, as every staff role's desk does on the web;
          quick capture and the feature guides follow the work. */}
      {workRole && staffRoleChoices.length < 2 ? <Body muted>{t('Working as {role}', { role: catalogLabel(LIVE_STAFF_ROLE_LABELS[workRole]) })}</Body> : null}
      {liveStaffHat !== null ? (
        <View style={styles.section}>
          <Text style={[styles.sectionLabel, { color: theme.mutedForeground }]}>{t("Your staff desks")}</Text>
          {workItemsWithRoleDeskFirst(workItems.filter((item) => !MEMBER_WORK_WIDGET_KEYS.has(item.key)), workRole).map((item) => ({ ...item, blurb: hatFunctionBlurb(item, neuroMapOn) })).map((item) => (
            <Pressable key={item.key} accessibilityRole="button" accessibilityLabel={t('Open {name}', { name: catalogLabel(item.label) })} onPress={() => router.push(item.href as never)}>
              {({ pressed }) => <Card pressed={pressed}><Heading level={3}>{catalogLabel(item.label)}</Heading><Body muted>{item.blurb ? catalogLabel(item.blurb) : t("Staff work for your campaign.")}</Body></Card>}
            </Pressable>
          ))}
        </View>
      ) : null}
      <Body muted>{t("Only records you can open appear here.")}</Body>
      {view === 'board' ? (
        dashboard.cases.length === 0
          ? <StateMessage title={t("Nothing active")} body={t("Your active issues and deadlines will appear here.")} />
          : <CaseBoard cases={dashboard.cases} />
      ) : (
        <>
          <Card>
            <Heading level={3}>{t("Questions and issue follow-up")}</Heading>
            <Body muted>{t("Use your private committee member conversation without changing an issue record.")}</Body>
            <Button label={t("Open messages")} variant="secondary" onPress={() => router.push('/messages')} />
          </Card>
          {dashboard.cases.length === 0 ? <StateMessage title={t("Nothing active")} body={t("Your active issues and deadlines will appear here.")} /> : (
            [
              { label: t("Active"), cases: dashboard.cases.filter((item) => item.status.toLowerCase() === 'active') },
              { label: t("Settled"), cases: dashboard.cases.filter((item) => item.status.toLowerCase() !== 'active') },
            ].filter((group) => group.cases.length > 0).map((group) => (
              <View key={group.label} style={styles.section}>
                <Text style={[styles.sectionLabel, { color: theme.mutedForeground }]}>{group.label}</Text>
                {group.cases.map((item) => {
                  const active = item.status.toLowerCase() === 'active';
                  return (
                    <CaseRowPressable key={item.id} reference={item.reference} visible={[item.status, item.title, `${item.caseType} · ${memberCaseStep(item)}`]} onPress={() => { void haptics.select(); router.push(`/issue/${item.id}`); }}>
                      {({ pressed }) => (
                        <Card pressed={pressed}>
                          <View style={styles.row}>
                            <Text style={[styles.reference, { color: theme.primary }]}>{item.reference}</Text>
                            <View style={[styles.badge, { backgroundColor: active ? theme.secondary : theme.muted }]}>
                              <Ionicons name={active ? 'time-outline' : 'checkmark-circle-outline'} size={14} color={active ? theme.secondaryForeground : theme.mutedForeground} accessibilityElementsHidden />
                              <Text style={[styles.badgeText, { color: active ? theme.secondaryForeground : theme.mutedForeground }]}>{item.status}</Text>
                            </View>
                          </View>
                          <Heading level={3}>{item.title}</Heading>
                          <Body muted>{item.caseType} · {memberCaseStep(item)}</Body>
                        </Card>
                      )}
                    </CaseRowPressable>
                  );
                })}
              </View>
            ))
          )}
        </>
      )}
      <StaffQuickCapture />
      {memberWork ? (
        <Body muted>{t("Messages, one-on-ones, issues, forms, workplace log, and reports.")}</Body>
      ) : null}
      {pulseLink}
      {view === 'board' ? (
        <CaseBoard cases={dashboard.cases} />
      ) : (
        <WorkWidgets
          dashboard={dashboard}
          desk={previewDesk}
          channels={inboxChannels}
          focus={section}
          items={workItems}
          // The layout saves only for a PREVIEW hat (onLayoutChange below), so
          // the customize control shows only there; a live or SAMPLE session
          // would drop the change (critic P7 C1, Nov 6, 2026).
          customizable={!memberWork && previewHat != null}
          layout={previewHat ? previewWidgetLayout(previewHat) : null}
          onLayoutChange={(next) => {
            if (previewHat) setPreviewWidgetLayout(previewHat, next);
          }}
        />
      )}
    </Screen>
  );
}

const styles = StyleSheet.create({
  headerRow: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', justifyContent: 'space-between', gap: spacing.sm },
  viewSeg: { flexDirection: 'row', flexWrap: 'wrap', maxWidth: '100%', borderRadius: radii.sm, padding: 3, gap: 2 },
  viewSegButton: {
    // 42 inside the 3pt track padding makes the track 48pt, so the 8pt hitSlop,
    // which React Native clips to the parent, reaches the 48pt minimum; at 38
    // the track was 44pt and the slop stopped there (Codex thread on PR #4747).
    minHeight: 42,
    flexShrink: 1,
    borderRadius: radii.sm - 3,
    paddingHorizontal: spacing.md,
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.xs,
  },
  viewSegText: { flexShrink: 1, fontSize: 13, lineHeight: 17, ...typeface.controlStrong },
  pulseLink: {
    minHeight: minimumTouchTarget,
    borderRadius: radii.md,
    borderWidth: StyleSheet.hairlineWidth,
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
  },
  pulseIcon: { width: 32, height: 32, borderRadius: radii.sm, alignItems: 'center', justifyContent: 'center' },
  pulseCopy: { flex: 1, gap: 1 },
  pulseTitle: { fontSize: 16, lineHeight: 21, ...typeface.heading },
  pulseSub: { fontSize: 13, lineHeight: 18, ...typeface.bodyMedium },
  board: { gap: spacing.md, paddingRight: spacing.lg },
  boardScroll: { marginHorizontal: -spacing.lg, paddingHorizontal: spacing.lg },
  boardColumn: { width: BOARD_COLUMN_WIDTH, borderRadius: radii.lg, padding: spacing.sm, gap: spacing.sm, alignSelf: 'flex-start' },
  boardColumnHead: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: spacing.xs, paddingTop: spacing.xs },
  boardCount: { fontSize: 13, lineHeight: 18, ...typeface.controlStrong },
  boardCard: { borderRadius: radii.sm, padding: spacing.md, gap: spacing.sm },
  boardCardTitle: { fontSize: 15, lineHeight: 20, ...typeface.heading },
  boardCardTitleDone: { textDecorationLine: 'line-through' },
  boardCardMeta: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  boardCardKey: { fontSize: 12, lineHeight: 16, ...typeface.controlStrong, letterSpacing: 0.4 },
  boardCardStep: { flex: 1, fontSize: 12, lineHeight: 16, ...typeface.control },
  dueChip: { flexDirection: 'row', alignItems: 'center', gap: 4, alignSelf: 'flex-start', borderRadius: radii.pill, paddingHorizontal: spacing.sm, paddingVertical: 3 },
  dueChipText: { fontSize: 11, lineHeight: 15, ...typeface.controlStrong },
  row: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: spacing.sm },
  reference: { fontSize: 13, ...typeface.controlStrong, letterSpacing: 0.4 },
  section: { gap: spacing.md },
  sectionLabel: { fontSize: 13, lineHeight: 18, ...typeface.controlStrong, letterSpacing: 0.4, textTransform: 'uppercase' },
  badge: { flexDirection: 'row', alignItems: 'center', gap: spacing.xs, borderRadius: radii.pill, paddingHorizontal: spacing.sm, paddingVertical: spacing.xs },
  badgeText: { fontSize: 12, ...typeface.controlStrong, textTransform: 'capitalize' },
});
