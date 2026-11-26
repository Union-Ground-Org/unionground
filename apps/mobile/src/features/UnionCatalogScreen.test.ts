// @vitest-environment jsdom
// REQ-UG-CATALOG-DOCUMENTS-MEMBERS-ONLY-20261110: document links are
// for members. The public catalog screen opens with no account, so a visitor
// sees each document's kind, title and date, a members-only note and a
// Request an invite action; a signed-in member's profile read carries the
// member's session and shows the links.
import { act, createElement, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { readFileSync } from 'node:fs';
import { fileURLToPath, URL as NodeURL } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CatalogProfile } from '../../../../src/features/unionCatalog/catalogSearch.js';
import { unionCatalogCatalogue } from '../../../../src/lib/i18n/unionCatalog.js';
import { REQUEST_INVITATION_URL, UnionCatalogScreen, useUnionCatalogCopy } from './UnionCatalogScreen';

const mocks = vi.hoisted(() => ({
  app: { mode: 'signedOut', session: null as { access_token: string; user: { id: string } } | null, dashboard: null as { member: { language: string } } | null },
  profile: null as unknown,
  openURL: vi.fn(async () => true),
  push: vi.fn(),
  anonymous: { rpc: vi.fn() },
  member: { rpc: vi.fn() },
  profileClientFor: vi.fn(),
  readUnionProfile: vi.fn(),
}));

type HostProps = {
  children?: ReactNode; label?: string; accessibilityLabel?: string; onPress?: () => void; disabled?: boolean; title?: string; body?: string; action?: ReactNode;
  level?: number; numberOfLines?: number; accessibilityElementsHidden?: boolean;
};
vi.mock('react-native', () => ({ Linking: { openURL: mocks.openURL } }));
vi.mock('expo-router', () => ({ useRouter: () => ({ push: mocks.push }) }));
vi.mock('../state/AppProvider', () => ({ useApp: () => mocks.app }));
// This edition publishes no site; the invite cases run against a fictional one.
vi.mock('../lib/publicSite', () => ({ PUBLIC_SITE_ORIGIN: 'https://app.unionground.example' }));
vi.mock('../components/ui', () => {
  const Wrapper = ({ children }: HostProps) => createElement('div', null, children);
  return {
    // Each text reports the line cap components/ui.tsx gives it: a level 1
    // Heading is the two-line page title, a Body wraps unless told otherwise
    // (pinned to ui.tsx in the long-name test below).
    Body: ({ children, numberOfLines, accessibilityElementsHidden }: HostProps) => createElement('p', {
      'data-lines': numberOfLines === undefined ? 'unlimited' : String(numberOfLines),
      'aria-hidden': accessibilityElementsHidden ? 'true' : undefined,
    }, children),
    Heading: ({ children, level = 1 }: HostProps) => createElement('h2', { 'data-lines': level === 1 ? '2' : 'unlimited' }, children),
    Card: Wrapper, Screen: Wrapper, SearchField: () => null,
    StateMessage: ({ title, body, action }: HostProps) => createElement('div', null, title, body, action),
    // Named as components/ui.tsx's Button names itself (pinned in the
    // members-only test below): its accessibilityLabel, else its label.
    Button: ({ label, accessibilityLabel, onPress, disabled }: HostProps) => createElement('button', { onClick: onPress, disabled, 'aria-label': accessibilityLabel ?? label }, label),
  };
});
vi.mock('../services/unionCatalog', () => ({
  getPublicCatalogClient: () => mocks.anonymous,
  getCatalogProfileClient: mocks.profileClientFor,
  readUnionProfile: mocks.readUnionProfile,
  readUnionSearch: vi.fn(),
}));

const KEY = 'olms-900000001';
const profile = (documentLinks: 'members' | 'included', name = 'Example Workers 1'): CatalogProfile => ({
  found: true,
  organization: { key: KEY, name, affiliation: 'EXW', designation: null, localNumber: '1', level: 'local', city: 'Springfield', state: 'MA', website: null, membersLatest: null, membersYear: null, confidence: null, researchedOn: null },
  parents: [], children: [], childrenTotal: 0, subunits: [], seats: [], contacts: [], coverage: null, sources: [],
  documentLinks,
  documents: [
    { key: 'doc-1', kind: 'contract', title: 'Example agreement', asOf: '2026-01-15',
      link: documentLinks === 'included' ? { href: 'https://docs.example.invalid/agreement.pdf', host: 'docs.example.invalid' } : null },
    { key: 'doc-2', kind: 'bylaws', title: null, asOf: null, link: null },
  ],
});

