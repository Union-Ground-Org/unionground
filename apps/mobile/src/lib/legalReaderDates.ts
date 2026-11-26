import { deviceCalendarDay } from './evidenceTimestamp';
import type { LegalDocument } from './legalDocuments';

type ReaderLocale = 'en-US' | 'es-US';

// The published ISO values are shared with the web. Format only the two date
// fields in the reader metadata, leaving versions and policy text as published.
function readerDateLines(text: string, locale: ReaderLocale): string {
  return text.replace(/((?:Content last reviewed|Effective date): )(\d{4}-\d{2}-\d{2})(?=\.)/g,
    (_match, label: string, day: string) => `${label}${deviceCalendarDay(day, locale) ?? day}`);
}

export function legalReaderDocument(document: LegalDocument, locale: ReaderLocale): LegalDocument {
  const { instrument } = document;
  return {
    ...document,
    notice: readerDateLines(document.notice, locale),
    instrument: instrument ? { ...instrument, status: readerDateLines(instrument.status, locale) } : instrument,
  };
}
