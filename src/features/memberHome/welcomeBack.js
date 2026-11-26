// REQ-UG-REACTIVATION-WELCOME-BACK-20261001.
//
// The old app greeted a member returning after more than 21 days away with one
// calm welcome-back screen instead of the full dashboard
// (de7df4b57c^:components/home/reactivation-hero.tsx) and picked ONE next step
// for them (components/home/lib/reactivation-cta.ts), first match wins:
//   1. unread updates  -> catch up on them
//   2. an open poll    -> vote
//   3. this week's (or the next) event -> see what is happening
//   4. an active case  -> review it
//   5. otherwise       -> member resources (Know your rights)
//
// The server decides whether this visit is a welcome back
// (public.record_member_home_return, one last-active date per account, no page
// views). Everything here is pure; native imports it through a typed seam.

export const WELCOME_BACK_SWITCH = "features.home.reactivation_welcome_back";
export const WELCOME_BACK_RPC = "record_member_home_return";

const DAY_MS = 86_400_000;

/**
 * @param {unknown} payload
 * @returns {{ enabled: boolean, welcomeBack: boolean, afterDays: number | null }}
 */
export function normalizeWelcomeBack(payload) {
  if (!payload || typeof payload !== "object") return { enabled: false, welcomeBack: false, afterDays: null };
  const value = /** @type {Record<string, unknown>} */ (payload);
  return {
    enabled: value.enabled === true,
    welcomeBack: value.enabled === true && value.welcomeBack === true,
    afterDays: Number.isInteger(value.afterDays) ? /** @type {number} */ (value.afterDays) : null,
  };
}

/**
 * Inputs are already-loaded member data, so the screen adds no request.
 * @param {{ unreadUpdates?: number, newestUpdateTitle?: string | null,
 *   openPolls?: ReadonlyArray<{ id: string, title: string }>,
 *   events?: ReadonlyArray<{ id: string, title: string, startsAt: string }>,
 *   activeCases?: ReadonlyArray<{ id: string, reference?: string | null, title?: string | null }>,
 *   now?: Date }} input
 * @returns {any}
 */
export function resolveWelcomeBackStep({ unreadUpdates = 0, newestUpdateTitle = null, openPolls = [], events = [], activeCases = [], now = new Date() } = {}) {
  if (unreadUpdates > 0) return { kind: "updates", count: unreadUpdates, title: newestUpdateTitle };
  const poll = (openPolls ?? [])[0];
  if (poll) return { kind: "poll", id: String(poll.id), title: String(poll.title ?? "") };
  const nowMs = now.getTime();
  const upcoming = (events ?? [])
    .filter((item) => Number.isFinite(Date.parse(item?.startsAt)) && Date.parse(item.startsAt) >= nowMs)
    .sort((a, b) => Date.parse(a.startsAt) - Date.parse(b.startsAt));
  const event = upcoming.find((item) => Date.parse(item.startsAt) <= nowMs + 7 * DAY_MS) ?? upcoming[0];
  if (event) return { kind: "event", id: String(event.id), title: String(event.title ?? ""), startsAt: event.startsAt };
  const activeCase = (activeCases ?? [])[0];
  if (activeCase) return { kind: "case", id: String(activeCase.id), reference: activeCase.reference ?? null, title: activeCase.title ?? null };
  return { kind: "resources" };
}
