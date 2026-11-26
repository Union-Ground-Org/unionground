import { stubSessionWriter } from '../apps/mobile/src/testing/stubSessionWriter';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { useState } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mock = vi.hoisted(() => ({
  announce: vi.fn(),
  rpc: {
    loadSnapshot: vi.fn(),
    saveRelationship: vi.fn(),
    saveTopic: vi.fn(),
  },
}));

vi.mock('expo-router', () => ({ useRouter: () => ({ push: vi.fn() }) }));
vi.mock('expo-crypto', () => ({ randomUUID: () => globalThis.crypto.randomUUID() }));

vi.mock('react-native', () => ({
  // Save outcomes are spoken through the shared announcement queue.
  AccessibilityInfo: { announceForAccessibilityWithOptions: mock.announce, announceForAccessibility: mock.announce },
  Platform: { OS: 'ios' },
  Pressable: ({ accessibilityRole, accessibilityState, accessibilityLabel, disabled, onPress, children }) => (
    <button
      type="button"
      role={accessibilityRole}
      aria-label={accessibilityLabel}
      aria-pressed={accessibilityState?.selected}
      disabled={disabled}
      onClick={onPress}
    >{children}</button>
  ),
  Share: { share: vi.fn() },
  StyleSheet: { create: (styles) => styles, hairlineWidth: 1 },
  Text: ({ accessibilityRole, accessibilityLabel, children }) => (
    <span role={accessibilityRole} aria-label={accessibilityLabel}>{children}</span>
  ),
  TextInput: ({ accessibilityLabel, value, onChangeText, multiline }) => (
    <input aria-label={accessibilityLabel} value={value} onChange={(event) => onChangeText(event.target.value)} data-multiline={multiline ? 'true' : undefined} />
  ),
  View: ({ role, accessibilityRole, accessibilityLabel, accessibilityState, children }) => (
    <div role={role ?? accessibilityRole} aria-label={accessibilityLabel} aria-pressed={accessibilityState?.selected}>{children}</div>
  ),
}));

vi.mock('../apps/mobile/src/services/haptics', () => ({ haptics: { select: vi.fn() } }));

vi.mock('../apps/mobile/src/components/PressableScale', () => ({
  PressableScale: ({ accessibilityRole, accessibilityState, accessibilityLabel, onPress, children }) => (
    <button
      type="button"
      role={accessibilityRole}
      aria-label={accessibilityLabel}
      aria-pressed={accessibilityState?.selected}
      onClick={onPress}
    >{children}</button>
  ),
}));

vi.mock('../apps/mobile/src/components/ui', async () => {
  const { OptionPicker } = await import('../apps/mobile/src/components/optionPicker');
  return {
    Body: ({ children, muted }) => <p data-muted={muted ? 'true' : undefined}>{children}</p>,
    Button: ({ label, onPress, disabled, busy }) => <button type="button" disabled={disabled || busy} onClick={onPress}>{label}</button>,
    Card: ({ children }) => <article>{children}</article>,
    Heading: ({ children, level = 1 }) => <h2>{children}</h2>,
    OptionPicker,
    Screen: ({ children }) => <main>{children}</main>,
    StateMessage: ({ title }) => <p role="alert">{title}</p>,
    StatusPill: ({ label }) => <span>{label}</span>,
  };
});

vi.mock('../apps/mobile/src/state/AppProvider', () => ({
  useApp: () => ({
    mode: 'authenticated',
    dashboard: { member: { id: 'staff-1', chapterID: 'chapter-1' } },
    previewHat: null,
    authorizedRoles: ['advisor'],
    chapterMemberships: [{ selected: true, chapterID: 'chapter-1' }],
    organizationID: 'org-1',
    organizationRoles: ['advisor'],
  }),
}));

vi.mock('../apps/mobile/src/theme/ThemeProvider', () => ({
  useTheme: () => ({
    foreground: 'ink',
    mutedForeground: 'muted',
    border: 'line',
    card: 'paper',
    primary: 'blue',
    primaryForeground: 'white',
    secondary: 'wash',
    secondaryForeground: 'navy',
    accent: 'gold',
    accentForeground: 'black',
    destructive: 'red',
    destructiveForeground: 'white',
    muted: 'fog',
  }),
}));

