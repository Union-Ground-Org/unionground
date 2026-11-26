// UX-UG-WEB-FIRST-HOME-WELCOME-BACK-AND-REWARDS-ERROR-20261018.
// Two things Home used to claim that a new member's data does not support:
// "Welcome back" before there is any earlier visit to come back from, and "the
// rewards catalog could not load" when the catalog loaded and simply has no
// tier ladder. Both are decided from what the snapshot already holds.

// A member has been here before when something in their own snapshot shows
// activity: points, a streak, a case, a notice they read, a vote or survey
// answer, or an event RSVP. A brand-new account has none of these. Only signals
// a cold Home load reads count: conversations arrive with the Messages
// resources, so counting them made the greeting depend on whether Messages had
// opened earlier in the session. RSVPs live on events, not on plan items
// (ballots, surveys and lessons).
export function hasPriorActivity(data) {
  const rewards = data?.rewards;
  if (Number(rewards?.totalPoints) > 0 || Number(rewards?.weekStreak) > 0) return true;
  if ((data?.cases?.length ?? 0) > 0) return true;
  if ((data?.notifications ?? []).some((item) => item?.read_at)) return true;
  if ((data?.events ?? []).some((event) => Boolean(event?.rsvpStatus))) return true;
  return (data?.planItems ?? []).some((item) => Boolean(item?.receiptCode || item?.selectedOption));
}

export const homeGreetingKey = (data) => (hasPriorActivity(data) ? "today.welcomeBack" : "today.welcome");
