import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import { activityCopy, activityLanguage, type ActivityFilter } from './activityCopy';

const FILTERS: ActivityFilter[] = ['all', 'cases', 'messages', 'votes'];
const screen = readFileSync(fileURLToPath(new URL('../../app/notifications.tsx', import.meta.url)), 'utf8');

function strings(language: 'en' | 'es'): string[] {
  const copy = activityCopy[language];
  return Object.values(copy).flatMap((value) => {
    if (typeof value === 'string') return [value];
    if (typeof value === 'function') return FILTERS.map((filter) => (value as (a: string, b: string) => string)(filter, 'Body'));
    return Object.values(value as Record<string, string>);
  });
}

describe('Activity speaks the worker language', () => {
  it('follows worker.language, and the device locale only when there is no saved choice', () => {
    expect(activityCopy[activityLanguage('es', 'en-US')].title).toBe('Actividad');
    expect(activityCopy[activityLanguage('en', 'es-MX')].title).toBe('Activity');
    expect(activityLanguage(undefined, 'es-US')).toBe('es');
    expect(activityLanguage(null, 'en-GB')).toBe('en');
  });

  it('has the same keys in English and Spanish, and Spanish never falls back to the English words', () => {
    expect(Object.keys(activityCopy.es).sort()).toEqual(Object.keys(activityCopy.en).sort());
    expect(Object.keys(activityCopy.es.filters)).toEqual(FILTERS);
    const en = strings('en');
    const es = strings('es');
    for (const [index, value] of es.entries()) {
      if (value.includes('Union Ground')) continue;
      expect(value, `es copy ${index}`).not.toBe(en[index]);
    }
    for (const filter of FILTERS) {
      expect(activityCopy.es.showFilter(filter)).not.toMatch(/Show|updates/);
      expect(activityCopy.es.noFilterUpdates(filter)).toMatch(/^No hay novedades/);
    }
  });

  it('addresses the member as tú, not usted', () => {
    for (const value of strings('es')) {
      expect(value).not.toMatch(/\b(usted|su sesión|su acceso|pruebe|actualice)\b/iu);
    }
    expect(activityCopy.es.subtitle).toBe('Las novedades más recientes para ti y tu campaña.');
  });

  it('renders every visible Activity string and date through the copy and the worker locale', () => {
    expect(screen).toContain('<PinnedHeaderScreen screenName={copy.title} language={language}>');
    expect(screen).toContain("useScreenNameAlreadySpoken(copy.title)");
    expect(screen).toContain('new Intl.DateTimeFormat(localeFor(language),');
    expect(screen).not.toContain('Intl.DateTimeFormat(undefined');
    for (const english of [
      '>Activity<', 'Only updates authorized', 'Updates are loading', 'could not be changed', 'right now.',
      'all caught up', '>New<', '>Earlier<', "'Mark read'", "'Mark unread'", "'Saving…'", 'never trusts its preview',
      'accessibilityLabel="Unread"', '`Show ${', '`Open update:', '`Mark ${',
    ]) {
      expect(screen, english).not.toContain(english);
    }
  });
});

// PRES-P5 (Nov 6, 2026): the iOS demo signs in as fictional SAMPLE accounts,
// so a first-time viewer reads the Activity band and its footer; neither may
// speak in access-control terms.
describe('Activity reads like a product to a first-time viewer', () => {
  it('keeps access-control jargon out of the English subtitle and footer', () => {
    for (const text of [activityCopy.en.subtitle, activityCopy.en.pushNote]) {
      expect(text).not.toMatch(/row-level|authoriz|allowed to see|protected destination|trusts its preview/i);
    }
  });

  it('keeps the same jargon out of the Account rows a viewer reads', () => {
    const account = readFileSync(fileURLToPath(new URL('../../app/(tabs)/account.tsx', import.meta.url)), 'utf8');
    for (const phrase of ['authorized worker profile', 'SMS is unset', 'local test banner', 'kill switch']) {
      expect(account, phrase).not.toContain(phrase);
    }
  });
});
