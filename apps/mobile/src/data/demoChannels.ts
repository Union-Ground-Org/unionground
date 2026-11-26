// Seeded organizing channels for the demo workspace (Slack-model messaging
// from the Mobbin redesign). In-memory only: reactions, poll votes, and sent
// messages persist for the app session and feed the Pulse poll card.

import { MESSAGE_REACTION_GLYPHS, isMessageReactionKind } from '../lib/messagingShared';

// BUG-UG-MESSAGE-REACTION-PARITY-20260904: the kind is the contract value
// the database stores and toggle_member_message_reaction accepts; the emoji is
// presentation resolved from the shared contract. Carrying both means the
// preview store and the live store speak the same language as the server.
export type ChannelReaction = { kind: string; emoji: string; count: number; mine: boolean };

export type ChannelMessage = {
  id: string;
  author: string;
  initials: string;
  // The organizing labels the preview seeds; liveChannels.ts maps the
  // inherited server author_role values onto COMMITTEE and CAMPAIGN CHAIR.
  role?: 'ORGANIZER' | 'COMMITTEE' | 'CAMPAIGN LEAD' | 'CAMPAIGN CHAIR' | 'ADVISOR' | 'WORKER';
  time: string;
  createdAt?: string;
  day?: string;
  newDivider?: boolean;
  body: string;
  /** Member-written Spanish version; native interface copy stays English. */
  bodyEs?: string | null;
  reactions?: ChannelReaction[];
  /** Written by the viewer: never counted as unread for them. */
  mine?: true;
  attachment?: { name: string; meta: string };
  poll?: boolean;
  threadHint?: string;
  parentMessageID?: string | null;
  /** Live store only: the post's sanitized structured mentions include the signed-in member. */
  mentionsMe?: boolean;
};

export type DemoChannel = {
  id: string;
  name: string;
  nameEs?: string | null;
  locked?: boolean;
  unread: number;
  topic: string;
  topicEs?: string | null;
  members?: number;
  messages: ChannelMessage[];
  /** Live store only: the channel has a poll whose tally could not load. */
  pollUnavailable?: boolean;
  /** Live store only: the chapter_spaces id this row belongs to; the reply RPCs take the space, not the thread row id. */
  spaceID?: string;
  /** Live store only: the thread's status is not `open`, so the workspace refuses new posts and replies in it. */
  closed?: boolean;
  /** Live store only: when chapter staff pinned this thread (set_chapter_thread_pinned). */
  pinnedAt?: string | null;
};

export type ChannelPoll = {
  closesAt?: string | null;
  question: string;
  options: { label: string; votes: number | null }[];
  mine: number | null;
};

// b05-13: the seeded tally was 34/52/19 of 105, so every percentage on screen
// was a rounded approximation of a fraction that has no whole-percent value,
// and the three rounded numbers did not have to add up. The seed now totals
// 100 votes, so the resting state is exact, and `pollShares` keeps the numbers
// honest at any other total the session reaches.
const poll: ChannelPoll = {
  question: 'Which night works for the September open meeting?',
  options: [
    { label: 'Tue · Sep 8', votes: 34 },
    { label: 'Wed · Sep 9', votes: 47 },
    { label: 'Thu · Sep 10', votes: 19 },
  ],
  mine: null,
};

/**
 * Whole-percent shares of a poll, one per option, that always sum to exactly
 * 100 and always move when a vote does (b05-13).
 *
 * Rounding each option on its own is what produced the reviewed defect: three
 * independently rounded shares can total 99 or 101, and a share whose fraction
 * sits far from a boundary does not visibly change when one vote arrives, so a
 * live poll looked frozen. Largest-remainder apportionment gives every option
 * its floor and then hands the leftover points to the largest fractions, which
 * is the same rule a seat allocation uses and the only one that keeps "these
 * are percentages of one whole" true.
 */
export function pollShares(options: readonly { votes: number | null }[]): number[] {
  if (options.some((option) => option.votes === null)) return [];
  const total = options.reduce((sum, option) => sum + (option.votes ?? 0), 0);
  if (total <= 0) return options.map(() => 0);
  const exact = options.map((option) => ((option.votes ?? 0) * 100) / total);
  const shares = exact.map((value) => Math.floor(value));
  let leftover = 100 - shares.reduce((sum, value) => sum + value, 0);
  const byRemainder = exact
    .map((value, index) => ({ index, remainder: value - Math.floor(value) }))
    // Ties go to the earlier option so the same tally always renders the same
    // way — a poll that reorders itself between renders is its own defect.
    .sort((left, right) => right.remainder - left.remainder || left.index - right.index);
  for (const entry of byRemainder) {
    if (leftover <= 0) break;
    shares[entry.index] = (shares[entry.index] ?? 0) + 1;
    leftover -= 1;
  }
  return shares;
}

