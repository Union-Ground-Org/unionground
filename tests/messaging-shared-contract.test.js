// @vitest-environment node
//
// BUG-UG-MESSAGE-REACTION-PARITY-20260904 and
// TEST-UG-SHARED-UNREAD-CONTRACT-20260904.
//
// Both records describe one defect: a rule the database owns, reimplemented
// once per client, with nothing keeping the copies equal. These tests fail if
// either client grows a private copy again, and they run the SAME fixture
// matrix the mobile suite runs (src/features/messaging/unreadFixtures.js), so a
// divergence is caught on whichever side introduces it.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
// tests/setup.js registers Spanish only for DOM files; this node file reads it.
import "../src/lib/i18n/allLanguages.js";

import {
  readGeneratedMessagingContract,
  readMessagingContract,
  renderMessagingContract,
} from "../scripts/sync-messaging-contract.mjs";
import {
  MESSAGE_REACTIONS,
  MESSAGE_REACTION_KINDS,
  aggregateMessageReactions,
  isMessageReactionKind,
  toggleAggregatedReaction,
} from "../src/features/messaging/index.js";
import { UNREAD_CONFORMANCE_CASES, runUnreadConformance } from "../src/features/messaging/unreadFixtures.js";
import { isOwnChannelPost } from "../src/features/messaging/unread.js";
import { migrationFiles, stripComments } from "./helpers/migration.js";
import { catalogue, t } from "../src/lib/i18n.js";

const read = (path) => readFileSync(resolve(process.cwd(), path), "utf8");
const generated = read("src/features/messaging/generated/messagingContract.js");
const memberApi = read("src/lib/memberApi.js");
const messagesView = read("src/views/MessagesView.jsx");
const messageActions = read("src/components/MessageActions.jsx");
const mobileInbox = read("apps/mobile/src/lib/messageInbox.ts");
const mobileChannels = read("apps/mobile/src/data/liveChannels.ts");
const mobileSupabase = read("apps/mobile/src/services/supabase.ts");
const channelScreen = read("apps/mobile/app/channel/[id].tsx");

describe("the generated messaging contract tracks the database", () => {
  it("is current — regenerating it produces no change", () => {
    // The whole point of a generated contract is that it cannot silently fall
    // behind the migration it is generated from.
    expect(readGeneratedMessagingContract()).toBe(renderMessagingContract());
    const contract = readMessagingContract();
    for (const kind of contract.reactionKinds) {
      expect(generated, `${kind} missing from the generated module`).toContain(`"${kind}"`);
    }
    expect(MESSAGE_REACTION_KINDS).toEqual(contract.reactionKinds);
    expect(generated).toContain("GENERATED FILE — do not edit by hand");
  });

  it("matches the CHECK constraint the migration actually writes", () => {
    const migration = migrationFiles()
      .find((entry) => entry.name === readMessagingContract().sources.reactionKinds);
    const sql = stripComments(migration.sql).toLowerCase();
    const rendered = MESSAGE_REACTION_KINDS.map((kind) => `'${kind}'`).join(",");
    expect(sql).toContain(`check (reaction in (${rendered}))`);
    // The RPC's own allow-list has to match, or the client would offer a kind
    // the server rejects.
    expect(sql).toContain(`p_reaction not in (${rendered})`);
  });

  it("gives every reaction kind a glyph and a translated label in both languages", () => {
    expect(MESSAGE_REACTIONS).toHaveLength(MESSAGE_REACTION_KINDS.length);
    for (const entry of MESSAGE_REACTIONS) {
      expect(entry.glyph, `${entry.kind} glyph`).not.toBe("•");
      expect(entry.labelKey).toBe(`inbox.reaction.${entry.kind}`);
      for (const lang of ["en", "es"]) {
        expect(catalogue[lang][entry.labelKey], `${entry.kind} needs a ${lang} label`).toBeTypeOf("string");
        expect(t(lang, entry.labelKey)).toBe(catalogue[lang][entry.labelKey]);
        expect(t(lang, entry.labelKey).trim()).not.toBe("");
      }
    }
  });

  it("leaves no orphan reaction label behind after the vocabulary changed", () => {
    for (const retired of ["agree", "thanks", "question"]) {
      for (const lang of ["en", "es"]) {
        expect(catalogue[lang][`inbox.reaction.${retired}`], `${retired} is no longer a database kind`)
          .toBeUndefined();
      }
    }
  });
});

