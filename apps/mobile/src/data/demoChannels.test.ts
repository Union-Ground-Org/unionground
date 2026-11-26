import { describe, expect, it } from 'vitest';

import { channelStore, pollShares } from './demoChannels';

describe('preview channel history', () => {
  it('makes three complete historical years visible in every SAMPLE channel', () => {
    for (const channel of channelStore.channels()) {
      const years = new Set(channel.messages.map((message) => new Date(message.createdAt ?? '').getUTCFullYear()));
      expect(years.has(2023), channel.name).toBe(true);
      expect(years.has(2024), channel.name).toBe(true);
      expect(years.has(2025), channel.name).toBe(true);
      expect(years.has(2026), channel.name).toBe(true);
    }
  });
});

describe('preview organizing fiction', () => {
  it('seeds the Harborview Care United campaign channels', () => {
    expect(channelStore.channels().map((channel) => channel.id)).toEqual(['harborview-all', 'meeting-planning', 'committee', 'evening-shift', 'first-contract-prep']);
  });

  it('keeps notes about employer conduct in the locked committee channel only', () => {
    const committee = channelStore.channel('committee');
    expect(committee?.locked).toBe(true);
    expect(committee?.messages.some((message) => /supervisor|management/i.test(message.body))).toBe(true);
    for (const channel of channelStore.channels().filter((entry) => !entry.locked)) {
      expect(channel.messages.some((message) => /supervisor|management/i.test(message.body)), channel.name).toBe(false);
    }
  });

  it('carries no existing-union vocabulary in any seeded name, topic, author or message', () => {
    const banned = /steward|grievance|chapter|dues|weingarten|worcester|okafor|509|contract art/i;
    for (const channel of channelStore.channels()) {
      const text = [channel.name, channel.topic, ...channel.messages.flatMap((message) => [message.author, message.role ?? '', message.body, message.attachment?.name ?? '', message.attachment?.meta ?? ''])];
      for (const entry of text) expect(entry, channel.name).not.toMatch(banned);
    }
    expect(channelStore.poll().question).not.toMatch(banned);
  });
});

describe('preview channel reactions', () => {
  it('removes a reaction chip after the final in-session reaction is removed', () => {
    const message = channelStore.channel('meeting-planning')?.messages.find((entry) => entry.id === 'm2');
    expect(message).toBeDefined();
    if (!message) return;

    const reaction = { kind: 'support', emoji: '🤝', count: 1, mine: true };
    message.reactions = [...(message.reactions ?? []), reaction];

    try {
      channelStore.toggleReaction('meeting-planning', 'm2', reaction.kind);
      expect(message.reactions?.find((entry) => entry.kind === reaction.kind)).toBeUndefined();
    } finally {
      message.reactions = message.reactions?.filter((entry) => entry.kind !== reaction.kind);
    }
  });
});

// b05-13: the reviewed poll printed 32/50/18 of 105 votes — three separately
// rounded fractions, no whole-percent value behind any of them, and no rule
// making them add up. These are the properties that defect violated.
describe('poll percentages (b05-13)', () => {
  it('seeds a tally whose shares are exact whole percentages', () => {
    const poll = channelStore.poll();
    const total = poll.options.reduce((sum, option) => sum + (option.votes ?? 0), 0);
    expect(total).toBe(100);
    expect(pollShares(poll.options)).toEqual(poll.options.map((option) => option.votes));
  });

  it('always returns whole numbers that sum to 100', () => {
    const tallies = [
      [34, 47, 19],
      [34, 48, 19], // 101 votes: every share is a repeating fraction
      [1, 1, 1], // 33.33 each — the case naive rounding leaves at 99
      [2, 1], // 66.67 / 33.33 — the case naive rounding leaves at 101
      [7],
      [5, 0, 0],
    ];
    for (const votes of tallies) {
      const shares = pollShares(votes.map((count) => ({ votes: count })));
      expect(shares.every((share) => Number.isInteger(share)), `${votes} produced a fraction`).toBe(true);
      expect(shares.reduce((sum, share) => sum + share, 0), `${votes} did not total 100`).toBe(100);
      // Order is preserved and a larger tally never gets a smaller share.
      expect(shares.length).toBe(votes.length);
      for (const [index, count] of votes.entries()) {
        for (const [other, otherCount] of votes.entries()) {
          if (count > otherCount) expect(shares[index]!).toBeGreaterThanOrEqual(shares[other]!);
        }
      }
    }
  });

  it('moves when a vote moves, rather than freezing at the seeded numbers', () => {
    const poll = channelStore.poll();
    const before = pollShares(poll.options);
    channelStore.vote(2);
    try {
      const after = pollShares(poll.options);
      expect(after).not.toEqual(before);
      expect(after[2]!).toBeGreaterThan(before[2]!);
      expect(after.reduce((sum, share) => sum + share, 0)).toBe(100);
    } finally {
      channelStore.vote(2);
    }
  });

  it('reports zero for every option before the first vote', () => {
    expect(pollShares([{ votes: 0 }, { votes: 0 }])).toEqual([0, 0]);
    expect(pollShares([])).toEqual([]);
  });
});
