import { describe, expect, it } from 'vitest';

import { collectiveActionGoalSave, parseCollectiveActionGoal } from './collectiveActionGoal';

// BUG-UG-COLLECTIVE-ACTION-GOAL-FIXED-AT-100-20261111 (#8220).
describe('native collective action goal', () => {
  it('accepts only a whole number of people the server allows', () => {
    expect(parseCollectiveActionGoal('61')).toBe(61);
    expect(parseCollectiveActionGoal(' 250 ')).toBe(250);
    expect(parseCollectiveActionGoal('1000000')).toBe(1_000_000);
    for (const value of ['', ' ', '0', '-5', '6.5', '1e3', '1000001', '61 people', 'abc']) {
      expect(parseCollectiveActionGoal(value)).toBeNull();
    }
  });

  it('corrects only the goal, resending the action as it is', () => {
    expect(collectiveActionGoalSave({
      id: 'a-1', chapterId: 'harbor', kind: 'pledge', title: 'Safe staffing', summary: 'Sign by Friday.',
      status: 'published', startsAt: '2026-11-12T14:00:00Z', endsAt: null,
    }, 61)).toEqual({
      p_id: 'a-1', p_chapter_id: 'harbor', p_action_kind: 'pledge', p_title: 'Safe staffing', p_summary: 'Sign by Friday.',
      p_status: 'published', p_target_count: 61, p_starts_at: '2026-11-12T14:00:00Z', p_ends_at: null,
    });
  });

  // The create form's goal and the editor's Change goal are executed in
  // features/mi1/collectiveActionGoal.screen.test.tsx (#8319).
});
