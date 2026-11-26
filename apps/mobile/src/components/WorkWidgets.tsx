import { Ionicons } from '@expo/vector-icons';
import { useRouter } from 'expo-router';
import { Fragment, useState } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';
import { Text } from './Text';

import { isOpenTaskStatus, isPastEvent, orderEventsForDesk, statusLabel } from '../lib/deskCopy';
import { straightRailInsets } from '../lib/drawerEdgeGeometry';
import { nativeCatalogLabel, type NativeLanguage } from '../lib/nativeUiCopy';
import { CAMPAIGNS } from '../lib/featureCatalog';
import { formatFlowCount } from '../lib/numberFlow';
import {
  MEMBER_WORK_WIDGETS,
  applyWidgetLayout,
  hiddenWidgetItems,
  moveVisibleWidgetKey,
  toggleWidgetHidden,
  widgetSourceFor,
  type HatFunction,
  type LiveStaffRole,
  type WidgetLayout,
} from '../lib/hatFunctions';
import type { StaffDeskNumber } from '../lib/staffDeskNumbers';
import type { DemoChannel } from '../data/demoChannels';
import { dashboardMetrics, messagesWorkWidgetModel, type MemberDashboard } from '../models/member';
import { haptics } from '../services/haptics';
import { PREVIEW_HEALTH_PORTFOLIO, PREVIEW_NOW, type PreviewDesk } from '../data/preview';
import { useTheme } from '../theme/ThemeProvider';
import { minimumTouchTarget, radii, spacing } from '../theme/tokens';
import { functionIcons } from './FunctionDeck';
import { NumberFlow } from './NumberFlow';
import { HighlightList, HighlightRow } from './RowHighlight';
import { Avatar, Body } from './ui';
import { PREVIEW_CAMPAIGN } from '../data/previewCampaign';
import { ORGANIZING_STAGES, organizingStageStatuses } from '../lib/organizingPath';

import { typeface } from '../theme/typeface';
type WidgetRow = {
  id: string;
  primary: string;
  accessibilityTitle?: string;
  kind?: 'direct' | 'channel';
  secondary?: string;
  // A third, single-line detail (a venue) that must not wrap into the date.
  meta?: string;
  href?: string;
  tone?: 'urgent' | 'active';
  initials?: string;
};

const MEMBER_WIDGET_KEYS = new Set(MEMBER_WORK_WIDGETS.map((item) => item.key));
// A task whose subtitle opens with a deadline phrase is the one dated item
// on the desk, so it carries the urgent tone rather than the neutral one.
const DEADLINE_SUBTITLE = /^(before|closes|due)\b/i;

// Sources whose dataset the workspace does not hold. "Nothing in By article
// cited yet." promised rows that no collection can supply.
const VIEW_EMPTY_LINE: Record<'trend' | 'broadcasts' | 'memberships' | 'invitations', string> = {
  trend: 'No support trend is recorded here.',
  broadcasts: 'Sent broadcasts are not listed here.',
  // Campaign memberships are read from the authorized directory on the screen
  // itself. The preview desk holds no roster to count, and inventing one
  // would put a fake number under an audited administrative control.
  memberships: 'Campaign memberships open on an authorized session.',
  // Invitations are read with the officer's session on the screen itself.
  invitations: 'Invitations are listed on the full screen.',
};

// The roles a live session holds are read and changed on the Roles & access
// screen, not in this widget, so its empty line points there rather than
// promising rows that will arrive.
const LIVE_ACCESS_EMPTY_LINE = 'Roles and access are managed on the full screen.';

// Authenticated sessions pass no preview desk. These trays send the worker to
// the live destination instead of claiming the authorized collection is empty.
export const LIVE_EMPTY_LINE: Record<'appointments' | 'forms' | 'workload', string> = {
  appointments: 'Open One-on-ones to see your schedule.',
  forms: 'Open Forms to see your forms.',
  workload: 'Open Workplace log to see your hours.',
};

function initialsFor(name: string) {
  return name.split(/\s+/).map((part) => part[0] ?? '').join('').slice(0, 2).toUpperCase() || '?';
}

