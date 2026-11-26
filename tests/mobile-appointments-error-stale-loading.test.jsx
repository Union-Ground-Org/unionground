import { stubSessionWriter } from '../apps/mobile/src/testing/stubSessionWriter';
import { readFileSync } from 'node:fs';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, expect, it, vi } from 'vitest';

const mock = vi.hoisted(() => ({
  loadMobileAppointments: vi.fn(),
  loadMobileSupervisedAppointments: vi.fn(),
  loadMobileAppointmentHistory: vi.fn(),
  prepareCalendar: vi.fn(),
  exportToDeviceCalendar: vi.fn(),
  staffHat: vi.fn(() => null),
  calendarReady: true,
  app: {
    dashboard: { member: { chapterID: 'ch-1' } },
    authorizedRoles: [],
    // A live authenticated session: the calendar offer is gated on these
    // (NATIVE-CALENDAR-EXPORT item 4).
    mode: 'authenticated',
    sampleHat: null,
    liveSampleBackend: false,
    captureAuthenticatedSessionGuard: vi.fn(() => true),
  },
}));

vi.mock('react-native', () => ({
  Pressable: ({ children, onPress, accessibilityLabel }) => {
    const content = typeof children === 'function' ? children({ pressed: false }) : children;
    return <button type="button" aria-label={accessibilityLabel} onClick={onPress}>{content}</button>;
  },
  View: ({ children }) => <div>{children}</div>,
  Text: ({ children }) => <span>{children}</span>,
  StyleSheet: { create: (styles) => styles, hairlineWidth: 1 },
}));
vi.mock('../apps/mobile/src/components/ui', () => ({
  Screen: ({ children }) => <div>{children}</div>,
  Heading: ({ children }) => <h2>{children}</h2>,
  Body: ({ children }) => <p>{children}</p>,
  Card: ({ children }) => <article>{children}</article>,
  Button: ({ label, onPress, disabled }) => <button type="button" disabled={disabled} onClick={onPress}>{label}</button>,
  StateMessage: ({ title, body }) => <section><h3>{title}</h3><p>{body}</p></section>,
  StatusPill: ({ label }) => <span>{label}</span>,
}));
vi.mock('../apps/mobile/src/theme/ThemeProvider', () => ({
  useTheme: () => ({ primary: 'green', destructive: 'red', muted: 'gray', mutedForeground: 'ink', border: 'silver' }),
}));
vi.mock('../apps/mobile/src/state/AppProvider', () => ({ useApp: () => mock.app }));
vi.mock('../apps/mobile/src/lib/hatFunctions', () => ({ explicitLiveStaffHat: (roles) => mock.staffHat(roles) }));
vi.mock('../apps/mobile/src/services/haptics', () => ({ haptics: { success: vi.fn() } }));
vi.mock('../apps/mobile/src/services/nativeCalendarExport', () => ({
  isCalendarExportAvailable: () => mock.calendarReady,
  exportToDeviceCalendar: (...args) => mock.exportToDeviceCalendar(...args),
  calendarExportWasSaved: () => false,
}));
vi.mock('../apps/mobile/src/services/supabase', () => ({ captureSessionWriter: () => stubSessionWriter(() => null),
  loadMobileAppointments: (...args) => mock.loadMobileAppointments(...args),
  loadMobileSupervisedAppointments: (...args) => mock.loadMobileSupervisedAppointments(...args),
  loadMobileAppointmentHistory: (...args) => mock.loadMobileAppointmentHistory(...args),
  prepareAuthorizedAppointmentCalendarExport: (...args) => mock.prepareCalendar(...args),
}));
vi.mock('../apps/mobile/src/theme/tokens', async () => ({
  // The app's Text reads the typography roles (#8928).
  ...await vi.importActual('../apps/mobile/src/theme/tokens'),
  spacing: { xs: 4, sm: 8, md: 12, lg: 16 },
  radii: { pill: 999 },
}));

