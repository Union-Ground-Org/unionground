// Maps a shared in-app workflow href (/m/…) onto the native route that opens
// the same authorized record, preserving the exact selected message/post/task
// identifier as a query parameter the target screen consumes for authorized
// hydration. Anything that cannot be opened honestly in the native shell
// returns null so the caller shows an explicit notice instead of pushing a
// route that would drop the selected row or select another identity.
//
// Precedence mirrors src/features/connectedWorkflows/navigation.js
// (workflowReferenceFromHref): an exact message first (taskThread → task
// conversation, otherwise conversation/thread), then post (tested before the
// bare thread/conversation anchor), then event, then taskThread / task, then
// the bare thread or conversation record.

import { isSafeInAppRoute } from '../../../../src/features/connectedWorkflows/api.js';

// Ids we are willing to place in a route path: uuids (messages, tasks,
// conversations, channels) and the text event ids (a-z0-9 and dashes).
const ROUTE_ID_RE = /^[A-Za-z0-9_-]{1,128}$/;

function segment(id: string | null | undefined): string | null {
  if (!id || !ROUTE_ID_RE.test(id)) return null;
  return encodeURIComponent(id);
}

/** A native route string for the record behind `href`, or null if unmappable. */
export function nativeWorkflowRoute(href: unknown): string | null {
  if (typeof href !== 'string' || !isSafeInAppRoute(href)) return null;
  const url = new URL(href, 'https://workflow.invalid');
  if (!['/m/messages', '/m/steward', '/m/organize', '/m/tasks', '/m/events'].includes(url.pathname)) return null;
  const query = url.searchParams;

  // Exact message landings keep the message id for hydration/scrolling. The
  // message branch precedes post and the bare thread/conversation branches the
  // same way workflowReferenceFromHref orders its kind detection.
  if (query.has('message')) {
    if (query.has('taskThread') || (url.pathname === '/m/messages' && query.has('task'))) {
      // task_message: taskThread carries the task id (the task alias).
      const task = segment(query.get('taskThread') ?? query.get('task'));
      const message = segment(query.get('message'));
      return task && message ? `/task-conversation/${task}?message=${message}` : null;
    }
    const conversation = segment(query.get('conversation')) ?? segment(query.get('thread'));
    const message = segment(query.get('message'));
    if (!conversation || !message) return null;
    return `/conversation/${conversation}?message=${message}`;
  }

  // Exact channel post: tested before the bare thread/conversation anchor, so
  // /m/organize?thread=x&post=y never collapses into a private conversation.
  if (query.has('post')) {
    const channel = segment(query.get('channel')) ?? segment(query.get('space')) ?? segment(query.get('thread'));
    const post = segment(query.get('post'));
    return channel && post ? `/channel/${channel}?post=${post}` : null;
  }

  if (query.has('event')) {
    const event = segment(query.get('event'));
    return event ? `/feature/events?source=${event}` : null;
  }

  // Task conversation with no exact message still opens the task alias route.
  if (query.has('taskThread') || (url.pathname === '/m/messages' && query.has('task'))) {
    const task = segment(query.get('taskThread') ?? query.get('task'));
    return task ? `/task-conversation/${task}` : null;
  }

  if (query.has('task')) {
    const task = segment(query.get('task'));
    return task ? `/feature/tasks?source=${task}` : null;
  }

  if (query.has('conversation') || query.has('thread')) {
    const conversation = segment(query.get('conversation')) ?? segment(query.get('thread'));
    return conversation ? `/conversation/${conversation}` : null;
  }

  return null;
}

/** The canonical focused-task route for a task the facade already linked. */
export function nativeTaskRoute(taskId: string): string | null {
  const task = segment(taskId);
  return task ? `/feature/tasks?source=${task}` : null;
}

/** The canonical task-conversation route, keeping an exact message id. */
export function nativeTaskConversationRoute(taskId: string, messageId?: string | null): string | null {
  const task = segment(taskId);
  if (!task) return null;
  const message = messageId ? segment(messageId) : null;
  if (messageId && !message) return null;
  return `/task-conversation/${task}${message ? `?message=${message}` : ''}`;
}