describe("both clients consume the reaction contract instead of a private list", () => {
  it("responsive web renders every contract kind from the shared module", () => {
    expect(messageActions).toContain('from "../features/messaging/index.js"');
    expect(messageActions).toContain("aggregateMessageReactions(state.reactions, actorId)");
    expect(messageActions).toContain("isMessageReactionKind(reaction)");
    // The old hard-coded triple must not come back.
    expect(messageActions).not.toMatch(/\["like", "👍"\]/);
  });

  it("native maps kinds through the shared contract and toggles by kind", () => {
    expect(mobileChannels).toContain("REACTION_KIND_EMOJI: Record<string, string> = MESSAGE_REACTION_GLYPHS");
    expect(mobileChannels).not.toContain("EMOJI_REACTION_KIND");
    expect(mobileChannels).toContain("toggleReaction(writer: MobileSessionWriter, channelID: string, messageID: string, kind: string)");
  });

  it("native offers the first reaction on a message that has none", () => {
    // The defect: the reaction row rendered only when reactions.length was
    // truthy, so a fresh post could not be reacted to at all from a phone.
    expect(channelScreen).not.toContain("{message.reactions?.length ? (");
    expect(channelScreen).toContain("<MessageReactionPicker mine={[...mineByKind]}");
    expect(read("apps/mobile/src/components/MessageReactions.tsx")).toContain("MESSAGE_REACTION_CHOICES.map((choice)");
    expect(channelScreen).toContain("accessibilityLabel={t('React to the message from {name}', { name: message.author })}");
    expect(channelScreen).toContain("<AddReactionChip accessibilityLabel={t('React to the message from {name}', { name: message.author })}");
  });

  it("aggregates every kind so a zero-count kind is still offerable", () => {
    const aggregate = aggregateMessageReactions([], "me");
    expect(aggregate.map((entry) => entry.kind)).toEqual([...MESSAGE_REACTION_KINDS]);
    expect(aggregate.every((entry) => entry.count === 0 && entry.mine === false)).toBe(true);
  });

  it("aggregates counts and ownership from raw rows", () => {
    const aggregate = aggregateMessageReactions([
      { reaction: "like", actor_id: "me" },
      { reaction: "like", actor_id: "other" },
      { reaction: "solidarity", actor_id: "other" },
    ], "me");
    const like = aggregate.find((entry) => entry.kind === "like");
    const solidarity = aggregate.find((entry) => entry.kind === "solidarity");
    expect(like).toMatchObject({ count: 2, mine: true });
    expect(solidarity).toMatchObject({ count: 1, mine: false });
  });

  it("toggles optimistically without mutating the rendered aggregate", () => {
    const aggregate = aggregateMessageReactions([{ reaction: "like", actor_id: "other" }], "me");
    const toggled = toggleAggregatedReaction(aggregate, "like");
    expect(aggregate.find((entry) => entry.kind === "like")).toMatchObject({ count: 1, mine: false });
    expect(toggled.find((entry) => entry.kind === "like")).toMatchObject({ count: 2, mine: true });
    expect(toggleAggregatedReaction(toggled, "like").find((entry) => entry.kind === "like"))
      .toMatchObject({ count: 1, mine: false });
  });

  it("never lets a non-contract kind reach the RPC", () => {
    expect(isMessageReactionKind("shrug")).toBe(false);
    expect(isMessageReactionKind("")).toBe(false);
    expect(isMessageReactionKind(undefined)).toBe(false);
    for (const kind of MESSAGE_REACTION_KINDS) expect(isMessageReactionKind(kind)).toBe(true);
  });
});

describe("the unread contract is one implementation, conformance-tested", () => {
  it("passes the shared fixture matrix", () => {
    expect(runUnreadConformance()).toEqual([]);
  });

  it("treats a missing post as nobody's own", () => {
    expect(isOwnChannelPost(null, "me")).toBe(false);
    expect(isOwnChannelPost(undefined)).toBe(false);
  });

  it("covers every case class the record names", () => {
    const names = UNREAD_CONFORMANCE_CASES.map((entry) => entry.name).join(" | ");
    for (const required of [
      "null cursor", "exactly at the cursor", "unparseable", "redacted",
      "reconnect", "saved rows never count", "reminder rows never count",
      "announcement",
    ]) {
      expect(names.toLowerCase(), `no fixture covers ${required}`).toContain(required.toLowerCase());
    }
    expect(UNREAD_CONFORMANCE_CASES.length).toBeGreaterThanOrEqual(25);
  });

  it("is the only place either client writes an unread predicate", () => {
    // The exact predicates each client used to carry. Their reappearance is the
    // regression this record exists to prevent.
    const banned = [
      /sender_kind === ["']steward["'] && !\w*\.?read_at/,
      /sender_kind: ["']steward["'][\s\S]{0,40}!\w+\.read_at/,
      /postedAt > lastRead/,
    ];
    for (const [label, source] of Object.entries({ memberApi, messagesView, mobileInbox, mobileChannels, mobileSupabase })) {
      for (const pattern of banned) {
        expect(source, `${label} reintroduced an unreviewed unread predicate`).not.toMatch(pattern);
      }
    }
  });

  it("routes both clients' inbox counts through the shared normalizer", () => {
    expect(messagesView).toContain('from "../features/messaging/index.js"');
    expect(messagesView).toContain("countUnreadInboxItems(inboxItems)");
    expect(messagesView).toContain("isInboxItemUnread(item)");
    expect(memberApi).toContain('from("member_conversation_summaries")');
    expect(memberApi).toContain('summaries.get(item.id)?.unread_count');
    expect(mobileSupabase).toContain("from('member_conversation_summaries')");
    expect(mobileInbox).toContain("from './messagingShared'");
    expect(mobileInbox).toContain("inboxUnreadCount('direct'");
    expect(mobileSupabase).toContain("directUnreadCount(matching)");
    expect(mobileChannels).toContain("isChannelPostUnread(post, lastRead, data.userID)");
    expect(memberApi).toContain("spaceReadCursor(space.id), user.id)");
  });
});
