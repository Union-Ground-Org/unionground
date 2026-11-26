// Historical fixture only. Never imported by the native application.
// Seeded chapter channels for the demo workspace (Slack-model messaging from
// the Mobbin redesign). In-memory only: reactions, poll votes, and sent
// messages persist for the app session and feed the Chapter Pulse poll card.

import { MESSAGE_REACTION_GLYPHS, isMessageReactionKind } from '../../../../../../../apps/mobile/src/lib/messagingShared';

// BUG-UG-MESSAGE-REACTION-PARITY-20260904: the kind is the contract value
// the database stores and toggle_member_message_reaction accepts; the emoji is
// presentation resolved from the shared contract. Carrying both means the
// preview store and the live store speak the same language as the server.
export type ChannelReaction = { kind: string; emoji: string; count: number; mine: boolean };

export type ChannelMessage = {
  id: string;
  author: string;
  initials: string;
  role?: 'STEWARD' | 'PRESIDENT';
  time: string;
  createdAt?: string;
  day?: string;
  newDivider?: boolean;
  body: string;
  reactions?: ChannelReaction[];
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
  locked?: boolean;
  unread: number;
  topic: string;
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
  options: { label: string; votes: number }[];
  mine: number | null;
};

// b05-13: the seeded tally was 34/52/19 of 105, so every percentage on screen
// was a rounded approximation of a fraction that has no whole-percent value,
// and the three rounded numbers did not have to add up. The seed now totals
// 100 votes, so the resting state is exact, and `pollShares` keeps the numbers
// honest at any other total the session reaches.
const poll: ChannelPoll = {
  question: 'Which night works for the September general meeting?',
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
export function pollShares(options: readonly { votes: number }[]): number[] {
  const total = options.reduce((sum, option) => sum + option.votes, 0);
  if (total <= 0) return options.map(() => 0);
  const exact = options.map((option) => (option.votes * 100) / total);
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

const channels: DemoChannel[] = [
  {
    id: 'cedar-ridge-campaign',
    name: 'cedar-ridge-campaign',
    unread: 3,
    topic: 'chapter announcements and wins',
    members: 212,
    messages: [
      { id: 'w-2023', author: 'Jordan Patel', initials: 'JP', role: 'PRESIDENT', time: '6:20 PM', createdAt: '2023-09-14T18:20:00-04:00', day: 'September 14, 2023', body: 'Chapter archive: members approved the first rotating evening meeting schedule, 86–14.' },
      { id: 'w-2024', author: 'Sam Okafor', initials: 'SO', role: 'STEWARD', time: '12:05 PM', createdAt: '2024-06-21T12:05:00-04:00', day: 'June 21, 2024', body: 'Chapter archive: the summer safety walk produced repairs at all three Cedar Ridge worksites.' },
      { id: 'w-2025', author: 'Ava Ramos', initials: 'AR', time: '9:42 AM', createdAt: '2025-11-03T09:42:00-05:00', day: 'November 3, 2025', body: 'Chapter archive: minutes and the approved 2026 meeting calendar are filed in My union.' },
      { id: 'w1', author: 'Jordan Patel', initials: 'JP', role: 'PRESIDENT', time: '8:05 AM', createdAt: '2026-08-23T08:05:00-04:00', day: 'Today', body: 'September general meeting agenda is posted. Bring worksite questions for the open floor.' },
      { id: 'w2', author: 'Sam Okafor', initials: 'SO', role: 'STEWARD', time: '8:31 AM', createdAt: '2026-08-23T08:31:00-04:00', body: 'Two new members signed at Plantation St this week. Welcome them when you see them. ✊', reactions: [{ kind: 'celebrate', emoji: '🎉', count: 7, mine: false }] },
    ],
  },
  {
    id: 'contract-2027',
    name: 'contract-2027',
    unread: 12,
    topic: 'bargaining updates',
    members: 128,
    messages: [
      { id: 'c-2023', author: 'Jordan Patel', initials: 'JP', role: 'PRESIDENT', time: '7:10 PM', createdAt: '2023-10-02T19:10:00-04:00', day: 'October 2, 2023', body: 'Bargaining archive: the chapter ratified the wage reopener priorities after the October listening session.' },
      { id: 'c-2024', author: 'Sam Okafor', initials: 'SO', role: 'STEWARD', time: '4:18 PM', createdAt: '2024-04-18T16:18:00-04:00', day: 'April 18, 2024', body: 'Bargaining archive: overtime and safety survey results were delivered with 187 verified responses.' },
      { id: 'c-2025', author: 'Ava Ramos', initials: 'AR', time: '8:32 AM', createdAt: '2025-08-27T08:32:00-04:00', day: 'August 27, 2025', body: 'Bargaining archive: members completed the 2025 priorities ranking; scheduling finished first.' },
      { id: 'c1', author: 'Jordan Patel', initials: 'JP', role: 'PRESIDENT', time: '4:12 PM', createdAt: '2026-08-22T16:12:00-04:00', day: 'Yesterday', body: 'Bargaining survey closes Friday — 214 responses so far. If your worksite is under 60% participation, stewards get a list tomorrow morning.', reactions: [{ kind: 'solidarity', emoji: '✊', count: 12, mine: false }, { kind: 'like', emoji: '👍', count: 8, mine: false }] },
      { id: 'c2', author: 'Sam Okafor', initials: 'SO', role: 'STEWARD', time: '5:03 PM', createdAt: '2026-08-22T17:03:00-04:00', body: 'Cedar Ridge Care Services sites are at 71% 🎉 Huge thanks to everyone who tabled at shift change.', reactions: [{ kind: 'celebrate', emoji: '🎉', count: 9, mine: true }], threadHint: '3 replies · last today' },
      { id: 'c3', author: 'Jordan Patel', initials: 'JP', role: 'PRESIDENT', time: '5:20 PM', createdAt: '2026-08-22T17:20:00-04:00', body: 'Before I book the hall — quick poll:', poll: true },
      { id: 'c4', author: 'Ava Ramos', initials: 'AR', time: '8:47 AM', createdAt: '2026-08-23T08:47:00-04:00', day: 'Today', newDivider: true, body: 'Can someone repost the overtime grievance template? A manager is denying the 15-minute grace period again.' },
      { id: 'c5', author: 'Sam Okafor', initials: 'SO', role: 'STEWARD', time: '8:52 AM', createdAt: '2026-08-23T08:52:00-04:00', body: 'On it — here is the current version. Document each denied break with date and witness.', attachment: { name: 'OT-grievance-template.docx', meta: '38 KB · Contract Art. 12' } },
    ],
  },
  {
    id: 'stewards',
    name: 'stewards',
    locked: true,
    unread: 0,
    topic: 'steward coordination (private)',
    members: 8,
    messages: [
      { id: 's-2023', author: 'Sam Okafor', initials: 'SO', role: 'STEWARD', time: '3:15 PM', createdAt: '2023-12-06T15:15:00-05:00', day: 'December 6, 2023', body: 'Steward archive: year-end case review closed nine matters and carried two deadlines into January.' },
      { id: 's-2024', author: 'Jordan Patel', initials: 'JP', role: 'PRESIDENT', time: '10:00 AM', createdAt: '2024-07-12T10:00:00-04:00', day: 'July 12, 2024', body: 'Steward archive: the representation rotation and backup contacts are approved through December.' },
      { id: 's-2025', author: 'Sam Okafor', initials: 'SO', role: 'STEWARD', time: '5:26 PM', createdAt: '2025-05-30T17:26:00-04:00', day: 'May 30, 2025', body: 'Steward archive: appointment notes and outcome letters are complete for the spring docket.' },
      { id: 's1', author: 'Sam Okafor', initials: 'SO', role: 'STEWARD', time: '9:15 AM', createdAt: '2026-08-23T09:15:00-04:00', day: 'Today', body: 'Step 2 packet template updated for hearings. Check the shared drive before Thursday.' },
    ],
  },
  {
    id: 'new-members',
    name: 'new-members',
    unread: 0,
    topic: 'orientation and onboarding',
    members: 64,
    messages: [
      { id: 'n-2023', author: 'Priya Chandran', initials: 'PC', time: '1:30 PM', createdAt: '2023-03-11T13:30:00-05:00', day: 'March 11, 2023', body: 'Orientation archive: the first Saturday welcome session enrolled 18 new members.' },
      { id: 'n-2024', author: 'Ava Ramos', initials: 'AR', time: '11:12 AM', createdAt: '2024-09-09T11:12:00-04:00', day: 'September 9, 2024', body: 'Orientation archive: benefits and workplace-rights recordings now have Spanish captions.' },
      { id: 'n-2025', author: 'Priya Chandran', initials: 'PC', time: '2:45 PM', createdAt: '2025-02-24T14:45:00-05:00', day: 'February 24, 2025', body: 'Orientation archive: updated first-30-days checklist is attached to every welcome note.' },
      { id: 'n1', author: 'Priya Chandran', initials: 'PC', time: '2:10 PM', createdAt: '2026-08-18T14:10:00-04:00', day: 'Tuesday', body: 'Orientation packets are printed and in the office. Grab one before your first chapter meeting.' },
    ],
  },
  {
    id: 'scheduling-wins',
    name: 'scheduling-wins',
    unread: 2,
    topic: 'post your scheduling wins',
    members: 97,
    messages: [
      { id: 'g-2023', author: 'Ava Ramos', initials: 'AR', time: '6:04 PM', createdAt: '2023-05-19T18:04:00-04:00', day: 'May 19, 2023', body: 'Win archive: the weekend swap pilot protected every member who volunteered for it.' },
      { id: 'g-2024', author: 'Sam Okafor', initials: 'SO', role: 'STEWARD', time: '9:08 AM', createdAt: '2024-11-15T09:08:00-05:00', day: 'November 15, 2024', body: 'Win archive: holiday assignments posted on time after the chapter documented the recurring delay.' },
      { id: 'g-2025', author: 'Jordan Patel', initials: 'JP', role: 'PRESIDENT', time: '4:44 PM', createdAt: '2025-07-08T16:44:00-04:00', day: 'July 8, 2025', body: 'Win archive: the new rotation language resolved six months of inconsistent weekend assignments.' },
      { id: 'g1', author: 'Ava Ramos', initials: 'AR', time: '11:40 AM', createdAt: '2026-08-23T11:40:00-04:00', day: 'Today', body: 'Weekend rotation posted 3 weeks out for the first time ever. Filing worked. 💪', reactions: [{ kind: 'strength', emoji: '💪', count: 14, mine: false }] },
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
  pollTotal: () => poll.options.reduce((sum, option) => sum + option.votes, 0),
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
    if (poll.mine === index) { target.votes -= 1; poll.mine = null; }
    else {
      const previous = poll.mine != null ? poll.options[poll.mine] : null;
      if (previous) previous.votes -= 1;
      target.votes += 1;
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
