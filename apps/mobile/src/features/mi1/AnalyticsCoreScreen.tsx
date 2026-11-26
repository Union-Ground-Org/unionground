import { useNativeUi } from '../../lib/useNativeUi';
import { analyticsCaseFigures } from './analyticsCaseFigures';
import { useEffect, useMemo, useRef, useState } from 'react';
import { Pressable, View } from 'react-native';
import { Text } from '../../components/Text';

import { Body, Button, Card, Heading, Screen, StateMessage, StatusPill } from '../../components/ui';
import { QuarterlySurveyGate } from '../../components/QuarterlySurveyGate';
import { useAccessibilityAnnouncementQueue } from '../../lib/announce';
import {
  ANALYTICS_DESK_TABS,
  authorizeAnalyticsAccess,
  composeAnalyticsCore,
  MI1_ANALYTICS_NATIVE_PERSISTENCE,
  paginateAnalyticsLayouts,
  paginateAnalyticsMembers,
  toAnalyticsViewer,
  type NativeOrganizationActor,
} from '../../lib/mi1AnalyticsShared';
import { haptics } from '../../services/haptics';
import { useTheme } from '../../theme/ThemeProvider';
import { mi1Styles as styles } from './mi1Styles';

type AnalyticsSnapshot = Record<string, unknown>;

const ANALYTICS_TAB_LABELS: Readonly<Record<string, string>> = Object.freeze({
  stats: 'Statistics',
  usage: 'Portal usage',
  insights: 'Insights',
  heatmaps: 'Heatmaps',
  engagement: 'Engagement',
  attendance: 'Attendance',
  health: 'Health tree',
  explorer: 'Explorer',
  studio: 'Charts studio',
  chapter_charts: 'Campaign charts',
});

function Metric({ label, value }: { label: string; value: unknown }) {
  return (
    <Card>
      <Body muted>{label}</Body>
      <Heading level={3}>{value == null ? '—' : String(value)}</Heading>
    </Card>
  );
}

function pageAnnouncement(page: number, pageCount: number) {
  return `Page ${page + 1} of ${pageCount}`;
}

function PaginationControls({ page, pageCount, setPage }: {
  page: number;
  pageCount: number;
  setPage: (page: number) => void;
}) {
  const queueAnnouncement = useAccessibilityAnnouncementQueue('analytics-pagination');
  if (pageCount <= 1) return null;
  const goToPage = (nextPage: number) => {
    setPage(nextPage);
    queueAnnouncement(pageAnnouncement(nextPage, pageCount));
  };
  return (
    <View>
      <View accessibilityLiveRegion="polite">
        <Body muted>{pageAnnouncement(page, pageCount)}</Body>
      </View>
      <View style={styles.row}>
        <Button label="Previous page" variant="secondary" disabled={page === 0} onPress={() => goToPage(page - 1)} />
        <Button label="Next page" variant="secondary" disabled={page + 1 >= pageCount} onPress={() => goToPage(page + 1)} />
      </View>
    </View>
  );
}

function PaginatedLayouts({ layouts, emptyTitle, emptyBody, chapter = false }: {
  layouts: any[];
  emptyTitle: string;
  emptyBody: string;
  chapter?: boolean;
}) {
  const [page, setPage] = useState(0);
  const pagination = paginateAnalyticsLayouts(layouts, page);
  if (layouts.length === 0) return <StateMessage title={emptyTitle} body={emptyBody} />;
  return (
    <View>
      {pagination.items.map((layout: any) => (
        <Card key={layout.id}>
          <Heading level={3}>{layout.name}</Heading>
          <Body muted>{chapter ? `${layout.spec.chartType} · shared campaign layout` : `${layout.scope} · ${layout.spec.chartType}`}</Body>
        </Card>
      ))}
      <PaginationControls page={pagination.page} pageCount={pagination.pageCount} setPage={setPage} />
    </View>
  );
}

