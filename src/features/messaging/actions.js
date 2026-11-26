// Presentation consumes server capabilities; it never computes edit eligibility.
export const MESSAGE_QUICK_ACTION = 'like';

// Web rows resolve control text from the catalogue through these keys. Native
// keeps printing `label`, which stays the English contract (apps/mobile is
// not expected to speak Spanish). `save` shares an id across both labels, so
// lookup is by the English label rather than by id.
export const MESSAGE_ACTION_LABEL_KEYS = Object.freeze({
  Reply: 'inbox.reply',
  'Edit message': 'inbox.editMessage',
  React: 'inbox.react',
  'Save message': 'inbox.saveMessage',
  'Unsave message': 'inbox.unsaveMessage',
  'Remind me…': 'inbox.remindMe',
  'Remove reminders': 'inbox.removeReminders',
});

export function messageActionLabelKey(choice) {
  return MESSAGE_ACTION_LABEL_KEYS[choice?.label] ?? '';
}

export function messageActionChoices(state) {
  if (!state) return [];
  return [
    { id: 'reply', label: 'Reply' },
    ...(state.canEdit === true ? [{ id: 'edit', label: 'Edit message' }] : []),
    { id: 'react', label: 'React' },
    { id: 'save', label: state.saved ? 'Unsave message' : 'Save message' },
    // `remind` only opens a time chooser on every client; the `remind` request
    // below carries the ISO instant the member confirmed. The id and the wire
    // protocol are unchanged, only the label says a choice follows.
    { id: state.reminders?.length ? 'unremind' : 'remind', label: state.reminders?.length ? 'Remove reminders' : 'Remind me…' },
  ];
}

// Reminder time bounds a client checks before it offers Confirm. The database
// is the authority (public.create_member_message_reminder refuses a time at or
// before now() or after now() + 1 year, 20260925140000_message_action_write_bounds.sql);
// these mirror it so the member reads the reason instead of a generic refusal.
// The lead absorbs the request's own flight time, and the horizon stays a day
// inside the year so a skewed device clock cannot turn a valid pick into a
// refusal.
export const MESSAGE_REMINDER_MIN_LEAD_MS = 60 * 1000;
export const MESSAGE_REMINDER_MAX_AHEAD_MS = 364 * 24 * 60 * 60 * 1000;

/**
 * @param {number} remindAtMs epoch milliseconds of the chosen instant
 * @param {number} [nowMs]
 * @returns {null | 'invalid' | 'past' | 'far'} null when the instant is acceptable
 */
export function messageReminderProblem(remindAtMs, nowMs = Date.now()) {
  if (!Number.isFinite(remindAtMs)) return 'invalid';
  if (remindAtMs < nowMs + MESSAGE_REMINDER_MIN_LEAD_MS) return 'past';
  if (remindAtMs > nowMs + MESSAGE_REMINDER_MAX_AHEAD_MS) return 'far';
  return null;
}

/**
 * @param {string | null} value
 * @returns {Promise<unknown>}
 */
export async function messageActionRequest(client, sourceKind, messageId, action, value = null) {
  if (!client || !['private', 'channel'].includes(sourceKind) || !messageId) throw new Error('Message unavailable.');
  const target = { p_source_kind: sourceKind, p_message_id: messageId };
  const request = action === 'state'
    ? ['get_member_message_actions', target]
    : action === 'reply'
      ? ['reply_to_member_message', { ...target, p_body: value }]
      : action === 'edit' && sourceKind === 'private'
        ? ['edit_member_message', { p_message_id: messageId, p_body: value }]
        : ['act_on_member_message', { ...target, p_action: action, p_value: value }];
  const { data, error } = await client.rpc(request[0], request[1]);
  if (error) throw error;
  if (!data) throw new Error('Message action was not confirmed.');
  return data;
}
