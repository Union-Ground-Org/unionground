// REQ-UG-HOME-NUDGES-20261001, native reads and device-local history. The
// server says which nudges the organization allows and the member's own
// onboarding progress; get_member_onboarding_guide says whether the
// organization has no checklist of its own (the starting-list card). "Not now"
// and the shown-this-week marker stay in this phone's secure storage, per
// account.
import type { Session } from '@supabase/supabase-js';
import * as SecureStore from 'expo-secure-store';

import { GUIDE_RPC, NUDGES_RPC, normalizeHomeNudges, type HomeNudgeHistory, type HomeNudgeKind, type HomeNudgeServer } from '../lib/nudgesShared';
import { createCapturedSessionRpcClient } from './supabase';

export type HomeNudgeRpcClient = {
  rpc(name: string): PromiseLike<{ data: unknown; error: unknown }>;
};

const ACCOUNT = /^[A-Za-z0-9-]{1,64}$/;
const shownThisRun = new Set<string>();

export async function loadHomeNudges(
  session: Session,
  client: HomeNudgeRpcClient = createCapturedSessionRpcClient(session),
): Promise<HomeNudgeServer> {
  // The guide read is optional: if it fails, the starting-list card stays off.
  const guide: Promise<unknown> = Promise.resolve(client.rpc(GUIDE_RPC))
    .then((response) => (response.error ? null : response.data ?? null), () => null);
  const [{ data, error }, guidePayload] = await Promise.all([client.rpc(NUDGES_RPC), guide]);
  if (error) throw new Error('Home suggestions are unavailable.');
  return normalizeHomeNudges(data, guidePayload);
}

function historyKey(userID: string): string | null {
  return ACCOUNT.test(userID) ? `org.unionground.app.home-nudges-v1.${userID}` : null;
}

function entry(value: unknown): { dismissedAt?: number; shownAt?: number } {
  if (!value || typeof value !== 'object') return {};
  const record = value as Record<string, unknown>;
  return {
    ...(typeof record.dismissedAt === 'number' && Number.isFinite(record.dismissedAt) ? { dismissedAt: record.dismissedAt } : {}),
    ...(typeof record.shownAt === 'number' && Number.isFinite(record.shownAt) ? { shownAt: record.shownAt } : {}),
  };
}

export async function readHomeNudgeHistory(userID: string): Promise<HomeNudgeHistory> {
  const key = historyKey(userID);
  if (!key) return {};
  try {
    const parsed: unknown = JSON.parse((await SecureStore.getItemAsync(key)) ?? '{}');
    const record = parsed && typeof parsed === 'object' ? parsed as Record<string, unknown> : {};
    return {
      onboarding: { ...entry(record.onboarding), shownThisSession: shownThisRun.has(`${userID}:onboarding`) },
      starter: { ...entry(record.starter), shownThisSession: shownThisRun.has(`${userID}:starter`) },
      passkey: { ...entry(record.passkey), shownThisSession: shownThisRun.has(`${userID}:passkey`) },
    };
  } catch {
    return {};
  }
}

async function update(userID: string, kind: HomeNudgeKind, patch: { dismissedAt?: number; shownAt?: number }): Promise<void> {
  const key = historyKey(userID);
  if (!key) return;
  const current = await readHomeNudgeHistory(userID);
  const next = {
    onboarding: entry(current.onboarding),
    starter: entry(current.starter),
    passkey: entry(current.passkey),
    [kind]: { ...entry(current[kind]), ...patch },
  };
  await SecureStore.setItemAsync(key, JSON.stringify(next));
}

export async function markHomeNudgeShown(userID: string, kind: HomeNudgeKind, now: number = Date.now()): Promise<void> {
  if (shownThisRun.has(`${userID}:${kind}`)) return;
  shownThisRun.add(`${userID}:${kind}`);
  await update(userID, kind, { shownAt: now });
}

export async function dismissHomeNudge(userID: string, kind: HomeNudgeKind, now: number = Date.now()): Promise<void> {
  await update(userID, kind, { dismissedAt: now });
}

export function forgetHomeNudgeRun(): void {
  shownThisRun.clear();
}

// REQ-UG-TEMPORARY-PASSWORD-CHANGE-PROMPT-20261018, native half. The
// emailed password is stamped on the account (user_metadata
// union_ground_password_issued_at) and the member's own password change
// deletes the stamp. "Not now" is kept on this phone for that stamp only, so
// a reissued password asks again.
function passwordPromptKey(userID: string): string | null {
  return ACCOUNT.test(userID) ? `org.unionground.app.choose-password-v1.${userID}` : null;
}

export async function isPasswordPromptDismissed(userID: string, issuedAt: string): Promise<boolean> {
  const key = passwordPromptKey(userID);
  if (!key) return true;
  try {
    return (await SecureStore.getItemAsync(key)) === issuedAt;
  } catch {
    return true;
  }
}

export async function dismissPasswordPrompt(userID: string, issuedAt: string): Promise<void> {
  const key = passwordPromptKey(userID);
  if (key) await SecureStore.setItemAsync(key, issuedAt);
}
