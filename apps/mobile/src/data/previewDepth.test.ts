import { describe, expect, it } from 'vitest';
import {
  PREVIEW_CHAPTERS,
  PREVIEW_CHAPTER_ACTIVITY,
  PREVIEW_HEALTH_PORTFOLIO,
  previewConversationThread,
  previewDashboardFor,
} from './preview';

// The involved-messages and Home-depth wave (owner feedback 2026-08-25):
// direct threads read as authored multi-turn organizing arcs, and the Home
// canvas has a deep, deterministic campaign-activity archive to scroll.

describe('storyline conversations', () => {
  it('gives the worker hat involved multi-turn organizer and committee threads', () => {
    const conversations = previewDashboardFor('member').conversations;
    expect(conversations.length).toBeGreaterThanOrEqual(5);
    const deepThreads = conversations
      .map((item) => previewConversationThread(item.id, 'member'))
      .filter((thread) => (thread?.messages.length ?? 0) >= 6);
    expect(deepThreads.length).toBeGreaterThanOrEqual(3);
    for (const thread of deepThreads) {
      // A real back-and-forth, not a monologue: the worker and the
      // organizer or committee member both speak.
      expect(thread!.messages.some((message) => message.senderKind === 'member')).toBe(true);
      expect(thread!.messages.some((message) => message.senderKind === 'steward')).toBe(true);
      expect(thread!.messages.some((message) => message.senderName === 'Darnell Foster')).toBe(true);
    }
    // Distinct storylines, not one script repeated with new names.
    const openers = new Set(deepThreads.map((thread) => thread!.messages[0]!.body));
    expect(openers.size).toBe(deepThreads.length);
  });

  it('gives the worker a private committee conversation', () => {
    const conversations = previewDashboardFor('member').conversations;
    const committee = conversations.find((item) => /committee/i.test(item.title) && /private/i.test(item.title));
    expect(committee).toBeDefined();
    const thread = previewConversationThread(committee!.id, 'member');
    expect(thread!.messages.some((message) => message.senderKind === 'member')).toBe(true);
    expect(thread!.messages.some((message) => message.senderKind === 'steward')).toBe(true);
  });

  it('carries the committee intake threads as full arcs whose previews still match', () => {
    for (const summary of previewDashboardFor('steward').conversations.slice(0, 2)) {
      const thread = previewConversationThread(summary.id, 'steward');
      expect(thread, summary.title).not.toBeNull();
      expect(thread!.messages.length).toBeGreaterThanOrEqual(6);
      expect(thread!.messages[thread!.messages.length - 1]!.body).toBe(summary.latestMessage);
    }
  });

  it('carries the organizer threads as full arcs whose previews still match', () => {
    for (const summary of previewDashboardFor('organizer').conversations.slice(0, 2)) {
      const thread = previewConversationThread(summary.id, 'organizer');
      expect(thread, summary.title).not.toBeNull();
      expect(thread!.messages.length).toBeGreaterThanOrEqual(6);
      expect(thread!.messages[thread!.messages.length - 1]!.body).toBe(summary.latestMessage);
      expect(thread!.messages.some((message) => message.senderName === 'Elena Cruz')).toBe(true);
    }
  });
});

describe('campaign activity feed', () => {
  it('is deep enough for many pages and spans the rolling history', () => {
    expect(PREVIEW_CHAPTER_ACTIVITY.length).toBeGreaterThan(120);
    const kinds = new Set(PREVIEW_CHAPTER_ACTIVITY.map((item) => item.kind));
    expect(kinds).toEqual(new Set(['broadcast', 'event', 'ballot']));
    expect(PREVIEW_CHAPTER_ACTIVITY.some((item) => item.when.includes('2023'))).toBe(true);
    const ids = new Set(PREVIEW_CHAPTER_ACTIVITY.map((item) => item.id));
    expect(ids.size).toBe(PREVIEW_CHAPTER_ACTIVITY.length);
  });

  it('keeps every feed vote a committee poll whose responses stay under the coworkers reached', () => {
    const ballots = PREVIEW_CHAPTER_ACTIVITY.filter((item) => item.kind === 'ballot');
    expect(ballots.length).toBeGreaterThan(0);
    for (const ballot of ballots) {
      expect(ballot.title).toMatch(/^Committee poll: /);
      expect(ballot.title).not.toMatch(/recogni|certif|ratif/i);
      expect(Number(/^(\d+) responses$/.exec(ballot.detail)?.[1])).toBeLessThanOrEqual(151);
    }
    expect(PREVIEW_CHAPTER_ACTIVITY.filter((item) => item.kind === 'broadcast')
      .every((item) => item.title.startsWith('Harborview Care United weekly: '))).toBe(true);
  });
});

describe('campaign landing depth', () => {
  it('seeds every campaign and every shared landing collection', () => {
    expect(PREVIEW_CHAPTERS.map((item) => item.name)).toEqual([
      'Harborview Care United', 'North County Transit Workers', 'Metro Dispatch Committee',
    ]);
    expect(PREVIEW_CHAPTERS.filter((item) => item.current).map((item) => item.id)).toEqual(['hbv']);
    // Harborview's eligible estimate matches the campaign snapshot.
    expect(PREVIEW_CHAPTERS[0]!.memberCount).toBe(184);
    expect(PREVIEW_CHAPTERS.reduce((sum, campaign) => sum + campaign.memberCount, 0)).toBe(478);
    for (const campaign of PREVIEW_CHAPTERS) {
      expect(campaign.activity, campaign.id).toHaveLength(8);
      expect(campaign.sharedResources, campaign.id).toHaveLength(4);
    }
  });

  it('keeps one small protected cohort in the campaign health portfolio', () => {
    const shown = PREVIEW_HEALTH_PORTFOLIO.find((entry) => !entry.cohortProtected);
    expect(shown?.chapterName).toBe('Harborview Care United');
    expect(shown?.memberCount).toBe(184);
    const protectedEntries = PREVIEW_HEALTH_PORTFOLIO.filter((entry) => entry.cohortProtected);
    expect(protectedEntries).toHaveLength(1);
    expect(protectedEntries[0]).toMatchObject({ memberCount: null, score: null, drivers: null, trend: [] });
  });

  it('contains no sample labels or identifiers in native preview data', () => {
    expect(JSON.stringify(PREVIEW_CHAPTERS).toLowerCase()).not.toContain('sample');
  });
});
