import { Ionicons } from '@expo/vector-icons';
import { Fragment, useCallback, useEffect, useMemo, useState } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';
import { Text } from '../components/Text';

import { Body, Button, Card, Heading, Screen, SearchField, StateMessage } from '../components/ui';
import { useNativeTabContentInset } from '../lib/chrome';
import {
  buildMemberOrgTree,
  memberOrgChartsWithContent,
  memberOrgSourceLine,
  normalizeMemberOrgStructure,
  resolveMemberOrgEdges,
  searchMemberOrgNodes,
  type MemberOrgChart,
  type MemberOrgChartKind,
  type MemberOrgNode,
  type MemberOrgStructure,
  type MemberOrgTreeRow,
} from '../lib/memberOrgContract';
import { useNativeUi } from '../lib/useNativeUi';
import { memberOrgPort } from '../services/memberOrgPort';
import { haptics } from '../services/haptics';
import { useApp } from '../state/AppProvider';
import { useTheme } from '../theme/ThemeProvider';
import { minimumTouchTarget, radii, spacing } from '../theme/tokens';

import { typeface } from '../theme/typeface';
const CHART_KIND_LABELS: Record<MemberOrgChartKind, string> = {
  union: 'Campaign',
  agency: 'Employer',
};

const NODE_KIND_LABELS: Record<string, string> = {
  organization: 'Organization',
  division: 'Division',
  chapter: 'Campaign',
  team: 'Team',
  role: 'Role',
  person: 'Person',
};

function nodeKindLabel(nodeKind: string): string {
  return NODE_KIND_LABELS[nodeKind] ?? nodeKind;
}

const SEAT_STATUS_LABELS: Record<MemberOrgNode['seatStatus'], string | null> = {
  confirmed: null,
  unconfirmed: 'Unconfirmed',
  unknown: 'Unknown',
  stale: 'Stale',
};

// A vacant, unknown, unconfirmed or stale seat is marked wherever the node
// appears, so it is never read as a confirmed, filled seat.
function nodeSummary(node: MemberOrgNode): string {
  return [nodeKindLabel(node.nodeKind), node.vacant ? 'Vacant' : null, SEAT_STATUS_LABELS[node.seatStatus], node.subtitle]
    .filter((value) => value !== null).join(' · ');
}

// Preview fixture only. Generic structural words and the existing preview cast,
// so the blank-system rule holds: no organization or agency name can ship as a
// default, seed or fixture through this screen.
const PREVIEW_STRUCTURE: MemberOrgStructure = normalizeMemberOrgStructure({
  organizationId: 'preview-organization',
  chapterId: 'wor',
  generatedAt: '2026-09-22T12:00:00Z',
  charts: [
    {
      chartKind: 'agency',
      nodes: [
        { id: 'a-org', parentId: null, chapterId: null, nodeKind: 'organization', label: 'Employer', subtitle: 'The agency that employs this workplace', sortOrder: 0 },
        { id: 'a-division', parentId: 'a-org', chapterId: null, nodeKind: 'division', label: 'Regional operations', subtitle: 'Service delivery region', sortOrder: 1 },
        { id: 'a-role', parentId: 'a-division', chapterId: 'wor', nodeKind: 'role', label: 'Area director', subtitle: 'Seat shown without an occupant', sortOrder: 0, vacant: true, badge: 'Operations', roleClass: 'director', sourceLabel: 'Published chart', sourceAsOf: '2026-09-01' },
      ],
      edges: [],
    },
    {
      chartKind: 'union',
      nodes: [
        { id: 'u-org', parentId: null, chapterId: null, nodeKind: 'organization', label: 'Organizing campaign', subtitle: 'Worker-led organizing', sortOrder: 0 },
        { id: 'u-exec', parentId: 'u-org', chapterId: null, nodeKind: 'team', label: 'Leadership team', subtitle: 'Campaign leaders and at-large seats', sortOrder: 1 },
        { id: 'u-chapter', parentId: 'u-org', chapterId: 'wor', nodeKind: 'chapter', label: 'Your campaign', subtitle: 'The campaign you are part of', sortOrder: 2 },
        { id: 'u-advisor', parentId: 'u-chapter', chapterId: 'wor', nodeKind: 'person', label: 'Avery Nguyen', subtitle: 'Campaign advisor', sortOrder: 0 },
        { id: 'u-steward-1', parentId: 'u-chapter', chapterId: 'wor', nodeKind: 'person', label: 'Sam Okafor', subtitle: 'Committee member', sortOrder: 1 },
        { id: 'u-steward-2', parentId: 'u-chapter', chapterId: 'wor', nodeKind: 'person', label: 'Dana Whitfield', subtitle: 'Committee member', sortOrder: 2 },
      ],
      edges: [
        { id: 'e-1', sourceId: 'u-steward-1', targetId: 'u-advisor', kind: 'reports_to' },
        { id: 'e-2', sourceId: 'u-steward-2', targetId: 'u-advisor', kind: 'reports_to' },
        // Deliberately unresolvable: the target is not an admitted node of this
        // chart, so the chart must omit the edge rather than draw a phantom.
        { id: 'e-3', sourceId: 'u-advisor', targetId: 'u-outside-scope', kind: 'reports_to' },
      ],
    },
  ],
});

