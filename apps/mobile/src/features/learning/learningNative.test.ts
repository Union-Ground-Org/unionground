import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runInNewContext } from 'node:vm';
import { describe, expect, it, vi } from 'vitest';

import { learningContentCopy, type LearningCopy } from '../../lib/learningContentCopy';
import type { LearningIssue, LearningLocale } from '../../lib/learningContentModel';

const root = fileURLToPath(new URL('../../../', import.meta.url));
const read = (path: string) => readFileSync(join(root, path), 'utf8');

const UI_FILES = [
  'src/features/learning/LearningHomeCard.tsx',
  'src/features/learning/LearningLibrarySection.tsx',
  'src/features/learning/LearningContentManager.tsx',
  'src/features/learning/LearningControls.tsx',
  'src/features/learning/LearningItemView.tsx',
];

function between(source: string, start: string, end: string): string {
  const from = source.indexOf(start);
  const to = source.indexOf(end, from + start.length);
  if (from < 0 || to < 0) throw new Error(`missing ${start} … ${end}`);
  return source.slice(from, to);
}

function sample(copy: LearningCopy): Record<string, string> {
  const flat: Record<string, string> = {};
  for (const [key, value] of Object.entries(copy)) {
    if (typeof value === 'string') flat[key] = value;
    else if (typeof value === 'function') {
      const single = key === 'issue' ? { field: 'title', code: 'required' } : key === 'historyAction' ? 'publish' : key.startsWith('selection') ? 2 : 'Showing up';
      flat[key] = String(value.length === 1 ? (value as (arg: unknown) => unknown)(single) : (value as (...args: unknown[]) => unknown)('Showing up', 2, 5));
    }
    else for (const [inner, text] of Object.entries(value as Record<string, string>)) flat[`${key}.${inner}`] = text;
  }
  return flat;
}

describe('native EN/ES learning copy', () => {
  const en = sample(learningContentCopy.en);
  const es = sample(learningContentCopy.es);

  // UX-UG-LEARNING-CONTENT-HISTORY-POLISH-BATCH-20261115.
  it('labels every history action the server writes and never prints a raw action name', () => {
    expect(learningContentCopy.en.historyAction('public_provenance')).toBe('Public source details updated');
    expect(learningContentCopy.es.historyAction('public_provenance')).toBe('Detalles de la fuente pública actualizados');
    for (const action of ['future_action', 'constructor', 'toString', '']) {
      expect(learningContentCopy.en.historyAction(action)).toBe('Changed');
      expect(learningContentCopy.es.historyAction(action)).toBe('Cambiado');
    }
  });

  it('has the same keys in both languages and no empty text', () => {
    expect(Object.keys(es).sort()).toEqual(Object.keys(en).sort());
    for (const text of [...Object.values(en), ...Object.values(es)]) expect(text.trim()).not.toBe('');
  });

  it('speaks Spanish in Spanish: only symbols and numbers are shared', () => {
    const identical = Object.keys(en).filter((key) => en[key] === es[key]).sort();
    // The dash before an attribution, the n/limit counter and a field label
    // followed by its number carry no words of their own.
    expect(identical).toEqual(['attributionLine', 'counter', 'entryLabel']);
    expect(learningContentCopy.es.learnEmptyTitle).toContain('español');
    expect(learningContentCopy.en.learnEmptyTitle).toContain('English');
  });

  it('names every validation outcome the shared model can report, in both languages', () => {
    const codes: LearningIssue['code'][] = ['invalid', 'required', 'too_long', 'too_many', 'empty_entry', 'entry_too_long', 'out_of_range', 'platform_only', 'not_reviewed', 'too_large', 'invalid_date', 'not_allowed', 'not_future', 'not_after_start'];
    const languages: LearningLocale[] = ['en', 'es'];
    for (const language of languages) {
      const messages = codes.map((code) => learningContentCopy[language].issue({ field: 'title', code, limit: 100, index: 0 }));
      expect(messages.every((message) => typeof message === 'string' && message.length > 0)).toBe(true);
    }
  });
});

