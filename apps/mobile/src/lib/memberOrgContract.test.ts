import { describe, expect, it } from 'vitest';

import {
  buildMemberOrgTree,
  memberOrgChartsWithContent,
  memberOrgSourceLine,
  normalizeMemberOrgStructure,
  normalizeMemberStewardRoster,
  startSelectedStewardConversation,
  resolveMemberOrgEdges,
  searchMemberOrgNodes,
  MEMBER_ORG_CHART_KINDS,
  MEMBER_ORG_RPC_NAMES,
  MEMBER_VISIBLE_RELATIONSHIP_KINDS,
} from './memberOrgContract';

// The payload shape is v1 §4:
// get_member_organization_structure() groups nodes per chart kind, never
// projects user_id, and emits edges as already-resolved node-id pairs.
const structurePayload = {
  organizationId: '11111111-1111-4111-8111-111111111111',
  chapterId: 'wor',
  generatedAt: '2026-09-22T00:00:00Z',
  charts: [
    {
      chartKind: 'union',
      nodes: [
        { id: 'org', parentId: null, chapterId: null, nodeKind: 'organization', label: 'Statewide organization', subtitle: null, sortOrder: 0 },
        { id: 'chapter', parentId: 'org', chapterId: 'wor', nodeKind: 'chapter', label: 'Your campaign', subtitle: 'Regional worker campaign', sortOrder: 1 },
        { id: 'advisor', parentId: 'chapter', chapterId: 'wor', nodeKind: 'person', label: 'Advisor seat', subtitle: 'Campaign advisor', sortOrder: 0 },
        { id: 'steward', parentId: 'chapter', chapterId: 'wor', nodeKind: 'person', label: 'Committee seat', subtitle: 'Committee', sortOrder: 1 },
      ],
      edges: [
        { id: 'e-resolves', sourceId: 'steward', targetId: 'advisor', kind: 'reports_to' },
        { id: 'e-unresolved', sourceId: 'steward', targetId: 'outside-my-chapter', kind: 'reports_to' },
        { id: 'e-cross-chart', sourceId: 'steward', targetId: 'agency-role', kind: 'reports_to' },
        { id: 'e-works-with', sourceId: 'steward', targetId: 'advisor', kind: 'works_with' },
        { id: 'e-mentors', sourceId: 'steward', targetId: 'advisor', kind: 'mentors' },
        { id: 'e-organizes-with', sourceId: 'steward', targetId: 'advisor', kind: 'organizes_with' },
        { id: 'e-trusted-contact', sourceId: 'steward', targetId: 'advisor', kind: 'trusted_contact' },
      ],
    },
    {
      chartKind: 'agency',
      nodes: [
        { id: 'agency', parentId: null, chapterId: null, nodeKind: 'organization', label: 'Employer', subtitle: null, sortOrder: 0 },
        { id: 'agency-role', parentId: 'agency', chapterId: 'wor', nodeKind: 'role', label: 'Area director', subtitle: 'Seat shown without an occupant', sortOrder: 1 },
      ],
      edges: [],
    },
  ],
};