type LoadState =
  | { kind: 'loading' }
  | { kind: 'ready'; structure: MemberOrgStructure }
  | { kind: 'error'; message: string };

export function OrgStructureScreen() {
  const { chapterMemberships, confirmedMembershipScope, mode, sessionRestricted } = useApp();
  const selection = confirmedMembershipScope?.length === 1 ? confirmedMembershipScope[0] : null;
  const { organizationID, chapterID } = selection ?? {};
  const { t } = useNativeUi();
  const bottomInset = useNativeTabContentInset();
  const theme = useTheme();
  const [query, setQuery] = useState('');
  const [selectedKind, setSelectedKind] = useState<MemberOrgChartKind | null>(null);
  const [selectedNodeID, setSelectedNodeID] = useState<string | null>(null);
  const [state, setState] = useState<LoadState>(
    mode === 'preview' ? { kind: 'ready', structure: PREVIEW_STRUCTURE } : { kind: 'loading' },
  );

  const load = useCallback(async () => {
    if (mode === 'preview') {
      setState({ kind: 'ready', structure: PREVIEW_STRUCTURE });
      return;
    }
    setState({ kind: 'loading' });
    try {
      setState({ kind: 'ready', structure: normalizeMemberOrgStructure(await memberOrgPort.loadOrganizationStructure()) });
    } catch (error) {
      setState({
        kind: 'error',
        message: error instanceof Error ? error.message : 'Your workplace structure could not be loaded.',
      });
    }
  }, [mode]);

  useEffect(() => { void load(); }, [load]);

  const charts = state.kind === 'ready' ? memberOrgChartsWithContent(state.structure) : [];
  const activeChart: MemberOrgChart | null = charts.find((chart) => chart.chartKind === selectedKind) ?? charts[0] ?? null;
  const treeRows = useMemo(() => (activeChart ? buildMemberOrgTree(activeChart.nodes) : []), [activeChart]);
  const visibleRows = useMemo(() => searchMemberOrgNodes(treeRows, query), [treeRows, query]);
  const resolvedEdges = useMemo(() => (activeChart ? resolveMemberOrgEdges(activeChart) : []), [activeChart]);
  const sourceLine = memberOrgSourceLine(charts);

  if (state.kind === 'loading') {
    return (
      <Screen tabRoot bottomInset={bottomInset}>
        <StateMessage
          title="Your workplace structure is loading"
          body="Getting your organization's structure."
        />
      </Screen>
    );
  }

  if (state.kind === 'error') {
    return (
      <Screen tabRoot bottomInset={bottomInset}>
        <StateMessage
          title="Your workplace structure could not be loaded"
          body={state.message}
          action={<Button label="Try again" onPress={() => { void load(); }} />}
        />
      </Screen>
    );
  }

  if (charts.length === 0) {
    const chapterName = organizationID && state.structure.organizationID === organizationID
      && state.structure.chapterID === chapterID && !sessionRestricted
      ? chapterMemberships.find((membership) => membership.chapterID === state.structure.chapterID
        && membership.organizationID === organizationID)?.name.trim() : null;
    return (
      <Screen tabRoot bottomInset={bottomInset}>
        <StateMessage
          title={t('No workplace structure yet')}
          body={t('Nobody has published a chart for your workplace. When one is published, the parts you can see appear here.')}
        />
        {chapterName ? <Body>{t('Campaign: {chapter}', { chapter: chapterName })}</Body> : null}
      </Screen>
    );
  }

  return (
    <Screen tabRoot bottomInset={bottomInset}>
      <Body muted>View only. You see the parts of your organization your membership and campaign include.</Body>
      {charts.length > 1 ? (
        <View style={styles.kindRow} accessibilityRole="tablist">
          {charts.map((chart) => {
            const selected = chart.chartKind === activeChart?.chartKind;
            return (
              <Pressable
                key={chart.chartKind}
                accessibilityRole="tab"
                accessibilityState={{ selected }}
                accessibilityLabel={`${CHART_KIND_LABELS[chart.chartKind]} structure`}
                onPress={() => { void haptics.select(); setSelectedKind(chart.chartKind); setSelectedNodeID(null); }}
                style={[styles.kindChip, { backgroundColor: selected ? theme.primary : theme.secondary }]}
              >
                <Text style={[styles.kindChipText, { color: selected ? theme.primaryForeground : theme.secondaryForeground }]}>
                  {CHART_KIND_LABELS[chart.chartKind]}
                </Text>
              </Pressable>
            );
          })}
        </View>
      ) : null}
      <SearchField
        value={query}
        onChangeText={setQuery}
        placeholder="Search this structure"
        accessibilityLabel="Search the workplace structure"
      />
      {visibleRows.length === 0 ? (
        <StateMessage
          compact
          title="Nothing matches that search"
          body="Try a different name, team, or seat."
        />
      ) : (
        <View style={styles.tree}>
          {visibleRows.map((row) => {
            const selected = row.node.id === selectedNodeID;
            return (
              <Fragment key={row.node.id}>
                <OrgTreeRow
                  row={row}
                  indented={query.trim() === ''}
                  selected={selected}
                  onPress={() => {
                    void haptics.select();
                    setSelectedNodeID((current) => (current === row.node.id ? null : row.node.id));
                  }}
                />
                {selected ? <OrgNodeDetail node={row.node} edges={resolvedEdges} /> : null}
              </Fragment>
            );
          })}
        </View>
      )}
      {sourceLine !== null ? <Body muted>{`Source: ${sourceLine}`}</Body> : null}
    </Screen>
  );
}

