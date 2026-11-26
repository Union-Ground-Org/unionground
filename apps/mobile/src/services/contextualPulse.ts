import { businessRpc } from './businessWriters';
import type { MobileSessionWriter } from './supabase';
// REQ-UG-CONTEXTUAL-PULSE-PRODUCT-TRIGGERS-20261001 (CR-014): the native
// reading-screen quick check calls the same RPCs as the web slot. The server
// (public.evaluate_contextual_pulse_in_context) enforces the organization
// switch, blocked screens, thresholds, once per session, cooldown, weekly
// target and sampling; this file only carries the calls.
import * as Crypto from 'expo-crypto';
import { getSupabaseClient } from './supabase';
import type { OrganizationSwitchConfiguration } from '../lib/featureSwitches';

export const CONTEXTUAL_PULSE_RPC_NAMES = Object.freeze({
  configuration: 'get_member_organization_configuration',
  evaluate: 'evaluate_contextual_pulse_in_context',
  respond: 'respond_contextual_pulse',
});

// One quick check per app session: a fresh key each time the app process
// starts (the web keeps one per browser tab session).
let sessionKey: string | null = null;
let sessionUsed = false;

export function nativePulseSessionKey(): string {
  sessionKey ??= Crypto.randomUUID();
  return sessionKey;
}

export function nativePulseSessionUsed(): boolean {
  return sessionUsed;
}

export function markNativePulseSessionUsed(): void {
  sessionUsed = true;
}

async function rpc(name: string, args: Record<string, unknown> = {}): Promise<unknown> {
  const client = getSupabaseClient();
  if (!client) throw new Error('The secure mobile backend is not configured.');
  const { data, error } = await client.rpc(name, args);
  if (error) throw error;
  return data;
}

const CONFIGURATION_TTL_MS = 5 * 60 * 1000;
let cachedConfiguration: { at: number; value: OrganizationSwitchConfiguration } | null = null;

// The member-safe organization configuration (switches), cached briefly so a
// reading screen does not re-read it on every visit.
export async function loadPulseConfiguration(now = Date.now()): Promise<OrganizationSwitchConfiguration> {
  if (cachedConfiguration && now - cachedConfiguration.at < CONFIGURATION_TTL_MS) return cachedConfiguration.value;
  const value = (await rpc(CONTEXTUAL_PULSE_RPC_NAMES.configuration)) as OrganizationSwitchConfiguration;
  cachedConfiguration = { at: now, value };
  return value;
}

export function resetPulseConfigurationCache(): void {
  cachedConfiguration = null;
}

export async function evaluateNativePulse(writer: MobileSessionWriter, contextKey: string, dwellSeconds: number, scrollPercent: number): Promise<unknown> {
  return businessRpc(writer, CONTEXTUAL_PULSE_RPC_NAMES.evaluate, {
    p_context_key: contextKey,
    p_session_key: nativePulseSessionKey(),
    p_dwell_seconds: Math.max(0, Math.min(86400, Math.round(dwellSeconds))),
    p_scroll_percent: Math.max(0, Math.min(100, Math.round(scrollPercent))),
  });
}

export async function respondNativePulse(writer: MobileSessionWriter, eventId: string, response: unknown, dismiss: boolean): Promise<void> {
  await businessRpc(writer, CONTEXTUAL_PULSE_RPC_NAMES.respond, {
    p_event_id: eventId,
    p_response: dismiss ? null : response,
    p_dismiss: dismiss,
  });
}
