import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

function walkSources(directory: string, found: string[] = []): string[] {
  for (const entry of readdirSync(directory)) {
    if (entry === 'node_modules') continue;
    const full = join(directory, entry);
    if (statSync(full).isDirectory()) walkSources(full, found);
    else if (/\.tsx?$/.test(entry) && !/\.test\.tsx?$/.test(entry)) found.push(full);
  }
  return found;
}

const REPO_ROOT = fileURLToPath(new URL('../../../../', import.meta.url));
const MOBILE_ROOT = fileURLToPath(new URL('../../', import.meta.url));

// TEST-UG-MOBILE-TEXTINPUT-KEYBOARD-AUDIT-COVERAGE-GAP-20260920: files that
// render a TextInput whose keyboard does not follow the selected theme yet.
// Binding them is a separate change; a file that later binds every input must
// leave this table or the audit fails.
const KEYBOARD_THEME_EXCEPTIONS: Readonly<Record<string, string>> = {
  'apps/mobile/app/share-intake.tsx': 'share-intake destination filter does not bind keyboardAppearance',
  'apps/mobile/src/components/Text.tsx': "the app's TextInput forwards the caller's keyboardAppearance; each caller is audited",
  'apps/mobile/src/components/optionPicker.tsx': 'option picker search field does not bind keyboardAppearance',
  'apps/mobile/src/features/LiveLivedInScreens.tsx': 'check-in and chapter-work inputs do not bind keyboardAppearance',
  'apps/mobile/src/features/MemberSupportScreen.tsx': 'member-support forms do not bind keyboardAppearance',
  'apps/mobile/src/features/StewardFinderSheet.tsx': 'committee member finder search does not bind keyboardAppearance',
  'apps/mobile/src/features/mi1/OrganizationIntelligenceScreens.tsx': 'organization-intelligence field does not bind keyboardAppearance',
};

function repoPath(absolute: string): string {
  return relative(REPO_ROOT, absolute).split(sep).join('/');
}