let root: Root;
let container: HTMLDivElement;
const buttons = () => [...container.querySelectorAll('button')].map((button) => button.textContent);
// What a screen reader announces for each button.
const buttonNames = () => [...container.querySelectorAll('button')].map((button) => button.getAttribute('aria-label'));
async function renderScreen() {
  await act(async () => { root.render(createElement(UnionCatalogScreen, { catalogKey: KEY })); });
}

beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  mocks.app = { mode: 'signedOut', session: null, dashboard: null };
  mocks.profileClientFor.mockImplementation((session: unknown) => (session ? mocks.member : mocks.anonymous));
  mocks.readUnionProfile.mockImplementation(async (client: unknown) => profile(client === mocks.member ? 'included' : 'members'));
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});
afterEach(() => { act(() => root.unmount()); container.remove(); vi.clearAllMocks(); });

describe('native catalog parent bodies', () => {
  const parentKey = 'olms-900000010';
  const splitParents: Extract<CatalogProfile, { found: true }>['parents'] = [
    { key: 'test-split-label', parentKey: null, parentName: null, parentLabel: 'Example Council 2 West) Example Council 3 (county choice', certainty: 'split' },
    { key: 'test-split-link', parentKey: 'olms-900000011', parentName: 'Example split body', parentLabel: 'Example split source', certainty: 'split' },
  ];

  it.each([
    {
      language: 'en', heading: 'Part of', filing: 'from a public filing', inferred: 'not confirmed by a filing',
      notice: 'More than one parent body is possible for this organization. This listing does not yet say which.',
    },
    {
      language: 'es', heading: 'Forma parte de', filing: 'según un informe público', inferred: 'sin confirmar en un informe público',
      notice: 'Esta organización puede depender de más de un organismo superior. Este listado todavía no indica cuál.',
    },
  ])('omits two split parents, explains the uncertainty once and keeps the parent link in $language', async ({ language, heading, filing, inferred, notice }) => {
    mocks.app.dashboard = { member: { language } };
    mocks.readUnionProfile.mockResolvedValue({
      ...profile('included'), documents: [],
      parents: [
        { key: 'test-filed-parent', parentKey, parentName: 'Example National Board', parentLabel: null, certainty: 'filed' },
        ...splitParents,
        { key: 'test-inferred-parent', parentKey: null, parentName: null, parentLabel: 'Example State Federation', certainty: 'inferred' },
      ],
    });
    await renderScreen();
    const parentCard = [...container.querySelectorAll('h2')].find((node) => node.textContent === heading)?.parentElement;
    expect(Array.from(parentCard?.children ?? [], (node) => node.textContent)).toEqual([
      heading, `Example National Board · ${filing}`, `Example State Federation · ${inferred}`, notice,
    ]);
    expect(buttonNames()).toEqual([`Example National Board · ${filing}`]);
    await act(async () => { parentCard?.querySelector('button')?.click(); });
    expect(mocks.push).toHaveBeenCalledExactlyOnceWith(`/public/unions/${parentKey}`);
  });

  it('keeps the heading and one notice when all parent bodies are split', async () => {
    mocks.app.dashboard = { member: { language: 'en' } };
    mocks.readUnionProfile.mockResolvedValue({ ...profile('included'), documents: [], parents: splitParents });
    await renderScreen();
    const parentCard = [...container.querySelectorAll('h2')].find((node) => node.textContent === 'Part of')?.parentElement;
    expect(Array.from(parentCard?.children ?? [], (node) => node.textContent)).toEqual([
      'Part of', 'More than one parent body is possible for this organization. This listing does not yet say which.',
    ]);
    expect(buttons()).toHaveLength(0);
  });
});

