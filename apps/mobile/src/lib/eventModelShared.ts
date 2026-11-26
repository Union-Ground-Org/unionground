import { eventTypeText as sharedTypeText } from '../../../../src/lib/i18n/eventTypes.js';
import { compareEventSchedule as sharedCompare } from '../../../../src/lib/eventModel.js';
import type { LivedInEvent } from '../services/livedIn';

export function eventTypeText(lang: string, kind: string): string {
  return String(sharedTypeText(lang, kind));
}
// The web member view's EN/ES copy for an event staff closed to RSVPs
// (mevents.rsvpClosed in src/lib/i18n/eventCheckIn.js), copied rather than
// imported so the native bundle stays inside its catalogue byte budget
// (tests/mi1-member-qa-mobile-wiring.test.js); a test keeps the two equal.
const RSVP_CLOSED_TEXT: Readonly<Record<'en' | 'es', string>> = { en: 'Not collecting RSVPs', es: 'No se reciben confirmaciones' };
export function eventRsvpClosedText(lang: string): string {
  return lang === 'es' ? RSVP_CLOSED_TEXT.es : RSVP_CLOSED_TEXT.en;
}
export function compareEventSchedule(a: LivedInEvent, b: LivedInEvent): number {
  return Number(sharedCompare(a, b));
}
