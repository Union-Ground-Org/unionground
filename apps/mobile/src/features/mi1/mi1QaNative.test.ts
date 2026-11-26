import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { canOpenFeature, FEATURE_KEYS, isStaffOnlyFeatureKey } from '../../lib/featureCatalog';
import {
  buildNativeQaActor,
  createQaRpcAdapter,
  memberQaPreviewState,
  MI1_QA_NATIVE_PERSISTENCE,
  nativeOrganizationId,
  qaText,
  requireActiveQaMember,
  toQaActor,
} from '../../lib/mi1QaShared';
import { routeFromNotification } from '../../lib/routes';
import { createRequestGeneration } from '../../lib/requestGeneration';

function source(relativeFromThisFile: string): string {
  return readFileSync(fileURLToPath(new URL(relativeFromThisFile, import.meta.url)), 'utf8');
}

describe('CR-018 native Q&A wiring', () => {
  const languages: Array<'en' | 'es'> = ['en', 'es'];
  it.each(languages)('confirms submitted questions and replies in %s', async (language) => {
    const screen = source('./MemberQaScreen.tsx');
    const handlers = screen.slice(screen.indexOf('  async function postQuestion()'), screen.indexOf('  if (!live) {'));
    const notices: string[] = [];
    // Execute the actual submit handlers, replacing only their external effects.
    const run = new Function('qaText', 'language', 'mutate', 'qa', 'idempotencyKey', 'idempotencyKeys',
      'setTitle', 'setBody', 'setReply', 'canOfficialReplyOnQa', 'requests',
      `const title = 'Question title', body = 'Question details', reply = 'Reply details';
       const selected = { id: 'question-1' }, qaActor = {}, actor = { userId: 'member-a' }, confirmedOwner = { workspace: 'scope-a' };
       ${handlers}
       return (async () => { await postQuestion(); await postReply(); })();`);
    const expected = language === 'es'
      ? ['Pregunta publicada.', 'Respuesta publicada.']
      : ['Question posted.', 'Reply posted.'];
    for (const official of [true, false]) {
      notices.length = 0;
      const calls: string[] = [];
      await run(qaText, language, async (action: () => Promise<unknown>, notice: string) => {
        await action(); notices.push(notice); return 'current';
      }, {
        ask: async () => { calls.push('ask'); },
        officialReply: async () => { calls.push('official'); },
        followUp: async () => { calls.push('follow-up'); },
      }, () => 'fixture-key', { current: new Map() }, () => {}, () => {}, () => {}, () => official, createRequestGeneration());
      expect(notices).toEqual(expected);
      expect(calls).toEqual(['ask', official ? 'official' : 'follow-up']);
    }
  });

  it('registers the worker Q&A destination without staff-only gating', () => {
    expect(FEATURE_KEYS).toContain('qa');
    expect(canOpenFeature('preview', 'qa', 'member')).toBe(true);
    expect(canOpenFeature('authenticated', 'qa', null)).toBe(true);
    expect(isStaffOnlyFeatureKey('qa')).toBe(false);
    expect(routeFromNotification({ screen: 'qa' })).toEqual({ kind: 'feature', key: 'qa' });
  });

  it('derives Q&A scope from the selected membership and keeps missing scope closed', async () => {
    expect(nativeOrganizationId()).toBeNull();
    expect(nativeOrganizationId('org-a')).toBe('org-a');
    expect(MI1_QA_NATIVE_PERSISTENCE).toEqual({ qaRpc: true });
    const scoped = buildNativeQaActor({
      userId: 'member-1',
      organizationId: 'org-a',
      chapterId: 'wor',
      roles: ['steward'],
      selectedHat: 'steward',
      authenticated: true,
      mfaSatisfied: true,
    });
    expect(scoped.organizationId).toBe('org-a');
    expect(requireActiveQaMember(toQaActor(scoped)).ok).toBe(true);
    const empty = buildNativeQaActor({ userId: 'member-1', chapterId: 'wor', authenticated: true, mfaSatisfied: true });
    expect(requireActiveQaMember(toQaActor(empty)).ok).toBe(false);
    const qa = createQaRpcAdapter({ rpc: async () => ({ data: [], error: null }) });
    const result = await qa.list({});
    expect(result).toEqual({ ok: true, value: [] });
  });

  // UX-UG-MOBILE-KEYBOARD-APPEARANCE-LITERAL-20260920: the reply field
  // pinned the iOS keyboard tray to light, and search, title and body left the
  // tray to chance. All four now follow the active theme.
  it('asks iOS for the themed keyboard on every Q&A field', () => {
    const qa = source('./MemberQaScreen.tsx');
    const inputs = qa.match(/<TextInput/g)?.length ?? 0;
    const themed = qa.match(/keyboardAppearance=\{theme\.appearance\}/g)?.length ?? 0;

    expect(inputs).toBeGreaterThan(0);
    expect(themed, 'every Q&A TextInput sets keyboardAppearance from the theme').toBe(inputs);
    expect(qa).not.toMatch(/keyboardAppearance="/);
  });

  it('reuses the shared QA engine without mounting web JSX or other domains', () => {
    const shared = source('../../lib/mi1QaShared.ts');
    const qa = source('./MemberQaScreen.tsx');
    const feature = source('../FeatureScreen.tsx');
    expect(shared).toContain("from '../../../../src/features/qa/copy.js'");
    expect(shared).not.toContain('MemberQaForum');
    expect(shared).not.toContain('features/pay');
    expect(shared).not.toContain('features/analytics');
    expect(shared).not.toContain('features/integrations');
    expect(shared).not.toContain('features/operations');
    expect(qa).toContain('bindBusinessApi(client, writer, createQaRpcAdapter');
    expect(qa).toContain('getSupabaseClient()');
    expect(feature).toContain("featureKey === 'qa'");
    expect(feature).toContain('<Mi1QaFeatureScreen />');
  });

  it('keeps preview Q&A off the live RPC and does not promise sign-in', () => {
    const feature = source('./Mi1QaFeatureScreen.tsx');
    const qa = source('./MemberQaScreen.tsx');
    const previewReturn = [
      '  if (!live) {',
      '    const preview = memberQaPreviewState(language);',
      '    return (',
      '      <Screen>',
      "        <Heading>{qaText(language, 'title')}</Heading>",
      '        <StateMessage title={preview.title} body={preview.body} />',
      '      </Screen>',
      '    );',
      '  }',
    ].join('\n');
    expect(feature).toContain("live={mode === 'authenticated'}");
    expect(qa).toContain(previewReturn);
    const beforePreview = qa.slice(qa.indexOf('export function MemberQaScreen'), qa.indexOf(previewReturn));
    expect(beforePreview.length).toBeGreaterThan(0);
    expect(beforePreview).not.toMatch(/if\s*\(\s*!live\s*\)/);
    expect(qa).not.toContain('memberQaPreviewState(live, language)');
    expect(memberQaPreviewState('en')).toEqual({
      title: 'Questions preview',
      body: 'This preview does not load saved questions.',
    });
    expect(memberQaPreviewState('es')).toEqual({
      title: 'Vista previa de preguntas',
      body: 'Esta vista previa no carga preguntas guardadas.',
    });
    expect(JSON.stringify(memberQaPreviewState('en'))).not.toMatch(/sign in/i);
    expect(JSON.stringify(memberQaPreviewState('es'))).not.toMatch(/iniciar sesi[oó]n/i);
  });

  it('announces every Q&A failure with the same sentence the Notice renders', () => {
    const qa = source('./MemberQaScreen.tsx');
    expect(qa).toMatch(/useEffect\(\(\) => \{\s*if \(error\) return queueAnnouncement\(error\);\s*return undefined;\s*\}, \[error, errorVersion, queueAnnouncement\]\);/);
    expect(qa).toContain('if (notice) return queueAnnouncement(notice);');
    const failures = [...qa.matchAll(/setError\(qaFailureText\(language, ([^)]+)\)\);/g)];
    expect(failures).toHaveLength(4);
    expect(failures.map((match) => match[1])).toEqual(['listResult', 'detail', 'result', "result, null, 'writeUnconfirmed'"]);
    for (const match of failures) {
      const after = qa.slice(match.index! + match[0].length, match.index! + match[0].length + 64);
      expect(after).toMatch(/^\s*setErrorVersion\(\(value\) => value \+ 1\);/);
    }
    expect((qa.match(/\{error \? <Notice>\{error\}<\/Notice> : null\}/g) ?? []).length).toBe(2);
    expect(qa).toContain('accessibilityLiveRegion="polite"');
  });
});