vi.mock('../apps/mobile/src/services/supabase', () => ({ captureSessionWriter: () => stubSessionWriter(() => null),
  loadMobileCollectiveActions: vi.fn(),
  loadMobileOrganizationIntelligenceSnapshot: (...args) => mock.rpc.loadSnapshot(...args),
  requestMobileCollectiveActionExport: vi.fn(),
  saveMobileCollectiveAction: vi.fn(),
  saveMobileOrganizationChartNode: vi.fn(),
  saveMobileOrganizationRelationship: (...args) => mock.rpc.saveRelationship(...args),
  saveMobileOrganizationTimelineEvent: vi.fn(),
  saveMobileOrganizationTopicProgress: (...args) => mock.rpc.saveTopic(...args),
  toggleMobileCollectiveActionParticipation: vi.fn(),
}));

import { OptionPicker } from '../apps/mobile/src/components/optionPicker';
import { OrganizationIntelligenceScreen } from '../apps/mobile/src/features/mi1/OrganizationIntelligenceScreens';

// The server's snapshot states the Neuro Map switch; the screen names the
// Neuro Map only once a read says it is on (#8598).
const snapshot = {
  organizationId: 'org-1',
  generatedAt: '2026-09-21T12:00:00Z',
  neuroMapEnabled: true,
  chartNodes: [],
  relationshipNodes: [
    { id: 'sam', label: 'Sam Okafor', roleLabel: 'Committee' },
    { id: 'maya', label: 'Maya Chen', roleLabel: 'Campaign lead' },
  ],
  relationships: [],
  topicProgress: [],
  timeline: [],
};

async function openNeuroMap() {
  render(<OrganizationIntelligenceScreen />);
  fireEvent.click(await screen.findByRole('button', { name: 'Neuro Map' }));
}

