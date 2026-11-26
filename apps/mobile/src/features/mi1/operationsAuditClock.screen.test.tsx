// @vitest-environment jsdom
import { act, createElement as h } from 'react';
import { afterEach, expect, it, vi } from 'vitest';
import { render, type Rendered } from '../../testing/reactNativeStandIn';
import { stubSessionWriter } from '../../testing/stubSessionWriter';
import { buildNativeActor } from '../../lib/mi1Shared';
import { OperationsHealthScreen } from './OperationsHealthScreen';

const organizationId = '10000000-0000-4000-8000-000000000001';
const app = { memberLanguage: 'en', mode: 'authenticated', session: { user: { id: 'admin-fixture' } }, organizationID: organizationId };

const fixedNow = '2026-07-04T02:20:00.000Z';
const freshStart = '2026-07-04T02:19:00.000Z';
const freshFinish = '2026-07-04T02:19:30.000Z';
const olderStart = '2026-07-04T01:55:00.000Z';

const additionalJobStates = [
  { jobName: 'appointment-reminders-tick', title: 'One-on-one reminders', lastStatus: 'completed', startedAt: freshStart, finishedAt: freshFinish, en: 'Up to date', es: 'Al día' },
  { jobName: 'workload-reminders-tick', title: 'Workplace log reminders', lastStatus: 'in_progress', startedAt: freshStart, finishedAt: null, en: 'Running', es: 'En ejecución' },
  { jobName: 'ballot-notices-tick', title: 'Vote notices', lastStatus: 'skipped', startedAt: freshStart, finishedAt: freshFinish, en: 'Skipped', es: 'Omitida' },
  { jobName: 'member-messaging-dispatch', title: 'Worker messaging dispatch', lastStatus: 'in_progress', startedAt: olderStart, finishedAt: null, en: 'No recent run', es: 'Sin ejecuciones recientes' },
  { jobName: 'casework-alert-escalation-tick', title: 'Issue alert escalation', lastStatus: 'failed', startedAt: freshStart, finishedAt: freshFinish, acknowledged: true, en: 'Issue acknowledged', es: 'Problema reconocido' },
];

vi.mock('react-native', () => import('../../testing/reactNativeStandIn'));
vi.mock('../../components/ui', () => import('../../testing/uiStandIn'));
vi.mock('../../state/AppProvider', () => ({ useApp: () => app }));
vi.mock('../../services/supabase', () => ({
  captureSessionWriter: () => stubSessionWriter(() => null),
  loadMobileOperationsAudit: async () => [
    { id: 'audit-1', domain: 'privacy', eventType: 'message.react', occurredAt: '2026-07-04 02:15:00.123456+00', reviewStatus: null },
    { id: 'audit-2', domain: 'casework', eventType: 'settings.changed', occurredAt: 'invalid', reviewStatus: null },
  ],
  loadMobileOperationsJobHealth: async () => [
    {
      jobName: 'notifications-dispatch-tick',
      organizationId,
      lastRunId: 'notification-run',
      lastStatus: 'failed',
      lastStartedAt: '2026-07-04T02:16:00.000Z',
      lastFinishedAt: '2026-07-04 02:17:00.123456+00',
      failureCode: 'timeout',
    },
    {
      jobName: 'deadline-notices-tick',
      organizationId,
      lastRunId: 'deadline-run',
      lastStatus: null,
      lastStartedAt: '2026-07-04T02:19:00.000Z',
      lastFinishedAt: null,
    },
    ...additionalJobStates.map((row) => ({
      jobName: row.jobName,
      organizationId,
      lastRunId: `${row.jobName}-run`,
      lastStatus: row.lastStatus,
      lastStartedAt: row.startedAt,
      lastFinishedAt: row.finishedAt,
      acknowledged: row.acknowledged,
      remediation: row.acknowledged ? 'acknowledge' : null,
    })),
  ],
}));
vi.mock('../../services/heldJobScope', () => ({
  loadMobileAdminListedSettingKeys: async () => [],
  loadMobileCompassPlatformOperator: async () => false,
}));

const actor = buildNativeActor({
  userId: 'admin-fixture', organizationId, organizationRoles: ['admin'], authenticated: true, mfaSatisfied: true,
});

let screen: Rendered | null = null;
afterEach(async () => {
  await screen?.unmount();
  screen = null;
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

it.each([
  ['en', 'Jul 3, 2026, 10:15 PM EDT', 'Time unavailable'],
  ['es', '3 jul 2026, 10:15 p. m. EDT', 'Hora no disponible'],
])('shows the organization clock on an Admin audit row in %s', async (language, expected, unavailable) => {
  vi.stubEnv('TZ', 'Asia/Tokyo');
  expect(new Intl.DateTimeFormat().resolvedOptions().timeZone).toBe('Asia/Tokyo');
  app.memberLanguage = language;
  screen = await render(h(OperationsHealthScreen, { actor, live: true }));
  await act(async () => { await Promise.resolve(); });
  expect(screen.container.textContent).toContain(expected);
  expect(screen.container.textContent).toContain(unavailable);
});

const jobDisplayCases = [
  ['en', 'No run recorded', 'Run failed', 'Last run · Jul 3, 2026, 10:17 PM EDT', 'Job status unavailable', 'Started · Jul 3, 2026, 10:19 PM EDT'],
  ['es', 'Sin ejecuciones registradas', 'La ejecución falló', 'Última ejecución · 3 jul 2026, 10:17 p. m. EDT', 'Estado de la tarea no disponible', 'Inicio · 3 jul 2026, 10:19 p. m. EDT'],
] satisfies ['en' | 'es', string, string, string, string, string][];

it.each(jobDisplayCases)('describes recorded and unrecorded Background jobs in %s without scheduler syntax', async (
  language, noRun, failed, finished, unknownStatus, started,
) => {
  vi.spyOn(Date, 'now').mockReturnValue(Date.parse(fixedNow));
  vi.stubEnv('TZ', 'Asia/Tokyo');
  expect(new Intl.DateTimeFormat().resolvedOptions().timeZone).toBe('Asia/Tokyo');
  app.memberLanguage = language;
  screen = await render(h(OperationsHealthScreen, { actor, live: true }));
  await act(async () => { await Promise.resolve(); });
  const headings = [...screen.container.querySelectorAll('[role="heading"]')];
  const job = (title: string) => headings.find((heading) => heading.textContent === title)?.parentElement;

  const unrecorded = job('Scheduled job health sync');
  expect(unrecorded).toBeDefined();
  expect(unrecorded?.textContent).not.toContain('* * * * *');
  expect(unrecorded?.textContent).toBe(`Scheduled job health sync${noRun}`);

  const recorded = job('Notification dispatch');
  expect(recorded?.textContent).toContain(failed);
  expect(recorded?.textContent).toContain(finished);
  expect(recorded?.textContent).not.toContain('1-56/5 * * * *');

  const incomplete = job('Issue deadline notices');
  expect(incomplete?.textContent).toContain(unknownStatus);
  for (const row of additionalJobStates) {
    expect(job(row.title)?.textContent).toContain(row[language]);
  }
  expect(incomplete?.textContent).toContain(started);
});
