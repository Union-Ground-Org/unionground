// REQ-UG-MEMBER-WHAT-MATTERS-NOW-20261001: the bounded native reads behind
// "What matters for you now". Cases come from the dashboard the member already
// holds; this adds the member's open ballots and this week's events, both read
// through the same row-level-security policies the Voting and Events screens
// use. Nothing here is written, and the ranking itself runs on the phone.
// BUG-UG-PULSE-THIS-WEEK-CAUGHT-UP-WITH-OPEN-ITEMS-20261103: it also
// reads the member's surveys and latest notices, so Home never says caught up
// above a survey to answer or an unread notice.
// UX-UG-WHAT-MATTERS-NOW-SAYS-CAUGHT-UP-WITH-AN-ASSIGNED-TASK-20261112:
// it reads the open chapter tasks assigned to the member too, so Home never
// says caught up while one is overdue or nearly due.

import type { Session } from '@supabase/supabase-js';

import { isFeatureEnabled } from '../lib/featureSwitches';
import {
  WHAT_MATTERS_SWITCH,
  whatMattersSurveys,
  type WhatMattersBallot,
  type WhatMattersEvent,
  type WhatMattersNotice,
  type WhatMattersSurvey,
  type WhatMattersTask,
} from '../lib/whatMattersShared';
import { createCapturedSessionRpcClient, getSupabaseClient, loadMobileBallots } from './supabase';

const DAY_MS = 86_400_000;
const EVENT_HORIZON_DAYS = 7;
// The same latest-twenty window Pulse counts unread notices in.
const NOTICE_WINDOW = 20;
// Open assignments read for one person: the oldest assigned first, then that
// window's tasks soonest due first.
const TASK_WINDOW = 200;

export async function loadWhatMattersSwitch(session: Session): Promise<boolean> {
  const { data, error } = await createCapturedSessionRpcClient(session).rpc('get_member_organization_configuration');
  // Unknown configuration keeps the registered default (on).
  if (error) return true;
  return isFeatureEnabled(data, WHAT_MATTERS_SWITCH, true);
}

export async function loadWhatMattersBallots(): Promise<WhatMattersBallot[]> {
  const ballots = await loadMobileBallots();
  return ballots.map((item) => ({
    id: item.id,
    title: item.title,
    closed: item.closed,
    voted: item.receiptCode !== null,
    closesAt: item.closesAt,
  }));
}

// A read's rows, or none when the response is not a list.
function rows<T>(data: unknown): T[] {
  return Array.isArray(data) ? data as T[] : [];
}

type EventRow = {
  id: unknown;
  title: unknown;
  starts_at: unknown;
  chapter_id: unknown;
  is_public_across_agencies: unknown;
  cancelled_at: unknown;
};

export async function loadWhatMattersEvents(userID: string, chapterID: string | null, nowMs: number = Date.now()): Promise<WhatMattersEvent[]> {
  const supabase = getSupabaseClient();
  if (!supabase) throw new Error('The secure mobile backend is not configured.');
  const from = new Date(nowMs).toISOString();
  const to = new Date(nowMs + EVENT_HORIZON_DAYS * DAY_MS).toISOString();
  const eventsResult = await supabase.from('member_events')
    .select('id,title,starts_at,chapter_id,is_public_across_agencies,cancelled_at')
    .gte('starts_at', from)
    .lte('starts_at', to)
    .is('cancelled_at', null)
    .order('starts_at', { ascending: true })
    .limit(20);
  if (eventsResult.error) throw eventsResult.error;
  // Same Home relevance as the web feed: the member's chapter plus events
  // published across every agency, never the regional directory.
  const events = rows<EventRow>(eventsResult.data).flatMap((value) => (
    typeof value.id === 'string' && typeof value.title === 'string' && typeof value.starts_at === 'string'
      && (!chapterID || value.chapter_id == null || value.chapter_id === chapterID || value.is_public_across_agencies === true)
      ? [{ id: value.id, title: value.title, startsAt: value.starts_at }]
      : []
  ));
  if (events.length === 0) return [];
  // Explicit self-scope: staff-role accounts can read wider RSVP rows, and the
  // member's own Home must never count someone else's answer.
  const rsvpResult = await supabase.from('member_event_rsvps')
    .select('event_id,status')
    .eq('user_id', userID)
    .in('event_id', events.map((row) => row.id));
  if (rsvpResult.error) throw rsvpResult.error;
  const answered = new Set(rows<{ event_id: unknown }>(rsvpResult.data).flatMap((value) => (
    typeof value.event_id === 'string' ? [value.event_id] : []
  )));
  return events.map((row) => ({ ...row, cancelled: false, responded: answered.has(row.id) }));
}

