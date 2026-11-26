const STAFF_HATS = new Set(['steward', 'coordinator', 'advisor', 'admin', 'vp']);
const MEMBER_DESTINATIONS = new Set(['messages', 'events', 'cases', 'voting', 'organize', 'appointments']);

// Each pane carries its own transport flags; record coordinates belong to the
// destination, never to the previous screen's query string.
export function workspaceRouteWithTransport(href, { demo = false, embedPhone = false } = {}) {
  if (typeof href !== 'string' || !href.startsWith('/') || href.startsWith('//') || href.includes('\\')) return null;
  const url = new URL(href, 'https://workflow.invalid');
  if (url.origin !== 'https://workflow.invalid') return null;
  url.searchParams.delete('embed');
  url.searchParams.delete('demo');
  if (demo) url.searchParams.set('demo', '1');
  if (embedPhone) url.searchParams.set('embed', 'phone');
  return `${url.pathname}${url.search}${url.hash}`;
}

// A return address is navigation state, never a source of authorization or a
// request to wear a different role. Only local product routes are retained.
export function safeWorkflowReturn(value) {
  if (typeof value !== 'string' || value.length > 2000 || !value.startsWith('/m/')) return null;
  if (value.includes('\\') || [...value].some((character) => character.codePointAt(0) <= 32)) return null;
  try {
    const url = new URL(value, 'https://workflow.invalid');
    if (url.origin !== 'https://workflow.invalid' || !url.pathname.startsWith('/m/')) return null;
    url.searchParams.delete('returnTo');
    return `${url.pathname}${url.search}${url.hash}`;
  } catch { return null; }
}

export function workflowDestination(href, { selectedHat = 'member', staffAccess = false } = {}) {
  const safe = safeWorkflowReturn(href);
  if (!safe) return null;
  const url = new URL(safe, 'https://workflow.invalid');
  const section = url.pathname.split('/')[2];
  if (section === 'tasks') return staffAccess && STAFF_HATS.has(selectedHat) ? { view: 'tasks', href: safe } : null;
  if (STAFF_HATS.has(section)) {
    return staffAccess && selectedHat === section ? { view: section, href: safe } : null;
  }
  if (!MEMBER_DESTINATIONS.has(section)) return null;
  // #9524: a channel post's source link is stored as
  // /m/messages?channel=<thread>&post=<post> (private.cw_resolve_source and the
  // demo builders), but channel posts live in Topics, which reads
  // ?thread=&post=. Open the post there, as the phone does; an exact message
  // keeps its own Messages landing.
  if (section === 'messages' && url.searchParams.get('post') && !url.searchParams.has('message')) {
    const topic = new URLSearchParams();
    if (url.searchParams.get('channel')) topic.set('thread', url.searchParams.get('channel'));
    topic.set('post', url.searchParams.get('post'));
    return { view: 'hub', href: `/m/organize?${topic}` };
  }
  return { view: section === 'organize' ? 'hub' : section, href: safe };
}

export function withWorkflowReturn(href, returnTo) {
  const safe = safeWorkflowReturn(href);
  if (!safe) return null;
  const url = new URL(safe, 'https://workflow.invalid');
  const back = safeWorkflowReturn(returnTo);
  if (back && back !== safe) url.searchParams.set('returnTo', back);
  return `${url.pathname}${url.search}${url.hash}`;
}

export function exactMessageHref({ conversationId, messageId, chapterId, organizationId, staff = false }) {
  if (!conversationId || !messageId) return null;
  const query = new URLSearchParams({ [staff ? 'thread' : 'conversation']: conversationId, message: messageId });
  if (chapterId) query.set('chapter', chapterId);
  if (organizationId) query.set('organization', organizationId);
  return `/m/${staff ? 'steward' : 'messages'}?${query}`;
}

export function workflowReferenceFromHref(href) {
  const safe = safeWorkflowReturn(href);
  if (!safe) return null;
  const url = new URL(safe, 'https://workflow.invalid');
  const query = url.searchParams;
  const kind = query.has('message') ? (query.has('taskThread') || query.has('task') ? 'task_message' : 'private_message')
    : query.has('post') ? 'channel_post'
      : query.has('event') ? 'event'
        : query.has('task') || query.has('taskThread') ? 'task' : null;
  const id = query.get(['private_message', 'task_message'].includes(kind) ? 'message' : kind === 'channel_post' ? 'post' : kind === 'task' && query.has('taskThread') ? 'taskThread' : kind);
  return kind && id ? { kind, id, chapterId: query.get('chapter') || undefined, organizationId: query.get('organization') || undefined } : null;
}
