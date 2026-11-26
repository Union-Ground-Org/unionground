// @vitest-environment jsdom
import { act, createElement as h, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BUSINESS_SAVED_STALE, type BusinessProof } from '../lib/businessWriteContinuation';
import { nativeUiText } from '../lib/nativeUiCopy';

type ProfileSave = { firstName: string; fullName: string; language: 'en' | 'es' };
const state = vi.hoisted(() => ({ language: 'en' as 'en' | 'es', platform: 'ios', save: vi.fn<(input: ProfileSave) => Promise<BusinessProof>>(), available: true, sameAccount: true, sampleHat: null as string | null }));
vi.mock('react-native', () => ({ Platform: { get OS() { return state.platform; } }, View: ({ children }: { children?: ReactNode }) => h('div', null, children), StyleSheet: { create: (value: unknown) => value } }));
vi.mock('../state/AppProvider', () => ({ useApp: () => ({
  memberLanguage: state.language,
  dashboard: state.available ? { member: { id:'A', firstName: 'Original', fullName: 'Original Name', language: state.language } } : null,
  saveProfile: state.save,
  captureAccountSessionGuard: () => () => state.sameAccount,
  sampleHat: state.sampleHat,
}) }));
vi.mock('./ui', () => {
  const Host = ({ children, testID }: { children?: ReactNode; testID?: string }) => h('div', { 'data-testid': testID }, children);
  return { Card: Host, Body: Host, Heading: Host, Notice: Host,
    Button: ({ label, selected, disabled, onPress, testID }: { label: string; selected: boolean; disabled: boolean; onPress: () => void; testID?: string }) => h('button', { disabled, 'aria-pressed': selected, onClick: onPress, 'data-testid': testID }, label) };
});
import { LanguageSettingsCard } from './LanguageSettingsCard';

let root: Root; let container: HTMLDivElement;
beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  state.language = 'en'; state.available = true; state.sameAccount = true; state.sampleHat = null; state.save.mockReset();
  state.save.mockImplementation(async (input: { language: 'en' | 'es' }) => { state.language = input.language; return 'current'; });
  container = document.createElement('div'); document.body.append(container); root = createRoot(container);
});
afterEach(async () => { await act(async () => root.unmount()); container.remove(); });
const spanish = () => Array.from(container.querySelectorAll('button')).find((button) => button.textContent === 'Español')!;

