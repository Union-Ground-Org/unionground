import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import {
  LIVE_NOTIFICATION_KINDS,
  PREVIEW_NOTIFICATION_KINDS,
  notificationDestination,
  notificationGlyphRole,
  notificationKindFamily,
  peerNoticeConversation,
} from './notificationKinds';

// REQ-UNION-BASE-MOBILE-MEMBER-PARITY-20260814, findings F1 (Activity filters
// never matched live kinds) and F2 (live notifications carried no
// destination), 2026-09-26. The mobile lane ships no React
// renderer: the vocabulary is exercised here and the screen and service are
// pinned by source.

const read = (relative: string) => readFileSync(fileURLToPath(new URL(relative, import.meta.url)), 'utf8');
const screen = read('../../app/notifications.tsx');
const service = read('../services/supabase.ts');
// PHASE-2-WEB-PARITY: the database phase brings this migration in; until then
// the constraint parity case is skipped rather than reading a missing file.
const migrationPath = fileURLToPath(new URL('../../../../supabase/migrations/20260831110100_mi1_dues_ledger_mutations.sql', import.meta.url));
const migration = existsSync(migrationPath) ? readFileSync(migrationPath, 'utf8') : null;

describe('notification kind vocabulary', () => {
  it.skipIf(migration === null)('pins the live kinds to the member_notifications check constraint', () => {
    const constraint = (migration ?? '').split('member_notifications_kind_check')[2] ?? '';
    const listed = [...(constraint.split('))')[0] ?? '').matchAll(/'([a-z]+)'/g)].map((match) => match[1] ?? '');
    expect(listed).toEqual([...LIVE_NOTIFICATION_KINDS]);
  });

  it('maps every live kind and every preview kind to a filter family', () => {
    for (const kind of [...LIVE_NOTIFICATION_KINDS, ...PREVIEW_NOTIFICATION_KINDS]) {
      expect(['cases', 'messages', 'votes', 'other']).toContain(notificationKindFamily(kind));
    }
    // F1 on SAMPLE: "Case deadline approaching" (deadlines) is a Cases update
    // and "Ballot results are in" (votes) is a Votes update.
    expect(notificationKindFamily('deadlines')).toBe('cases');
    expect(notificationKindFamily('cases')).toBe('cases');
    expect(notificationKindFamily('votes')).toBe('votes');
    // The preview vocabulary keeps working.
    expect(notificationKindFamily('case')).toBe('cases');
    expect(notificationKindFamily('vote')).toBe('votes');
    expect(notificationKindFamily('message')).toBe('messages');
    for (const kind of ['general', 'forms', 'events', 'tasks', 'appointments', 'workload', 'dues', 'chapter', 'rights', 'report', 'admin', 'unknown']) {
      expect(notificationKindFamily(kind), kind).toBe('other');
    }
  });

  it('maps every live kind to a glyph role the screen draws', () => {
    for (const kind of [...LIVE_NOTIFICATION_KINDS, ...PREVIEW_NOTIFICATION_KINDS, 'unknown']) {
      expect(screen, kind).toContain(`  ${notificationGlyphRole(kind)}: '`);
    }
    expect(notificationGlyphRole('deadlines')).toBe('case');
    expect(notificationGlyphRole('votes')).toBe('vote');
    expect(notificationGlyphRole('appointments')).toBe('appointment');
    expect(notificationGlyphRole('unknown')).toBe('general');
  });

  it('gives every live kind a destination or an explicit null, never a route to protected content', () => {
    const destinations = Object.fromEntries(LIVE_NOTIFICATION_KINDS.map((kind) => [kind, notificationDestination(kind)]));
    expect(destinations).toEqual({
      general: null,
      deadlines: '/work',
      cases: '/work',
      forms: '/work',
      votes: '/feature/voting',
      events: null,
      tasks: '/work',
      appointments: '/feature/appointments',
      workload: '/work',
      // Union Ground has no dues screen; a row of the inert kind stays
      // text-only instead of opening a route that does not exist.
      dues: null,
    });
    expect(Object.values(destinations).filter((href) => href?.includes('dues'))).toEqual([]);
    // No destination ever embeds a record id: the row carries none, and the
    // destination screen reauthorizes on its own.
    for (const href of Object.values(destinations)) {
      if (href) expect(href).not.toMatch(/[0-9a-f]{8}-/u);
    }
  });
});