export async function loadWhatMattersSurveys(session: Session): Promise<WhatMattersSurvey[]> {
  const result: { data: unknown; error: unknown } = await createCapturedSessionRpcClient(session).rpc('get_member_engagement_snapshot');
  if (result.error) throw result.error;
  return whatMattersSurveys(result.data);
}

export async function loadWhatMattersNotices(userID: string): Promise<WhatMattersNotice[]> {
  const supabase = getSupabaseClient();
  if (!supabase) throw new Error('The secure mobile backend is not configured.');
  const noticesResult = await supabase.from('member_broadcasts')
    .select('id,title')
    .is('retracted_at', null)
    .not('published_at', 'is', null)
    .order('published_at', { ascending: false })
    .limit(NOTICE_WINDOW);
  if (noticesResult.error) throw noticesResult.error;
  const notices = rows<{ id: unknown; title: unknown }>(noticesResult.data).flatMap((value) => (
    typeof value.id === 'string' ? [{ id: value.id, title: typeof value.title === 'string' ? value.title : '' }] : []
  ));
  if (notices.length === 0) return [];
  // The member's own receipts only, as on Pulse.
  const receiptsResult = await supabase.from('member_broadcast_receipts')
    .select('broadcast_id')
    .eq('user_id', userID)
    .in('broadcast_id', notices.map((row) => row.id));
  if (receiptsResult.error) throw receiptsResult.error;
  const read = new Set(rows<{ broadcast_id: unknown }>(receiptsResult.data).flatMap((value) => (
    typeof value.broadcast_id === 'string' ? [value.broadcast_id] : []
  )));
  return notices.map((row) => ({ ...row, unread: !read.has(row.id) }));
}

type TaskRow = { id: unknown; title: unknown; status: unknown; due_date: unknown };

// The member's own open tasks in their selected chapter: primary assignee or
// co-assignee (chapter_task_assignments), read through the chapter board
// policies the web Home's "Assigned to you" list uses. Done tasks never rank.
export async function loadWhatMattersTasks(userID: string, chapterID: string | null): Promise<WhatMattersTask[]> {
  if (!chapterID) return [];
  const supabase = getSupabaseClient();
  if (!supabase) throw new Error('The secure mobile backend is not configured.');
  // BUG-UG-NATIVE-HOME-CAUGHT-UP-PAST-200-TASK-ASSIGNMENTS-20261115
  // (#8776): the window holds open tasks only. Finished assignments are left
  // out on the server (inner join to the task, status not done), so however
  // many a member has finished, an open co-assigned task is never pushed out.
  // Past the window's 200 OPEN assignments, the oldest
  // assigned (the likeliest to be overdue) stay in and the newest drop out.
  const assignmentsResult = await supabase.from('chapter_task_assignments')
    .select('task_id,chapter_tasks!inner(status)')
    .eq('assignee_id', userID)
    .eq('chapter_id', chapterID)
    .neq('chapter_tasks.status', 'done')
    .order('assigned_at', { ascending: true })
    .order('task_id')
    .limit(TASK_WINDOW);
  if (assignmentsResult.error) throw assignmentsResult.error;
  const assigned = rows<{ task_id: unknown }>(assignmentsResult.data).flatMap((value) => (
    typeof value.task_id === 'string' && /^[0-9a-f-]{36}$/i.test(value.task_id) ? [value.task_id] : []
  ));
  const owners = [`assignee_id.eq.${userID}`, ...(assigned.length ? [`id.in.(${assigned.join(',')})`] : [])].join(',');
  const tasksResult = await supabase.from('chapter_tasks')
    .select('id,title,status,due_date')
    .eq('chapter_id', chapterID)
    .neq('status', 'done')
    .or(owners)
    .order('due_date', { ascending: true, nullsFirst: false })
    .limit(TASK_WINDOW);
  if (tasksResult.error) throw tasksResult.error;
  return rows<TaskRow>(tasksResult.data).flatMap((value) => (
    typeof value.id === 'string' && value.status !== 'done'
      ? [{ id: value.id, title: typeof value.title === 'string' ? value.title : '', dueDate: typeof value.due_date === 'string' ? value.due_date : null }]
      : []
  ));
}
