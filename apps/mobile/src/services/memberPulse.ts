import type { Session } from '@supabase/supabase-js';
import type { MemberDashboard } from '../models/member';
import { memberStatisticsCards } from '../lib/memberPulse';
import { nativeUiText, type NativeLanguage } from '../lib/nativeUiCopy';
import { classifyQuarterlyGate } from '../lib/memberSurveysShared';
import { pulseCount, pulseObject, pulseRows, pulseText, type PulseCard, type PulseRow } from '../lib/pulseCatalog';
import { memberCaseStep } from '../lib/caseStepLabels';
import { rankWhatMattersNow, surveysToAnswer, whatMattersSurveys, type WhatMattersItem } from '../lib/whatMattersShared';
import { loadWhatMattersBallots, loadWhatMattersEvents } from './memberHomeAttention';
import { createCapturedSessionRpcClient, getSupabaseClient } from './supabase';

type Read = { data: unknown; error: unknown };
async function settled(read: PromiseLike<{ data: unknown; error: unknown }>): Promise<Read> {
  try { return await read; } catch (error) { return { data: null, error }; }
}
async function input<T>(read: Promise<T>): Promise<{ data: T | null; error: unknown }> {
  try { return { data: await read, error: null }; } catch (error) { return { data: null, error }; }
}
export type MemberPulse = {
  cards: PulseCard[]; updatedAt: Date; next: WhatMattersItem | null; nextAvailable: boolean;
  statisticsLocked: boolean; surveys: string[]; notice: { title: string; unread: number; limited: boolean } | null;
};

export async function loadMemberPulse(session: Session, dashboard: MemberDashboard, signal: AbortSignal, language: NativeLanguage = 'en'): Promise<MemberPulse> {
  const t = nativeUiText(language);
  const client = getSupabaseClient();
  if (!client) throw new Error('The secure mobile backend is not configured.');
  const rpcClient = createCapturedSessionRpcClient(session);
  const rpc = (name: string, args: Record<string, unknown> = {}) => settled(rpcClient.rpc(name, args));
  const userID = session.user.id;
  const now = new Date();
  const [engagement, rewards, events, notices, ballots, upcoming] = await Promise.all([
    rpc('get_member_engagement_snapshot'), rpc('get_member_rewards_summary'),
    settled(client.from('member_events').select('id,title,starts_at').eq('event_kind', 'meeting').is('cancelled_at', null)
      .lte('starts_at', now.toISOString()).order('starts_at', { ascending: false }).limit(4).abortSignal(signal)),
    settled(client.from('member_broadcasts').select('id,title,published_at').is('retracted_at', null).not('published_at', 'is', null)
      .order('published_at', { ascending: false }).limit(21).abortSignal(signal)),
    input(loadWhatMattersBallots()), input(loadWhatMattersEvents(userID, dashboard.member.chapterID)),
  ]);
  if (signal.aborted) throw new Error('Pulse read cancelled.');
  const gate = engagement.error ? 'error' : classifyQuarterlyGate(pulseObject(engagement.data).quarterlyGate).status;
  const eventRows = pulseRows(events.data);
  const noticeRows = pulseRows(notices.data).slice(0, 20);
  const [statistics, quorum, receipts] = await Promise.all([
    gate === 'open' ? rpc('get_member_union_statistics') : Promise.resolve({ data: null, error: null }),
    events.error ? Promise.resolve({ data: null, error: events.error }) : rpc('get_member_event_quorum', { p_event_ids: eventRows.map((row) => row.id) }),
    notices.error ? Promise.resolve({ data: null, error: notices.error }) : noticeRows.length
      ? settled(client.from('member_broadcast_receipts').select('broadcast_id').eq('user_id', userID).in('broadcast_id', noticeRows.map((row) => row.id)).abortSignal(signal))
      : Promise.resolve({ data: [], error: null }),
  ]);
  const statsCards = memberStatisticsCards(statistics.error ? null : statistics.data, gate, language);
  const quorumRows = pulseRows(quorum.data);
  const meetingRows: PulseRow[] = [];
  for (const event of eventRows) {
    const count = quorumRows.find((row) => row.eventId === event.id);
    const checkedIn = pulseCount(count?.checkedIn), target = pulseCount(count?.quorum);
    if (checkedIn !== null && target !== null) {
      meetingRows.push({ label: t('{meeting} · checked in', { meeting: pulseText(event.title) }), value: checkedIn }, { label: t('{meeting} · quorum', { meeting: pulseText(event.title) }), value: target });
    }
  }
  const reward = pulseObject(rewards.data);
  const weekRows: PulseRow[] = [{ label: t('Actions this week'), value: dashboard.weeklyActions.length }];
  for (const [key, label] of [['weekStreak', 'Week streak'], ['totalPoints', 'Confirmed points'], ['actionsYtd', 'Actions this year']] as const) {
    const value = pulseCount(reward[key]);
    if (value !== null) weekRows.push({ label: t(label), value });
  }
  const cards: PulseCard[] = [statsCards[0]!, {
    id: 'meetings', number: '02', title: t('Meeting turnout'), category: 'meetings', period: t('Latest four meetings that have started'),
    countedFrom: t('recorded meeting check-ins and the meeting’s configured quorum.'),
    notCounted: t('Cancelled and future meetings, meetings with no configured quorum, and unrecorded attendance are excluded. Worker reads do not expose campaign RSVP totals.'),
    rows: quorum.error ? [] : meetingRows, unavailable: Boolean(quorum.error),
    message: !quorum.error && !meetingRows.length ? t('No recent meeting has published quorum figures.') : undefined,
  }, {
    id: 'week', number: '03', title: t('Your week'), category: 'chapter', period: t('This week; streak, points and year totals as labelled'),
    countedFrom: t('your own action log and rewards summary.'), notCounted: t('Other workers, page views and product analytics are excluded. Points are confirmed rewards, never money.'),
    rows: weekRows, message: rewards.error ? t('Your rewards could not be verified; only your loaded weekly actions are shown.') : undefined,
  }, statsCards[1]!];
  const readIDs = new Set(pulseRows(receipts.data).map((row) => pulseText(row.broadcast_id)));
  const unread = noticeRows.filter((row) => !readIDs.has(pulseText(row.id)));
  // BUG-UG-PULSE-THIS-WEEK-CAUGHT-UP-WITH-OPEN-ITEMS-20261103: the
  // headline ranks the same surveys and notices the card lists, so it never
  // says caught up above them; a survey past its deadline is not one to answer.
  const surveys = engagement.error ? [] : surveysToAnswer(whatMattersSurveys(engagement.data), now);
  const noticesRead = !notices.error && !receipts.error;
  const nextAvailable = !ballots.error && !upcoming.error && !engagement.error && noticesRead;
  return {
    cards, updatedAt: now, nextAvailable,
    next: nextAvailable ? rankWhatMattersNow({
      cases: dashboard.cases.map((item) => ({ ...item, step: memberCaseStep(item) })), ballots: ballots.data!, events: upcoming.data!, surveys,
      notices: noticeRows.map((row) => ({ id: pulseText(row.id), title: pulseText(row.title), unread: !readIDs.has(pulseText(row.id)) })), now,
    }) : null,
    statisticsLocked: gate === 'locked' || pulseObject(statistics.data).locked === true,
    surveys: surveys.map((row) => row.title),
    notice: !noticesRead || !unread.length ? null : { title: pulseText(unread[0]?.title), unread: unread.length, limited: pulseRows(notices.data).length > 20 },
  };
}