// Fictional Harborview Care United campaign at Fictional Harborview Care. The
// campaign has no union and no contract yet, so channels carry issues,
// meetings and first-contract priorities. Employer-resistance notes live only
// in the locked committee channel: a channel every worker can read is the
// wrong place to keep dated accounts of who said what to whom.
const channels: DemoChannel[] = [
  {
    id: 'harborview-all',
    name: 'harborview-all',
    unread: 3,
    topic: 'campaign updates for every Harborview worker',
    members: 186,
    messages: [
      { id: 'h-2023', author: 'Jordan Kim', initials: 'JK', role: 'CAMPAIGN CHAIR', time: '6:20 PM', createdAt: '2023-09-14T18:20:00-04:00', day: 'September 14, 2023', body: 'Campaign archive: the first listening session drew coworkers from all three units. Short staffing came up at every table.' },
      { id: 'h-2024', author: 'Elena Cruz', initials: 'EC', role: 'ORGANIZER', time: '12:05 PM', createdAt: '2024-06-21T12:05:00-04:00', day: 'June 21, 2024', body: 'Campaign archive: the summer issue survey closed with answers from the day, evening and night shifts.' },
      { id: 'h-2025', author: 'Darnell Foster', initials: 'DF', role: 'WORKER', time: '9:42 AM', createdAt: '2025-11-03T09:42:00-05:00', day: 'November 3, 2025', body: 'Campaign archive: notes from the fall open meeting and the 2026 meeting calendar are filed under Campaign.' },
      { id: 'h1', author: 'Jordan Kim', initials: 'JK', role: 'CAMPAIGN CHAIR', time: '8:05 AM', createdAt: '2026-08-23T08:05:00-04:00', day: 'Today', body: 'The September open meeting agenda is posted. Bring the issues you want the committee to take up.' },
      { id: 'h2', author: 'Elena Cruz', initials: 'EC', role: 'ORGANIZER', time: '8:31 AM', createdAt: '2026-08-23T08:31:00-04:00', body: 'Six coworkers on 3 West had their first organizing conversation this week. Say hello when you see them. ✊', reactions: [{ kind: 'celebrate', emoji: '🎉', count: 7, mine: false }] },
    ],
  },
  {
    id: 'meeting-planning',
    name: 'meeting-planning',
    unread: 12,
    topic: 'open meetings and one-on-one conversations',
    members: 92,
    messages: [
      { id: 'm-2023', author: 'Andre Lewis', initials: 'AL', role: 'CAMPAIGN LEAD', time: '7:10 PM', createdAt: '2023-10-02T19:10:00-04:00', day: 'October 2, 2023', body: 'Planning archive: the committee agreed to hold campaign meetings off site and outside work time, and to plan them away from work email.' },
      { id: 'm-2024', author: 'Maya Thompson', initials: 'MT', role: 'COMMITTEE', time: '4:18 PM', createdAt: '2024-04-18T16:18:00-04:00', day: 'April 18, 2024', body: 'Planning archive: the evening meeting moved to 9:30 PM so night-shift coworkers could come after handoff.' },
      { id: 'm-2025', author: 'Elena Cruz', initials: 'EC', role: 'ORGANIZER', time: '8:32 AM', createdAt: '2025-08-27T08:32:00-04:00', day: 'August 27, 2025', body: 'Planning archive: coworkers ranked meeting times; weeknights after 7 PM finished first.' },
      { id: 'm1', author: 'Andre Lewis', initials: 'AL', role: 'CAMPAIGN LEAD', time: '4:12 PM', createdAt: '2026-08-22T16:12:00-04:00', day: 'Yesterday', body: 'Conversation tracker: 41 first conversations logged this month. If nobody on your unit has had one yet, the committee will set up times with you tomorrow.', reactions: [{ kind: 'solidarity', emoji: '✊', count: 12, mine: false }, { kind: 'like', emoji: '👍', count: 8, mine: false }] },
      { id: 'm2', author: 'Maya Thompson', initials: 'MT', role: 'COMMITTEE', time: '5:03 PM', createdAt: '2026-08-22T17:03:00-04:00', body: 'Evening shift on 3 West and 4 East reached everyone who asked for a conversation this week 🎉 Thank you to everyone who stayed after handoff.', reactions: [{ kind: 'celebrate', emoji: '🎉', count: 9, mine: true }], threadHint: '3 replies · last today' },
      { id: 'm3', author: 'Jordan Kim', initials: 'JK', role: 'CAMPAIGN CHAIR', time: '5:20 PM', createdAt: '2026-08-22T17:20:00-04:00', body: 'Before I book the library room — quick poll:', poll: true },
      { id: 'm4', author: 'Tomás Reyes', initials: 'TR', time: '8:47 AM', createdAt: '2026-08-23T08:47:00-04:00', day: 'Today', newDivider: true, body: 'Can someone repost the open meeting flyer? A few people on nights asked me what time it starts.' },
      { id: 'm5', author: 'Elena Cruz', initials: 'EC', role: 'ORGANIZER', time: '8:52 AM', createdAt: '2026-08-23T08:52:00-04:00', body: 'Here it is. It lists only the time and place, no names, so it is fine to hand to anyone.', attachment: { name: 'September-open-meeting-flyer.pdf', meta: '212 KB · English and Spanish' } },
    ],
  },
  {
    id: 'committee',
    name: 'committee',
    locked: true,
    unread: 0,
    topic: 'committee coordination (private)',
    members: 11,
    messages: [
      { id: 'k-2023', author: 'Maya Thompson', initials: 'MT', role: 'COMMITTEE', time: '3:15 PM', createdAt: '2023-12-06T15:15:00-05:00', day: 'December 6, 2023', body: 'Committee archive: year-end review of the worker list. Contact details stay in the committee workspace, never in group chats or on work devices.' },
      { id: 'k-2024', author: 'Jordan Kim', initials: 'JK', role: 'CAMPAIGN CHAIR', time: '10:00 AM', createdAt: '2024-07-12T10:00:00-04:00', day: 'July 12, 2024', body: 'Committee archive: the unit-by-unit outreach rotation and backup contacts are set through December.' },
      { id: 'k-2025', author: 'Andre Lewis', initials: 'AL', role: 'CAMPAIGN LEAD', time: '5:26 PM', createdAt: '2025-05-30T17:26:00-04:00', day: 'May 30, 2025', body: 'Committee archive: notes on the two meetings management called in May are filed with the dates, times, who ran them and what was said.' },
      { id: 'k1', author: 'Maya Thompson', initials: 'MT', role: 'COMMITTEE', time: '9:15 AM', createdAt: '2026-08-23T09:15:00-04:00', day: 'Today', body: 'A supervisor on 4 East asked two coworkers about the campaign during Tuesday’s shift huddle. I wrote down the date, time, who was there and the words used. Elena, can we go over it with Priya before Thursday?' },
    ],
  },
  {
    id: 'evening-shift',
    name: 'evening-shift',
    unread: 0,
    topic: 'evening shift issues and check-ins',
    members: 47,
    messages: [
      { id: 'e-2023', author: 'Maya Thompson', initials: 'MT', role: 'COMMITTEE', time: '1:30 PM', createdAt: '2023-03-11T13:30:00-05:00', day: 'March 11, 2023', body: 'Evening archive: the first after-shift check-in brought 18 coworkers to the diner across the street.' },
      { id: 'e-2024', author: 'Darnell Foster', initials: 'DF', role: 'WORKER', time: '11:12 AM', createdAt: '2024-09-09T11:12:00-04:00', day: 'September 9, 2024', body: 'Evening archive: the recording of the organizing-rights talk now has Spanish captions.' },
      { id: 'e-2025', author: 'Maya Thompson', initials: 'MT', role: 'COMMITTEE', time: '2:45 PM', createdAt: '2025-02-24T14:45:00-05:00', day: 'February 24, 2025', body: 'Evening archive: the first-conversation checklist is pinned for anyone new to outreach.' },
      { id: 'e1', author: 'Maya Thompson', initials: 'MT', role: 'COMMITTEE', time: '2:10 PM', createdAt: '2026-08-18T14:10:00-04:00', day: 'Tuesday', body: 'Short-staffing log sheets are ready. Write down the date, the unit and how many people were on the floor, and keep your copy at home.' },
    ],
  },
  {
    id: 'first-contract-prep',
    name: 'first-contract-prep',
    unread: 2,
    topic: 'what workers want in a first contract',
    members: 58,
    messages: [
      { id: 'f-2023', author: 'Darnell Foster', initials: 'DF', role: 'WORKER', time: '6:04 PM', createdAt: '2023-05-19T18:04:00-04:00', day: 'May 19, 2023', body: 'Priorities archive: the first issue survey put safe staffing and predictable schedules at the top.' },
      { id: 'f-2024', author: 'Elena Cruz', initials: 'EC', role: 'ORGANIZER', time: '9:08 AM', createdAt: '2024-11-15T09:08:00-05:00', day: 'November 15, 2024', body: 'Priorities archive: coworkers added holiday scheduling to the list after three years of late postings.' },
      { id: 'f-2025', author: 'Jordan Kim', initials: 'JK', role: 'CAMPAIGN CHAIR', time: '4:44 PM', createdAt: '2025-07-08T16:44:00-04:00', day: 'July 8, 2025', body: 'Priorities archive: the committee wrote plain-language goals for staffing levels and schedule notice.' },
      { id: 'f1', author: 'Priya Shah', initials: 'PS', role: 'ADVISOR', time: '11:40 AM', createdAt: '2026-08-23T11:40:00-04:00', day: 'Today', body: 'Reminder: none of this is a contract yet. These are the priorities workers would bring to the table once the union is recognized or certified and bargaining starts. 💪', reactions: [{ kind: 'strength', emoji: '💪', count: 14, mine: false }] },
    ],
  },
];

