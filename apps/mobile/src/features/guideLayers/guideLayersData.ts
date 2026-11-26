import type { MobileSessionWriter } from '../../services/supabase';
// REQ-UG-ONBOARDING-GUIDE-ENGINE-PORT-STEP3-20261029 (native).
//
// The onboarding guide engine's member layers and org-start guide on the
// phone, from the same pure rules as the web
// (src/features/onboardingGuideEngine/memberLayers.js and orgStart.js).
// The source lines in ./guideCopy.ts mirror src/lib/i18n/guideEngine.js. This module
// holds the reads, the device marks and the copy lookup; the screens are in
// GuideLayers.tsx. PREVIEW never reads: the switches and the org-start facts
// belong to a real organization.

import * as SecureStore from 'expo-secure-store';

import { getSupabaseClient } from '../../services/supabase';
import { GUIDE_COPY_EN } from './guideCopy';

export const FEATURE_GUIDES_SWITCH = 'features.guidance_onboarding.feature_guides';
export const COACH_MARKS_SWITCH = 'features.guidance_onboarding.coach_marks';
export const ORG_START_GUIDE_SWITCH = 'features.guidance_onboarding.org_start_guide';

export type GuideCopy = { key: string; params?: Record<string, unknown> };

/** Translate the app-owned template before inserting names and other values. */
export function createGuideText(translate = (template: string) => template) {
  function render(entry: GuideCopy | null | undefined): string {
    if (!entry || typeof entry.key !== 'string') return '';
    const params = Object.fromEntries(Object.entries(entry.params ?? {}).map(([name, value]) => (
      value && typeof value === 'object' && typeof (value as GuideCopy).key === 'string' ? [name, render(value as GuideCopy)] : [name, value]
    )));
    const template = Object.hasOwn(GUIDE_COPY_EN, entry.key) ? GUIDE_COPY_EN[entry.key] : undefined;
    if (template === undefined) return entry.key;
    return translate(template).replace(/\{(\w+)\}/g, (_match, name: string) => (params[name] == null ? '' : String(params[name])));
  }
  return render;
}

export const guideText = createGuideText();

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

export type GuideSwitches = { featureGuides: boolean; coachMarks: boolean; orgStartGuide: boolean };
export const GUIDE_SWITCHES_OFF: GuideSwitches = Object.freeze({ featureGuides: false, coachMarks: false, orgStartGuide: false });

/** The three guidance switches from the member configuration; absent is off. */
export function guideSwitchesFrom(configuration: unknown): GuideSwitches {
  const switches = record(record(configuration)?.switches);
  if (!switches) return GUIDE_SWITCHES_OFF;
  return {
    featureGuides: switches[FEATURE_GUIDES_SWITCH] === true,
    coachMarks: switches[COACH_MARKS_SWITCH] === true,
    orgStartGuide: switches[ORG_START_GUIDE_SWITCH] === true,
  };
}

export async function loadGuideSwitches(): Promise<GuideSwitches> {
  const client = getSupabaseClient();
  if (!client) return GUIDE_SWITCHES_OFF;
  const response: { data: unknown; error: unknown } = await client.rpc('get_member_organization_configuration');
  if (response.error) throw response.error;
  return guideSwitchesFrom(response.data);
}

// Org-start guide doors: one read and three writers, each answering with the
// guide after it (supabase/migrations/20261029150000_organization_start_guide.sql).
async function orgStartCall(response: { data: unknown; error: unknown }): Promise<unknown> {
  if (response.error) throw response.error;
  return response.data ?? null;
}

export async function loadOrganizationStartGuide(): Promise<unknown> {
  const client = getSupabaseClient();
  if (!client) return null;
  return orgStartCall(await client.rpc('get_organization_start_guide'));
}

export async function reviewOrganizationStartSwitches(writer: MobileSessionWriter): Promise<unknown> {
  const client = await writer.client();
  return orgStartCall(await client.rpc('mark_organization_start_switches_reviewed'));
}

export async function saveOrganizationStartContacts(writer: MobileSessionWriter, backupUserId: string | null, spokespersonUserIds: string[]): Promise<unknown> {
  const client = await writer.client();
  return orgStartCall(await client.rpc('save_organization_start_contacts', { p_backup_user_id: backupUserId, p_spokesperson_user_ids: spokespersonUserIds }));
}

export async function acknowledgeOrganizationStartCelebration(writer: MobileSessionWriter): Promise<unknown> {
  const client = await writer.client();
  return orgStartCall(await client.rpc('acknowledge_organization_start_celebration'));
}

// Device marks, per signed-in user. Feature guides keep seen / got / reopen /
// acted times per feature (the web's shape); coach marks keep the anchors
// already closed with Got it. This session's coach mark lives in memory only,
// so a relaunch is a new session, as on the web.
export type FeatureMarks = { seen: Record<string, number>; got: Record<string, number>; reopen: Record<string, number>; acted: Record<string, number> };
export type FeatureMarkKind = keyof FeatureMarks;
export const NO_FEATURE_MARKS: FeatureMarks = Object.freeze({ seen: {}, got: {}, reopen: {}, acted: {} });