describe('worker organization structure (REQ-UG-MEMBER-ORG-STRUCTURE-VIEW-20260922)', () => {
  it('uses only the RPC names the worker contract publishes', () => {
    expect(MEMBER_ORG_RPC_NAMES).toEqual({
      stewardRoster: 'get_member_chapter_stewards',
      organizationStructure: 'get_member_organization_structure',
      stewardConversation: 'start_member_steward_conversation',
    });
    expect(MEMBER_ORG_CHART_KINDS).toEqual(['agency', 'union']);
  });

  it('keeps reports_to as the only member-visible relationship kind', () => {
    expect([...MEMBER_VISIBLE_RELATIONSHIP_KINDS]).toEqual(['reports_to']);
  });

  it.each(['works_with', 'mentors', 'organizes_with', 'trusted_contact'])('drops every %s edge', (kind) => {
    const structure = normalizeMemberOrgStructure(structurePayload);
    const union = structure.charts.find((chart) => chart.chartKind === 'union');
    expect(union?.edges.some((edge) => edge.id === `e-${kind.replaceAll('_', '-')}`)).toBe(false);
    for (const chart of structure.charts) expect(chart.edges.every((edge) => edge.kind === 'reports_to')).toBe(true);
  });

  it('reads the envelope and orders the charts agency then union', () => {
    const structure = normalizeMemberOrgStructure(structurePayload);
    expect(structure.organizationID).toBe('11111111-1111-4111-8111-111111111111');
    expect(structure.chapterID).toBe('wor');
    expect(structure.generatedAt).toBe('2026-09-22T00:00:00Z');
    expect(structure.charts.map((chart) => chart.chartKind)).toEqual(['agency', 'union']);
  });

  it('omits an edge whose endpoint is not an admitted node of the chart being drawn', () => {
    const structure = normalizeMemberOrgStructure(structurePayload);
    const union = structure.charts.find((chart) => chart.chartKind === 'union');
    expect(union).toBeDefined();
    const resolved = resolveMemberOrgEdges(union!);
    // 'e-unresolved' names a node outside the caller's chapter and
    // 'e-cross-chart' names a node of the other chart: both are omitted rather
    // than drawn against a phantom, and neither is matched by display text.
    expect(resolved.map((entry) => entry.edge.id)).toEqual(['e-resolves']);
    expect(resolved[0]?.source.id).toBe('steward');
    expect(resolved[0]?.target.id).toBe('advisor');
  });

  it('never resolves an edge on the chart that does not carry it', () => {
    const structure = normalizeMemberOrgStructure(structurePayload);
    const agency = structure.charts.find((chart) => chart.chartKind === 'agency');
    expect(resolveMemberOrgEdges(agency!)).toEqual([]);
  });

  it('builds an indented tree and keeps a scoped-out parent from hiding its subtree', () => {
    const structure = normalizeMemberOrgStructure({
      charts: [{
        chartKind: 'union',
        nodes: [
          { id: 'chapter', parentId: 'organization-out-of-scope', nodeKind: 'chapter', label: 'Your campaign', sortOrder: 1 },
          { id: 'steward', parentId: 'chapter', nodeKind: 'person', label: 'Committee seat', sortOrder: 0 },
        ],
        edges: [],
      }],
    });
    expect(buildMemberOrgTree(structure.charts[0]!.nodes).map((row) => [row.node.id, row.depth])).toEqual([
      ['chapter', 0],
      ['steward', 1],
    ]);
  });

  it('orders siblings by sort order then label and counts children', () => {
    const structure = normalizeMemberOrgStructure(structurePayload);
    const rows = buildMemberOrgTree(structure.charts.find((chart) => chart.chartKind === 'union')!.nodes);
    expect(rows.map((row) => row.node.id)).toEqual(['org', 'chapter', 'advisor', 'steward']);
    expect(rows[1]?.childCount).toBe(2);
  });

  it('survives a cyclic parent chain instead of recursing forever', () => {
    const structure = normalizeMemberOrgStructure({
      charts: [{
        chartKind: 'union',
        nodes: [
          { id: 'a', parentId: 'b', nodeKind: 'team', label: 'A', sortOrder: 0 },
          { id: 'b', parentId: 'a', nodeKind: 'team', label: 'B', sortOrder: 1 },
        ],
        edges: [],
      }],
    });
    expect(buildMemberOrgTree(structure.charts[0]!.nodes)).toEqual([]);
  });

  it('searches label and subtitle and returns everything for an empty query', () => {
    const structure = normalizeMemberOrgStructure(structurePayload);
    const rows = buildMemberOrgTree(structure.charts.find((chart) => chart.chartKind === 'union')!.nodes);
    expect(searchMemberOrgNodes(rows, '')).toHaveLength(rows.length);
    expect(searchMemberOrgNodes(rows, 'advisor').map((row) => row.node.id)).toEqual(['advisor']);
    expect(searchMemberOrgNodes(rows, 'COMMITTEE').map((row) => row.node.id)).toEqual(['steward']);
    expect(searchMemberOrgNodes(rows, 'nothing here')).toEqual([]);
  });

  it('reports only the charts that actually carry nodes', () => {
    const structure = normalizeMemberOrgStructure({
      charts: [
        { chartKind: 'agency', nodes: [], edges: [] },
        { chartKind: 'union', nodes: [{ id: 'a', nodeKind: 'chapter', label: 'Your campaign', sortOrder: 0 }], edges: [] },
      ],
    });
    expect(memberOrgChartsWithContent(structure).map((chart) => chart.chartKind)).toEqual(['union']);
    expect(memberOrgChartsWithContent(normalizeMemberOrgStructure(null))).toEqual([]);
  });

  it('keeps the vacant, badge, role-class and provenance markers and carries no identity or contact field', () => {
    const structure = normalizeMemberOrgStructure({
      charts: [{
        chartKind: 'agency',
        nodes: [
          {
            id: 'seat', parentId: null, chapterId: 'wor', nodeKind: 'role', label: 'Area director', subtitle: null, sortOrder: 0,
            vacant: true, badge: 'Operations', roleClass: 'director', reportsToLabel: 'Regional lead', chipLabel: 'Unit 4',
            sourceLabel: 'Published chart', sourceAsOf: '2026-09-01',
            // A widened server must not widen the native surface.
            user_id: 'user-1', userId: 'user-1', email: 'withheld@example.test', phone: '555-0100', contacts: [{ email: 'x@example.test' }],
          },
          { id: 'filled', parentId: 'seat', chapterId: 'wor', nodeKind: 'person', label: 'Filled seat', subtitle: null, sortOrder: 1, vacant: 'true' },
        ],
        edges: [],
      }],
    });
    const chart = structure.charts[0]!;
    const [seat, filled] = chart.nodes;
    expect(seat).toEqual({
      id: 'seat', parentID: null, chapterID: 'wor', nodeKind: 'role', label: 'Area director', subtitle: null, sortOrder: 0,
      badge: 'Operations', roleClass: 'director', vacant: true, reportsToLabel: 'Regional lead', chipLabel: 'Unit 4',
      sourceLabel: 'Published chart', sourceAsOf: '2026-09-01', seatStatus: 'unconfirmed',
    });
    // Only a real boolean true marks a seat vacant.
    expect(filled?.vacant).toBe(false);
    expect(filled?.sourceLabel).toBeNull();
    expect(JSON.stringify(structure)).not.toMatch(/user-1|withheld|555-0100|x@example/);
    expect(memberOrgSourceLine(structure.charts)).toBe('Published chart · 2026-09-01');
    expect(memberOrgSourceLine([])).toBeNull();
    // The reportsToLabel is searchable text, never an edge.
    expect(resolveMemberOrgEdges(chart)).toEqual([]);
    expect(searchMemberOrgNodes(buildMemberOrgTree(chart.nodes), 'unit 4').map((row) => row.node.id)).toEqual(['seat']);
  });

  it('refuses malformed rows rather than inventing structure', () => {
    const structure = normalizeMemberOrgStructure({
      charts: [
        { chartKind: 'board', nodes: [{ id: 'x', label: 'Unknown chart', sortOrder: 0 }], edges: [] },
        'not an object',
        {
          chartKind: 'union',
          nodes: [
            { id: 'ok', label: 'Fine', sortOrder: 0 },
            { id: 'no-label', sortOrder: 1 },
            { label: 'No id', sortOrder: 2 },
          ],
          edges: [{ id: 'partial', sourceId: 'ok', kind: 'reports_to' }],
        },
        // A duplicate chart kind must not silently replace or hide the first.
        { chartKind: 'union', nodes: [{ id: 'shadow', label: 'Shadow', sortOrder: 0 }], edges: [] },
      ],
    });
    expect(structure.charts).toHaveLength(1);
    expect(structure.charts[0]?.nodes.map((node) => node.id)).toEqual(['ok']);
    expect(structure.charts[0]?.nodes[0]?.nodeKind).toBe('role');
    expect(structure.charts[0]?.nodes[0]?.parentID).toBeNull();
    expect(structure.charts[0]?.edges).toEqual([]);
    expect(normalizeMemberOrgStructure(null)).toEqual({ organizationID: null, chapterID: null, generatedAt: null, charts: [] });
  });
});