describe('native catalog related union bodies', () => {
  const children = [
    { key: 'olms-900000021', name: 'Example Central Council', edgeKind: 'affiliate', certainty: 'filed' },
    { key: 'olms-900000022', name: 'Example Regional Board', edgeKind: 'affiliate', certainty: 'confirmed' },
    { key: 'olms-900000023', name: 'Example District Council', edgeKind: 'affiliate', certainty: 'inferred' },
    { key: 'olms-900000024', name: 'Example Branch Board', edgeKind: 'affiliate', certainty: 'split' },
  ];

  const cases: { language: 'en' | 'es'; heading: string }[] = [
    { language: 'en', heading: 'Related union bodies' },
    { language: 'es', heading: 'Organizaciones relacionadas' },
  ];

  it.each(cases)('uses the website certainty labels and retains related profile links in $language', async ({ language, heading }) => {
    mocks.app.dashboard = { member: { language } };
    mocks.readUnionProfile.mockResolvedValue({
      ...profile('included'), documents: [], children, childrenTotal: children.length,
    });
    await renderScreen();

    expect(container.textContent).toContain(`${heading} (4)`);
    const web: Record<'en' | 'es', Record<string, string>> = unionCatalogCatalogue;
    const expected = children.map(({ name, certainty }) => `${name} · ${web[language][`unions.certainty.${certainty}`]}`);
    expect(buttons()).toEqual(expected);
    expect(buttonNames()).toEqual(expected);
    await act(async () => { container.querySelector('button')?.click(); });
    expect(mocks.push).toHaveBeenCalledExactlyOnceWith('/public/unions/olms-900000021');
  });
});

