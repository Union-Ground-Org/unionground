import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const feature = readFileSync(new URL('./LiveAppointmentsFeature.tsx', import.meta.url), 'utf8');
const screen = readFileSync(new URL('./FeatureScreen.tsx', import.meta.url), 'utf8');
const service = readFileSync(new URL('../services/supabase.ts', import.meta.url), 'utf8');

describe('native appointment-history reader', () => {
  it('uses the chapter-scoped supervisor report only for authorized supervising roles', () => {
    expect(feature).toContain('const activeRole = explicitLiveStaffHat(authorizedRoles);');
    expect(feature).toContain("const canSupervise = activeRole !== null && ['coordinator', 'advisor', 'admin'].includes(activeRole);");
    expect(feature).toContain('canSupervise ? loadMobileSupervisedAppointments() : loadMobileAppointments()');
    expect(feature).not.toMatch(/\['steward'[^\]]*'coordinator'[^\]]*'advisor'[^\]]*'admin'\]\.includes\(role\)/);
  });

  it('maps the bounded campaign report without exposing private one-on-one reasons', () => {
    expect(service).toContain('export async function loadMobileSupervisedAppointments()');
    expect(service).toContain("supabase.rpc('list_chapter_appointments'");
    expect(service).toContain('memberName: row.member_name');
    expect(service).toContain('stewardName: row.steward_name');
    const implementation = service.slice(
      service.indexOf('export async function loadMobileSupervisedAppointments()'),
      service.indexOf('export async function loadMobileAppointmentHistory'),
    );
    expect(implementation).not.toMatch(/reason_category|calendarreason|busyreason|\bplace\b|email|phone/);
  });

  it('separates upcoming from past or closed records and labels every lifecycle state', () => {
    expect(feature).toContain('<Heading level={2}>Upcoming</Heading>');
    expect(feature).toContain('<Heading level={2}>Past &amp; closed</Heading>');
    expect(feature).toContain('appointmentStatusState(item.status)');
    expect(feature).toContain('appointmentEventState(item.action)');
    expect(feature).toContain('<StatusPill label={item.status.replaceAll');
    expect(feature).toContain('<StatusPill label={item.action.replaceAll');
    expect(feature).toContain('Latest meeting first');
  });
});

describe('one-on-one card structure', () => {
  const card = feature.slice(
    feature.indexOf('function appointmentCards(items: MobileAppointment[])'),
    feature.indexOf('<Heading>Appointments</Heading>'),
  );
  const historyControl = card.slice(card.indexOf('<Pressable'), card.indexOf('</Pressable>'));
  const calendarControl = card.slice(card.indexOf('</Pressable>'), card.indexOf('</Card>'));

  it('keeps Add to calendar outside the history button so a screen reader focuses it on its own', () => {
    expect(historyControl).not.toContain('Add to calendar');
    expect(historyControl).not.toContain('addToCalendar');
    expect(calendarControl).toContain('<Button label="Add to calendar"');
  });

  it('makes the card the outer element with the history control nested inside it', () => {
    expect(card).toContain('<Card key={item.id}>');
    expect(card.indexOf('<Card key={item.id}>')).toBeLessThan(card.indexOf('<Pressable'));
    expect(card.indexOf('</Pressable>')).toBeLessThan(card.indexOf('</Card>'));
  });

  it('keeps the one-on-one summary an operable button that opens the matching history', () => {
    expect(historyControl).toContain('accessibilityRole="button"');
    expect(historyControl).toContain('onPress={() => { void openHistory(item.id); }}');
    expect(historyControl).toContain('opacity: pressed ? 0.82 : 1');
  });

  it('exposes date, time and status through the history button name instead of a verb-only label (iPhone window 9 finding)', () => {
    // A labelled button hides its children from the iOS accessibility tree, so the
    // pill, eyebrow and heading inside it were unreachable; the name must carry them.
    expect(feature).toContain("from '../lib/appointmentCardAccessibility'");
    expect(historyControl).toContain('accessibilityLabel={appointmentCardAccessibilityLabel(item, canSupervise, scheduleLabel)}');
    expect(historyControl).toContain('accessibilityHint={APPOINTMENT_CARD_ACCESSIBILITY_HINT}');
    expect(historyControl).not.toContain('history`}');
    // The spoken appointment range is the painted one: a single formatted value feeds both.
    expect(card).toContain("const scheduleLabel = appointmentRangeLabel(item.startsAt, item.endsAt, locale) ?? t('Time unavailable');");
    expect(historyControl).toContain('<Heading level={3}>{scheduleLabel}</Heading>');
    expect(historyControl).toContain('<Body muted>{appointmentCardDetailLine(item, canSupervise)} · View history</Body>');
    // The card is still one 48 pt+ target: no second Pressable was introduced.
    expect(card.split('<Pressable').length - 1).toBe(1);
  });

  it('keeps the calendar control on the same export handler, visibility rule and busy state', () => {
    expect(calendarControl).toContain('offersAppointmentCalendarExport(calendarOffer, item, Date.now())');
    expect(calendarControl).toContain('disabled={calendarBusy}');
    expect(calendarControl).toContain('onPress={() => { void addToCalendar(item); }}');
  });
});

describe('rejected-appointments-load state', () => {
  it('does not show Loading one-on-ones beside a load error', () => {
    expect(feature).not.toContain('appointments === null ? <StateMessage title="Loading one-on-ones"');
    expect(feature).toContain('appointments === null && !loadFailed ? <StateMessage title="Loading one-on-ones"');
  });

  it('marks a dedicated load failure in the one-on-ones effect catch and resets it before each request', () => {
    const effect = feature.slice(
      feature.indexOf('await (canSupervise ? loadMobileSupervisedAppointments() : loadMobileAppointments())'),
      feature.indexOf('async function openHistory'),
    );
    expect(effect).toContain('setLoadFailed(true)');
    expect(effect).toContain("setError('One-on-ones could not be refreshed.')");

    const effectReset = feature.slice(
      feature.lastIndexOf('const refreshAppointments = useCallback(async () => {', feature.indexOf('await (canSupervise ? loadMobileSupervisedAppointments() : loadMobileAppointments())')),
      feature.indexOf('await (canSupervise ? loadMobileSupervisedAppointments() : loadMobileAppointments())'),
    );
    expect(effectReset).toContain('setAppointments(null)');
    expect(effectReset).toContain('setError(null)');
    expect(effectReset).toContain('setLoadFailed(false)');
  });

  it('keeps Try again wired to a fresh one-on-ones request', () => {
    expect(feature).toContain('<Button label="Try again" onPress={() => setReload((value) => value + 1)} />');
  });

  it('keeps the authenticated FeatureScreen mount on the extracted live surface', () => {
    expect(screen).toContain("import { LiveAppointmentsFeature } from './LiveAppointmentsFeature';");
    expect(screen).toContain("if (featureKey === 'appointments') return <LiveAppointmentsFeature />;");
  });
});
