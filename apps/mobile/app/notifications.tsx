import { Ionicons } from '@expo/vector-icons';
import { Redirect, useRouter } from 'expo-router';
import { useRef, useState } from 'react';
import { Platform, Pressable, StyleSheet, View } from 'react-native';
import { Text } from '../src/components/Text';

import { localeFor, TWELVE_HOUR_CLOCK } from '../../../src/lib/i18n/format.js';
import { PinnedHeaderScreen, useScreenNameAlreadySpoken } from '../src/components/PinnedHeader';
import { Body, Button, Card, Group, GroupRow, Notice, Screen, StateMessage } from '../src/components/ui';
import { useWordFit } from '../src/components/useWordFit';
import { activityCopy, activityLanguage, type ActivityFilter, type ActivityLanguage } from '../src/lib/activityCopy';
import { activityRows, activityRowSummary, localizeActivityRow, type ActivityRow } from '../src/lib/activityRows';
import { nativeUiText } from '../src/lib/nativeUiCopy';
import { notificationGlyphRole, notificationKindFamily, type NotificationGlyphRole, type NotificationKindFamily } from '../src/lib/notificationKinds';
import type { MemberNotification } from '../src/models/member';
import { haptics } from '../src/services/haptics';
import { useApp } from '../src/state/AppProvider';
import { useTheme } from '../src/theme/ThemeProvider';
import type { ThemeTokens } from '../src/theme/tokens';
import { minimumTouchTarget, radii, spacing } from '../src/theme/tokens';

import { typeface } from '../src/theme/typeface';
// Keyed by glyph role: the live kinds (general, deadlines, cases, forms,
// votes, events, tasks, appointments, workload, dues) and the preview kinds
// both fold onto these roles through notificationGlyphRole
// (REQ-UNION-BASE-MOBILE-MEMBER-PARITY-20260814 F1).
const kindIcons: Record<NotificationGlyphRole, keyof typeof Ionicons.glyphMap> = {
  vote: 'checkbox-outline',
  case: 'briefcase-outline',
  rights: 'shield-checkmark-outline',
  message: 'chatbubble-ellipses-outline',
  chapter: 'people-outline',
  appointment: 'calendar-outline',
  form: 'document-text-outline',
  report: 'bar-chart-outline',
  admin: 'settings-outline',
  general: 'mail-unread-outline',
};

// Icon roles carry meaning here (the glyph is the only per-kind signal), so
// each pair has to clear the 3:1 non-text floor against the chip it sits on.
// Gold is a fill role (brief §B): the vote chip therefore inverts to a gold
// fill with the palette's dark-gold ink (6.74:1) instead of a gold glyph on
// the lavender secondary fill (1.89:1). Dark gold on lavender is 4.51:1 and
// aubergine on lavender is 12.12:1, so those two stay as they are.
type KindTint = { fill: string; glyph: string };

function kindTint(kind: string, theme: ThemeTokens): KindTint {
  switch (notificationGlyphRole(kind)) {
    case 'vote': return { fill: theme.accent, glyph: theme.accentForeground };
    case 'rights': return { fill: theme.secondary, glyph: theme.compass };
    case 'case': return { fill: theme.secondary, glyph: theme.primary };
    case 'message': return { fill: theme.secondary, glyph: theme.primary };
    default: return { fill: theme.secondary, glyph: theme.secondaryForeground };
  }
}

// Filters match on the kind family, so the live vocabulary (cases, deadlines,
// votes, ...) and the preview vocabulary (case, vote, ...) both land in the
// same pill (REQ-UNION-BASE-MOBILE-MEMBER-PARITY-20260814 F1).
const activityFilters = [
  { key: 'all', family: null },
  { key: 'cases', family: 'cases' },
  { key: 'messages', family: 'messages' },
  { key: 'votes', family: 'votes' },
] as const satisfies readonly { key: ActivityFilter; family: NotificationKindFamily | null }[];

function useActivityLanguage(): ActivityLanguage {
  const { dashboard, memberLanguage } = useApp();
  return activityLanguage(memberLanguage ?? dashboard?.member.language, Intl.DateTimeFormat().resolvedOptions().locale);
}

export default function NotificationsScreen() {
  const language = useActivityLanguage();
  const copy = activityCopy[language];
  return (
    <PinnedHeaderScreen screenName={copy.title} language={language}>
      <NotificationsContent />
    </PinnedHeaderScreen>
  );
}

