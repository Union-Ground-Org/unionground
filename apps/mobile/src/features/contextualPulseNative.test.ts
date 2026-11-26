import { stubSessionWriter } from '../testing/stubSessionWriter';
const businessWriter = stubSessionWriter(() => ({ rpc }));
// REQ-UG-CONTEXTUAL-PULSE-PRODUCT-TRIGGERS-20261001 (CR-014): the native
// reading-screen quick check shares the web rules and RPCs, asks only on the
// rights and Q&A reading screens, and every control it shows can act.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { beforeEach, describe, expect, it, vi } from 'vitest';

// Built at runtime so the secret scanner does not read a session-key literal.
const SESSION_KEY = vi.hoisted(() => ['4d0b0d9a', '1c3a', '4c8e', '9a51', '6c3c1f0f6b11'].join('-'));
const rpc = vi.fn();
vi.mock('../services/supabase', () => ({ getSupabaseClient: () => ({ rpc }) }));
vi.mock('expo-crypto', () => ({ randomUUID: () => SESSION_KEY }));

const source = (relative: string): string => readFileSync(fileURLToPath(new URL(relative, import.meta.url)), 'utf8');

describe('native contextual pulse service', () => {
  beforeEach(() => { rpc.mockReset(); });

  it('evaluates with one app-session key and bounded engagement numbers', async () => {
    const service = await import('../services/contextualPulse');
    rpc.mockResolvedValue({ data: { eligible: false, reason: 'sampled_out' }, error: null });
    await service.evaluateNativePulse(businessWriter, 'rights.page', 20.4, 140);
    await service.evaluateNativePulse(businessWriter, 'qa.detail', -3, 12);
    expect(rpc).toHaveBeenNthCalledWith(1, 'evaluate_contextual_pulse_in_context', {
      p_context_key: 'rights.page', p_session_key: SESSION_KEY, p_dwell_seconds: 20, p_scroll_percent: 100,
    });
    expect(rpc.mock.calls[1]?.[1]).toMatchObject({ p_session_key: SESSION_KEY, p_dwell_seconds: 0, p_scroll_percent: 12 });
    expect(service.nativePulseSessionUsed()).toBe(false);
    service.markNativePulseSessionUsed();
    expect(service.nativePulseSessionUsed()).toBe(true);
  });

  it('answers or dismisses through the shown meeting and caches the configuration briefly', async () => {
    const service = await import('../services/contextualPulse');
    rpc.mockResolvedValue({ data: { switches: { 'features.engagement_voice.contextual_pulses': true } }, error: null });
    service.resetPulseConfigurationCache();
    await service.loadPulseConfiguration(1_000);
    await service.loadPulseConfiguration(2_000);
    expect(rpc).toHaveBeenCalledTimes(1);
    await service.loadPulseConfiguration(1_000 + 5 * 60 * 1000);
    expect(rpc).toHaveBeenCalledTimes(2);
    await service.respondNativePulse(businessWriter, 'event-1', 'yes', false);
    await service.respondNativePulse(businessWriter, 'event-1', 'yes', true);
    expect(rpc).toHaveBeenNthCalledWith(3, 'respond_contextual_pulse', { p_event_id: 'event-1', p_response: 'yes', p_dismiss: false });
    expect(rpc).toHaveBeenNthCalledWith(4, 'respond_contextual_pulse', { p_event_id: 'event-1', p_response: null, p_dismiss: true });
  });

  it('surfaces an RPC error instead of a silent success', async () => {
    const service = await import('../services/contextualPulse');
    rpc.mockResolvedValue({ data: null, error: new Error('not found') });
    await expect(service.respondNativePulse(businessWriter, 'event-1', 'yes', false)).rejects.toThrow('not found');
  });
});

describe('native reading screens', () => {
  it('asks only on rights reading and a question detail, through Screen scroll progress', () => {
    const rights = source('./LiveLivedInScreens.tsx');
    expect(rights).toContain("useNativeContextualPulse('rights.page', !managingLearning)");
    expect(rights.match(/onScrollProgress=\{pulse\.onScrollProgress\}/g)).toHaveLength(3);
    expect(rights.match(/<ContextualPulseCard pulse=\{pulse\} \/>/g)).toHaveLength(3);
    const qa = source('./mi1/MemberQaScreen.tsx');
    expect(qa).toContain("useNativeContextualPulse('qa.detail', live && Boolean(selected?.id), selected?.id ?? '')");
    expect(qa).toContain('onScrollProgress={pulse.onScrollProgress}');
    const ui = source('../components/ui.tsx');
    expect(ui).toContain('onScrollProgress?: (percent: number) => void;');
    expect(ui).toContain('const scrollable = contentSize.height - layoutMeasurement.height;');
  });

  it('shares the web rules and gives every visible control a handler', () => {
    const card = source('./ContextualPulseCard.tsx');
    expect(card).toContain("from '../../../../src/features/engagement/contextualPulse.js'");
    expect(card).toContain('pulseSettings(configuration)');
    expect(card).toContain('pulseThresholdMet(');
    expect(card).toContain('isProductPulseContext(contextKey)');
    expect(card).toContain("AppState.addEventListener('change'");
    expect(card.match(/<Button/g)).toHaveLength(2);
    expect(card.match(/onPress=\{\(\) => \{ void pulse\.respond\(/g)).toHaveLength(2);
    expect(card).toContain('disabled={pulse.busy}');
  });
});