const RN_IMPORT_CLAUSE = /import\s+([^;]*?)\s+from\s+['"]react-native['"]/g;

// Every JSX tag that renders React Native's TextInput in this file: the plain
// import, `TextInput as Alias`, and `* as RN` namespace members. Without this
// an aliased import carries no literal `<TextInput` and escapes the audit.
function textInputTags(source: string): string[] {
  const tags = new Set(['TextInput']);
  for (const match of source.matchAll(RN_IMPORT_CLAUSE)) {
    const clause = match[1] ?? '';
    const namespace = /\*\s+as\s+([A-Za-z_$][\w$]*)/.exec(clause)?.[1];
    if (namespace) tags.add(`${namespace}.TextInput`);
    const named = clause.slice(clause.lastIndexOf('{') + 1, clause.lastIndexOf('}'));
    for (const specifier of named.split(',')) {
      const [imported, local] = specifier.trim().split(/\s+as\s+/);
      if (imported === 'TextInput' && local) tags.add(local);
    }
  }
  return [...tags];
}

function keyboardThemeCounts(source: string): { inputs: number; themed: number } {
  let inputs = 0;
  for (const tag of textInputTags(source)) {
    inputs += source.match(new RegExp(`<${tag.replace('.', '\\.')}[\\s/>]`, 'g'))?.length ?? 0;
  }
  return {
    inputs,
    themed: source.match(/keyboardAppearance=\{theme\.appearance\}/g)?.length ?? 0,
  };
}

function discoverTextInputFiles(): string[] {
  const discovered: string[] = [];
  for (const directory of ['app', 'src']) {
    for (const file of walkSources(join(MOBILE_ROOT, directory))) {
      if (!file.endsWith('.tsx')) continue;
      if (keyboardThemeCounts(readFileSync(file, 'utf8')).inputs > 0) discovered.push(repoPath(file));
    }
  }
  return discovered.sort();
}

describe('sample-only preview chrome', () => {
  it('keeps the unlocked-demo banner off every screen (owner request 2026-08-19)', () => {
    const screen = readFileSync(fileURLToPath(new URL('./ui.tsx', import.meta.url)), 'utf8');
    const home = readFileSync(fileURLToPath(new URL('../../app/(tabs)/home.tsx', import.meta.url)), 'utf8');
    const compass = readFileSync(fileURLToPath(new URL('./CompassPanel.tsx', import.meta.url)), 'utf8');
    expect(screen).not.toContain('<PreviewBanner />');
    expect(home).not.toContain('<PreviewBanner />');
    expect(compass).not.toContain('<PreviewBanner />');
  });

  it('keeps the SAMPLE boundary visible in the persistent preview hat pill', () => {
    const switcher = readFileSync(fileURLToPath(new URL('./HatSwitcher.tsx', import.meta.url)), 'utf8');
    expect(switcher).toContain('PREVIEW · {current.label}');
    expect(switcher).toContain('PREVIEW demo, switch role');
    expect(switcher).toContain('adjustsFontSizeToFit');
    expect(switcher).toContain('maxFontSizeMultiplier={1.4}');
    expect(switcher).toContain('minimumFontScale={0.7}');
    expect(switcher).not.toContain('shimmerStripe');
  });

  it('clears the preview store when a live session is established', () => {
    const provider = readFileSync(fileURLToPath(new URL('../state/AppProvider.tsx', import.meta.url)), 'utf8');
    expect(provider).toContain('setPreviewThreads({})');
    expect(provider).toContain('previewStore.current = {}');
    expect(provider.match(/previewStore\.current = \{\}/g)?.length).toBeGreaterThanOrEqual(2);
    const establish = provider.slice(provider.indexOf('const establishSession'), provider.indexOf('setMode(\'authenticated\')'));
    expect(establish.indexOf('previewStore.current = {}')).toBeGreaterThan(-1);
    expect(establish.indexOf('previewStore.current = {}')).toBeLessThan(establish.indexOf('sessionNeedsMfa'));
  });

  it('does not let a no-backend bootstrap race dismiss an explicit PREVIEW session', () => {
    const provider = readFileSync(fileURLToPath(new URL('../state/AppProvider.tsx', import.meta.url)), 'utf8');
    expect(provider).toContain("import { noBackendMode } from '../lib/noBackendMode'");
    expect(provider).toContain('setMode((current) => noBackendMode(current));');
  });

  it('resets the live channel cache before a replacement user can reuse it', () => {
    const provider = readFileSync(fileURLToPath(new URL('../state/AppProvider.tsx', import.meta.url)), 'utf8');
    const establish = provider.slice(provider.indexOf('const establishSession'), provider.indexOf("setMode('authenticated')"));
    const clearProtectedState = provider.slice(
      provider.indexOf('const clearProtectedState'),
      provider.indexOf('const fetchDashboard'),
    );
    expect(provider).toContain("import { liveChannelStore } from '../data/liveChannels'");
    expect(establish).toContain('clearProtectedState();');
    expect(clearProtectedState).toContain('liveChannelStore.resetForSession()');
  });

  it('resets chapter-scoped channels immediately after a live campaign switch', () => {
    const provider = readFileSync(fileURLToPath(new URL('../state/AppProvider.tsx', import.meta.url)), 'utf8');
    const switchBlock = provider.slice(provider.indexOf('const switchChapter'), provider.indexOf('const setChapterPinned'));
    expect(switchBlock).toContain('await switchMobileChapter(writer, chapterID)');
    expect(switchBlock).toContain('liveChannelStore.resetForSession()');
    expect(switchBlock.indexOf('await switchMobileChapter(writer, chapterID)')).toBeLessThan(switchBlock.indexOf('liveChannelStore.resetForSession()'));
    expect(switchBlock).toContain('setDashboard(null)');
    expect(switchBlock.indexOf('liveChannelStore.resetForSession()')).toBeLessThan(switchBlock.indexOf('await fetchDashboard(session)'));
    expect(switchBlock.indexOf('setDashboard(null)')).toBeLessThan(switchBlock.indexOf('await fetchDashboard(session)'));
    expect(switchBlock).toContain('Campaign changed, but the workspace could not refresh.');
  });

  it('drops a revoked campaign from the rail on refusal and on every rail open', () => {
    const provider = readFileSync(fileURLToPath(new URL('../state/AppProvider.tsx', import.meta.url)), 'utf8');
    const refreshBlock = provider.slice(provider.indexOf('const refreshChapterMemberships'), provider.indexOf('const setChapterPinned'));
    expect(refreshBlock).toContain("if (mode !== 'authenticated' || !session || !doorOpen(session)) return;");
    expect(refreshBlock).toContain('const request = ++membershipRequest.current;');
    expect(refreshBlock).toContain('if (!doorOpen(session) || activeUserID.current !== userID || membershipRequest.current !== request || dashboardRequest.current !== dashboardAt) return;');
    const membershipRead = refreshBlock.indexOf('await withProviderReadDeadline(loadMobileChapterMemberships(');
    expect(membershipRead).toBeGreaterThanOrEqual(0);
    expect(membershipRead).toBeLessThan(refreshBlock.indexOf('membershipRequest.current !== request'));
    expect(refreshBlock).toContain('if (previousSelected !== null && nextSelected !== previousSelected) {');
    expect(refreshBlock).toContain('liveChannelStore.resetForSession();');
    expect(refreshBlock.indexOf('setDashboard(null)')).toBeLessThan(refreshBlock.indexOf('await fetchDashboard(session)'));
    expect(provider).toContain('refreshChapterMemberships(): Promise<void>;');
    const rail = readFileSync(fileURLToPath(new URL('./ChapterRail.tsx', import.meta.url)), 'utf8');
    expect(rail).toContain('refreshChapterMemberships, setChapterPinned, switchChapter } = useApp()');
    // Opening refreshes and their request counts execute against the real
    // rail and provider in state/chapterRailMemberships.test.ts. Pinning the
    // old dependency array here would require the membership read loop.
    // A refused switch re-reads the active-membership list, so the row the
    // server no longer honors leaves the rail immediately.
    expect(rail).toMatch(/\} catch \(nextError\) \{[\s\S]*?refreshChapterMemberships\(\)\.catch\(\(\) => undefined\);\s*setActionError\(nextError instanceof Error/);
    expect(rail).toMatch(/\} catch \{\s*\/\/[^\n]*\n\s*\/\/[^\n]*\n\s*refreshChapterMemberships\(\)\.catch\(\(\) => undefined\);\s*setActionError\('The campaign pin could not be changed/);
  });

  it('uses UUIDs for SAMPLE conversations and keeps preview sign-out recoverable', () => {
    const provider = readFileSync(fileURLToPath(new URL('../state/AppProvider.tsx', import.meta.url)), 'utf8');
    expect(provider).toContain('Crypto.randomUUID()');
    expect(provider).not.toContain('00000000n001');
    expect(provider).toContain('await clearLocalNotificationPreference().catch(() => undefined)');
  });

  it('counts native text inputs imported under an alias or a namespace', () => {
    const aliased = "import { Text, TextInput as NativeInput, View } from 'react-native';\n<NativeInput keyboardAppearance={theme.appearance} />";
    expect(keyboardThemeCounts(aliased)).toEqual({ inputs: 1, themed: 1 });

    const namespaced = "import * as RN from 'react-native';\n<RN.TextInput />";
    expect(keyboardThemeCounts(namespaced)).toEqual({ inputs: 1, themed: 0 });

    // A same-named alias from another package is not a native keyboard.
    const foreign = "import { TextInput as NativeInput } from 'react-native-paper';\n<NativeInput />";
    expect(keyboardThemeCounts(foreign).inputs).toBe(0);

    // The tag boundary keeps `<TextInputMask` out of the native count.
    const lookalike = "import { TextInput } from 'react-native';\n<TextInputMask />";
    expect(keyboardThemeCounts(lookalike).inputs).toBe(0);
  });

  it('matches every text input keyboard to the selected theme', () => {
    // Discovered, not listed: every .tsx under app/ and src/ that renders a
    // TextInput is audited, so a new screen cannot be left out by omission.
    const discovered = discoverTextInputFiles();
    expect(discovered.length).toBeGreaterThanOrEqual(24);
    expect(discovered).toEqual(expect.arrayContaining([
      'apps/mobile/app/channel/[id].tsx',
      'apps/mobile/src/components/ChapterRail.tsx',
      'apps/mobile/src/components/ui.tsx',
      'apps/mobile/src/features/mi1/PayToolsScreen.tsx',
    ]));

    for (const [file, reason] of Object.entries(KEYBOARD_THEME_EXCEPTIONS)) {
      const absolute = join(REPO_ROOT, file);
      expect(existsSync(absolute), `${file}: exception path is missing`).toBe(true);
      const { inputs, themed } = keyboardThemeCounts(readFileSync(absolute, 'utf8'));
      expect(inputs, `${file} has no TextInput to audit`).toBeGreaterThan(0);
      expect(themed, `${file}: remove this stale exception (${reason})`).toBeLessThan(inputs);
    }

    for (const file of discovered) {
      if (Object.hasOwn(KEYBOARD_THEME_EXCEPTIONS, file)) continue;
      const { inputs, themed } = keyboardThemeCounts(readFileSync(join(REPO_ROOT, file), 'utf8'));
      expect(themed, `${file}: every TextInput must match the selected theme`).toBe(inputs);
    }
  });

  // UX-UG-MOBILE-KEYBOARD-APPEARANCE-LITERAL-20260920: Pay tools and member
  // Q&A pinned the iOS keyboard tray to `light`, so a member on a dark theme got
  // a bright keyboard under a dark surface. The per-file audit above only sees
  // the files it names, so this walk fails on any future screen that spells the
  // appearance out instead of reading it from the active theme.
  it('rejects a literal iOS keyboard appearance anywhere under apps/mobile', () => {
    const mobileRoot = fileURLToPath(new URL('../..', import.meta.url));
    const offenders: string[] = [];
    for (const directory of ['src', 'app']) {
      for (const file of walkSources(join(mobileRoot, directory))) {
        const source = readFileSync(file, 'utf8');
        for (const [match] of source.matchAll(/keyboardAppearance=(?!\{theme\.appearance\})\S*/g)) {
          offenders.push(`${file.slice(mobileRoot.length)}: ${match}`);
        }
      }
    }
    expect(offenders, 'keyboardAppearance must read theme.appearance, never a literal').toEqual([]);
  });

  it('keeps the shortcut deck, organizing work widgets, overlay drawers, and one palette for every hat', () => {
    const theme = readFileSync(fileURLToPath(new URL('../theme/ThemeProvider.tsx', import.meta.url)), 'utf8');
    const home = readFileSync(fileURLToPath(new URL('../../app/(tabs)/home.tsx', import.meta.url)), 'utf8');
    const carousel = readFileSync(fileURLToPath(new URL('./HomeCarousel.tsx', import.meta.url)), 'utf8');
    const deck = readFileSync(fileURLToPath(new URL('./FunctionDeck.tsx', import.meta.url)), 'utf8');
    expect(deck).toContain('railCircle');
    expect(deck).toContain('Shortcuts');
    const widgets = readFileSync(fileURLToPath(new URL('./WorkWidgets.tsx', import.meta.url)), 'utf8');
    expect(widgets).toContain('moveVisibleWidgetKey');
    expect(widgets).toContain('widgetSourceFor');
    expect(home).toContain('<HomeCarousel');
    expect(carousel).toContain('workItemsForHat(previewHat)');
    expect(carousel).not.toContain('<CompassPanel');
    expect(carousel).toContain("pointerEvents={activeDrawer === 'features' ? 'auto' : 'none'}");
    expect(carousel).toContain("zIndex: visibleDrawer === 'features' ? 1 : 0");
    expect(carousel).toContain("zIndex: visibleDrawer === 'work' ? 1 : 0");
    // Full-surface pan (Pixel 10a): edge-only arming sat inside Android's
    // system back band, so the drawers arm on any decisively horizontal drag.
    expect(carousel).not.toContain('EDGE_PAN_WIDTH');
    expect(carousel).toContain('Math.abs(gesture.dx) > Math.abs(gesture.dy) * 1.15');
    expect(carousel).toContain('shortcutScope=');
    expect(deck).toContain('`${SHORTCUT_STORE_KEY}.${shortcutScope}`');
    // Union Ground wears one palette on every hat: no hat pins a theme.
    expect(theme).not.toContain("previewHat === 'committee member'");
    expect(theme).toContain('resolveTheme(effectiveTheme)');
    expect(theme).not.toContain('useColorScheme');
    expect(theme).toContain("effectiveThemeKey(selectedTheme, mode === 'preview' ? previewHat : null)");
  });
});