const safeUser = (userId: string) => userId.replace(/[^A-Za-z0-9._-]/g, '');
export const featureMarksKey = (userId: string) => `ug.guide.featureMarks.${safeUser(userId)}`;
export const coachSeenKey = (userId: string) => `ug.guide.coachSeen.${safeUser(userId)}`;

function times(value: unknown): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [name, time] of Object.entries(record(value) ?? {})) {
    if (/^[a-z-]{1,40}$|^next-step:[\w-]{1,80}$/.test(name) && typeof time === 'number' && Number.isFinite(time)) out[name] = time;
  }
  return out;
}

export function parseFeatureMarks(raw: string | null): FeatureMarks {
  try {
    const data = record(raw ? JSON.parse(raw) : null);
    return { seen: times(data?.seen), got: times(data?.got), reopen: times(data?.reopen), acted: times(data?.acted) };
  } catch {
    return NO_FEATURE_MARKS;
  }
}

/** The marks after one more; the first "seen" and "acted" are kept. */
export function withFeatureMark(marks: FeatureMarks, kind: FeatureMarkKind, feature: string, now: number): FeatureMarks {
  if ((kind === 'seen' || kind === 'acted') && Number.isFinite(marks[kind][feature])) return marks;
  return { ...marks, [kind]: { ...marks[kind], [feature]: now } };
}

export async function readFeatureMarks(userId: string): Promise<FeatureMarks> {
  try { return parseFeatureMarks(await SecureStore.getItemAsync(featureMarksKey(userId))); } catch { return NO_FEATURE_MARKS; }
}

export async function writeFeatureMarks(userId: string, marks: FeatureMarks): Promise<void> {
  try { await SecureStore.setItemAsync(featureMarksKey(userId), JSON.stringify(marks)); } catch { /* the card still closes for this launch */ }
}

// BUG-UG-NATIVE-FEATURE-GUIDE-MARKS-AND-PULSE-20261102: every guide
// on the device shares one stored record per user, and native tabs stay
// mounted. Each mark is therefore a read-merge-write of the stored record, run
// one at a time in call order, so a mark on Home never drops a dismissal made
// on Events and two quick marks never land out of order. Loads wait their
// turn too, so a guide never shows a record older than one already written.
let featureMarkQueue: Promise<unknown> = Promise.resolve();
type FeatureMarksListener = (userId: string, marks: FeatureMarks) => void;
const featureMarkListeners = new Set<FeatureMarksListener>();

function inFeatureMarkTurn<T>(work: () => Promise<T>): Promise<T> {
  const turn = featureMarkQueue.then(work);
  featureMarkQueue = turn.catch(() => undefined);
  return turn;
}

/** The stored marks, read after every mark already asked for has landed. */
export function loadFeatureMarks(userId: string): Promise<FeatureMarks> {
  return inFeatureMarkTurn(() => readFeatureMarks(userId));
}

/** Told the stored record after each mark, so every mounted guide shows it. */
export function subscribeFeatureMarks(listener: FeatureMarksListener): () => void {
  featureMarkListeners.add(listener);
  return () => { featureMarkListeners.delete(listener); };
}

/**
 * One more mark, merged into the stored record. A record that cannot be read
 * is never overwritten: the mark is dropped for this launch rather than
 * replacing every other guide's marks with this one.
 */
export function recordFeatureMark(userId: string, kind: FeatureMarkKind, feature: string, now: number): Promise<FeatureMarks | null> {
  return inFeatureMarkTurn(async () => {
    let stored: FeatureMarks;
    try { stored = parseFeatureMarks(await SecureStore.getItemAsync(featureMarksKey(userId))); } catch { return null; }
    const next = withFeatureMark(stored, kind, feature, now);
    if (next !== stored) await writeFeatureMarks(userId, next);
    for (const listener of featureMarkListeners) listener(userId, next);
    return next;
  });
}

export async function readCoachSeen(userId: string): Promise<Record<string, number>> {
  try {
    const raw = await SecureStore.getItemAsync(coachSeenKey(userId));
    return times(raw ? JSON.parse(raw) : null);
  } catch {
    return {};
  }
}

export async function writeCoachSeen(userId: string, seen: Record<string, number>): Promise<void> {
  try { await SecureStore.setItemAsync(coachSeenKey(userId), JSON.stringify(seen)); } catch { /* closed for this launch */ }
}

let coachSessionAnchor: { userId: string; anchor: string } | null = null;
export function coachMarkShownThisSession(userId: string | null): string | null {
  return userId && coachSessionAnchor?.userId === userId ? coachSessionAnchor.anchor : null;
}
export function noteCoachMarkShown(userId: string, anchor: string): void {
  coachSessionAnchor = { userId, anchor };
}
