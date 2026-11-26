// @vitest-environment jsdom
import { act, createElement as h, type PropsWithChildren } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { OfflineAvailabilityScreen } from './OfflineAvailabilityScreen';
import { storageSize } from '../lib/storageSize';

const app = vi.hoisted(() => ({ language: 'en' as 'en' | 'es' }));
const downloads = vi.hoisted(() => ({ read: vi.fn(), clear: vi.fn(), enable: vi.fn(), download: vi.fn() }));
const announce = vi.hoisted(() => vi.fn((_message: string) => () => {}));
const notes = vi.hoisted(() => ({ read: vi.fn(), save: vi.fn(), remove: vi.fn(), enable: vi.fn() }));
vi.mock('../services/publicLearningDownloads', () => ({ readPublicLearningLibrary: downloads.read,
  clearPublicLearningDownloads: downloads.clear, setPublicLearningEnabled: downloads.enable, downloadPublicLearningGuide: downloads.download }));
vi.mock('../services/offlineAvailability', () => ({ readOfflineAvailability: notes.read,
  setOfflineAvailability: notes.enable, saveOfflineLearningDraft: notes.save, deleteOfflineLearningDraft: notes.remove }));
vi.mock('../state/AppProvider', () => ({ useApp: () => ({ mode: 'authenticated', session: { user: { id: 'member' } },
  dashboard: {}, memberLanguage: app.language, organizationID: 'chapter', locked: false, privacyCovered: false, offlineDraftsReady: true }) }));
vi.mock('../lib/announce', () => ({ useAccessibilityAnnouncementQueue: () => announce }));
vi.mock('../state/useLowData', () => ({ useLowData: () => ({ signals: { connected: true } }) }));
vi.mock('../theme/ThemeProvider', () => ({ useTheme: () => ({}) }));
vi.mock('../components/DisabledStateBoundary', () => ({ DisabledStateBoundary: ({ children }: PropsWithChildren) => h('div', null, children) }));
vi.mock('../components/PinnedHeader', () => ({ PinnedHeaderScreen: ({ title, children }: PropsWithChildren<{ title: string }>) => h('main', null, h('h1', null, title), children) }));
vi.mock('../components/ui', () => {
  const Text = ({ children }: PropsWithChildren) => h('p', null, children);
  return { Body: Text, Card: ({ children }: PropsWithChildren) => h('section', null, children), Heading: Text, Notice: Text, Screen: ({ children }: PropsWithChildren) => h('div', null, children),
    Button: ({ label, disabled, onPress }: { label: string; disabled?: boolean; onPress: () => void }) => h('button', { disabled, onClick: onPress }, label) };
});
vi.mock('react-native', () => ({
  AppState: { addEventListener: () => ({ remove: vi.fn() }) }, StyleSheet: { create: <T,>(styles: T) => styles },
  Platform: { OS: 'ios' },
  View: ({ children, accessibilityLiveRegion }: PropsWithChildren<{ accessibilityLiveRegion?: string }>) => h('div', { 'aria-live': accessibilityLiveRegion }, children), TextInput: ({ value, onChangeText }: { value?: string; onChangeText?: (text: string) => void }) => h('textarea', { value, onChange: (event: { target: { value: string } }) => onChangeText?.(event.target.value) }),
  Switch: ({ accessibilityLabel, value, disabled }: { accessibilityLabel: string; value: boolean; disabled: boolean }) =>
    h('input', { type: 'checkbox', 'aria-label': accessibilityLabel, checked: value, disabled, readOnly: true }),
}));

let root: Root;
let container: HTMLDivElement;
beforeEach(() => {
  app.language = 'en';
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  container = document.createElement('div'); document.body.append(container); root = createRoot(container);
  downloads.read.mockResolvedValue({ enabled: true, downloads: [{ id: 'getting-started', downloadedAt: Date.now(), bytes: 2_100_000 }], bytes: 2_100_000 });
  notes.read.mockResolvedValue({ enabled: false, drafts: [], bytes: 2_400 });
  downloads.clear.mockResolvedValue(undefined);
  downloads.enable.mockResolvedValue({ enabled: false, downloads: [], bytes: 0 });
});
afterEach(async () => { await act(async () => root.unmount()); container.remove(); vi.clearAllMocks(); });