describe('Activity screen and dashboard service use the shared vocabulary', () => {
  it('filters on the kind family and draws icons by glyph role', () => {
    expect(screen).toContain("import { notificationGlyphRole, notificationKindFamily, type NotificationGlyphRole, type NotificationKindFamily } from '../src/lib/notificationKinds';");
    expect(screen).toContain('const matchesFilter = (item: MemberNotification) => !activeFilter.family || notificationKindFamily(item.kind) === activeFilter.family;');
    expect(screen).toContain("{ key: 'cases', family: 'cases' },");
    expect(screen).toContain("{ key: 'votes', family: 'votes' },");
    expect(screen).not.toContain("kinds: ['issue']");
    expect(screen).toContain('const kindIcons: Record<NotificationGlyphRole, keyof typeof Ionicons.glyphMap> = {');
    expect(screen).toContain('switch (notificationGlyphRole(kind)) {');
    expect(screen).toContain('name={kindIcons[notificationGlyphRole(item.kind)]} size={22}');
    expect(screen).toContain('name={kindIcons[notificationGlyphRole(item.kind)]} size={18}');
    // Opening still goes through the row's href, and a row without one stays text-only.
    expect(screen).toContain('if (!item.href || updating) return;');
  });

  it('gives live rows a kind-based href in memberNotification', () => {
    expect(service).toContain("import { notificationDestination } from '../lib/notificationKinds';");
    const mapper = service.split('function memberNotification(row: NotificationRow): MemberNotification {')[1]?.split('\n}\n')[0] ?? '';
    expect(mapper).toContain("const kind = row.kind ?? 'general';");
    expect(mapper).toContain('const href = notificationDestination(kind, row.copy_key, row.peer_conversation_id);');
    expect(mapper).toContain('...(href ? { href } : {}),');
  });
});

// BUG-UG-PRIVATE-TWO-PERSON-MESSAGES-SEND-NO-NOTIFICATION-20261118 .
describe('private two-person message notices', () => {
  const conversation = '5b0d6c2e-7f41-4c39-9a52-1f3e8d7c6b10';

  it('open their own conversation', () => {
    expect(notificationDestination('messages', 'peer.message', conversation)).toBe(`/peer-conversation/${conversation}`);
    expect(notificationDestination('messages', 'peer.message', conversation.toUpperCase())).toBe(`/peer-conversation/${conversation}`);
    expect(peerNoticeConversation('peer.message', conversation)).toBe(conversation);
  });

  it('open Messages without a well-formed conversation id, and no other notice opens a conversation', () => {
    for (const id of [null, undefined, '', 'not-a-uuid', `${conversation}/x`, `../${conversation}`]) {
      expect(notificationDestination('messages', 'peer.message', id)).toBe('/messages');
      expect(peerNoticeConversation('peer.message', id)).toBeNull();
    }
    // A channel mention keeps opening Messages even if a row carried an id.
    expect(notificationDestination('messages', 'channel.mention', conversation)).toBe('/messages');
    expect(notificationDestination('messages')).toBe('/messages');
    expect(notificationDestination('tasks', 'task.message', conversation)).toBe('/messages?show=tasks');
    expect(peerNoticeConversation('channel.mention', conversation)).toBeNull();
  });

  it('read the notice row\'s conversation id in both notification reads', () => {
    expect(service.match(/\.select\('id,title,body,kind,copy_key,peer_conversation_id,read_at,created_at'\)/g)).toHaveLength(2);
    expect(service).toContain('peer_conversation_id?: string | null;');
  });
});
