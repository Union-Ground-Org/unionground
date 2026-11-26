import { describe, expect, it } from 'vitest';
import { exactMessageHref, safeWorkflowReturn, withWorkflowReturn, workflowDestination, workflowReferenceFromHref, workspaceRouteWithTransport } from '../src/features/connectedWorkflows/navigation.js';

describe('connected workflow navigation', () => {
  it('keeps exact coordinates and return links when mirrored between desktop and companion', () => {
    const href = '/m/messages?conversation=c&message=older&returnTo=%2Fm%2Fevents%3Fevent%3De';
    const phone = workspaceRouteWithTransport(href, { demo: true, embedPhone: true });
    expect(new URL(phone, 'https://example.test').searchParams.get('message')).toBe('older');
    expect(workspaceRouteWithTransport(phone, { demo: true })).toBe(`${href}&demo=1`);
    expect(workspaceRouteWithTransport('/m/events', { demo: true, embedPhone: true })).toBe('/m/events?demo=1&embed=phone');
    expect(workspaceRouteWithTransport('//evil.test/m/events')).toBeNull();
  });
  it('distinguishes private, task and channel messages without losing the exact ID', () => {
    expect(workflowReferenceFromHref('/m/messages?conversation=c&message=m')).toMatchObject({ kind: 'private_message', id: 'm' });
    expect(workflowReferenceFromHref('/m/messages?taskThread=t&message=m')).toMatchObject({ kind: 'task_message', id: 'm' });
    expect(workflowReferenceFromHref('/m/messages?task=t&message=m')).toMatchObject({ kind: 'task_message', id: 'm' });
    expect(workflowReferenceFromHref('/m/messages?channel=c&post=p')).toMatchObject({ kind: 'channel_post', id: 'p' });
    expect(workflowReferenceFromHref('/m/messages?taskThread=t')).toMatchObject({ kind: 'task', id: 't' });
  });
  it('retains the exact selected message and scope in a return link', () => {
    const source = exactMessageHref({ conversationId: 'thread-1', messageId: 'older-message', chapterId: 'chapter-1', organizationId: 'org-1' });
    const target = withWorkflowReturn('/m/tasks/board?task=task-1', source);
    const parsed = new URL(target, 'https://example.test');
    expect(parsed.searchParams.get('returnTo')).toBe(source);
    const back = new URL(parsed.searchParams.get('returnTo'), 'https://example.test');
    expect(Object.fromEntries(back.searchParams)).toEqual({ conversation: 'thread-1', message: 'older-message', chapter: 'chapter-1', organization: 'org-1' });
  });

  it('never uses a link to grant a member task access or switch a staff hat', () => {
    expect(workflowDestination('/m/tasks?task=1', { selectedHat: 'member', staffAccess: true })).toBeNull();
    expect(workflowDestination('/m/coordinator?case=1', { selectedHat: 'steward', staffAccess: true })).toBeNull();
    expect(workflowDestination('/m/steward?thread=1', { selectedHat: 'steward', staffAccess: false })).toBeNull();
    expect(workflowDestination('/m/tasks?task=1', { selectedHat: 'steward', staffAccess: true })).toEqual({ view: 'tasks', href: '/m/tasks?task=1' });
  });

  // #9524: the stored channel-post source link opened the Messages inbox, which
  // never reads channel or post. It opens the post in Topics, as the phone does.
  it('opens a channel post source link in Topics, not the Messages inbox', () => {
    const stored = '/m/messages?channel=thread-1&post=post-2';
    for (const selectedHat of ['member', 'steward', 'admin']) {
      expect(workflowDestination(stored, { selectedHat, staffAccess: selectedHat !== 'member' })).toEqual({ view: 'hub', href: '/m/organize?thread=thread-1&post=post-2' });
    }
    expect(workflowDestination('/m/messages?channel=thread-1&post=post-2&returnTo=%2Fm%2Ftasks', {})).toEqual({ view: 'hub', href: '/m/organize?thread=thread-1&post=post-2' });
    // A post the builder could not place in a thread is still named alone; Topics finds its thread.
    expect(workflowDestination('/m/messages?channel=&post=post-2', {})).toEqual({ view: 'hub', href: '/m/organize?post=post-2' });
    // The address the hub reads is the one the reference check authorized.
    expect(workflowReferenceFromHref(workflowDestination('/m/messages?channel=c&post=p', {}).href)).toMatchObject({ kind: 'channel_post', id: 'p' });
    // Exact messages and the Topics form keep their own landings.
    expect(workflowDestination('/m/messages?conversation=c&message=m', {})).toEqual({ view: 'messages', href: '/m/messages?conversation=c&message=m' });
    expect(workflowDestination('/m/organize?thread=t&post=p', {})).toEqual({ view: 'hub', href: '/m/organize?thread=t&post=p' });
  });

  it.each(['https://evil.test/m/tasks', '//evil.test/m/tasks', '/m/\\evil', '/m/tasks\n', 'javascript:alert(1)', '/api/send', '/m/unknown'])('refuses an untrusted destination: %s', (href) => {
    expect(workflowDestination(href, { selectedHat: 'admin', staffAccess: true })).toBeNull();
  });

  it('bounds return navigation and drops nested return chains', () => {
    expect(safeWorkflowReturn('/m/events?event=one&returnTo=%2Fm%2Fmessages')).toBe('/m/events?event=one');
    expect(withWorkflowReturn('/m/events?event=one', 'https://evil.test')).toBe('/m/events?event=one');
    expect(safeWorkflowReturn('/m/events?event=' + 'x'.repeat(2000))).toBeNull();
  });
});
