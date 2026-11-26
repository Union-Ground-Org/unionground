import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { Session } from '@supabase/supabase-js';
import { describe, expect, it, vi } from 'vitest';

vi.mock('../services/supabase', () => ({ createCapturedSessionRpcClient: vi.fn() }));

import {
  BUILT_IN_COMPASS_SUGGESTIONS,
  DEFAULT_MEMBER_SUGGESTED_QUESTIONS,
  MEMBER_SUGGESTED_QUESTIONS_KEY,
  SUGGESTED_QUESTIONS_SWITCH,
  memberSuggestedQuestions,
  scopedCompassValue,
} from './compassSuggestions';
import { loadCompassSwitchConfiguration } from '../services/compassSuggestions';

const panel = readFileSync(fileURLToPath(new URL('../components/CompassPanel.tsx', import.meta.url)), 'utf8');
// The web's worker list is the source of truth after Phase 2. An older
// migration still seeds member questions as the
// definition default; that is the database group's to replace, so the native
// list is pinned to the web module rather than to that migration.
const webSuggestedPath = fileURLToPath(new URL('../../../../src/features/compass/suggestedQuestions.js', import.meta.url));
const webSuggested = existsSync(webSuggestedPath) ? await import('../../../../src/features/compass/suggestedQuestions.js') : null;

describe('native Guide suggested questions (REQ-UG-COMPASS-ROLE-SUGGESTED-QUESTIONS-20261001)', () => {
  it('uses the organization worker list, its defaults, or none when turned off', () => {
    expect(memberSuggestedQuestions({ switches: {} })).toEqual([...DEFAULT_MEMBER_SUGGESTED_QUESTIONS]);
    expect(memberSuggestedQuestions({ switches: { [MEMBER_SUGGESTED_QUESTIONS_KEY]: [' Who is my committee member? ', ''] } })).toEqual(['Who is my committee member?']);
    expect(memberSuggestedQuestions({ switches: { [SUGGESTED_QUESTIONS_SWITCH]: false } })).toEqual([]);
    expect(memberSuggestedQuestions(null)).toEqual([...BUILT_IN_COMPASS_SUGGESTIONS]);
  });

  it.skipIf(webSuggested === null)('keeps the defaults identical to the web worker list', () => {
    expect([...DEFAULT_MEMBER_SUGGESTED_QUESTIONS]).toEqual([...(webSuggested?.DEFAULT_SUGGESTED_QUESTIONS.member ?? [])]);
    expect(MEMBER_SUGGESTED_QUESTIONS_KEY).toBe(webSuggested?.SUGGESTED_QUESTION_LIST_KEYS.member);
    expect(SUGGESTED_QUESTIONS_SWITCH).toBe(webSuggested?.SUGGESTED_QUESTIONS_SWITCH);
    for (const question of [...DEFAULT_MEMBER_SUGGESTED_QUESTIONS, ...BUILT_IN_COMPASS_SUGGESTIONS]) {
      expect(question).not.toMatch(/Weingarten|grievance|Loudermill|steward|contract say|\bdues\b/i);
      // Legal response deadlines are
      // left out, so no starter asks how long a worker has to respond.
      expect(question).not.toMatch(/how long do I have|deadline|time to respond/i);
    }
  });

  it('reads only the switches map of the member-safe configuration', async () => {
    const rpc = vi.fn().mockResolvedValue({ data: { passkeyEnrollmentEnabled: true, switches: { [SUGGESTED_QUESTIONS_SWITCH]: false } }, error: null });
    await expect(loadCompassSwitchConfiguration({} as Session, { rpc })).resolves.toEqual({ switches: { [SUGGESTED_QUESTIONS_SWITCH]: false } });
    expect(rpc).toHaveBeenCalledWith('get_member_organization_configuration');
    await expect(loadCompassSwitchConfiguration({} as Session, { rpc: vi.fn().mockResolvedValue({ data: null, error: { message: 'x' } }) })).resolves.toBeNull();
  });

  it('renders chips only when the list is not empty and they stay populate-only', () => {
    expect(panel).toContain('suggestions.length > 0 && <View style={styles.suggestions}');
    expect(panel).toContain('onPress={() => { populateComposer(suggestion); }}');
  });
});

describe('Guide tenant payload boundary', () => {
  it('hides a previous tenant payload immediately and rejects a late result', () => {
    const a = 'authenticated:member:org-a';
    const b = 'authenticated:member:org-b';
    const oldQuestions = ['Private org A question'];
    const fallback = ['Built-in starter'];
    expect(scopedCompassValue(a, b, oldQuestions, fallback)).toEqual(fallback);
    expect(scopedCompassValue(null, b, oldQuestions, fallback)).toEqual(fallback);
    expect(scopedCompassValue(b, b, ['Org B question'], fallback)).toEqual(['Org B question']);
    expect(scopedCompassValue(a, b, [{ title: 'Org A nudge' }], [])).toEqual([]);
  });
});
