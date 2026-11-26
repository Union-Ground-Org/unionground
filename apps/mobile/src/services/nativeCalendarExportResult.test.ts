import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it, vi } from 'vitest';

vi.mock('../../modules/native-calendar-export/src/NativeCalendarExportModule', () => ({ default: null }));

import { calendarExportWasSaved } from './nativeCalendarExport';

const mobileRoot = join(import.meta.dirname, '../..');
const livedInScreenSource = readFileSync(join(mobileRoot, 'src/features/LiveLivedInScreens.tsx'), 'utf8');
const appointmentsSource = readFileSync(join(mobileRoot, 'src/features/LiveAppointmentsFeature.tsx'), 'utf8');
const appProviderSource = readFileSync(join(mobileRoot, 'src/state/AppProvider.tsx'), 'utf8');

describe('native calendar export result feedback', () => {
  it('confirms success only when the operating system reports a saved meeting', () => {
    expect(calendarExportWasSaved('saved')).toBe(true);
    expect(calendarExportWasSaved('opened')).toBe(false);
    expect(calendarExportWasSaved('canceled')).toBe(false);
    expect(calendarExportWasSaved('unavailable')).toBe(false);
    for (const source of [livedInScreenSource, appointmentsSource]) {
      expect(source).toContain('if (calendarExportWasSaved(result)) void haptics.success();');
      expect(source).not.toContain("result !== 'canceled'");
    }
  });

  it('rechecks the captured authenticated user and transition immediately before each OS handoff', () => {
    expect(appProviderSource).toContain('const capturedTransition = sessionTransition.current;');
    expect(appProviderSource).toContain('const capturedUserID = activeUserID.current;');
    expect(appProviderSource).toContain('sessionTransition.current === capturedTransition');
    expect(appProviderSource).toContain('activeUserID.current === capturedUserID');

    for (const [source, preparation] of [
      [livedInScreenSource, 'prepareAuthorizedEventCalendarExport(event.id, Date.now())'],
      [appointmentsSource, 'prepareAuthorizedAppointmentCalendarExport(item.id, Date.now())'],
    ] as const) {
      const guardAt = source.indexOf('const sessionStillCurrent = captureAuthenticatedSessionGuard();');
      const preparationAt = source.indexOf(preparation, guardAt);
      const handoffAt = source.indexOf('exportToDeviceCalendar(payload, sessionStillCurrent)', preparationAt);
      expect(guardAt).toBeGreaterThan(-1);
      expect(preparationAt).toBeGreaterThan(guardAt);
      expect(handoffAt).toBeGreaterThan(preparationAt);
    }
  });
});
