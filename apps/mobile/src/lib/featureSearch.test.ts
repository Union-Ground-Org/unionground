// BUG-UG-NATIVE-FEATURE-SEARCH-MISSES-EXISTING-FEATURES-20261111: the
// terms people searched All features for in the Nov 8-10 campaign, each found
// on the deck they used.
import { describe, expect, it } from 'vitest';
import { featureGroupsForHat, featureMatchesSearch, MEMBER_FEATURE_GROUPS, normalizeFeatureSearch, withMyCampaignGroup } from './hatFunctions';
import type { HatFunctionGroup } from './hatFunctions';

function search(groups: HatFunctionGroup[], query: string): string[] {
  return groups.flatMap((group) => group.items).filter((item) => featureMatchesSearch(item, query)).map((item) => item.key);
}

const memberDeck = withMyCampaignGroup(MEMBER_FEATURE_GROUPS);
const stewardDeck = withMyCampaignGroup(featureGroupsForHat('steward'));

describe('All features search', () => {
  it.each([
    ['Org structure', 'my-campaign'],
    ['Compass', 'rights'],
    ['notice', 'notifications'],
    ['Activity', 'notifications'],
    ['Sign out', 'settings'],
    ['Account', 'settings'],
    ['Notifications', 'notifications'],
    ['Settings', 'settings'],
  ])('finds %s on the worker deck', (query, key) => {
    expect(search(memberDeck, query)).toContain(key);
  });

  it.each(['Tasks', 'task', 'TASK '])('finds Campaign work for %s on a staff deck', (query) => {
    expect(search(stewardDeck, query)).toContain('tasks');
  });

  it('still matches by label, ignores case and keeps every row for an empty query', () => {
    expect(search(memberDeck, 'ORGANIZING ri')).toEqual(['rights']);
    expect(search(memberDeck, '   ')).toHaveLength(memberDeck.flatMap((group) => group.items).length);
  });

  it('adds no destination the deck does not already list', () => {
    // A member deck has no chapter-work board, and no native membership card exists.
    expect(search(memberDeck, 'tasks')).toEqual([]);
    expect(search(memberDeck, 'card')).toEqual([]);
    expect(search(memberDeck, 'zzz')).toEqual([]);
  });

  it('folds accents, issue and spacing', () => {
    expect(normalizeFeatureSearch('  Acción   Cívica ')).toBe('accion civica');
  });
});
