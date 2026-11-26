// REQ-UG-REACTIVATION-WELCOME-BACK-20261001, native reads. The server
// keeps one last-active date per account and nothing else; the RPC records
// today and answers whether this visit follows a long absence.
// BUG-UG-WELCOME-BACK-ACTIVITY-CACHE-20261002: the display/dismissal
// decision and the activity mark are separate. The decision lasts for the app
// run (a dismissed welcome stays dismissed); the activity is recorded at most
// once per UTC calendar day, so an app kept running or resumed on a later day
// records again and evaluates the return then.

import type { Session } from '@supabase/supabase-js';

import { WELCOME_BACK_RPC, normalizeWelcomeBack } from '../lib/welcomeBackShared';
import { createCapturedSessionRpcClient, getSupabaseClient, loadMobileBallots } from './supabase';

export type HomeReturnRpcClient = {
  rpc(name: string): PromiseLike<{ data: unknown; error: unknown }>;
};

type Decision = 'welcome' | 'seen';
const decisions = new Map<string, Decision>();
const recordedOn = new Map<string, string>();
const pending = new Map<string, Promise<Decision>>();

function homeReturnDay(now: Date = new Date()): string {
  return now.toISOString().slice(0, 10);
}

export function homeReturnDecision(userID: string): Decision | null {
  return decisions.get(userID) ?? null;
}

export function dismissHomeReturn(userID: string): void {
  decisions.set(userID, 'seen');
}

export function forgetHomeReturnDecisions(): void {
  decisions.clear();
  recordedOn.clear();
  pending.clear();
}

export function recordMemberHomeReturn(
  session: Session,
  client: HomeReturnRpcClient = createCapturedSessionRpcClient(session),
  today: string = homeReturnDay(),
): Promise<Decision> {
  const userID = session.user.id;
  // Days compare as YYYY-MM-DD strings. Today or an earlier day than the one
  // already recorded asks nothing.
  const recorded = recordedOn.get(userID);
  if (recorded !== undefined && recorded >= today) return Promise.resolve(decisions.get(userID) ?? 'seen');
  const attempt = `${userID}:${today}`;
  const inFlight = pending.get(attempt);
  if (inFlight) return inFlight;
  const request = Promise.resolve(client.rpc(WELCOME_BACK_RPC))
    .then(({ data, error }) => !error && normalizeWelcomeBack(data).welcomeBack)
    .catch(() => false)
    .then((welcome): Decision => {
      pending.delete(attempt);
      // An older day's answer that settles after a later day's (an app
      // suspended with day D's read in flight and resumed on day D+1) is
      // stale: it never moves the recorded day back and never replaces the
      // later decision.
      const latest = recordedOn.get(userID);
      if (latest !== undefined && latest > today) return decisions.get(userID) ?? 'seen';
      // One attempt per day, answered or not; a later day asks again.
      recordedOn.set(userID, today);
      // A new welcome replaces an earlier dismissal; otherwise the run's own
      // decision (including an undismissed welcome) is kept.
      if (welcome) decisions.set(userID, 'welcome');
      else if (!decisions.has(userID)) decisions.set(userID, 'seen');
      return decisions.get(userID) ?? 'seen';
    });
  pending.set(attempt, request);
  return request;
}

export type WelcomeBackExtras = {
  openPolls: { id: string; title: string }[];
  events: { id: string; title: string; startsAt: string }[];
};

// Open votes and the next two weeks of events, both through the same RLS the
// Voting and Events screens use. Read once, only for a welcome back.
export async function loadWelcomeBackExtras(chapterID: string | null, nowMs: number = Date.now()): Promise<WelcomeBackExtras> {
  const supabase = getSupabaseClient();
  if (!supabase) throw new Error('The secure mobile backend is not configured.');
  const [ballots, eventsResult] = await Promise.all([
    loadMobileBallots().catch(() => []),
    supabase.from('member_events')
      .select('id,title,starts_at,chapter_id,is_public_across_agencies')
      .gte('starts_at', new Date(nowMs).toISOString())
      .lte('starts_at', new Date(nowMs + 14 * 86_400_000).toISOString())
      .is('cancelled_at', null)
      .order('starts_at', { ascending: true })
      .limit(10),
  ]);
  const events = eventsResult.error ? [] : (Array.isArray(eventsResult.data) ? eventsResult.data : []).flatMap((row: { id: unknown; title: unknown; starts_at: unknown; chapter_id: unknown; is_public_across_agencies: unknown }) => (
    typeof row.id === 'string' && typeof row.title === 'string' && typeof row.starts_at === 'string'
      // Same Home relevance as the web: the member's chapter plus events
      // published across every agency.
      && (!chapterID || row.chapter_id == null || row.chapter_id === chapterID || row.is_public_across_agencies === true)
      ? [{ id: row.id, title: row.title, startsAt: row.starts_at }]
      : []
  ));
  return {
    openPolls: ballots.filter((item) => !item.closed && item.receiptCode === null).map((item) => ({ id: item.id, title: item.title })),
    events,
  };
}