function rowKindLabel(row: WidgetRow, language: NativeLanguage): string | undefined {
  if (!row.kind) return undefined;
  return nativeCatalogLabel(language, row.kind === 'channel' ? 'Channel' : 'Private conversation');
}

function rowAccessibilityLabel(row: WidgetRow, language: NativeLanguage) {
  return [row.accessibilityTitle ?? row.primary, rowKindLabel(row, language), row.secondary, row.meta].filter(Boolean).join('. ');
}

export function rowsFor(
  item: HatFunction,
  desk: PreviewDesk | null,
  dashboard: MemberDashboard,
  channels: readonly DemoChannel[] = [],
  staff: { role: LiveStaffRole | null; numbers: readonly StaffDeskNumber[] } | null = null,
  language: NativeLanguage = 'en',
): { badge?: string; rows: WidgetRow[]; href: string; tiles?: boolean; empty?: string; hideBody?: boolean } {
  const metrics = dashboardMetrics(dashboard, channels);
  const source = widgetSourceFor(item.key);
  const staffSpecific = !MEMBER_WIDGET_KEYS.has(item.key);
  // Staff figures appear once, on the role's main desk. My reports keeps
  // its destination without repeating those figures or using member metrics.
  if (staff && source === 'numbers') return { href: item.href, rows: [], hideBody: true };
  if (staff && item.key === staff.role) {
    const rows = staff.numbers.flatMap((number) => number.value === null ? [] : [{
      id: number.label,
      primary: String(number.value),
      secondary: nativeCatalogLabel(language, number.label),
    }]);
    return { href: item.href, rows, hideBody: rows.length === 0 };
  }
  // The fictional preview desk carries its own queue rows.
  if (desk && staffSpecific && source === 'cases') {
    return {
      href: item.href,
      rows: (desk?.queue ?? []).slice(0, 3).map((entry) => ({
        id: `staff-case-${entry.id}`,
        primary: entry.title,
        secondary: entry.subtitle,
        href: entry.href,
        tone: 'urgent' as const,
      })),
    };
  }
  if (desk && staffSpecific && source === 'messages' && item.key !== 'steward-messages') {
    return {
      href: item.href,
      rows: (desk?.queue ?? []).slice(0, 3).map((entry) => ({
        id: `staff-request-${entry.id}`,
        primary: entry.title,
        secondary: entry.subtitle,
        href: entry.href,
      })),
    };
  }
  // A staff desk's own cases and requests open on the desk itself; the
  // member dashboard holds none of them.
  if (staffSpecific && (source === 'cases' || (source === 'messages' && item.key !== 'steward-messages'))) {
    return { href: item.href, rows: [], hideBody: true };
  }
  if (source === 'messages') {
    const messages = messagesWorkWidgetModel(dashboard, channels);
    return {
      href: item.href,
      badge: messages.badge,
      rows: messages.rows,
    };
  }
  if ((source === 'appointments' || source === 'forms' || source === 'workload') && desk === null) {
    return { href: item.href, rows: [], empty: LIVE_EMPTY_LINE[source], hideBody: true };
  }
  if (source === 'appointments') {
    return {
      href: item.href,
      rows: (desk?.appointments ?? []).slice(0, 3).map((entry) => ({
        id: entry.id,
        primary: `${entry.when} · ${entry.withName}`,
        secondary: entry.place,
        tone: 'active' as const,
        initials: initialsFor(entry.withName),
      })),
    };
  }
  if (source === 'cases') {
    return {
      href: item.href,
      badge: metrics.openCases > 0 ? `${metrics.openCases} open` : undefined,
      rows: dashboard.cases.filter((entry) => entry.status === 'active').slice(0, 3).map((entry) => ({
        id: entry.id,
        primary: entry.title,
        secondary: entry.caseType,
        href: `/issue/${entry.id}`,
        tone: 'active' as const,
      })),
    };
  }
  if (source === 'forms') {
    return {
      href: item.href,
      rows: (desk?.forms ?? []).slice(0, 3).map((entry) => ({
        id: entry.id,
        primary: entry.title,
        secondary: `${statusLabel(entry.status)} · ${entry.updated}`,
      })),
    };
  }
  if (source === 'workload') {
    return {
      href: item.href,
      rows: (desk?.workload ?? []).slice(0, 3).map((entry) => ({
        id: entry.id,
        primary: entry.dateLabel,
        secondary: entry.meta,
      })),
    };
  }
  if (source === 'numbers') {
    return {
      href: item.href,
      tiles: true,
      rows: desk?.rewards
        ? [
            { id: 'verified', primary: formatFlowCount(desk.rewards.totalVerified), secondary: 'Verified contributions' },
            { id: 'actions', primary: String(desk.rewards.actionsYtd), secondary: 'Actions this year' },
          ]
        : [
            { id: 'cases', primary: String(metrics.openCases), secondary: 'Open issues' },
            { id: 'week', primary: String(metrics.completedThisWeek), secondary: 'Finished this week' },
          ],
    };
  }
  if (desk && source === 'events') {
    // Upcoming events lead, soonest first; past events follow and say so.
    // The venue takes its own single line so "+ Zoom" never strands on a
    // wrapped second line under the date. A preview desk's event dates and
    // `when` copy are written against PREVIEW_NOW, so upcoming and past are
    // decided on that clock, never the device's.
    const previewClock = desk ? Date.parse(PREVIEW_NOW) : Date.now();
    const { upcoming, past } = orderEventsForDesk(desk?.events ?? [], previewClock);
    return {
      href: item.href,
      rows: [...upcoming, ...past].slice(0, 3).map((entry) => ({
        id: entry.id,
        primary: entry.title,
        secondary: isPastEvent(entry, previewClock) ? `Past · ${entry.when}` : entry.when,
        meta: entry.place,
      })),
    };
  }
  if (desk && source === 'campaigns') {
    return {
      href: item.href,
      rows: desk ? CAMPAIGNS.map((entry) => ({
        id: entry.id,
        primary: entry.title,
        secondary: statusLabel(entry.status),
      })) : [],
    };
  }
  if (desk && source === 'tasks') {
    // The badge counts every open task on the desk; only the rows truncate.
    const openTasks = (desk?.tasks ?? []).filter((entry) => isOpenTaskStatus(entry.status));
    return {
      href: item.href,
      badge: openTasks.length ? `${openTasks.length} open` : undefined,
      rows: openTasks.slice(0, 3).map((entry): WidgetRow => ({
        id: entry.id,
        primary: entry.title,
        secondary: entry.subtitle,
        tone: entry.status === 'blocked' || DEADLINE_SUBTITLE.test(entry.subtitle) ? 'urgent' : 'active',
      })),
    };
  }
  if (desk && (source === 'queue' || source === 'audit' || source === 'risks')) {
    return {
      href: item.href,
      rows: (desk?.queue ?? []).slice(0, 3).map((entry) => ({
        id: `${source}-${entry.id}`,
        primary: entry.title,
        secondary: entry.subtitle,
        href: entry.href,
        tone: 'urgent' as const,
      })),
    };
  }
  if (desk && source === 'ballots') {
    return {
      href: item.href,
      rows: (desk?.ballots ?? []).slice(0, 3).map((entry) => ({
        id: entry.id,
        primary: entry.title,
        secondary: entry.meta,
      })),
    };
  }
  if (desk && source === 'rewards') {
    return {
      href: item.href,
      tiles: true,
      rows: desk?.rewards
        ? [
            { id: 'verified', primary: formatFlowCount(desk.rewards.totalVerified), secondary: 'Verified contributions' },
            { id: 'actions', primary: String(desk.rewards.actionsYtd), secondary: 'Actions this year' },
          ]
        : [],
    };
  }
  if (source === 'access') {
    if (desk) {
      // Only a preview desk is a PREVIEW session. A live, authenticated
      // session has no preview desk, so the widget names where roles are
      // managed instead of telling a signed-in worker that their real roles
      // stay in a preview.
      return {
        href: item.href,
        empty: LIVE_ACCESS_EMPTY_LINE,
        rows: desk
          ? [
              { id: 'chapter', primary: desk.chapterName, secondary: 'Roles and access stay in this PREVIEW session' },
              ...desk.kpis.slice(0, 2).map((entry) => ({ id: entry.label, primary: entry.value, secondary: entry.label })),
            ]
          : [],
      };
    }
    // The roles a live session holds are managed on the full screen.
    return { href: item.href, rows: [], hideBody: true, empty: LIVE_ACCESS_EMPTY_LINE };
  }
  if (desk && source === 'mfa') {
    return {
      href: item.href,
      rows: (desk?.tasks ?? []).slice(0, 2).map((entry) => ({
        id: entry.id,
        primary: entry.title,
        secondary: entry.subtitle,
      })),
    };
  }
  if (desk && source === 'leadership') {
    return {
      href: item.href,
      rows: (desk?.partnerOrgs.length ? desk.partnerOrgs : []).slice(0, 3).map((entry) => ({
        id: entry.id,
        primary: entry.name,
        secondary: `${entry.city}, ${entry.state}`,
        initials: initialsFor(entry.name),
      })),
    };
  }
  if (desk && (source === 'hub' || source === 'handshakes')) {
    return {
      href: item.href,
      rows: (desk?.handshakes ?? []).slice(0, 3).map((entry) => ({
        id: entry.id,
        primary: entry.orgName,
        // "requested" under an organization name was a fragment; the row
        // now says what was requested.
        secondary: `Agreement ${entry.status.replaceAll('_', ' ')}`,
      })),
    };
  }
  if (source === 'recognition') {
    // The campaign's place on the path, never a count presented as an outcome.
    const statuses = organizingStageStatuses(desk ? PREVIEW_CAMPAIGN.stage : null);
    return {
      href: item.href,
      rows: ORGANIZING_STAGES
        .map((stage, index) => ({ stage, status: statuses[index]! }))
        .filter(({ status }) => status !== 'complete')
        .slice(0, 3)
        .map(({ stage, status }) => ({ id: stage.key, primary: stage.title, secondary: status === 'current' ? 'Current stage' : 'Upcoming' })),
    };
  }
  if (desk && source === 'health') {
    const chapter = desk
      ? PREVIEW_HEALTH_PORTFOLIO.find((entry) => !entry.cohortProtected)
      : undefined;
    const first = chapter?.trend[0];
    const latest = chapter?.trend.at(-1);
    return {
      href: item.href,
      rows: chapter ? [
        { id: 'health-score', primary: `${chapter.score} current score`, secondary: `${chapter.chapterName} · measured ${chapter.measuredOn}` },
        { id: 'health-trend', primary: `${first?.score ?? '—'} to ${latest?.score ?? '—'}`, secondary: `${chapter.trend.length} dated snapshots since ${first?.measuredOn ?? 'the first record'}` },
        { id: 'health-follow-up', primary: `${chapter.coaching.length} coaching ${chapter.coaching.length === 1 ? 'entry' : 'entries'}`, secondary: chapter.coaching[0]?.nextAction ?? 'No next action recorded' },
      ] : [],
    };
  }
  if (source === 'trend' || source === 'broadcasts' || source === 'memberships' || source === 'invitations') {
    // The workspace holds no collection of membership
    // movement or of sent broadcasts. These are views, not queues that fill
    // up, so the empty line says what is absent instead of "Nothing in … yet."
    return { href: item.href, rows: [], hideBody: true, empty: VIEW_EMPTY_LINE[source] };
  }
  if (source === 'events' || source === 'campaigns' || source === 'tasks' || source === 'queue' || source === 'audit'
    || source === 'risks' || source === 'ballots' || source === 'rewards' || source === 'mfa' || source === 'leadership'
    || source === 'hub' || source === 'handshakes' || source === 'health' || source === 'deadlines' || source === 'kpis'
    || source === 'qa' || source === 'pay' || source === 'integrations' || source === 'operations' || source === 'analytics'
    || source === 'organization-map' || source === 'actions') {
    // These trays open their own screens; the member dashboard carries none
    // of their rows.
    return { href: item.href, rows: [], hideBody: true };
  }
  if (source === 'deadlines') {
    // The dated slice of the desk queue: what is overdue or due soon. The
    // campaign tasks this widget used to list belong to Campaign work.
    return {
      href: item.href,
      rows: (desk?.queue ?? []).filter((entry) => entry.status === 'overdue' || entry.status === 'due soon').slice(0, 3).map((entry): WidgetRow => ({
        id: `deadline-${entry.id}`,
        primary: entry.title,
        secondary: entry.subtitle,
        href: entry.href,
        tone: entry.status === 'overdue' ? 'urgent' : 'active',
      })),
    };
  }
  if (source === 'trend' || source === 'broadcasts' || source === 'memberships') {
    // The desk holds no collection of cited articles, of membership movement
    // or of sent broadcasts. These are views, not queues that fill up, so
    // the empty line says what is absent instead of "Nothing in … yet."
    return { href: item.href, rows: [], empty: VIEW_EMPTY_LINE[source] };
  }
  if (source === 'kpis') {
    return {
      href: item.href,
      rows: (desk?.kpis ?? []).slice(0, 3).map((entry) => ({
        id: entry.label,
        primary: entry.value,
        secondary: entry.label,
      })),
    };
  }
  // Every source has a branch above. A new WidgetSource member fails the
  // typecheck here instead of silently borrowing the desk KPIs.
  source satisfies never;
  return { href: item.href, rows: [] };
}