describe('worker committee member roster (REQ-UG-MEMBER-FIND-MY-STEWARD-HOME-ENTRY-20260922)', () => {
  it('reads the contract row and defaults the role label to the machine role', () => {
    expect(normalizeMemberStewardRoster([
      { id: 'a', name: 'First Committee', chapterId: 'wor', chapterLabel: 'Your campaign', acceptsAppointments: true, contact: { conversation: true, email: null, phone: null } },
      { id: 'b', name: 'Second Committee', roleLabel: 'steward', chapterId: 'wor', chapterLabel: 'Your campaign', acceptsAppointments: false, contact: { conversation: true, email: null, phone: null } },
    ])).toEqual([
      { id: 'a', name: 'First Committee', roleLabel: 'steward', chapterID: 'wor', chapterLabel: 'Your campaign', acceptsAppointments: true, contact: { conversation: true, email: null, phone: null } },
      { id: 'b', name: 'Second Committee', roleLabel: 'steward', chapterID: 'wor', chapterLabel: 'Your campaign', acceptsAppointments: false, contact: { conversation: true, email: null, phone: null } },
    ]);
  });

  it('exposes no direct channel until the committee member opts in, and keeps the in-app thread as the floor', () => {
    const [optedIn, notOptedIn, noContactBlock] = normalizeMemberStewardRoster({
      stewards: [
        { id: 'a', name: 'Opted in', contact: { conversation: true, email: 'steward@example.invalid', phone: '  ' } },
        { id: 'b', name: 'Not opted in', contact: { conversation: true, email: null, phone: null } },
        { id: 'c', name: 'No contact block at all' },
      ],
    });
    expect(optedIn?.contact).toEqual({ conversation: true, email: 'steward@example.invalid', phone: null });
    expect(notOptedIn?.contact).toEqual({ conversation: true, email: null, phone: null });
    // A missing block must never strand the member with no way to reach anyone.
    expect(noContactBlock?.contact).toEqual({ conversation: true, email: null, phone: null });
  });

  it('drops a committee member it cannot identify instead of rendering an unbound name', () => {
    expect(normalizeMemberStewardRoster([
      { name: 'No identity' },
      { id: 'c', name: '  ' },
      { id: 'd', name: 'Kept' },
      'not an object',
    ]).map((card) => card.id)).toEqual(['d']);
    expect(normalizeMemberStewardRoster(undefined)).toEqual([]);
    expect(normalizeMemberStewardRoster({ stewards: null })).toEqual([]);
  });
});