describe.each(['ios', 'android'])('native language choice on %s', (platform) => {
  // #9776: a demo person is a shared account, so the card does not promise a
  // save to "your member profile" there.
  it.each<'en' | 'es'>(['en', 'es'])('explains the demo language lifetime and the profile save in %s', async (language) => {
    state.platform = platform; state.language = language;
    const t = nativeUiText(language);
    state.sampleHat = 'steward';
    await act(async () => root.render(h(LanguageSettingsCard)));
    expect(container.textContent).toContain(language === 'es'
      ? 'Elija aquí el idioma de la aplicación. En la demostración, su elección se mantiene al cambiar de rol y se restablece al salir de la demostración o cerrar la aplicación.'
      : 'Choose your app language here. In the demo, your choice follows you between roles and resets when you leave the demo or close the app.');
    expect(container.textContent).not.toContain(t('Choose your app language here. It is saved to your worker profile.'));
    state.sampleHat = null;
    await act(async () => root.render(h(LanguageSettingsCard)));
    expect(container.textContent).toContain(t('Choose your app language here. It is saved to your worker profile.'));
  });

  it.each<BusinessProof>(['unavailable','changed'])('reports saved but refresh needed for an accepted %s outcome',async proof=>{
    state.platform=platform;state.save.mockImplementation(async input=>{state.language=input.language;return proof;});
    await act(async()=>root.render(h(LanguageSettingsCard)));await act(async()=>spanish().click());
    expect(container.textContent).toContain(nativeUiText('es')(BUSINESS_SAVED_STALE));
    expect(container.querySelector('[data-testid^="account-language-saved-"]')).toBeNull();
  });
  it('does not report the old account result to its replacement',async()=>{
    state.save.mockImplementation(async()=>{state.sameAccount=false;return 'changed';});
    await act(async()=>root.render(h(LanguageSettingsCard)));await act(async()=>spanish().click());
    expect(container.textContent).not.toContain(BUSINESS_SAVED_STALE);expect(container.querySelector('[data-testid^="account-language-saved-"]')).toBeNull();
  });
  it('keeps stable selectors and confirms each save only after it succeeds', async () => {
    state.platform = platform;
    let finish!: () => void;
    state.save.mockImplementation(async (input: { language: 'en' | 'es' }) => { await new Promise<void>((resolve) => { finish = resolve; }); state.language = input.language; return 'current'; });
    const byId = (id: string) => container.querySelector<HTMLElement>(`[data-testid="${id}"]`);
    await act(async () => root.render(h(LanguageSettingsCard)));
    expect(byId('account-language-es')).toBeTruthy();
    await act(async () => byId('account-language-es')!.click());
    expect(byId('account-language-saved-es')).toBeNull();
    await act(async () => finish());
    expect(byId('account-language-saved-es')?.textContent).toBe('Idioma guardado.');
    await act(async () => byId('account-language-en')!.click());
    expect(byId('account-language-saved-es')).toBeNull();
    expect(byId('account-language-saved-en')).toBeNull();
    await act(async () => finish());
    expect(byId('account-language-saved-en')?.textContent).toBe('Language saved.');
    expect(state.save.mock.calls.map(([input]) => input.language)).toEqual(['es', 'en']);
  });

  it('saves immediately without opening profile editing and reflects the confirmed language', async () => {
    state.platform = platform;
    await act(async () => root.render(h(LanguageSettingsCard)));
    expect(container.textContent).toContain('Language / Idioma');
    await act(async () => spanish().click());
    expect(state.save).toHaveBeenCalledExactlyOnceWith({ firstName: 'Original', fullName: 'Original Name', language: 'es' });
    expect(container.textContent).toContain('Idioma guardado.');
    expect(spanish().getAttribute('aria-pressed')).toBe('true');
  });
  it('keeps the saved language on failure, reports it and permits retry', async () => {
    state.save.mockRejectedValueOnce(new Error('offline'));
    await act(async () => root.render(h(LanguageSettingsCard)));
    await act(async () => spanish().click());
    expect(state.language).toBe('en');
    expect(container.textContent).toContain('Your language could not be saved. Try again.');
    expect(container.querySelector('[data-testid^="account-language-saved-"]')).toBeNull();
    await act(async () => spanish().click());
    expect(state.language).toBe('es');
  });
  it('does not save without an available profile', async () => {
    state.available = false;
    await act(async () => root.render(h(LanguageSettingsCard)));
    expect(spanish().disabled).toBe(true);
    await act(async () => spanish().click());
    expect(state.save).not.toHaveBeenCalled();
  });
  it('refuses duplicate presses and coordinates with a profile-name save', async () => {
    let finish!: () => void;
    const pending = new Promise<void>((resolve) => { finish = resolve; });
    const busy = vi.fn();
    state.save.mockImplementation(async (input: { language: 'en' | 'es' }) => { await pending; state.language = input.language; return 'current'; });
    await act(async () => root.render(h(LanguageSettingsCard, { disabled: true, onBusyChange: busy })));
    await act(async () => spanish().click());
    expect(state.save).not.toHaveBeenCalled();
    await act(async () => root.render(h(LanguageSettingsCard, { onBusyChange: busy })));
    await act(async () => { spanish().click(); spanish().click(); });
    expect(state.save).toHaveBeenCalledTimes(1);
    expect(Array.from(container.querySelectorAll('button')).every((button) => button.disabled)).toBe(true);
    expect(busy).toHaveBeenCalledExactlyOnceWith(true);
    await act(async () => finish());
    expect(busy.mock.calls).toEqual([[true], [false]]);
    expect(spanish().disabled).toBe(false);
  });
});