let version = 0;
const listeners = new Set<() => void>();
function emit() {
  version += 1;
  listeners.forEach((listener) => listener());
}

export const channelStore = {
  subscribe(listener: () => void) {
    listeners.add(listener);
    return () => { listeners.delete(listener); };
  },
  getVersion: () => version,
  status: () => 'ready' as const,
  error: () => null,
  loadFault: () => null,
  diagnosis: () => null,
  markReadFault: () => null,
  refresh: () => undefined,
  channels: () => channels,
  channel: (id: string) => channels.find((entry) => entry.id === id) ?? null,
  poll: () => poll,
  pollTotal: () => poll.options.reduce((sum, option) => sum + (option.votes ?? 0), 0),
  markRead(id: string) {
    const channel = channelStore.channel(id);
    if (channel && channel.unread !== 0) { channel.unread = 0; emit(); }
  },
  // A message with no reactions used to return early here, so the preview app
  // reproduced the live defect: reactions were only reachable on a message that
  // already had one. Adding the first reaction is now the ordinary path.
  toggleReaction(channelID: string, messageID: string, kind: string) {
    if (!isMessageReactionKind(kind)) return;
    const message = channelStore.channel(channelID)?.messages.find((entry) => entry.id === messageID);
    if (!message) return;
    const list = message.reactions ?? (message.reactions = []);
    const reaction = list.find((entry) => entry.kind === kind);
    if (!reaction) {
      list.push({ kind, emoji: MESSAGE_REACTION_GLYPHS[kind] ?? '•', count: 1, mine: true });
      emit();
      return;
    }
    reaction.mine = !reaction.mine;
    reaction.count += reaction.mine ? 1 : -1;
    if (reaction.count <= 0) list.splice(list.indexOf(reaction), 1);
    emit();
  },
  vote(index: number) {
    const target = poll.options[index];
    if (!target) return;
    if (poll.mine === index) { target.votes = (target.votes ?? 0) - 1; poll.mine = null; }
    else {
      const previous = poll.mine != null ? poll.options[poll.mine] : null;
      if (previous) previous.votes = (previous.votes ?? 0) - 1;
      target.votes = (target.votes ?? 0) + 1;
      poll.mine = index;
    }
    emit();
  },
  send(channelID: string, body: string, author: string, initials: string) {
    const channel = channelStore.channel(channelID);
    if (!channel) return false;
    channel.messages.push({
      id: `sent-${version}-${channel.messages.length}`,
      author, initials,
      time: new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' }).format(new Date()),
      createdAt: new Date().toISOString(),
      body,
    });
    emit();
    return true;
  },
};