function NotificationsContent() {
  const theme = useTheme();
  const router = useRouter();
  const { dashboard, mode, error, refreshing, refresh, setNotificationRead } = useApp();
  const language = useActivityLanguage();
  const copy = activityCopy[language];
  const [busyIDs, setBusyIDs] = useState<readonly string[]>([]);
  const inFlightIDs = useRef(new Set<string>());
  const [actionError, setActionError] = useState<string | null>(null);
  const [filterKey, setFilterKey] = useState<(typeof activityFilters)[number]['key']>('all');
  // The title row beside Back already paints and announces the title, so the
  // band does not repeat it.
  const bandEcho = useScreenNameAlreadySpoken(copy.title);

  if (mode === 'signedOut') return <Redirect href="/sign-in" />;
  if (mode === 'mfaRequired') return <Redirect href="/mfa-challenge" />;
  if (!dashboard) {
    // BUG-UG-NATIVE-MESSAGES-ACTIVITY-LOADING-FOREVER-20261018: a
    // failed workspace load used to keep the loading copy on screen with no
    // way out. AppProvider records the failure in `error`; this mirrors Home
    // and WorkScreen: say it failed, offer Try again, and let pull-to-refresh
    // retry too. The recovery controls only work once bootstrap has finished
    // (refresh() needs an established session), so they stay hidden while
    // booting instead of rendering as dead controls.
    const canRecover = mode !== 'booting';
    const retry = () => { void refresh('user-refresh'); };
    return (
      <Screen refreshing={canRecover ? refreshing : undefined} onRefresh={canRecover ? retry : undefined}>
        <StateMessage
          title={error ? copy.loadFailedTitle : copy.loadingTitle}
          body={error ?? copy.loadingBody}
          action={error && canRecover
            ? <Button label={copy.tryAgain} variant="secondary" disabled={refreshing} busy={refreshing} onPress={retry} />
            : null}
        />
      </Screen>
    );
  }

  const activeFilter = activityFilters.find((entry) => entry.key === filterKey) ?? activityFilters[0];
  const matchesFilter = (item: MemberNotification) => !activeFilter.family || notificationKindFamily(item.kind) === activeFilter.family;
  const rows = activityRows(dashboard.notifications).map(item => localizeActivityRow(item, language));
  const t = nativeUiText(language);
  const fresh = rows.filter((item) => !item.readAt && matchesFilter(item));
  const earlier = rows.filter((item) => Boolean(item.readAt) && matchesFilter(item));
  const isUpdating = (item: ActivityRow) => item.notificationIDs.some(id => inFlightIDs.current.has(id));
  const summary = (item: ActivityRow) => activityRowSummary(item, t, (value, includeYear) => formatDateTime(value, language, includeYear));

  async function toggleRead(item: ActivityRow, read: boolean) {
    if (isUpdating(item)) return;
    for (const id of item.notificationIDs) inFlightIDs.current.add(id);
    setBusyIDs([...inFlightIDs.current]);
    setActionError(null);
    try {
      let failed = false;
      let changed = false;
      for (const notificationID of item.notificationIDs) {
        try {
          await setNotificationRead(notificationID, read, { silent: true });
          changed = true;
        } catch {
          // Keep unavailable IDs visible for refresh/retry without preventing
          // later authorized members of the group from being updated.
          failed = true;
        }
      }
      if (failed) setActionError(copy.updateError);
      if (changed) await haptics.select();
    } finally {
      for (const id of item.notificationIDs) inFlightIDs.current.delete(id);
      setBusyIDs([...inFlightIDs.current]);
    }
  }

  function open(item: ActivityRow, isRead: boolean) {
    const updating = isUpdating(item);
    if (!item.href || updating) return;
    if (!isRead) void toggleRead(item, true);
    if (isRead) void haptics.select();
    router.push(item.href as never);
  }

  return (
    <Screen>
      <View style={[styles.headerBand, { backgroundColor: theme.primary }]}>
        {/* The title row beside Back paints and announces the title. */}
        {bandEcho.duplicate ? null : (
          <Text accessibilityRole="header" style={[styles.bandTitle, { color: theme.primaryForeground }]}>{copy.title}</Text>
        )}
        <Text style={[styles.bandSub, { color: theme.primaryForeground }]}>{copy.subtitle}</Text>
      </View>
      <View style={styles.filterRow} accessibilityRole="tablist">
        {activityFilters.map((entry) => {
          const selected = entry.key === filterKey;
          return (
            <Pressable
              key={entry.key}
              accessibilityRole="button"
              accessibilityState={{ selected }}
              accessibilityLabel={copy.showFilter(entry.key)}
              onPress={() => { void haptics.select(); setFilterKey(entry.key); }}
              style={[
                styles.filterPill,
                selected
                  ? { backgroundColor: theme.primary, borderColor: theme.primary }
                  : { backgroundColor: theme.card, borderColor: theme.border },
              ]}
            >
              <Text style={[styles.filterPillText, { color: selected ? theme.primaryForeground : theme.foreground }]}>{copy.filters[entry.key]}</Text>
            </Pressable>
          );
        })}
      </View>
      {actionError ? <Notice>{actionError}</Notice> : null}
      {dashboard.notifications.length > 0 && fresh.length === 0 && earlier.length === 0 ? (
        <Body muted>{copy.noFilterUpdates(filterKey)}</Body>
      ) : null}
      {dashboard.notifications.length === 0 ? (
        <View style={styles.emptyWrap}>
          <View style={[styles.emptyBadge, { backgroundColor: theme.muted }]}>
            <Ionicons name="checkmark-done-outline" size={44} color={theme.mutedForeground} accessibilityElementsHidden />
          </View>
          <StateMessage title={copy.emptyTitle} body={copy.emptyBody} />
        </View>
      ) : null}
      {fresh.length > 0 ? (
        <View style={styles.section}>
          <Text accessibilityRole="header" style={[styles.sectionLabel, { color: theme.mutedForeground }]}>{copy.fresh}</Text>
          {fresh.map((item) => {
            const busy = item.notificationIDs.some(id => busyIDs.includes(id));
            const tint = kindTint(item.kind, theme);
            const unreadLabel = `${copy.unreadLabel(item.title, item.body)}, ${summary(item)}`;
            return (
              <Card key={item.id} style={{ borderColor: theme.primary }}>
                {item.href ? (
                  <Pressable accessibilityRole="button" accessibilityLabel={unreadLabel} disabled={busy} accessibilityState={{ disabled: busy }} onPress={() => open(item, false)}>
                    <NotificationContent item={item} tint={tint} unread unreadLabel={copy.unread} theme={theme} />
                  </Pressable>
                ) : (
                  <View accessible accessibilityLabel={unreadLabel}>
                    <NotificationContent item={item} tint={tint} unread unreadLabel={copy.unread} theme={theme} />
                  </View>
                )}
                <View style={styles.metaRow}>
                  <Body muted fitWords style={styles.metaSummary}>{summary(item)}</Body>
                  <Pressable
                    accessibilityRole="button"
                    accessibilityLabel={`${copy.markReadLabel(item.title)}, ${summary(item)}`}
                    accessibilityState={{ busy, disabled: busy }}
                    disabled={busy}
                    onPress={() => { void toggleRead(item, true); }}
                    style={styles.metaAction}
                  >
                    <Text style={[styles.metaActionText, { color: busy ? theme.mutedForeground : theme.primary }]}>{busy ? copy.saving : copy.markRead}</Text>
                  </Pressable>
                </View>
              </Card>
            );
          })}
        </View>
      ) : null}
      {earlier.length > 0 ? (
        <View style={styles.section}>
          <Text accessibilityRole="header" style={[styles.sectionLabel, { color: theme.mutedForeground }]}>{copy.earlier}</Text>
          <Group>
            {earlier.map((item, index) => {
              const busy = item.notificationIDs.some(id => busyIDs.includes(id));
              return (
                <GroupRow key={item.id} last={index === earlier.length - 1} highlight={false}>
                  <View style={styles.row}>
                    <View style={[styles.icon, styles.iconSmall, { backgroundColor: theme.muted }]}>
                      <Ionicons name={kindIcons[notificationGlyphRole(item.kind)]} size={18} color={theme.mutedForeground} />
                    </View>
                    <View style={styles.copy}>
                      {item.href ? (
                        <Pressable
                          accessibilityRole="button"
                          accessibilityLabel={`${copy.openUpdate(item.title, item.body)}, ${summary(item)}`}
                          disabled={busy}
                          accessibilityState={{ disabled: busy }}
                          hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
                          onPress={() => open(item, true)}
                          style={styles.rowTitleTarget}
                        >
                          <Text numberOfLines={1} style={[styles.rowTitle, { color: theme.foreground }]}>{item.title}</Text>
                        </Pressable>
                      ) : <Text accessible accessibilityLabel={`${item.title}, ${item.body}, ${summary(item)}`} numberOfLines={1} style={[styles.rowTitle, { color: theme.foreground }]}>{item.title}</Text>}
                      <View style={styles.metaRow}>
                        <Body muted fitWords style={styles.metaSummary}>{summary(item)}</Body>
                        <Pressable
                          accessibilityRole="button"
                          accessibilityLabel={`${copy.markUnreadLabel(item.title)}, ${summary(item)}`}
                          accessibilityState={{ busy, disabled: busy }}
                          disabled={busy}
                          onPress={() => { void toggleRead(item, false); }}
                          style={styles.metaAction}
                        >
                          <Text style={[styles.metaActionText, { color: busy ? theme.mutedForeground : theme.primary }]}>{busy ? copy.saving : copy.markUnread}</Text>
                        </Pressable>
                      </View>
                    </View>
                    {item.href ? <Ionicons name="chevron-forward" size={18} color={theme.mutedForeground} accessibilityElementsHidden /> : null}
                  </View>
                </GroupRow>
              );
            })}
          </Group>
        </View>
      ) : null}
      <Body muted fitWords>{copy.pushNote}</Body>
    </Screen>
  );
}