describe('native catalog documents are for workers', () => {
  it('shows a visitor kind, title and date with a members-only note and a request-invitation action', async () => {
    await renderScreen();
    expect(mocks.profileClientFor).toHaveBeenCalledWith(null);
    expect(mocks.readUnionProfile).toHaveBeenCalledWith(mocks.anonymous, KEY);
    expect(container.textContent).toContain('Document links are for Union Ground workers.');
    expect(container.textContent).toContain('Contract · Example agreement · 2026-01-15');
    expect(container.textContent).toContain('Bylaws · Untitled document');
    expect(container.textContent).not.toContain('docs.example.invalid');
    expect(container.textContent).not.toContain('Opens the original public source.');
    expect(buttons()).toEqual(['Request an invite']);
    // #9540 (C-11): the whole accessible name, as the real Button gives it.
    expect(buttonNames()).toEqual(['Request an invite']);
    expect(readFileSync(new NodeURL('../components/ui.tsx', import.meta.url), 'utf8')).toContain('accessibilityLabel={accessibilityLabel ?? label}');
    await act(async () => { container.querySelector('button')?.click(); });
    expect(mocks.openURL).toHaveBeenCalledWith(REQUEST_INVITATION_URL);
    expect(REQUEST_INVITATION_URL).toBe('https://app.unionground.example/request-invite');
  });

  it('says the same in Spanish', async () => {
    mocks.app = { mode: 'signedOut', session: null, dashboard: { member: { language: 'es' } } };
    await renderScreen();
    expect(container.textContent).toContain('Los enlaces a los documentos son para trabajadores de Union Ground.');
    expect(container.textContent).toContain('Contrato · Example agreement · 2026-01-15');
    expect(container.textContent).toContain('Estatutos · Documento sin título');
    expect(buttons()).toEqual(['Pedir una invitación']);
    expect(buttonNames()).toEqual(['Pedir una invitación']);
  });

  it("reads a signed-in worker's profile in the worker's session and shows the links without the note", async () => {
    const session = { access_token: 'member-token', user: { id: 'member-1' } };
    mocks.app = { mode: 'authenticated', session, dashboard: { member: { language: 'en' } } };
    await renderScreen();
    expect(mocks.profileClientFor).toHaveBeenCalledWith(session);
    expect(mocks.readUnionProfile).toHaveBeenCalledWith(mocks.member, KEY);
    expect(container.textContent).not.toContain('Document links are for Union Ground workers.');
    expect(container.textContent).toContain('Opens the original public source.');
    expect(buttons()).toEqual(['Example agreement · docs.example.invalid · 2026-01-15']);
    await act(async () => { container.querySelector('button')?.click(); });
    expect(mocks.openURL).toHaveBeenCalledWith('https://docs.example.invalid/agreement.pdf');
  });

  it('drops a worker answer that arrives after sign-out and re-reads the profile anonymously', async () => {
    let finish: (value: CatalogProfile) => void = () => {};
    mocks.readUnionProfile.mockImplementationOnce(() => new Promise<CatalogProfile>((resolve) => { finish = resolve; }));
    mocks.app = { mode: 'authenticated', session: { access_token: 'member-token', user: { id: 'member-1' } }, dashboard: null };
    await renderScreen();
    expect(mocks.readUnionProfile).toHaveBeenLastCalledWith(mocks.member, KEY);
    mocks.app = { mode: 'signedOut', session: null, dashboard: null };
    await renderScreen();
    await act(async () => { finish(profile('included')); });
    expect(mocks.readUnionProfile).toHaveBeenLastCalledWith(mocks.anonymous, KEY);
    expect(container.textContent).not.toContain('docs.example.invalid');
    expect(container.textContent).toContain('Document links are for Union Ground workers.');
  });

  // REQ-UG-CATALOG-ORGANIZATION-NAMES-OVER-200-CHARACTERS-20261114
  // (#8743, final review r3s1/r4s1): the page title stays at two lines, so a
  // long catalog name is also shown whole as wrapping text, once for a screen
  // reader (the title already carries it).
  it('shows a long catalog name whole as wrapping text under the two-line title', async () => {
    const ui = readFileSync(fileURLToPath(new NodeURL('../components/ui.tsx', import.meta.url)), 'utf8');
    expect(ui).toContain('numberOfLines={level === 1 ? 2 : undefined}');
    expect(ui).toMatch(/export function Body\([^)]*numberOfLines[^)]*\)/);
    let name = 'Sindicato Nacional de Trabajadores de Ejemplo';
    for (let i = 0; name.length < 622; i += 1) name += ` ${['de', 'la', 'Industria', 'Ejemplar', 'y', 'Similares'][i % 6]}`;
    name = name.slice(0, 622);
    mocks.readUnionProfile.mockImplementation(async () => profile('members', name));
    await renderScreen();
    const title = container.querySelector('h2');
    expect(title?.textContent).toBe(name);
    expect(title?.getAttribute('data-lines')).toBe('2');
    const whole = [...container.querySelectorAll('[data-lines="unlimited"]')].filter((node) => node.textContent?.includes(name));
    expect(whole.map((node) => node.textContent)).toEqual([`Full name: ${name}`]);
    expect(whole[0]?.getAttribute('aria-hidden')).toBe('true');
  });

  it('does not reload the profile when only the session token is refreshed', async () => {
    mocks.app = { mode: 'authenticated', session: { access_token: 'first', user: { id: 'member-1' } }, dashboard: null };
    await renderScreen();
    mocks.app = { ...mocks.app, session: { access_token: 'refreshed', user: { id: 'member-1' } } };
    await renderScreen();
    expect(mocks.readUnionProfile).toHaveBeenCalledTimes(1);
  });
});

// UX-UG-NATIVE-FIND-YOUR-UNION-SHORT-TITLE-20261115: the phone's
// directory has the website's title in both languages. The words are typed into
// the native copy (the web catalogue would add to the phone's register budget);
// this pins them to the website's catalogue. The route passes the same title to
// the pinned header as its screen name, so the screen reader heading matches.
describe('the Find your campaign title', () => {
  it('is the affiliation title in English and in Spanish', async () => {
    const titles: string[] = [];
    const Probe = () => { titles.push(useUnionCatalogCopy().title); return null; };
    for (const language of ['en', 'es']) {
      mocks.app = { mode: 'signedOut', session: null, dashboard: { member: { language } } };
      await act(async () => { root.render(createElement(Probe, { key: language })); });
    }
    // This edition names the screen for what a campaign does here: find a union to affiliate with.
    expect([titles[0], titles[titles.length - 1]]).toEqual(['Find a union to affiliate with', 'Buscar un sindicato con el cual afiliarse']);
    // Ledger 365: the directory and a union's profile both name their header with it.
    for (const file of ['../../app/public/unions.tsx', '../../app/public/unions/[key].tsx']) {
      const route = readFileSync(fileURLToPath(new NodeURL(file, import.meta.url)), 'utf8');
      expect(route).toContain('screenName={copy.title}');
    }
  });
});