describe('native learning surfaces', () => {
  it('mounts exactly one Home card on each Home', () => {
    const home = read('app/(tabs)/home.tsx');
    expect(home.match(/<LearningHomeCard\b/g)).toHaveLength(2);
    expect(between(home, 'function PrototypeHome()', 'function AuthenticatedHome()').match(/<LearningHomeCard\b/g)).toHaveLength(1);
    expect(between(home, 'function AuthenticatedHome()', 'function Metric(').match(/<LearningHomeCard\b/g)).toHaveLength(1);
  });

  it('adds the library and manager to both rights screens while keeping their lessons', () => {
    const preview = between(read('src/features/FeatureScreen.tsx'), 'function RightsFeature(', 'function EventsFeature(');
    const live = between(read('src/features/LiveLivedInScreens.tsx'), 'function LiveRightsScreen(', 'function LiveChapterScreen(');
    for (const screen of [preview, live]) {
      expect(screen).toContain('<LearningLibrarySection onManage={() => setManagingLearning(true)} />');
      expect(screen).toContain('return <LearningContentManager onClose={() => setManagingLearning(false)} />;');
    }
    expect(preview).toContain('lessons.map((item, index) => (');
    expect(live).toContain('data.lessons.map((lesson) =>');
  });

  it('reads live content only through the captured-session client, and PREVIEW only through its fictional source', () => {
    const service = read('src/services/learningContent.ts');
    expect(service).toContain('createCapturedSessionRpcClient(session)');
    expect(service).not.toMatch(/getSupabaseClient|service_role|serviceRole/);
    const hook = read('src/features/learning/useLearningContent.ts');
    expect(hook).toMatch(/if \(mode === 'preview'\) \{[\s\S]*createPreviewLearningRpcClient\(/);
    expect(hook).toContain('api: learningApiForSession(session)');
    expect(hook).toContain('captureGuard: captureAuthenticatedSessionGuard');
    for (const file of [...UI_FILES, 'src/features/learning/learningControllers.ts']) {
      expect(read(file)).not.toMatch(/getSupabaseClient|createClient\(|\.rpc\(/);
    }
  });

  it('keeps Next local and explicit: no request and no automatic motion', () => {
    const controllers = read('src/features/learning/learningControllers.ts');
    const next = between(controllers, '    next() {', '    async hide() {');
    expect(next).not.toContain('context.api');
    expect(next).toContain('context.nextStore.write(');
    const card = read('src/features/learning/LearningHomeCard.tsx');
    expect(card).toContain('onPress={() => controller.next()}');
    expect(card).not.toMatch(/\bsetInterval\b|\bsetTimeout\b|\bAnimated\b|\bLayoutAnimation\b|\bautoplay\b/);
  });

  it('gives every control a role, a label and a 48pt target', () => {
    for (const file of UI_FILES) {
      const source = read(file);
      for (const block of source.match(/<Pressable[\s\S]*?>/g) ?? []) {
        expect(block, file).toMatch(/accessibilityRole=/);
        expect(block, file).toMatch(/accessibilityLabel=/);
      }
      for (const block of source.match(/<TextInput[\s\S]*?\/>/g) ?? []) expect(block, file).toMatch(/accessibilityLabel=/);
      for (const block of source.match(/<Switch[\s\S]*?\/>/g) ?? []) expect(block, file).toMatch(/accessibilityLabel=/);
    }
    const controls = read('src/features/learning/LearningControls.tsx');
    for (const style of ['input', 'toggleRow', 'checkRow', 'rowAction', 'link', 'fact']) {
      expect(controls).toMatch(new RegExp(`${style}: \\{[^}]*minHeight: minimumTouchTarget`));
    }
    expect(controls).toMatch(/iconButton: \{ width: minimumTouchTarget, height: minimumTouchTarget/);
  });

  it('colors only through semantic theme tokens', () => {
    for (const file of UI_FILES) {
      const source = read(file);
      expect(source, file).not.toMatch(/#[0-9a-fA-F]{3,8}\b|rgba?\(|hsla?\(/);
      expect(source, file).not.toMatch(/color: '(?:white|black|red|green|blue|gray|grey)'/);
    }
  });

  it('offers no generated drafting', () => {
    for (const file of [...UI_FILES, 'src/services/learningContent.ts']) {
      expect(read(file)).not.toMatch(/askCompass|sendCompassQuestion|CompassPanel|compassHistory|openai|anthropic|\/api\/ai\b/i);
    }
  });
});

describe('Account administration entrance', () => {
  const account = read('app/(tabs)/account.tsx');
  const screen = between(account, 'export default function AccountScreen()', 'function Field(');

  it('shows the entrance only on the server-backed policy answer and opens the manager as an Account level', () => {
    expect(screen).toContain('const learningAdministration = useLearningAdministration();');
    expect(screen).toMatch(/\{learningAdministration\.allowed \? \(\s*<>\s*<Heading level=\{2\}>\{learningCopy\.accountHeading\}<\/Heading>/);
    expect(screen).toContain('<LearningContentManager origin="account" bottomInset={bottomInset} onClose={() => setManagingLearning(false)} />');
    expect(screen).toContain('if (!learningAdministration.allowed) setManagingLearning(false);');
    // Every hook runs before the Account-level early return.
    const early = screen.indexOf('if (managingLearning && learningAdministration.allowed)');
    expect(early).toBeGreaterThan(0);
    expect(screen.slice(early)).not.toMatch(/\buse[A-Z][A-Za-z]*\(/);
  });

  it('gives the entrance a labelled 48pt button', () => {
    const row = between(screen, '<SettingRow icon="library-outline"', '</SettingRow>');
    expect(row).toContain('accessibilityRole="button"');
    expect(row).toContain('accessibilityLabel={learningCopy.accountEntryLabel}');
    expect(row).toContain('styles.smallButton');
    expect(account).toMatch(/smallButton: \{ minHeight: minimumTouchTarget/);
  });

  it('spends exactly one policy-only read on the entrance', () => {
    const hook = between(read('src/features/learning/useLearningContent.ts'), 'export function useLearningAdministration()', 'export function manageableLearningScopes(');
    expect(hook).toContain('readLearningAdministration(scope)');
    expect(hook).toContain('scope.captureGuard()');
    const reader = read('src/features/learning/learningControllers.ts').slice(read('src/features/learning/learningControllers.ts').indexOf('export async function readLearningAdministration('));
    expect(reader).toContain('scope.api.getPolicy(scope.chapterId)');
    expect(reader).not.toMatch(/listContent|listChoices|getWorkspace|getHistory/);
    expect(hook).not.toMatch(/listContent|listChoices|getWorkspace|getHistory/);
  });

  it('labels Back for Account', () => {
    const manager = read('src/features/learning/LearningContentManager.tsx');
    expect(manager).toContain("const backLabel = origin === 'account' ? copy.backToAccount : copy.backToLearn;");
    expect(manager).not.toContain('copy.backToLearn} onPress');
  });

  it.each(['account', 'learn'])('blocks the stack swipe from %s until the manager closes', (origin) => {
    const manager = read('src/features/learning/LearningContentManager.tsx');
    const effect = between(manager.slice(manager.indexOf('const backLabel =')), 'useEffect(() => {', '\n\n  if (!scope)');
    const setOptions = vi.fn();
    let cleanup: (() => void) | undefined;
    runInNewContext(effect, {
      origin,
      navigation: { setOptions },
      useEffect: (setup: () => (() => void) | undefined) => { cleanup = setup(); },
    });

    expect(setOptions.mock.calls).toEqual([[{ gestureEnabled: false }]]);
    expect(cleanup).toBeTypeOf('function');
    cleanup?.();
    expect(setOptions.mock.calls).toEqual([[{ gestureEnabled: false }], [{ gestureEnabled: true }]]);
  });
});