function NotificationContent({ item, tint, unread, unreadLabel, theme }: { item: MemberNotification; tint: KindTint; unread: boolean; unreadLabel: string; theme: ThemeTokens }) {
  const fit = useWordFit(true, item.title, styles.rowTitle);
  return (
    <View style={styles.row}>
      <View style={[styles.icon, { backgroundColor: tint.fill }]}>
        <Ionicons name={kindIcons[notificationGlyphRole(item.kind)]} size={22} color={tint.glyph} />
      </View>
      <View style={styles.copy}>
        <View style={styles.titleRow}>
          {/* Single unread encoding (brief §D, b02b-29): an update has no
              countable number, and the dot pairs with the kind glyph, so the
              dot is the encoding and the title reads at the same weight as a
              row in Earlier. It used to be dot plus a heavier heading. */}
          <Text accessibilityRole="header" style={[styles.rowTitle, styles.flex, { color: theme.foreground }, fit.style]}
            onLayout={fit.onLayout} allowFontScaling={fit.allowFontScaling}>{item.title}</Text>
          {unread ? <View accessible style={[styles.dot, { backgroundColor: theme.primary }]} accessibilityLabel={unreadLabel} /> : null}
        </View>
        <Body fitWords>{item.body}</Body>
      </View>
      {item.href ? <Ionicons name="chevron-forward" size={18} color={theme.mutedForeground} accessibilityElementsHidden /> : null}
    </View>
  );
}

