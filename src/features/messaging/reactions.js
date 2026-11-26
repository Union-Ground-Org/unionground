// The one reaction contract, presentation included.
//
// BUG-UG-MESSAGE-REACTION-PARITY-20260904: the database has always allowed
// five reaction kinds. Responsive web offered three, and the Expo channel
// screen carried its own emoji map and rendered the reaction row only when a
// message already had a reaction — so a message with no reactions could not be
// reacted to at all from a phone. The kinds now come from the generated
// contract, the glyphs and label keys live here once, and both clients import
// the same list.

import { messageReactionsCatalogue } from "../../lib/i18n/messageReactions.js";
import { lookup } from "../../lib/i18n/runtime.js";
import { MESSAGE_REACTION_KINDS } from "./generated/messagingContract.js";

// Glyph per kind. Deliberately here and not in the generated file: the database
// owns which kinds exist, the product owns how they read.
/** @type {Readonly<Record<string, string>>} */
const GLYPHS = Object.freeze({
  like: "👍",
  support: "🤝",
  celebrate: "🎉",
  solidarity: "✊",
  strength: "💪",
  seen: "📋",
  agreed: "✓",
  care: "♥",
  grievance: "⚖",
  victory: "★",
});

/** @type {ReadonlyArray<Readonly<{kind: string, glyph: string, labelKey: string}>>} */
export const MESSAGE_REACTIONS = Object.freeze(
  MESSAGE_REACTION_KINDS.map((kind) => Object.freeze({
    kind,
    glyph: GLYPHS[kind] || "•",
    // Both clients resolve their own copy from this key, so a kind cannot ship
    // with a label in one client and a raw identifier in the other.
    labelKey: `inbox.reaction.${kind}`,
  })),
);

// New choices keep their own persisted identity. Legacy reactions remain in
// MESSAGE_REACTIONS for accurate counts and removal; they are never renamed.
export const MESSAGE_REACTION_CHOICES = Object.freeze(
  ["seen", "agreed", "solidarity", "care", "grievance", "victory"]
    .map((kind) => {
      const entry = MESSAGE_REACTIONS.find((reaction) => reaction.kind === kind);
      if (!entry) throw new Error(`Reaction choice is missing from the database contract: ${kind}`);
      return entry;
    }),
);

export function messageReactionLabel(kind, lang = "en") {
  return lookup(messageReactionsCatalogue, lang, `inbox.reaction.${kind}`);
}

const KIND_BY_GLYPH = Object.freeze(
  Object.fromEntries(MESSAGE_REACTIONS.map((entry) => [entry.glyph, entry.kind])),
);

export function isMessageReactionKind(value) {
  return typeof value === "string" && MESSAGE_REACTION_KINDS.includes(value);
}

export function reactionKindForGlyph(glyph) {
  return KIND_BY_GLYPH[glyph] || null;
}

// Aggregate raw reaction rows into one entry per kind, in contract order, with
// the caller's own reaction marked. Every kind is present so a client can offer
// the first reaction on a message that has none — the native defect this
// record names.
/**
 * @param {Array<{reaction: string, actor_id?: string | null}>} rows
 * @param {string | null | undefined} actorId
 */
export function aggregateMessageReactions(rows, actorId) {
  const list = Array.isArray(rows) ? rows : [];
  return MESSAGE_REACTIONS.map((entry) => {
    const matching = list.filter((row) => row && row.reaction === entry.kind);
    return {
      kind: entry.kind,
      glyph: entry.glyph,
      labelKey: entry.labelKey,
      count: matching.length,
      mine: actorId != null && matching.some((row) => row.actor_id === actorId),
    };
  });
}

/**
 * @param {Array<{kind: string, count: number, mine: boolean}>} aggregate
 * @param {string[]} confirmedKinds
 */
export function reconcileOwnReactions(aggregate, confirmedKinds) {
  return MESSAGE_REACTIONS.map((entry) => {
    const previous = aggregate.find((item) => item.kind === entry.kind);
    const mine = confirmedKinds.includes(entry.kind);
    return { ...entry, count: Math.max(0, (previous?.count ?? 0) - (previous?.mine ? 1 : 0) + (mine ? 1 : 0)), mine };
  });
}

// Optimistic toggle applied to an aggregate produced above. Returned fresh so
// callers never mutate a rendered list in place.
export function toggleAggregatedReaction(aggregate, kind) {
  return (Array.isArray(aggregate) ? aggregate : []).map((entry) => {
    if (entry.kind !== kind) return { ...entry };
    const mine = !entry.mine;
    return { ...entry, mine, count: Math.max(0, entry.count + (mine ? 1 : -1)) };
  });
}