describe('native Organization map relationship write form', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mock.rpc.loadSnapshot.mockResolvedValue(snapshot);
    mock.rpc.saveRelationship.mockResolvedValue(undefined);
    mock.rpc.saveTopic.mockResolvedValue(undefined);
  });

  it('offers both member names as pickers instead of raw member id fields', async () => {
    await openNeuroMap();
    expect(await screen.findByRole('group', { name: 'Source worker' })).toBeInTheDocument();
    expect(screen.getByRole('group', { name: 'Target worker' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Source worker: Sam Okafor, Committee' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Target worker: Maya Chen, Campaign lead' })).toBeInTheDocument();
    expect(screen.queryByText(/member ID/i)).not.toBeInTheDocument();
    expect(screen.queryByRole('textbox', { name: /member id/i })).not.toBeInTheDocument();
    expect(screen.getByRole('textbox', { name: 'Topic label' })).toBeInTheDocument();
  });

  it('keeps the save disabled with fewer than two distinct picks and saves the picked node ids', async () => {
    await openNeuroMap();
    const saveRelationship = screen.getByRole('button', { name: 'Save working relationship' });
    expect(saveRelationship).toBeDisabled();

    fireEvent.click(screen.getByRole('button', { name: 'Source worker: Sam Okafor, Committee' }));
    expect(saveRelationship).toBeDisabled();

    // Picking the same member as target still cannot save: the ids must differ.
    fireEvent.click(screen.getByRole('button', { name: 'Target worker: Sam Okafor, Committee' }));
    expect(saveRelationship).toBeDisabled();

    fireEvent.click(screen.getByRole('button', { name: 'Target worker: Maya Chen, Campaign lead' }));
    expect(saveRelationship).toBeEnabled();
    fireEvent.click(saveRelationship);

    await waitFor(() => expect(mock.rpc.saveRelationship).toHaveBeenCalledTimes(1));
    expect(mock.rpc.saveRelationship).toHaveBeenCalledWith(expect.objectContaining({ client: expect.any(Function) }), 'advisor', {
      p_id: null,
      p_source_user_id: 'sam',
      p_target_user_id: 'maya',
      p_relationship_kind: 'works_with',
      p_strength: 3,
    });
    // A11Y-UG-MOBILE-ORGANIZATION-AND-ACTION-NOTICES-NOT-ANNOUNCED-20260920: the pill's text is spoken too.
    expect(await screen.findByText('Saved.')).toBeInTheDocument();
    await waitFor(() => expect(mock.announce).toHaveBeenCalledWith('Saved.', { queue: true }));
  });

  it('keeps topic progress bound to the picked source member', async () => {
    await openNeuroMap();
    fireEvent.click(screen.getByRole('button', { name: 'Source worker: Sam Okafor, Committee' }));
    fireEvent.change(screen.getByRole('textbox', { name: 'Topic label' }), { target: { value: 'Workplace mapping' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save topic progress' }));
    await waitFor(() => expect(mock.rpc.saveTopic).toHaveBeenCalledTimes(1));
    expect(mock.rpc.saveTopic).toHaveBeenCalledWith(expect.objectContaining({ client: expect.any(Function) }), 'advisor', {
      p_member_user_id: 'sam',
      p_topic_key: 'workplace_mapping',
      p_topic_label: 'Workplace mapping',
      p_progress_state: 'introduced',
      p_progress: 0,
    });
  });

  it('clears a picked member that a snapshot refresh removes and disables the save', async () => {
    mock.rpc.loadSnapshot
      .mockResolvedValueOnce(snapshot)
      .mockResolvedValueOnce({ ...snapshot, relationshipNodes: [snapshot.relationshipNodes[0]] });
    await openNeuroMap();
    fireEvent.click(screen.getByRole('button', { name: 'Source worker: Sam Okafor, Committee' }));
    fireEvent.click(screen.getByRole('button', { name: 'Target worker: Maya Chen, Campaign lead' }));
    const saveRelationship = screen.getByRole('button', { name: 'Save working relationship' });
    expect(saveRelationship).toBeEnabled();

    // A topic save refreshes the snapshot; Maya is no longer an active member.
    fireEvent.change(screen.getByRole('textbox', { name: 'Topic label' }), { target: { value: 'Workplace mapping' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save topic progress' }));
    await waitFor(() => expect(mock.rpc.loadSnapshot).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Target worker: Maya Chen, Campaign lead' })).not.toBeInTheDocument());
    expect(screen.getByRole('button', { name: 'Save working relationship' })).toBeDisabled();
    expect(mock.rpc.saveRelationship).not.toHaveBeenCalled();
  });

  it('disambiguates members who share a full name with role and chapter context', async () => {
    mock.rpc.loadSnapshot.mockResolvedValue({
      ...snapshot,
      chartNodes: [
        { id: 'ch-north-node', chartKind: 'union', nodeKind: 'chapter', chapterId: 'ch-north', label: 'North Shore Campaign', sortOrder: 0 },
        { id: 'ch-south-node', chartKind: 'union', nodeKind: 'chapter', chapterId: 'ch-south', label: 'South Valley Campaign', sortOrder: 1 },
      ],
      relationshipNodes: [
        { id: 'jordan-north', label: 'Jordan Lee', chapterId: 'ch-north', roleLabel: 'Committee' },
        { id: 'jordan-south', label: 'Jordan Lee', chapterId: 'ch-south', roleLabel: 'Organizer' },
      ],
    });
    await openNeuroMap();
    expect(screen.getByRole('button', { name: 'Source worker: Jordan Lee, Committee · North Shore Campaign' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Source worker: Jordan Lee, Organizer · South Valley Campaign' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Source worker: Jordan Lee, Committee · North Shore Campaign' }));
    fireEvent.click(screen.getByRole('button', { name: 'Target worker: Jordan Lee, Organizer · South Valley Campaign' }));
    fireEvent.click(screen.getByRole('button', { name: 'Save working relationship' }));
    await waitFor(() => expect(mock.rpc.saveRelationship).toHaveBeenCalledTimes(1));
    expect(mock.rpc.saveRelationship).toHaveBeenCalledWith(expect.objectContaining({ client: expect.any(Function) }), 'advisor', expect.objectContaining({
      p_source_user_id: 'jordan-north',
      p_target_user_id: 'jordan-south',
    }));
  });

  it('keeps the picker usable with a roster far larger than any scroll surface', async () => {
    const many = Array.from({ length: 200 }, (_, index) => ({ id: `m-${index}`, label: `Worker ${index}`, roleLabel: 'Worker' }));
    mock.rpc.loadSnapshot.mockResolvedValue({ ...snapshot, relationshipNodes: many });
    await openNeuroMap();
    expect(screen.getByRole('textbox', { name: 'Search Source worker' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Source worker: Worker 0, Worker' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Source worker: Worker 199, Worker' })).not.toBeInTheDocument();
    fireEvent.change(screen.getByRole('textbox', { name: 'Search Source worker' }), { target: { value: 'Worker 199' } });
    fireEvent.click(screen.getByRole('button', { name: 'Source worker: Worker 199, Worker' }));
    fireEvent.change(screen.getByRole('textbox', { name: 'Search Source worker' }), { target: { value: '' } });
    expect(screen.getByRole('button', { name: 'Source worker: Worker 199, Worker' })).toHaveAttribute('aria-pressed', 'true');
    fireEvent.click(screen.getByRole('button', { name: 'Target worker: Worker 0, Worker' }));
    expect(screen.getByRole('button', { name: 'Save working relationship' })).toBeEnabled();
  });

  it('disambiguates same-name same-role members in the same chapter', async () => {
    mock.rpc.loadSnapshot.mockResolvedValue({
      ...snapshot,
      chartNodes: [
        { id: 'ch-north-node', chartKind: 'union', nodeKind: 'chapter', chapterId: 'ch-north', label: 'North Shore Campaign', sortOrder: 0 },
      ],
      relationshipNodes: [
        { id: 'jordan-bbb', label: 'Jordan Lee', chapterId: 'ch-north', roleLabel: 'Committee' },
        { id: 'jordan-aaa', label: 'Jordan Lee', chapterId: 'ch-north', roleLabel: 'Committee' },
      ],
    });
    await openNeuroMap();
    expect(screen.getByRole('button', { name: 'Source worker: Jordan Lee, Committee · North Shore Campaign · 2 of 2' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Source worker: Jordan Lee, Committee · North Shore Campaign · 1 of 2' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Source worker: Jordan Lee, Committee · North Shore Campaign · 1 of 2' }));
    fireEvent.click(screen.getByRole('button', { name: 'Target worker: Jordan Lee, Committee · North Shore Campaign · 2 of 2' }));
    fireEvent.click(screen.getByRole('button', { name: 'Save working relationship' }));
    await waitFor(() => expect(mock.rpc.saveRelationship).toHaveBeenCalledTimes(1));
    expect(mock.rpc.saveRelationship).toHaveBeenCalledWith(expect.objectContaining({ client: expect.any(Function) }), 'advisor', expect.objectContaining({
      p_source_user_id: 'jordan-aaa',
      p_target_user_id: 'jordan-bbb',
    }));
  });

  it('shows web-editor guidance instead of the picker when no members are on the map', async () => {
    mock.rpc.loadSnapshot.mockResolvedValue({ ...snapshot, relationshipNodes: [] });
    await openNeuroMap();
    expect(screen.queryByRole('group', { name: 'Source worker' })).not.toBeInTheDocument();
    expect(screen.getByText(/web editor, which is the supported path/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Save working relationship' })).not.toBeInTheDocument();
  });
});

describe('OptionPicker search visibility', () => {
  function Harness({ options }) {
    const [value, setValue] = useState('');
    return <OptionPicker label="Source worker" value={value} options={options} onChange={setValue} />;
  }

  it('clears a leftover query when a snapshot refresh drops the roster under the cap', () => {
    const large = Array.from({ length: 51 }, (_, index) => ({ id: `m-${index}`, label: `Worker ${index}` }));
    const { rerender } = render(<Harness options={large} />);
    fireEvent.change(screen.getByRole('textbox', { name: 'Search Source worker' }), { target: { value: 'zzzz' } });
    expect(screen.queryByRole('button', { name: 'Source worker: Worker 0' })).not.toBeInTheDocument();
    rerender(<Harness options={large.slice(0, 50)} />);
    expect(screen.queryByRole('textbox', { name: 'Search Source worker' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Source worker: Worker 0' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Source worker: Worker 49' })).toBeInTheDocument();
  });
});