function formatDateTime(value: string, language: ActivityLanguage, includeYear = false) {
  return new Intl.DateTimeFormat(localeFor(language), { year: includeYear ? 'numeric' : undefined, month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', hourCycle: TWELVE_HOUR_CLOCK }).format(new Date(value));
}

const styles = StyleSheet.create({
  heading: { gap: spacing.xs },
  headerBand: { borderRadius: radii.lg + 4, padding: spacing.lg, gap: spacing.xs },
  bandTitle: { fontSize: 28, lineHeight: 34, fontWeight: '600', fontFamily: Platform.select({ ios: 'Georgia', default: 'serif' }) },
  // iOS review 2026-09-13 D4: 78% opacity composited to 3.95:1 in Night
  // Shift; the full semantic foreground keeps the pair at AA.
  bandSub: { fontSize: 13.5, lineHeight: 19 },
  filterRow: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm },
  filterPill: {
    minHeight: minimumTouchTarget,
    borderRadius: radii.pill,
    borderWidth: StyleSheet.hairlineWidth,
    paddingHorizontal: spacing.lg,
    alignItems: 'center',
    justifyContent: 'center',
  },
  filterPillText: { fontSize: 13, lineHeight: 18, ...typeface.controlStrong },
  section: { gap: spacing.sm },
  sectionLabel: { fontSize: 13, lineHeight: 18, ...typeface.controlStrong, letterSpacing: 0.4, textTransform: 'uppercase' },
  row: { flexDirection: 'row', gap: spacing.md, alignItems: 'flex-start' },
  copy: { flex: 1, gap: spacing.xs },
  titleRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: spacing.sm },
  icon: { width: minimumTouchTarget, height: minimumTouchTarget, borderRadius: radii.pill, alignItems: 'center', justifyContent: 'center' },
  iconSmall: { width: 36, height: 36 },
  dot: { width: 10, height: 10, borderRadius: 5 },
  flex: { flex: 1 },
  // One title weight for New and Earlier rows: unread is the dot's job.
  rowTitle: { fontSize: 16, lineHeight: 22, ...typeface.control },
  // iOS review 2026-09-13 D3: the title used to be a 22pt press target.
  rowTitleTarget: { minHeight: minimumTouchTarget, justifyContent: 'center' },
  metaRow: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', justifyContent: 'space-between', gap: spacing.sm },
  metaSummary: { flexGrow: 1, flexShrink: 1 },
  metaAction: { minHeight: minimumTouchTarget, maxWidth: '100%', justifyContent: 'center', paddingHorizontal: spacing.xs },
  metaActionText: { fontSize: 14, lineHeight: 18, ...typeface.controlStrong },
  emptyWrap: { alignItems: 'center', gap: spacing.md },
  emptyBadge: { width: 96, height: 96, borderRadius: radii.md, alignItems: 'center', justifyContent: 'center' },
});