function PaginatedMembers({ members }: { members: any[] }) {
  const [page, setPage] = useState(0);
  const pagination = paginateAnalyticsMembers(members, page);
  if (members.length === 0) {
    return <StateMessage title="No worker signals yet" body="The explorer fills in once the organization has workers." />;
  }
  return (
    <View>
      {pagination.items.map((member: any) => (
        <Card key={member.id}>
          <Heading level={3}>{member.name}</Heading>
          <Body muted>{member.chapterName} · {member.attention ?? '—'}</Body>
          <Body>{`Score ${member.overallScore ?? '—'} · ${member.activeCases} active issues`}</Body>
        </Card>
      ))}
      <PaginationControls page={pagination.page} pageCount={pagination.pageCount} setPage={setPage} />
    </View>
  );
}

export function AnalyticsTab({ desk, tab }: { desk: any; tab: (typeof ANALYTICS_DESK_TABS)[number] }) {
  const { t, catalogLabel } = useNativeUi();
  if (tab === 'stats') {
    const overview = desk.stats.overview;
    // #9533: no number where no group of cases reached the floor; the
    // website's reason instead, and published chapter totals with the
    // website's scope sentence (analyticsCaseFigures).
    const cases = analyticsCaseFigures(overview);
    return (
      <View>
        <Metric label="Open issues" value={cases.openCases} />
        <Metric label="Resolved issues" value={cases.resolvedCases} />
        <Metric label="Resolution rate" value={cases.resolutionRate} />
        {cases.scope
          ? <Body muted>{t('In {count} of {total} campaigns', cases.scope)}</Body>
          : cases.missing ? <Body muted>{catalogLabel(cases.missing)}</Body> : null}
        <Metric label="Campaigns" value={overview.chapterCount} />
      </View>
    );
  }
  if (tab === 'usage') {
    return (
      <View>
        <Metric label="Views · 30 days" value={desk.usage.totalViews} />
        <Metric label="Daily actors" value={desk.usage.dau} />
        <Metric label="Weekly actors" value={desk.usage.wau} />
        <Metric label="Monthly actors" value={desk.usage.mau} />
      </View>
    );
  }
  if (tab === 'insights') {
    if (desk.insights.available === false) {
      return <StateMessage title="Insights unavailable" body="The current analytics do not include enough comparison data yet." />;
    }
    if (!desk.insights.enoughData) {
      return <StateMessage title="Comparison hidden for privacy" body="Insights stay hidden until at least 25 observations can be compared safely." />;
    }
    return desk.insights.findings.length > 0
      ? desk.insights.findings.map((finding: any) => (
        <Card key={finding.id}>
          <Heading level={3}>{finding.title}</Heading>
          <Body>{finding.description}</Body>
          <Body muted>{`r = ${finding.r} · n = ${finding.n}`}</Body>
        </Card>
      ))
      : <StateMessage title="No strong correlations yet" body="No organization-level relationship cleared the privacy and strength floors." />;
  }
  if (tab === 'heatmaps') {
    const grievance = desk.heatmaps.grievance;
    const solidarity = desk.heatmaps.solidarity;
    return (
      <View>
        <Metric label="Visible workplace issue cells" value={grievance.cells.filter((cell: any) => !cell.suppressed).length} />
        <Metric label="Protected workplace issue cells" value={grievance.suppressedCount} />
        {solidarity.available === false
          ? <StateMessage title="Solidarity heatmap unavailable" body="The current analytics do not include solidarity summaries yet." />
          : <>
            <Metric label="Visible solidarity cells" value={solidarity.cells.filter((cell: any) => !cell.suppressed).length} />
            <Metric label="Solidarity cells hidden for privacy" value={solidarity.suppressedCount} />
          </>}
      </View>
    );
  }
  if (tab === 'engagement') {
    return desk.engagement.enoughData
      ? (
        <View>
          <Metric label="Organization engagement mean" value={desk.engagement.mean} />
          <Metric label="Published campaign cohorts" value={desk.engagement.chapters.length} />
        </View>
      )
      : <StateMessage title="Engagement scores hidden for privacy" body="Named scores stay hidden until at least 25 workers are represented." />;
  }
  if (tab === 'health') {
    if (desk.workspace?.state !== 'ready') return <StateMessage title="Health tree unavailable" body="Worker data for this view isn’t connected yet." />;
    return desk.workspace.chapters.length > 0
      ? desk.workspace.chapters.map((chapter: any) => <Card key={chapter.chapterId}><Heading level={3}>{chapter.chapterName}</Heading><Body muted>{chapter.health?.protected ? 'Hidden for privacy' : `Health ${chapter.health?.score ?? '—'}`}</Body><Body>{chapter.members.length} authorized worker signals</Body></Card>)
      : <StateMessage title="No campaign health yet" body="Campaign health appears once records exist." />;
  }
  if (tab === 'explorer') {
    if (desk.workspace?.state !== 'ready') return <StateMessage title="Explorer unavailable" body="Worker data for this view isn’t connected yet." />;
    return <PaginatedMembers members={desk.workspace.members} />;
  }
  if (tab === 'studio') {
    if (desk.workspace?.state !== 'ready') return <StateMessage title="Charts studio unavailable" body="Saved charts for this view aren’t connected yet." />;
    return <PaginatedLayouts key="studio" layouts={desk.workspace.layouts} emptyTitle="No saved layouts" emptyBody="Create reusable layouts on the website; saved layouts appear here." />;
  }
  if (tab === 'chapter_charts') {
    if (desk.workspace?.state !== 'ready') return <StateMessage title="Campaign charts unavailable" body="Saved charts for this view aren’t connected yet." />;
    return <PaginatedLayouts key="chapter-charts" layouts={desk.workspace.chapterCharts} emptyTitle="No campaign charts" emptyBody="Shared campaign layouts appear after staff save them." chapter />;
  }
  if (desk.attendance.available === false) {
    return <StateMessage title="Attendance unavailable" body="The current analytics do not include attendance summaries yet." />;
  }
  return desk.attendance.enoughData
    ? (
      <View>
        <Metric label="Meetings · 180 days" value={desk.attendance.totals.events} />
        <Metric label="Check-ins" value={desk.attendance.totals.suppressed ? 'Hidden' : desk.attendance.totals.checkIns} />
        <Metric label="Average per meeting" value={desk.attendance.totals.suppressed ? 'Hidden' : desk.attendance.totals.averagePerEvent} />
      </View>
    )
    : <StateMessage title="No attendance yet" body="Attendance analytics stay empty until organization meetings record check-ins." />;
}

