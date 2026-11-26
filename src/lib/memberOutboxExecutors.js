import { markBroadcastRead, markConversationRead, markNotificationsRead, saveRightsProgress, submitEventRsvp, updateMemberProfile, updateMemberSettings } from "./memberApi.js";

// replayQueue invokes these in the same synchronous turn as stillActing().
// Read the current actor now; never store a token in the persisted queue or
// look up the actor after an await. The API validates that actor against Auth
// and pins the checked member's fresh token on every request.
export function createMemberOutboxExecutors(client, readSession) {
  const bind = (write) => (args) => {
    const session = readSession();
    const asUser = { userId: session?.user?.id ?? null, accessToken: session?.access_token ?? null };
    return write(args, { asUser });
  };
  return {
    rsvp: bind((args, options) => submitEventRsvp(client, args.eventId, args.status, options)),
    rightsProgress: bind((args, options) => saveRightsProgress(client, args.userId, args.lessonId, args.completedSteps, options)),
    broadcastRead: bind((args, options) => markBroadcastRead(client, args.userId, args.broadcastId, options)),
    conversationRead: bind((args, options) => markConversationRead(client, args.userId, args.conversationId, options)),
    notificationsRead: bind((args, options) => markNotificationsRead(client, args.userId, options)),
    settings: bind((args, options) => updateMemberSettings(client, args.userId, args.fields, options)),
    profile: bind((args, options) => updateMemberProfile(client, args.userId, args.fields, options)),
  };
}