describe('first message to a selected committee member (REQ-UG-MEMBER-FIND-MY-STEWARD-HOME-ENTRY-20260922)', () => {
  const stewardID = '22222222-2222-4222-8222-222222222222';
  const portReturning = (reply: () => Promise<unknown>) => {
    const calls: [string, string][] = [];
    return {
      calls,
      port: { startStewardConversation: (steward: string, body: string) => { calls.push([steward, body]); return reply(); } },
    };
  };

  it('calls the writer with the selected committee member id and the trimmed body, and opens the new thread', async () => {
    const { calls, port } = portReturning(async () => ({ conversationId: 'thread-new', stewardUserId: stewardID, created: true, messageId: 'm-1' }));
    await expect(startSelectedStewardConversation(port, stewardID, '  Can we talk Friday?  ')).resolves.toEqual({ conversationID: 'thread-new', created: true });
    expect(calls).toEqual([[stewardID, 'Can we talk Friday?']]);
  });

  it('reuses the existing bound thread the server returns instead of a second one', async () => {
    const { port } = portReturning(async () => ({ conversationId: 'thread-existing', stewardUserId: stewardID, created: false }));
    await expect(startSelectedStewardConversation(port, stewardID, 'Following up')).resolves.toEqual({ conversationID: 'thread-existing', created: false });
  });

  it('surfaces the server refusal for a committee member outside the caller\'s campaign', async () => {
    // Shaped like the PostgrestError supabase-js hands back for 42501.
    const refusal = Object.assign(new Error('committee member is not in your campaign'), { code: '42501', details: null, hint: null });
    const { port } = portReturning(async () => { throw refusal; });
    await expect(startSelectedStewardConversation(port, stewardID, 'Hello')).rejects.toBe(refusal);
  });

  it('refuses a reply bound to a different committee member or missing its thread', async () => {
    for (const reply of [
      { conversationId: 'thread-other', stewardUserId: '33333333-3333-4333-8333-333333333333', created: false },
      { conversationId: 'thread-unbound', stewardUserId: null, created: true },
      { stewardUserId: stewardID, created: true },
      null,
    ]) {
      const { port } = portReturning(async () => reply);
      await expect(startSelectedStewardConversation(port, stewardID, 'Hello')).rejects.toThrow('The conversation could not be confirmed.');
    }
  });

  it('never calls the writer for an empty or oversized body or a missing committee member', async () => {
    const { calls, port } = portReturning(async () => ({ conversationId: 'x', stewardUserId: stewardID }));
    await expect(startSelectedStewardConversation(port, stewardID, '   ')).rejects.toThrow('between 1 and 4,000');
    await expect(startSelectedStewardConversation(port, stewardID, 'x'.repeat(4_001))).rejects.toThrow('between 1 and 4,000');
    await expect(startSelectedStewardConversation(port, ' ', 'Hello')).rejects.toThrow('Choose a committee member');
    expect(calls).toEqual([]);
  });
});