export function AnalyticsCoreScreen({
  actor,
  loadSnapshot,
  loadWorkspace,
  preview = false,
}: {
  actor: NativeOrganizationActor;
  loadSnapshot?: (() => Promise<AnalyticsSnapshot>) | null;
  loadWorkspace?: (() => Promise<AnalyticsSnapshot>) | null;
  preview?: boolean;
}) {
  const { catalogLabel, t } = useNativeUi();
  const theme = useTheme();
  const viewer = useMemo(() => toAnalyticsViewer(actor), [actor]);
  const gate = authorizeAnalyticsAccess(viewer);
  const [tab, setTab] = useState<(typeof ANALYTICS_DESK_TABS)[number]>('stats');
  const [snapshot, setSnapshot] = useState<AnalyticsSnapshot | null>(null);
  const [workspace, setWorkspace] = useState<AnalyticsSnapshot | null>(null);
  const [loadState, setLoadState] = useState<'idle' | 'loading' | 'ready' | 'error'>('idle');
  const [attempt, setAttempt] = useState(0);
  const [refreshing, setRefreshing] = useState(false);
  const loadPending = useRef(false);

  useEffect(() => {
    if (!gate.ok || !loadSnapshot) {
      loadPending.current = false;
      setRefreshing(false);
      setSnapshot(null);
      setWorkspace(null);
      setLoadState('idle');
      return undefined;
    }
    let active = true;
    loadPending.current = true;
    setLoadState('loading');
    Promise.all([loadSnapshot(), loadWorkspace ? loadWorkspace() : Promise.resolve(null)]).then(([next, nextWorkspace]) => {
      if (!active) return;
      setSnapshot(next);
      setWorkspace(nextWorkspace);
      setLoadState('ready');
    }).catch(() => {
      if (!active) return;
      setSnapshot(null);
      setWorkspace(null);
      setLoadState('error');
    }).finally(() => {
      if (!active) return;
      loadPending.current = false;
      setRefreshing(false);
    });
    return () => { active = false; };
  }, [attempt, gate.ok, loadSnapshot, loadWorkspace, viewer.organizationId]);

  function refreshAnalytics() {
    if (loadPending.current) return;
    loadPending.current = true;
    setRefreshing(true);
    setAttempt((value) => value + 1);
  }

  const desk = useMemo(() => composeAnalyticsCore({ snapshot: snapshot as any, workspace: workspace as any, viewer }), [snapshot, workspace, viewer]);
  const status = !gate.ok ? 'Restricted'
    : loadState === 'loading' ? 'Loading'
      : loadState === 'error' ? 'Unavailable'
        : desk.state === 'ready' ? 'Ready' : 'Unset';

  return (
    <Screen>
      <Heading>{catalogLabel('Organization analytics')}</Heading>
      {preview ? <StatusPill label="Sample data" /> : null}
      <Body muted>Organization staff see these totals. Workers see no organization analytics.</Body>
      <QuarterlySurveyGate>
      <Card>
        <View style={styles.row}>
          <Heading level={3}>Current totals</Heading>
          <StatusPill label={status} />
        </View>
        <Body muted>Totals are grouped, and small groups are hidden, before they appear here.</Body>
      </Card>
      {!gate.ok ? (
        <StateMessage
          title={gate.reason === 'no_organization' ? 'No organization is selected' : 'This desk needs a staff role'}
          body={gate.reason === 'no_organization'
            ? 'Choose an organization to view its analytics.'
            : 'Choose an eligible organization staff role to continue.'}
        />
      ) : null}
      {gate.ok && loadState === 'loading' ? (
        <StateMessage title="Loading organization analytics" body="Preparing the latest totals." />
      ) : null}
      {gate.ok && loadState === 'error' ? (
        <View>
          <StateMessage title="Organization analytics are unavailable" body="The latest analytics didn’t load. No earlier organization data is shown." />
          <Button label="Try again" variant="secondary" onPress={() => setAttempt((value) => value + 1)} />
        </View>
      ) : null}
      {gate.ok && loadState === 'idle' ? (
        <StateMessage
          title={MI1_ANALYTICS_NATIVE_PERSISTENCE.analyticsSnapshot ? 'A live session is required' : 'Analytics are not connected'}
          body="Sign in to view current organization analytics."
        />
      ) : null}
      {gate.ok && loadState === 'ready' && desk.state === 'ready' ? <View style={styles.wrap}>
        {ANALYTICS_DESK_TABS.map((item) => (
          <Pressable
            key={item}
            accessibilityRole="button"
            accessibilityLabel={`Analytics: ${ANALYTICS_TAB_LABELS[item]}`}
            accessibilityState={{ selected: tab === item }}
            onPress={() => { setTab(item); void haptics.select(); }}
            style={({ pressed }) => [styles.chip, {
              backgroundColor: tab === item ? theme.primary : theme.secondary,
              opacity: pressed ? 0.82 : 1,
            }]}
          >
            <Text style={[styles.chipText, { color: tab === item ? theme.primaryForeground : theme.secondaryForeground }]}>{ANALYTICS_TAB_LABELS[item]}</Text>
          </Pressable>
        ))}
      </View> : null}
      {gate.ok && loadState === 'ready' && desk.state === 'ready' ? (
        <View>
          <AnalyticsTab desk={desk} tab={tab} />
          <Body muted>{desk.exportAllowed
            ? 'Protected CSV export is available on the website and expires after 24 hours.'
            : 'Export is limited to Campaign lead, Admin, and Campaign chair grants.'}</Body>
        </View>
      ) : null}
      {gate.ok && (refreshing || (loadState === 'ready' && desk.state !== 'ready')) ? (
        <View>
          {refreshing ? null : (
            <StateMessage
              title={t(desk.state === 'unauthorized' ? 'Analytics authorization changed' : 'Analytics are not ready')}
              body={t('Refresh after your organization access and two-step verification are current. No earlier totals are shown.')}
            />
          )}
          <Button label={t('Refresh')} variant="secondary" onPress={refreshAnalytics} busy={refreshing} />
        </View>
      ) : null}
      </QuarterlySurveyGate>
    </Screen>
  );
}
