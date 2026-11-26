import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { Session } from '@supabase/supabase-js';
import { describe, expect, it, vi } from 'vitest';

vi.mock('../services/supabase', () => ({ createCapturedSessionRpcClient: vi.fn() }));

import { contextualNudgesEnabled, memberNudgesFrom } from './compassNudges';
import { loadCompassMemberNudges } from '../services/compassSuggestions';

const panel = readFileSync(fileURLToPath(new URL('../components/CompassPanel.tsx', import.meta.url)), 'utf8');

describe('native Guide worker nudges (REQ-UG-COMPASS-CONTEXTUAL-NUDGES-20261001)', () => {
  it('follows both organization switches', () => {
    expect(contextualNudgesEnabled({ switches: { 'features.ai_assistant.contextual_nudges': true } })).toBe(true);
    expect(contextualNudgesEnabled({ switches: { 'features.ai_assistant.contextual_nudges': true, 'features.ai_assistant.enabled': false } })).toBe(false);
    expect(contextualNudgesEnabled(null)).toBe(false);
  });

  it('keeps only the worker retaliation flag with a positive count', () => {
    expect(memberNudgesFrom({ enabled: true, member: [{ id: 'retaliation-flag', count: 2 }, { id: 'overdue-cases', count: 3 }] })).toEqual([
      { id: 'retaliation-flag', label: 'Open retaliation report', prompt: 'I reported retaliation at work. What should I do while it is reviewed?', urgent: true },
    ]);
    expect(memberNudgesFrom({ enabled: false, member: [{ id: 'retaliation-flag', count: 1 }] })).toEqual([]);
    expect(memberNudgesFrom({ enabled: true, member: [{ id: 'retaliation-flag', count: 0 }] })).toEqual([]);
  });

  it('reads the nudge RPC and degrades to none', async () => {
    const rpc = vi.fn().mockResolvedValue({ data: { enabled: true, member: [{ id: 'retaliation-flag', count: 1 }] }, error: null });
    await expect(loadCompassMemberNudges({} as Session, { rpc })).resolves.toHaveLength(1);
    expect(rpc).toHaveBeenCalledWith('get_compass_nudges');
    await expect(loadCompassMemberNudges({} as Session, { rpc: vi.fn().mockResolvedValue({ data: null, error: { message: 'x' } }) })).resolves.toEqual([]);
  });

  it('renders nudges as populate-only buttons above the suggestions', () => {
    expect(panel).toContain("accessibilityLabel={t('Needs your attention')}");
    expect(panel).toContain('onPress={() => { populateComposer(nudge.prompt); }}');
  });
});