export function WorkWidgets({
  dashboard,
  desk,
  channels = [],
  focus,
  items = MEMBER_WORK_WIDGETS,
  language = 'en',
  staffRole = null,
  staffNumbers = [],
  customizable = false,
  layout = null,
  onLayoutChange,
}: {
  dashboard: MemberDashboard;
  desk: PreviewDesk | null;
  channels?: readonly DemoChannel[];
  focus?: string | null;
  items?: HatFunction[];
  // The member's language: app-owned empty lines read in it where the catalogue has them.
  language?: NativeLanguage;
  staffRole?: LiveStaffRole | null;
  staffNumbers?: readonly StaffDeskNumber[];
  customizable?: boolean;
  layout?: WidgetLayout | null;
  onLayoutChange?: (layout: WidgetLayout) => void;
}) {
  const router = useRouter();
  const theme = useTheme();
  const [editing, setEditing] = useState(false);
  const catalog = items;
  const visible = applyWidgetLayout(catalog, layout);
  const hidden = hiddenWidgetItems(catalog, layout);
  const order = layout?.order.length ? layout.order : catalog.map((item) => item.key);
  // One accent per drawer: a staff desk paints every widget rail in the
  // Guide accent, a worker desk in the primary. Mixing the two inside one
  // drawer (worker-shared widgets dark, staff widgets blue) read as a defect,
  // not a distinction anyone could decode.
  const staffDesk = catalog.some((item) => !MEMBER_WIDGET_KEYS.has(item.key));
  const railColor = staffDesk ? theme.compass : theme.primary;

  function currentLayout(): WidgetLayout {
    return {
      order,
      hidden: layout?.hidden ?? [],
    };
  }

  return (
    <View style={styles.stack}>
      {customizable ? (
        <View style={styles.customizeRow}>
          <Body muted style={styles.customizeHint}>{editing ? 'This desk layout is fixed for now, so changes made here are not kept.' : 'Your desk widgets. The layout is fixed for now.'}</Body>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={editing ? 'Done customizing' : 'Customize widgets'}
            onPress={() => {
              setEditing((current) => !current);
              void haptics.select();
            }}
            style={({ pressed }) => [styles.customizeButton, { backgroundColor: theme.secondary, opacity: pressed ? 0.82 : 1 }]}
          >
            <Ionicons name={editing ? 'checkmark' : 'options-outline'} size={18} color={theme.secondaryForeground} />
            <Text style={[styles.customizeLabel, { color: theme.secondaryForeground }]}>{editing ? 'Done' : 'Customize'}</Text>
          </Pressable>
        </View>
      ) : null}
      {visible.map((item, index) => {
        const rows = rowsFor(item, desk, dashboard, channels, staffDesk ? { role: staffRole, numbers: staffNumbers } : null, language);
        const widget = rows.empty ? { ...rows, empty: nativeCatalogLabel(language, rows.empty) } : rows;
        const icon = functionIcons[item.icon];
        const active = focus === item.key;
        return (
          <View
            key={item.key}
            nativeID={`work-${item.key}`}
            style={[
              styles.widget,
              {
                backgroundColor: theme.card,
                borderColor: active ? theme.ring : theme.border,
              },
            ]}
          >
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={widget.badge ? `${item.label}, ${widget.badge}` : item.label}
              onPress={() => { void haptics.select(); router.push(widget.href as never); }}
              style={({ pressed }) => [styles.head, pressed ? { backgroundColor: theme.muted } : null]}
            >
              {/* A11Y-UG-NATIVE-WORK-WIDGET-TITLES-BREAK-MID-WORD-AT-LARGE-TEXT-20261109:
                  the title takes the whole row. A badge beside it, with no
                  minimum on the title, squeezed "Messages" to a few letters
                  or to nothing. The count wraps under the title instead. */}
              <View style={styles.titleRow}>
                <View style={[styles.icon, { backgroundColor: theme.secondary }]}>
                  <Ionicons name={icon} size={18} color={theme.secondaryForeground} />
                </View>
                <View style={styles.titleSpacer} />
                <Ionicons name="chevron-forward" size={18} color={theme.mutedForeground} />
                <Text textBreakStrategy="simple" style={[styles.title, { color: theme.cardForeground }]}>{item.label}</Text>
              </View>
              {widget.badge ? (
                // Every badge producer in rowsFor emits a count — "N unread"
                // or "N open" — and a deadline's urgency rides on the row
                // tone, so the badge has one appearance. A badge that must
                // read as urgent needs an explicit tone on rowsFor's result,
                // never a substring match on this text.
                <View style={[styles.badge, { backgroundColor: theme.primary }]}>
                  <Text style={[styles.badgeText, { color: theme.primaryForeground }]}>{widget.badge}</Text>
                </View>
              ) : null}
            </Pressable>
            {editing ? (
              <View style={[styles.editRow, { borderTopColor: theme.muted }]}>
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel={`Move ${item.label} up`}
                  disabled={index === 0}
                  onPress={() => onLayoutChange?.({ ...currentLayout(), order: moveVisibleWidgetKey(order, currentLayout().hidden, item.key, -1) })}
                  style={styles.editButton}
                >
                  <Ionicons name="chevron-up" size={20} color={index === 0 ? theme.mutedForeground : theme.foreground} />
                </Pressable>
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel={`Move ${item.label} down`}
                  disabled={index === visible.length - 1}
                  onPress={() => onLayoutChange?.({ ...currentLayout(), order: moveVisibleWidgetKey(order, currentLayout().hidden, item.key, 1) })}
                  style={styles.editButton}
                >
                  <Ionicons name="chevron-down" size={20} color={index === visible.length - 1 ? theme.mutedForeground : theme.foreground} />
                </Pressable>
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel={`Hide ${item.label}`}
                  onPress={() => onLayoutChange?.(toggleWidgetHidden(currentLayout(), catalog, item.key))}
                  style={styles.editButton}
                >
                  <Text style={[styles.editLabel, { color: theme.destructive }]}>Hide</Text>
                </Pressable>
              </View>
            ) : widget.hideBody ? null : widget.tiles && widget.rows.length ? (
              <View style={[styles.tileRow, { borderTopColor: theme.muted }]}>
                {widget.rows.map((row) => (
                  <View
                    key={row.id}
                    accessible
                    accessibilityLabel={rowAccessibilityLabel(row, language)}
                    style={[styles.tile, { backgroundColor: theme.secondary }]}
                  >
                    {/* The tile is one labelled element and speaks the value in
                        its label, so the rolling digits stay out of the tree. */}
                    <NumberFlow decorative value={row.primary} style={[styles.tileValue, { color: theme.secondaryForeground }]} />
                    {row.secondary ? <Text style={[styles.tileLabel, { color: theme.mutedForeground }]}>{row.secondary}</Text> : null}
                  </View>
                ))}
              </View>
            ) : widget.rows.length ? (
              // The head/body boundary stays full-bleed; the rules between
              // rows are inset to the content on both sides, the same rule the
              // features deck's grouped lists follow.
              <HighlightList style={[styles.body, { borderTopColor: theme.muted }]}>
                {widget.rows.map((row, rowIndex) => {
                  const copy = (
                    <>
                      {row.initials ? <Avatar initials={row.initials} size={28} /> : row.tone ? (
                        <View style={[styles.toneDot, { backgroundColor: row.tone === 'urgent' ? theme.destructive : theme.primary }]} accessibilityElementsHidden />
                      ) : null}
                      <View style={styles.rowCopy}>
                        <Text style={[styles.primary, { color: theme.cardForeground }]}>{row.primary}</Text>
                        {row.kind ? <Text style={[styles.secondary, { color: theme.mutedForeground }]}>{rowKindLabel(row, language)}</Text> : null}
                        {row.secondary ? <Text style={[styles.secondary, { color: theme.mutedForeground }]}>{row.secondary}</Text> : null}
                        {row.meta ? <Text numberOfLines={1} style={[styles.meta, { color: theme.mutedForeground }]}>{row.meta}</Text> : null}
                      </View>
                    </>
                  );
                  return (
                    <Fragment key={row.id}>
                      {rowIndex > 0 ? <View style={[styles.rowDivider, { backgroundColor: theme.muted }]} /> : null}
                      {row.href ? (
                        <HighlightRow>
                          <Pressable
                            accessibilityRole="button"
                            accessibilityLabel={rowAccessibilityLabel(row, language)}
                            onPress={() => { void haptics.select(); router.push(row.href as never); }}
                            style={styles.row}
                          >
                            {copy}
                            <Ionicons name="chevron-forward" size={16} color={theme.mutedForeground} />
                          </Pressable>
                        </HighlightRow>
                      ) : (
                        <View
                          accessible
                          accessibilityLabel={rowAccessibilityLabel(row, language)}
                          style={styles.row}
                        >
                          {copy}
                        </View>
                      )}
                    </Fragment>
                  );
                })}
              </HighlightList>
            ) : (
              // A neutral empty tray, not a read-receipt tick, and a line that
              // names what this widget will hold.
              <View style={[styles.emptyRow, { borderTopColor: theme.muted }]}>
                <Ionicons name="file-tray-outline" size={18} color={theme.mutedForeground} accessibilityElementsHidden />
                <Body muted style={styles.emptyCopy}>{widget.empty ?? `Nothing in ${item.label} yet.`}</Body>
              </View>
            )}
            {/* The rail is its own clipped view, not a border-left: a thick
                left border on a rounded card tapers into a crescent at both
                corners. It paints last so a pressed header's opaque background
                never covers its segment. */}
            <View pointerEvents="none" style={[styles.accentRail, straightRailInsets(radii.md), { backgroundColor: railColor }]} accessibilityElementsHidden />
          </View>
        );
      })}
      {editing && hidden.length ? (
        <View style={styles.hiddenBlock}>
          <Text style={[styles.hiddenHeading, { color: theme.mutedForeground }]}>Hidden widgets</Text>
          {hidden.map((item) => (
            <Pressable
              key={item.key}
              accessibilityRole="button"
              accessibilityLabel={`Show ${item.label}`}
              onPress={() => onLayoutChange?.(toggleWidgetHidden(currentLayout(), catalog, item.key))}
              style={({ pressed }) => [styles.hiddenRow, { borderColor: theme.border, backgroundColor: theme.card, opacity: pressed ? 0.82 : 1 }]}
            >
              <Text style={[styles.primary, { color: theme.foreground }]}>{item.label}</Text>
              <Text style={[styles.editLabel, { color: theme.primary }]}>Add back</Text>
            </Pressable>
          ))}
        </View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  stack: { gap: spacing.md },
  customizeRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  customizeHint: { flex: 1 },
  customizeButton: {
    minHeight: minimumTouchTarget,
    borderRadius: radii.pill,
    paddingHorizontal: spacing.md,
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.xs,
  },
  customizeLabel: { fontSize: 14, lineHeight: 18, ...typeface.controlStrong },
  widget: {
    borderRadius: radii.md,
    borderWidth: StyleSheet.hairlineWidth,
    overflow: 'hidden',
  },
  accentRail: { position: 'absolute', left: 0, width: 3 },
  head: {
    minHeight: minimumTouchTarget,
    alignItems: 'flex-start',
    gap: spacing.xs,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
  },
  titleRow: {
    width: '100%',
    flexDirection: 'row',
    flexWrap: 'wrap',
    alignItems: 'center',
    columnGap: spacing.sm,
  },
  titleSpacer: { flexGrow: 1, minWidth: spacing.sm },
  icon: { width: 32, height: 32, borderRadius: radii.sm, alignItems: 'center', justifyContent: 'center' },
  // Full line, so a non-shrinking badge cannot squeeze the title to zero
  // and a long word is not broken to fit beside the icon.
  title: { width: '100%', flexBasis: '100%', minWidth: '100%', marginTop: spacing.xs, fontSize: 17, lineHeight: 23, ...typeface.heading },
  badge: { alignSelf: 'flex-start', borderRadius: radii.pill, paddingHorizontal: spacing.sm, paddingVertical: 2 },
  badgeText: { fontSize: 12, lineHeight: 16, ...typeface.controlStrong },
  body: { borderTopWidth: StyleSheet.hairlineWidth },
  rowDivider: { height: StyleSheet.hairlineWidth, marginHorizontal: spacing.md },
  row: {
    minHeight: 48,
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
  },
  rowCopy: { flex: 1, gap: 2 },
  primary: { fontSize: 15, lineHeight: 20, ...typeface.control },
  secondary: { fontSize: 13, lineHeight: 18, ...typeface.bodyMedium },
  meta: { fontSize: 12, lineHeight: 16, ...typeface.bodyMedium },
  toneDot: { width: 8, height: 8, borderRadius: 4 },
  tileRow: {
    flexDirection: 'row',
    gap: spacing.sm,
    padding: spacing.md,
    borderTopWidth: StyleSheet.hairlineWidth,
  },
  tile: { flex: 1, borderRadius: radii.md, padding: spacing.md, gap: 2 },
  tileValue: { fontSize: 22, lineHeight: 28, ...typeface.controlStrong, letterSpacing: -0.4 },
  tileLabel: { fontSize: 12, lineHeight: 16, ...typeface.control },
  emptyRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    alignItems: 'center',
    columnGap: spacing.sm,
    rowGap: spacing.xs,
    borderTopWidth: StyleSheet.hairlineWidth,
    paddingVertical: spacing.md,
    paddingHorizontal: spacing.md,
  },
  // The sentence takes the next full line. Beside the icon, at the largest
  // font, "Appointments" was wider than the remaining column and Android
  // broke it inside the word. The icon stays on the first line, inside the
  // card padding.
  emptyCopy: { width: '100%', flexBasis: '100%', flexGrow: 1 },
  editRow: {
    minHeight: minimumTouchTarget,
    borderTopWidth: StyleSheet.hairlineWidth,
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: spacing.sm,
    gap: spacing.sm,
  },
  editButton: {
    minHeight: minimumTouchTarget,
    minWidth: minimumTouchTarget,
    alignItems: 'center',
    justifyContent: 'center',
  },
  editLabel: { fontSize: 14, lineHeight: 18, ...typeface.controlStrong },
  hiddenBlock: { gap: spacing.sm },
  hiddenHeading: { fontSize: 13, lineHeight: 18, ...typeface.heading, textTransform: 'uppercase' },
  hiddenRow: {
    minHeight: minimumTouchTarget,
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: radii.md,
    paddingHorizontal: spacing.md,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
});
