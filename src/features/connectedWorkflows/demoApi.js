// Local SAMPLE projection. It is created only by the fixture branch in App;
// live sessions always use the server facade. No source bodies enter metadata.
export function createDemoConnectedWorkflowApi({ getData, getStaffData = () => null, state, isStaff, createTask, sendTaskMessage }) {
  const unavailable = () => ({ available: false, reason: 'source_unavailable' });
  function source(ref) {
    const data = getData();
    if ((ref.chapterId && ref.chapterId !== data.member.chapterId)
      || (ref.organizationId && ref.organizationId !== data.member.organizationId)) return null;
    if (ref.kind === 'event') return (data.events || []).find((row) => row.id === ref.id);
    if (ref.kind === 'task') return (data.tasks || []).find((row) => row.id === ref.id && !row.deletedAt);
    if (ref.kind === 'private_message') {
      const own = (data.conversations || []).find((row) => row.messages?.some((message) => message.id === ref.id));
      const staff = !own && isStaff() ? (getStaffData()?.threads || []).find((row) => row.messages?.some((message) => message.id === ref.id)) : null;
      const conversation = own || staff;
      const message = conversation?.messages.find((row) => row.id === ref.id);
      return message && { ...message, conversationId: conversation.id, staff: Boolean(staff) };
    }
    if (ref.kind === 'channel_post') {
      const thread = (data.product?.spaces || []).flatMap((space) => space.threads || []).find((row) => row.posts?.some((post) => post.id === ref.id));
      const post = thread?.posts.find((row) => row.id === ref.id);
      return post && { ...post, threadId: thread.id };
    }
    if (ref.kind === 'task_message') return (data.taskMessages || []).find((row) => row.id === ref.id && [row.senderId, row.recipientId].includes(data.member.id));
    return null;
  }
  function audience(ref) {
    const task = source(ref);
    if (ref.kind !== 'task' || !task) return [];
    const data = getData();
    const mine = data.member.id;
    const other = task.createdBy === mine ? task.assigneeId : task.assigneeId === mine ? task.createdBy : null;
    if (!other || other === mine) return [];
    const person = (data.taskAssignees || []).find((row) => row.id === other);
    return [{ id: other, label: person?.fullName || task.assigneeName || 'Task participant' }];
  }
  const api = {
    async context(ref) {
      const row = source(ref);
      if (!row) return unavailable();
      const task = ref.kind === 'task';
      const event = ref.kind === 'event';
      const attachment = (getData().taskAttachments || []).find((item) => item.sourceKind === (ref.kind === 'private_message' ? 'message' : ref.kind) && item.sourceId === ref.id);
      const linked = state.tasks.get(`${ref.kind}:${ref.id}`) || (attachment && { task: (getData().tasks || []).find((item) => item.id === attachment.taskId) })
        || (ref.kind === 'task_message' && { task: (getData().tasks || []).find((item) => item.id === row.taskId) });
      const href = task ? `/m/tasks?task=${encodeURIComponent(ref.id)}`
        : event ? `/m/events?event=${encodeURIComponent(ref.id)}`
          : ref.kind === 'private_message' ? `/m/${row.staff ? 'steward?thread' : 'messages?conversation'}=${encodeURIComponent(row.conversationId)}&message=${encodeURIComponent(ref.id)}`
            : ref.kind === 'channel_post' ? `/m/messages?channel=${encodeURIComponent(row.threadId)}&post=${encodeURIComponent(ref.id)}`
              : `/m/messages?taskThread=${encodeURIComponent(row.taskId)}&message=${encodeURIComponent(ref.id)}`;
      return { available: true, kind: ref.kind, id: ref.id,
        href,
        canMessage: audience(ref).length > 0, canRemind: !row.cancelledAt && !row.redacted_at,
        canCreateTask: ['event', 'private_message', 'channel_post'].includes(ref.kind) && !row.redacted_at && isStaff(), linkedTask: linked?.task || null,
        discussionHref: task && audience(ref).length ? `/m/messages?task=${encodeURIComponent(ref.id)}` : null,
        sourceLinks: state.sources.get(ref.id) || [], cancelled: Boolean(row.cancelledAt),
        timezone: event ? { startsAt: row.startsAt, basis: 'instant' } : null,
        organizer: event ? state.organizers?.get(ref.id) || null : null, contactOptIn: state.optIns?.get(ref.id) || false,
        canManageOrganizer: event && isStaff(), canContactOptIn: event && (state.optIns?.get(ref.id) || (!row.cancelledAt && row.rsvpStatus === 'going' && state.organizers?.get(ref.id))), samplePreview: true };
    },
    async eventOrganizerCandidates(eventId) {
      if (!source({ kind: 'event', id: eventId }) || !isStaff()) throw new Error('Unavailable');
      return { items: (getData().chapterStewards || []).filter((person) => person.chapterId === getData().member.chapterId && person.contact?.conversation).map((person) => ({ id: person.id, label: person.name })), nextCursor: null };
    },
    async setEventOrganizer(eventId, organizerId) {
      const page = await api.eventOrganizerCandidates(eventId);
      const person = page.items.find((row) => row.id === organizerId);
      if (organizerId && !person) throw new Error('Unavailable');
      if (state.organizers?.get(eventId)?.id !== organizerId) state.optIns?.delete(eventId);
      state.organizers ||= new Map(); state.organizers.set(eventId, person);
      return { organizer: person };
    },
    async setEventContactOptIn(eventId, enabled, expectedOrganizerId) {
      const current = await api.context({ kind: 'event', id: eventId });
      if (!current.available || (enabled && (!current.canContactOptIn || current.organizer?.id !== expectedOrganizerId))) throw new Error('Unavailable');
      state.optIns ||= new Map(); state.optIns.set(eventId, Boolean(enabled));
      return { contactOptIn: Boolean(enabled) };
    },
    async recipients(ref) { return { items: source(ref) ? audience(ref) : [], nextCursor: null }; },
    async createTask(ref) {
      if (!(await api.context(ref)).canCreateTask || !isStaff()) throw new Error('Unavailable');
      const key = `${ref.kind}:${ref.id}`;
      if (state.tasks.has(key)) return { ...await state.tasks.get(key), created: false };
      const pending = createTask(ref.kind === 'private_message' ? 'message' : ref.kind, ref.id);
      // Cache the pending operation as well, so independently mounted menus converge.
      state.tasks.set(key, pending);
      try {
        const result = await pending;
        state.tasks.set(key, result);
        state.sources.set(result.task.id, [{ reference: ref, label: ref.kind === 'event' ? 'Calendar event' : ref.kind === 'channel_post' ? 'Channel post' : 'Message' }]);
        return result;
      } catch (error) { state.tasks.delete(key); throw error; }
    },
    async remind(ref, remindAt) {
      const current = await api.context(ref);
      if (!current.canRemind || !(Date.parse(remindAt) > Date.now())) throw new Error('Unavailable');
      const existing = [...state.reminders.values()].find((row) => row.kind === ref.kind && row.sourceId === ref.id && row.remindAt === remindAt && row.status === 'scheduled');
      if (existing) return { reminder: existing, created: false };
      const reminder = { id: crypto.randomUUID(), kind: ref.kind, sourceId: ref.id, reference: ref, remindAt, status: 'scheduled' };
      state.reminders.set(reminder.id, reminder);
      return { reminder, created: true };
    },
    async send(ref, recipientIds, body, requestId) {
      if (!requestId || !body.trim() || !recipientIds.length || recipientIds.some((id) => !audience(ref).some((person) => person.id === id))) throw new Error('Unavailable');
      if (state.sends.has(requestId)) return state.sends.get(requestId);
      const pending = sendTaskMessage(ref.id, body);
      state.sends.set(requestId, pending);
      try { await pending; return { sent: true, samplePreview: true }; }
      catch (error) { state.sends.delete(requestId); throw error; }
    },
    async listReminders() {
      return { items: [...state.reminders.values()].filter((row) => ['scheduled', 'delivered'].includes(row.status)), nextCursor: null };
    },
    async updateReminder(id, action, remindAt) {
      const row = state.reminders.get(id);
      if (!row) throw new Error('Unavailable');
      if (action === 'open') return api.context(row.reference);
      if (action === 'snooze') {
        if (!(await api.context(row.reference)).canRemind || !(Date.parse(remindAt) > Date.now())) throw new Error('Unavailable');
        Object.assign(row, { remindAt, status: 'scheduled' });
      } else if (['complete', 'cancel'].includes(action)) row.status = action === 'complete' ? 'completed' : 'cancelled';
      else throw new Error('Unavailable');
      return { reminder: row };
    },
  };
  return api;
}