import { LiveAppointmentsFeature } from '../apps/mobile/src/features/LiveAppointmentsFeature';

beforeEach(() => {
  vi.clearAllMocks();
  mock.staffHat.mockReturnValue(null);
  mock.calendarReady = true;
  mock.app.dashboard = { member: { chapterID: 'ch-1' } };
  mock.app.authorizedRoles = [];
  mock.loadMobileAppointments.mockReset();
  mock.loadMobileSupervisedAppointments.mockReset();
  mock.loadMobileAppointmentHistory.mockReset();
  mock.prepareCalendar.mockReset();
  mock.exportToDeviceCalendar.mockReset();
});

it('renders only the error card after a rejected appointments load', async () => {
  mock.loadMobileAppointments.mockRejectedValue(new Error('denied'));
  render(<LiveAppointmentsFeature />);
  expect(await screen.findByText('One-on-ones could not be refreshed.')).toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Try again' })).toBeInTheDocument();
  expect(screen.queryByText('Loading one-on-ones')).not.toBeInTheDocument();
});

it('Try again clears the error, shows Loading one-on-ones, and starts a fresh request', async () => {
  let finishRetry;
  mock.loadMobileAppointments
    .mockRejectedValueOnce(new Error('denied'))
    .mockImplementationOnce(() => new Promise((resolve) => { finishRetry = resolve; }));
  render(<LiveAppointmentsFeature />);
  await screen.findByText('One-on-ones could not be refreshed.');
  fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
  expect(await screen.findByText('Loading one-on-ones')).toBeInTheDocument();
  expect(screen.queryByText('One-on-ones could not be refreshed.')).not.toBeInTheDocument();
  expect(mock.loadMobileAppointments).toHaveBeenCalledTimes(2);
  await act(async () => { finishRetry([]); });
  expect(await screen.findByText('No one-on-ones')).toBeInTheDocument();
  expect(screen.queryByText('Loading one-on-ones')).not.toBeInTheDocument();
});

it('keeps Loading one-on-ones visible when a calendar export fails during a pending reload', async () => {
  const item = {
    id: 'apt-1',
    appointmentType: 'office_hours',
    status: 'confirmed',
    startsAt: new Date(Date.now() + 86_400_000).toISOString(),
    memberName: 'Ada',
    stewardName: 'Sam',
    reasonCategory: 'discipline',
  };
  let rejectCalendar;
  mock.loadMobileAppointments
    .mockResolvedValueOnce([item])
    .mockImplementationOnce(() => new Promise(() => {}));
  mock.prepareCalendar.mockResolvedValue({ id: item.id });
  mock.exportToDeviceCalendar.mockImplementation(() => new Promise((_, reject) => { rejectCalendar = reject; }));
  const view = render(<LiveAppointmentsFeature />);
  expect(await screen.findByRole('button', { name: 'Add to calendar' })).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'Add to calendar' }));
  mock.app.dashboard = { member: { chapterID: 'ch-2' } };
  view.rerender(<LiveAppointmentsFeature />);
  expect(await screen.findByText('Loading one-on-ones')).toBeInTheDocument();
  await act(async () => { rejectCalendar(new Error('Calendar export authorization changed.')); });
  // #9462: a failed handoff to the phone's calendar is not told as a gone appointment.
  expect(screen.getByText('The one-on-one could not be added to your calendar. Check your connection and try again.')).toBeInTheDocument();
  expect(screen.getByText('Loading one-on-ones')).toBeInTheDocument();
});

it('authenticated FeatureScreen still mounts the live appointments surface', () => {
  const feature = readFileSync('apps/mobile/src/features/FeatureScreen.tsx', 'utf8');
  expect(feature).toContain("import { LiveAppointmentsFeature } from './LiveAppointmentsFeature';");
  expect(feature).toContain("if (featureKey === 'appointments') return <LiveAppointmentsFeature />;");
});
