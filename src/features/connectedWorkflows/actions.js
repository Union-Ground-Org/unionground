// Both clients consume the same authorized capabilities. This is presentation
// only: the server rechecks source and recipient access for every operation.
export function connectedRecordActions(context, { staffAccess = false } = {}) {
  if (!context?.available) return [];
  const actions = [];
  const kind = context.reference?.kind || context.kind;
  const organizerIdentityAllowed = kind !== 'event' || context.contactRole !== 'organizer' || staffAccess;
  if (context.canMessage && organizerIdentityAllowed) actions.push({ id: 'message', label: 'Message…' });
  if (context.canRemind) actions.push({ id: 'remind', label: 'Remind me…' });
  if (staffAccess && context.linkedTask) actions.push({ id: 'openTask', label: 'Open linked task' });
  else if (staffAccess && context.canCreateTask) actions.push({ id: 'createTask', label: 'Create follow-up task' });
  if (context.discussionHref && organizerIdentityAllowed) actions.push({ id: 'discussion', label: 'Open discussion' });
  if (context.sourceLinks?.length) actions.push({ id: 'source', label: 'Open source' });
  return actions;
}

export function connectedReminderActions(reminder) {
  if (!reminder?.id) return [];
  // A /remind here reminder (REQ-UG-REMIND-HERE-20261001) belongs to a
  // channel, not one message: nothing to open, and it cannot be snoozed.
  if (reminder.kind === 'channel_here') {
    return ['scheduled', 'delivered'].includes(reminder.status) ? [
      { id: 'complete', label: 'Complete' },
      { id: 'cancel', label: 'Cancel reminder' },
    ] : [];
  }
  return [
    { id: 'source', label: 'Open original' },
    ...(['scheduled', 'delivered', 'pending', 'sent'].includes(reminder.status) ? [
      { id: 'snooze', label: 'Snooze…' },
      { id: 'complete', label: 'Complete' },
      { id: 'cancel', label: 'Cancel reminder' },
    ] : []),
  ];
}

export function retainAuthorizedRecipients(selectedIds, recipients) {
  const allowed = new Set((recipients || []).map((recipient) => recipient.id));
  return [...new Set(selectedIds || [])].filter((id) => allowed.has(id));
}