function OrgTreeRow({ row, indented, selected, onPress }: {
  row: MemberOrgTreeRow;
  indented: boolean;
  selected: boolean;
  onPress: () => void;
}) {
  const theme = useTheme();
  const { node, depth, childCount } = row;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ selected, expanded: selected }}
      accessibilityLabel={[
        node.label,
        nodeKindLabel(node.nodeKind),
        node.vacant ? 'Vacant' : null,
        SEAT_STATUS_LABELS[node.seatStatus],
        node.subtitle,
        childCount > 0 ? `${childCount} below` : null,
      ].filter((value) => value !== null).join(', ')}
      onPress={onPress}
      style={({ pressed }) => [
        styles.row,
        { marginLeft: indented ? depth * spacing.md : 0 },
        { borderColor: theme.border, backgroundColor: selected ? theme.secondary : theme.card },
        pressed ? { opacity: 0.82 } : null,
      ]}
    >
      <Ionicons
        name={node.nodeKind === 'person' ? 'person-outline' : 'git-branch-outline'}
        size={18}
        color={theme.mutedForeground}
        accessibilityElementsHidden
      />
      <View style={styles.rowCopy}>
        <Text style={[styles.rowLabel, { color: theme.foreground }]}>{node.label}</Text>
        <Text style={[styles.rowSub, { color: theme.mutedForeground }]}>
          {nodeSummary(node)}
        </Text>
      </View>
      <Ionicons name={selected ? 'chevron-up' : 'chevron-down'} size={16} color={theme.mutedForeground} accessibilityElementsHidden />
    </Pressable>
  );
}

function OrgNodeDetail({ node, edges }: {
  node: MemberOrgNode;
  edges: readonly { source: MemberOrgNode; target: MemberOrgNode }[];
}) {
  // Only edges whose two endpoints are both admitted nodes of this chart reach
  // here, so a reporting line can never be drawn against a phantom.
  const reportsTo = edges.filter((edge) => edge.source.id === node.id).map((edge) => edge.target);
  const directReports = edges.filter((edge) => edge.target.id === node.id).map((edge) => edge.source);
  return (
    <Card>
      <Heading level={3}>{node.label}</Heading>
      <Body muted>{nodeSummary(node)}</Body>
      {node.badge !== null ? <Body muted>{`Area: ${node.badge}`}</Body> : null}
      {node.roleClass !== null ? <Body muted>{`Role class: ${node.roleClass}`}</Body> : null}
      {node.chipLabel !== null ? <Body muted>{`Unit: ${node.chipLabel}`}</Body> : null}
      {/* The source's free-text reporting line. It is never coerced into an
          edge, so it is shown as what it is. */}
      {node.reportsToLabel !== null ? <Body muted>{`Listed as reporting to: ${node.reportsToLabel}`}</Body> : null}
      {node.sourceLabel !== null ? (
        <Body muted>{`Source: ${[node.sourceLabel, node.sourceAsOf].filter((value) => value !== null).join(' · ')}`}</Body>
      ) : null}
      {reportsTo.length > 0 ? (
        <Body muted>{`Reports to: ${reportsTo.map((entry) => entry.label).join(', ')}`}</Body>
      ) : null}
      {directReports.length > 0 ? (
        <Body muted>{`Reporting to this seat: ${directReports.map((entry) => entry.label).join(', ')}`}</Body>
      ) : null}
      {reportsTo.length === 0 && directReports.length === 0 ? (
        <Body muted>No reporting line is published for this seat inside what you can see.</Body>
      ) : null}
    </Card>
  );
}

const styles = StyleSheet.create({
  kindRow: { flexDirection: 'row', gap: spacing.sm },
  kindChip: { minHeight: minimumTouchTarget, justifyContent: 'center', paddingHorizontal: spacing.lg, borderRadius: radii.md },
  kindChipText: { fontSize: 15, lineHeight: 20, ...typeface.controlStrong },
  tree: { gap: spacing.xs },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    minHeight: minimumTouchTarget,
    paddingVertical: spacing.sm,
    paddingHorizontal: spacing.md,
    borderRadius: radii.md,
    borderWidth: StyleSheet.hairlineWidth,
  },
  rowCopy: { flex: 1, gap: 2 },
  rowLabel: { fontSize: 16, lineHeight: 21, ...typeface.controlStrong },
  rowSub: { fontSize: 13, lineHeight: 18 },
});