describe('saved guides and notes copy', () => {
  it('renders readable storage totals, individual sizes and the clear-download interaction', async () => {
    await act(async () => root.render(h(OfflineAvailabilityScreen)));
    expect(container.textContent).toContain('Saved guides and notes');
    expect(container.textContent).toContain('1 guide · 2.1 MB stored');
    expect(container.textContent).toContain('Saved just now · 2.1 MB');
    expect(container.textContent).toContain('0 notes · 2.4 KB stored');
    expect(container.textContent).not.toMatch(/Offline availability|\d+ bytes/);
    expect(container.querySelector('[aria-label="Save public guides on this phone"]')).not.toBeNull();
    const click = async (label: string) => act(async () => {
      [...container.querySelectorAll('button')].find((button) => button.textContent === label)!.click();
    });
    await click('Clear downloads');
    expect(container.textContent).toContain('Remove every public guide');
    await click('Remove downloads');
    expect(downloads.clear).toHaveBeenCalledOnce();
    expect(container.textContent).toContain('0 guides · 0 B stored');
  });

  it('renders the saved guide, download controls and offline instructions in Spanish', async () => {
    app.language = 'es';
    downloads.read.mockResolvedValue({ enabled: true, downloads: [
      { id: 'getting-started', downloadedAt: Date.now(), bytes: 785 },
      { id: 'data-and-offline', downloadedAt: Date.now(), bytes: 880 },
    ], bytes: 1665 });
    await act(async () => root.render(h(OfflineAvailabilityScreen)));
    const click = async (label: string) => act(async () => {
      [...container.querySelectorAll('button')].find((button) => button.textContent === label)!.click();
    });
    for (const copy of ['Guías y notas guardadas', 'Descargas de guías públicas', 'Oriéntate en la aplicación',
      'Guardada hace un momento', 'Notas personales de aprendizaje', '¿Qué necesita conexión?']) {
      expect(container.textContent).toContain(copy);
    }
    expect(container.querySelector('[aria-label="Guardar guías públicas en este teléfono"]')).not.toBeNull();
    await click('Leer «Oriéntate en la aplicación»');
    expect(container.textContent).toContain('Inicio reúne el trabajo de tu campaña.');
    expect(container.textContent).not.toMatch(/Saved guides and notes|Public learning downloads|Find your way around|What needs a connection|Home brings your campaign work together/);
    await click('Leer «Usa la aplicación con menos datos»');
    expect(container.textContent).toContain('Las guías guardadas y las notas se gestionan por separado.');
    await click('Borrar descargas');
    expect(container.textContent).toContain('¿Quieres borrar todas las guías públicas y desactivar las descargas en este teléfono?');
  });

  const FULL = 'This phone can hold 4 learning notes. Delete one to write another.';
  const draft = (id: string) => ({ id, body: 'A note', createdAt: Date.now(), revision: 1 });
  const region = () => [...container.querySelectorAll('[aria-live="polite"]')].find((node) => node.textContent === FULL);

  it.each([
    { language: 'en', button: 'Delete note', notice: 'The change may have been applied. Refresh and check your notes.' },
    { language: 'es', button: 'Eliminar nota', notice: 'Es posible que el cambio se haya aplicado. Actualiza la pantalla y revisa tus notas.' },
  ] satisfies { language: typeof app.language; button: string; notice: string }[])('shows a refresh warning in $language after a successful delete', async ({ language, button, notice }) => {
    app.language = language;
    notes.read.mockResolvedValueOnce({ enabled: true, drafts: [draft('saved-note')], bytes: 32 })
      .mockRejectedValueOnce(new Error('Note refresh failed'));
    notes.remove.mockResolvedValueOnce(undefined);
    await act(async () => root.render(h(OfflineAvailabilityScreen)));

    await act(async () => {
      [...container.querySelectorAll('button')].find((element) => element.textContent === button)!.click();
    });

    expect(notes.remove).toHaveBeenCalledOnce();
    expect(notes.read).toHaveBeenCalledTimes(2);
    expect(container.textContent).toContain(notice);
    expect(container.textContent).not.toMatch(/Your text is still here|Tu texto sigue aquí/);
  });

  it('M2-13 (#9460): at the cap on load, the notice is in a polite region and nothing is announced', async () => {
    notes.read.mockResolvedValue({ enabled: true, drafts: ['a', 'b', 'c', 'd'].map(draft), bytes: 400 });
    await act(async () => root.render(h(OfflineAvailabilityScreen)));
    expect(region()).toBeDefined();
    expect(announce).not.toHaveBeenCalled();
  });

  it('M2-13 (#9460): saving the fourth note fills the region and announces the sentence once', async () => {
    notes.read.mockResolvedValueOnce({ enabled: true, drafts: ['a', 'b', 'c'].map(draft), bytes: 300 })
      .mockResolvedValue({ enabled: true, drafts: ['a', 'b', 'c', 'd'].map(draft), bytes: 400 });
    notes.save.mockResolvedValue(undefined);
    await act(async () => root.render(h(OfflineAvailabilityScreen)));
    expect(region()).toBeUndefined();
    const box = container.querySelector('textarea')!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(box, 'A fourth note');
      box.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await act(async () => { [...container.querySelectorAll('button')].find((button) => button.textContent === 'Save note on this phone')!.click(); });
    expect(region()).toBeDefined();
    await act(async () => root.render(h(OfflineAvailabilityScreen)));
    expect(announce).toHaveBeenCalledTimes(1);
    expect(announce).toHaveBeenCalledWith(FULL);
  });

  it.each([[0, '0 B'], [512, '512 B'], [1_000, '1.0 KB'], [2_100_000, '2.1 MB'], [3_000_000_000, '3.0 GB'], [NaN, '0 B']])('formats %s as %s', (bytes, expected) => {
    expect(storageSize(bytes as number)).toBe(expected);
  });

  it('keeps the named internal terms out of member-facing source', () => {
    for (const path of ['../../app/sign-in.tsx', '../components/EmailAuthScreen.tsx',
      '../../app/mfa-challenge.tsx', '../../app/(tabs)/account.tsx', './OfflineAvailabilityScreen.tsx']) {
      const source = readFileSync(new URL(path, import.meta.url), 'utf8');
      expect(source).not.toMatch(/provisioned account|instruments are not operative|Authenticator setup key|authentication level|current RLS checks|E\.164|Offline availability|\} bytes/);
    }
  });
});
