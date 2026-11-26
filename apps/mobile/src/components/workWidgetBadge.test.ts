import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import type { DemoChannel } from '../data/demoChannels';
import type { MemberDashboard } from '../models/member';
import { messagesWorkWidgetModel } from '../models/member';

// DEBT-UG-WORK-WIDGET-BADGE-OVERDUE-BRANCH-IS-UNREACHABLE-20260920:
// the Work widget badge painted itself in the destructive token whenever its
// text contained "overdue", but no badge producer can emit that word — the
// deadline widget carries urgency on the row tone instead. These pins
// enumerate the producers and hold the styling to a path a producer reaches.

const widgets = readFileSync(fileURLToPath(new URL('./WorkWidgets.tsx', import.meta.url)), 'utf8');

// The `badge:` entries of the objects rowsFor returns: the complete set of
// texts the badge can ever be handed.
function badgeProducers(): string[] {
  // `(?!\{)` skips the StyleSheet entry of the same name.
  return [...widgets.matchAll(/^\s*badge: (?!\{)(.+),$/gm)].map((match) => match[1] ?? '');
}

// The badge's own JSX, so the pins below read its styling and not the row
// tone dot, which does branch on an explicit `tone` field.
function badgeMarkup(): string {
  const start = widgets.indexOf('{widget.badge ? (');
  const end = widgets.indexOf(') : null}', start);
  expect(start).toBeGreaterThan(-1);
  expect(end).toBeGreaterThan(start);
  return widgets.slice(start, end);
}

describe('Work widget badge contract', () => {
  it('has exactly the three badge producers this contract enumerates', () => {
    expect(badgeProducers()).toEqual([
      'messages.badge',
      'metrics.openCases > 0 ? `${metrics.openCases} open` : undefined',
      'openTasks.length ? `${openTasks.length} open` : undefined',
    ]);
  });

  it('emits only counted "unread" and "open" text, never an overdue word', () => {
    for (const producer of badgeProducers()) {
      expect(producer).not.toMatch(/overdue/i);
      // `messages.badge` is messagesWorkWidgetModel's, asserted below.
      if (producer === 'messages.badge') continue;
      expect(producer).toMatch(/`\$\{[^`]+\} (unread|open)`/);
    }
  });

  it('gives the messages producer the same counted "unread" shape', () => {
    const dashboard = {
      member: { id: 'member', firstName: 'Sam', fullName: 'Sam Okafor', initials: 'SO', roleLine: 'Member', memberSince: 2022, chapterID: null, language: 'en' },
      notifications: [],
      cases: [],
      conversations: [
        { id: 'c1', title: 'Steward', initials: 'CS', createdAt: '2026-08-18T12:00:00Z', updatedAt: '2026-08-18T12:00:00Z', unreadCount: 4, latestMessage: 'Reply' },
      ],
      weeklyActions: [],
    } satisfies MemberDashboard;
    const channels: DemoChannel[] = [
      { id: 'chapter', name: 'chapter-updates', unread: 2, topic: 'Chapter updates', messages: [] },
    ];

    expect(messagesWorkWidgetModel(dashboard, channels).badge).toMatch(/^\d+ unread$/);
  });

  it('paints one badge appearance, with no unreachable branch on the text', () => {
    const markup = badgeMarkup();
    expect(markup).toContain('<View style={[styles.badge, { backgroundColor: theme.primary }]}>');
    expect(markup).toContain('<Text style={[styles.badgeText, { color: theme.primaryForeground }]}>{widget.badge}</Text>');
    // No producer can reach a destructive badge, so nothing may branch on the
    // badge text. An urgent badge needs an explicit tone on rowsFor's result,
    // the way the row dot reads row.tone.
    expect(widgets).not.toMatch(/widget\.badge\.(includes|match|startsWith|endsWith|indexOf|search)\(/);
    expect(markup).not.toContain('destructive');
    // Past the `widget.badge ?` presence guard the styling is unconditional,
    // so there is no second path for a producer to leave unreached.
    expect(markup.slice(markup.indexOf('<View'))).not.toContain('?');
  });
});
