import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { PREVIEW_NOW, previewDashboardFor, previewDeskFor, type PreviewDesk } from '../data/preview';
import { MEMBER_WORK_WIDGETS, type HatFunction } from '../lib/hatFunctions';
import { statusLabel } from '../lib/deskCopy';

// Execute the shipped rowsFor helper. Native modules are the render boundary;
// the empty-line contract is pure data and does not need a renderer.
vi.mock('react-native', () => ({
  StyleSheet: { create: (styles: unknown) => styles, hairlineWidth: 1 },
  View: 'View',
  Text: 'Text',
  Pressable: 'Pressable',
}));
vi.mock('expo-router', () => ({ useRouter: () => ({ push: vi.fn() }) }));
vi.mock('@expo/vector-icons', () => ({ Ionicons: () => null }));
vi.mock('../theme/ThemeProvider', () => ({ useTheme: () => ({}) }));
vi.mock('../services/haptics', () => ({ haptics: { select: vi.fn() } }));
vi.mock('./FunctionDeck', () => ({ functionIcons: {} }));
vi.mock('./ui', () => ({ Body: () => null, Avatar: () => null }));

const { LIVE_EMPTY_LINE, rowsFor } = await import('./WorkWidgets');

const LIVE_SOURCES = ['appointments', 'forms', 'workload'] as const;
const DASHBOARD = previewDashboardFor('member');

function widget(key: (typeof LIVE_SOURCES)[number]) {
  const item = MEMBER_WORK_WIDGETS.find((entry) => entry.key === key);
  if (!item) throw new Error(`missing worker work widget ${key}`);
  return item;
}

function emptyPreviewDesk(): PreviewDesk {
  return { ...previewDeskFor('member'), appointments: [], forms: [], workload: [] };
}

// TEST-UG-MOBILE-TRIAGE-SOURCE-ONLY-IOS-AUDIT-G2-G4-FINDINGS-20260914,
// acceptance 2: preview events are upcoming or past on the preview clock. The
// member fixture's August chapter meeting (Aug 30) is upcoming at PREVIEW_NOW
// (Aug 13) and its July meeting is past; a device clock after Aug 30 used to
// turn the widget's next meeting into "Past" while the Events desk still
// offered its check-in.
describe('preview Meetings widget', () => {
  const eventsDesk: HatFunction = { key: 'events-desk', label: 'Meetings desk', href: '/feature/events-desk', icon: 'calendar' };
  afterEach(() => { vi.useRealTimers(); });

  it.each(['2026-08-01T12:00:00Z', '2026-09-25T12:00:00Z', '2031-01-01T12:00:00Z'])(
    'orders and labels preview meetings on PREVIEW_NOW with the device clock at %s',
    (deviceNow) => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date(deviceNow));
      expect(PREVIEW_NOW).toBe('2026-08-13T12:00:00.000Z');
      const desk = previewDeskFor('member');
      const when = (id: string) => desk.events.find((event) => event.id === id)?.when;
      const result = rowsFor(eventsDesk, desk, DASHBOARD);
      expect(result.rows.map((row) => [row.id, row.secondary])).toEqual([
        ['evt-demo', when('evt-demo')],
        ['evt-history-demo', `Past · ${when('evt-history-demo')}`],
        ['history-member-event-2025', `Past · ${when('history-member-event-2025')}`],
      ]);
    },
  );
});

describe('live One-on-ones, Forms, and Workload widgets', () => {
  it.each(LIVE_SOURCES)(
    'directs a live null-desk %s tray to the destination without claiming the collection is empty',
    (source) => {
      const item = widget(source);
      const result = rowsFor(item, null, DASHBOARD);
      expect(result.href).toBe(item.href);
      expect(result.rows).toEqual([]);
      expect(result.empty).toBe(LIVE_EMPTY_LINE[source]);
      expect(result.empty).not.toMatch(/Nothing in/);
      expect(result.empty).toContain(source === 'workload' ? 'Workplace log' : item.label);
    },
  );

  it.each(LIVE_SOURCES)('renders populated preview-desk %s fixture rows without live empty copy', (source) => {
    const item = widget(source);
    const desk = previewDeskFor('member');
    const result = rowsFor(item, desk, DASHBOARD);
    expect(result.empty).toBeUndefined();
    expect(result.empty).not.toBe(LIVE_EMPTY_LINE[source]);
    expect(result.rows.length).toBeGreaterThan(0);

    if (source === 'appointments') {
      expect(result.rows).toEqual(desk.appointments.slice(0, 3).map((entry) => ({
        id: entry.id,
        primary: `${entry.when} · ${entry.withName}`,
        secondary: entry.place,
        tone: 'active',
        initials: entry.withName.split(/\s+/).map((part) => part[0] ?? '').join('').slice(0, 2).toUpperCase() || '?',
      })));
    }
    if (source === 'forms') {
      expect(result.rows).toEqual(desk.forms.slice(0, 3).map((entry) => ({
        id: entry.id,
        primary: entry.title,
        secondary: `${statusLabel(entry.status)} · ${entry.updated}`,
      })));
    }
    if (source === 'workload') {
      expect(result.rows).toEqual(desk.workload.slice(0, 3).map((entry) => ({
        id: entry.id,
        primary: entry.dateLabel,
        secondary: entry.meta,
      })));
    }
  });

  it.each(LIVE_SOURCES)(
    'lets an empty preview-desk %s tray fall back to the generic empty line',
    (source) => {
      const item = widget(source);
      const result = rowsFor(item, emptyPreviewDesk(), DASHBOARD);
      expect(result.rows).toEqual([]);
      expect(result.empty).toBeUndefined();
      expect(result.empty).not.toBe(LIVE_EMPTY_LINE[source]);
    },
  );

  it('keeps the generic tray fallback for preview desks that hold nothing', () => {
    const source = readFileSync(fileURLToPath(new URL('./WorkWidgets.tsx', import.meta.url)), 'utf8');
    expect(source).toContain('{widget.empty ?? `Nothing in ${item.label} yet.`}');
  });

  it('does not let a badge squeeze a widget title to zero width', () => {
    const source = readFileSync(fileURLToPath(new URL('./WorkWidgets.tsx', import.meta.url)), 'utf8');
    const title = source.slice(source.indexOf('title: {'), source.indexOf('},', source.indexOf('title: {')) + 2);
    expect(title).toContain("minWidth: '100%'");
    expect(title).not.toContain('flex: 1');
    const headStart = source.indexOf('accessibilityLabel={widget.badge');
    const head = source.slice(headStart, source.indexOf('</Pressable>', headStart));
    const titleAt = head.indexOf('styles.title');
    const badgeAt = head.indexOf('styles.badge');
    expect(titleAt).toBeGreaterThan(-1);
    expect(badgeAt).toBeGreaterThan(titleAt);
    expect(head).toContain('styles.titleRow');
    expect(head).toContain('textBreakStrategy="simple"');
    expect(source).toContain("emptyCopy: { width: '100%', flexBasis: '100%', flexGrow: 1 }");
    expect(source).toContain('paddingHorizontal: spacing.md');
  });
});
