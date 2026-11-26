// BUG-UG-COLLECTIVE-ACTION-GOAL-FIXED-AT-100-20261111 (#8220): the
// native create form asks for the participation goal instead of sending a fixed
// 100, and an action's editor can correct it. The bounds are the server's
// (public.collective_actions.target_count between 1 and 1,000,000).

export const COLLECTIVE_ACTION_GOAL_MAX = 1_000_000;

// The typed goal as a whole number of people, or null when it is not one the
// server accepts (blank, zero, negative, a fraction or above the maximum).
export function parseCollectiveActionGoal(value: string): number | null {
  const text = value.trim();
  if (!/^\d{1,7}$/.test(text)) return null;
  const goal = Number(text);
  return goal >= 1 && goal <= COLLECTIVE_ACTION_GOAL_MAX ? goal : null;
}

export type EditableCollectiveAction = {
  id: string; chapterId: string | null; kind: string; title: string; summary: string;
  status: string; startsAt: string | null; endsAt: string | null;
};

// save_digital_action replaces every field, so a goal correction resends the
// action's own values with only the goal changed.
export function collectiveActionGoalSave(action: EditableCollectiveAction, goal: number): Record<string, unknown> {
  return {
    p_id: action.id, p_chapter_id: action.chapterId, p_action_kind: action.kind, p_title: action.title,
    p_summary: action.summary, p_status: action.status, p_target_count: goal,
    p_starts_at: action.startsAt, p_ends_at: action.endsAt,
  };
}
