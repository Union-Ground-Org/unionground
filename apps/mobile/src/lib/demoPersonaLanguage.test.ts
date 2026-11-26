import { afterEach, describe, expect, it } from 'vitest';
import { chooseDemoVisitorLanguage, demoVisitorLanguage, resetDemoVisitorLanguage, shownDemoMember } from './demoPersonaLanguage';

// #9776: a shared demo person speaks the visitor's language, the phone's own
// until the visitor chooses one in the demo; an account of its own keeps its saved one.
afterEach(() => resetDemoVisitorLanguage());

describe('demo visitor language', () => {
  it('starts from the phone and keeps the visitor\'s choice until reset', () => {
    expect(demoVisitorLanguage(() => 'es')).toBe('es');
    expect(demoVisitorLanguage(() => 'en')).toBe('en');
    chooseDemoVisitorLanguage('es');
    expect(demoVisitorLanguage(() => 'en')).toBe('es');
    resetDemoVisitorLanguage();
    expect(demoVisitorLanguage(() => 'en')).toBe('en');
  });

  it('shows a shared demo person in the visitor\'s language and leaves other accounts alone', () => {
    const steward: { id: string; language: 'en' | 'es' } = { id: 'steward', language: 'es' };
    expect(shownDemoMember(true, steward, () => 'en')).toEqual({ id: 'steward', language: 'en' });
    expect(steward.language).toBe('es');
    expect(shownDemoMember(false, steward, () => 'en')).toBe(steward);
    expect(shownDemoMember(true, steward, () => 'es')).toBe(steward);
    chooseDemoVisitorLanguage('en');
    expect(shownDemoMember(true, steward, () => 'es').language).toBe('en');
  });
});
