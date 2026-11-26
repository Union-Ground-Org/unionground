import type { ThemeTokens } from './tokens';

// The status state ramp required by triage P1-3/P1-4 and the visual-language
// brief §C: "aubergine = active/in-progress, copper/gold = needs attention,
// lavender = queued/new, muted ink = done/closed — same hue for row dot, column
// header dot, chart segment."
//
// The four hues are palette tokens rather than component literals, so a chart
// segment and a row dot can never drift apart. They are their own tokens (not
// aliases of `primary`/`accent`) because the ramp has to stay legible as a 6px
// dot on the tinted-neutral pill body: raw `accent` gold computes 1.83:1 there
// and the `secondary` lavender fill computes 1.03:1, which is the same class of
// defect the Activity icon-role audit already repaired. The light values are
// drawn from the shipped families — aubergine `primary`, the palette's dark
// copper (`compass` in light), the lavender ladder, and `mutedForeground`.
//
// Dark mode is a derived scheme with no purple family at all, so its active
// state takes the gold that stands in for aubergine there. Attention cannot
// also live in that family: the two shipped gold steps computed 1.43:1 apart
// ( finding F6), which is one hue at two lightnesses —
// unreadable as two states. Dark attention is therefore the copper the brief
// names ("copper/gold = needs attention"), a step darker and 12.5° off the
// gold (39.1° → 26.6° in HSL, measured from the shipped values, not the 18°
// this comment first claimed), still clearing the 3:1 non-text floor on the
// charcoal pill body.
export type StatusState = 'active' | 'attention' | 'queued' | 'done';

/** Palette key that carries each state's hue, for audits and chart migrations. */
export const STATUS_RAMP_TOKENS = {
  active: 'statusActive',
  attention: 'statusAttention',
  queued: 'statusQueued',
  done: 'statusDone',
} as const satisfies Record<StatusState, keyof ThemeTokens>;

/**
 * The attention state's second, non-colour channel (wave-2b finding w2b-2):
 * attention alone renders a larger dot with a 1px ring, so ~6px of copper is
 * no longer the whole cue at board glance and the state survives a
 * colour-vision difference. The ring is the step of the same hue that moves
 * away from the pill body — darker on the light body, lighter on the dark one
 * — which is why it is a mode-scoped palette token and not a component tint.
 */
export const STATUS_ATTENTION_RING_TOKEN = 'statusAttentionRing' as const satisfies keyof ThemeTokens;

/** Resolves the ramp against the active theme. */
export function statusRamp(theme: ThemeTokens): Record<StatusState, string> {
  return {
    active: theme.statusActive,
    attention: theme.statusAttention,
    queued: theme.statusQueued,
    done: theme.statusDone,
  };
}

// States only (BUG-UG-NATIVE-CHART-RAMP-DARK-SEPARATION-20261031):
// the ramp colors a state chip, a row dot or a badge. A chart series takes its
// hue from chartPalette.ts instead. Run through the palette validator the ramp
// fails as a series: dark done against queued is ΔE 13.8 under normal vision
// (floor 15), and the light steps leave the lightness band and the chroma
// floor. CHART_SERIES_ORDER and chartSeries() below stay only until the Pulse
// screens move to chartPalette(); nothing new may read them.

/**
 * @deprecated Series hues come from chartPalette() (chartPalette.ts).
 * The order a chart draws unrelated categories in (b02b-3/10/15/24).
 *
 * Campaign pulse used to mix five families across fourteen cards, so gold labeled
 * a period bar, an organizing ring, a "Trainings" area layer, a poll bar and an
 * "Open" record inside one scroll — four different meanings for one hue, which
 * is exactly what the brief §C ramp forbids. A series that *is* a state resolves
 * by name (`statusRamp(theme).done` for a resolved issue); a series that is only
 * a category walks this order instead, so the four approved hues appear in one
 * fixed sequence and gold occupies exactly one position in it.
 */
// Stack order per the iab review, corrected. The order is chosen by its
// weakest adjacent seam, not by any one pair: putting active between done and
// queued fixed the done|queued seam but left queued|attention touching at
// 1.243:1 in light, which is worse than the seam it repaired. This order's
// light boundaries are done|queued 1.554:1, queued|active 3.343:1 and
// active|attention 2.690:1 — every adjacency clears 1.554:1, the highest floor
// any permutation of the four shipped inks can reach.
export const CHART_SERIES_ORDER: readonly StatusState[] = ['done', 'queued', 'active', 'attention'];

/** @deprecated Use chartPalette(theme). The ramp resolved into the category order above. */
export function chartSeries(theme: ThemeTokens): string[] {
  const ramp = statusRamp(theme);
  return CHART_SERIES_ORDER.map((state) => ramp[state]);
}

// Record vocabularies are small and closed, so the mapping is an explicit word
// list rather than a substring match: "Preview" contains "review", and a
// substring rule would file it as needing attention.
const DONE_LABELS = new Set([
  'resolved', 'closed', 'settled', 'done', 'complete', 'completed', 'archived',
  'declined', 'withdrawn', 'read-only', 'ended',
  // A decided record is finished work: an approved or countersigned handshake
  // is not still in progress, and filing it as active would keep it emphasised
  // on a board it has already left.
  'approved', 'confirmed',
]);

const ATTENTION_LABELS = new Set([
  'overdue', 'urgent', 'blocked', 'escalated', 'flagged', 'committee member review', 'committee review',
  'needs attention', 'action needed', 'at risk', 'expiring',
  // The bare word a record can carry on its own, and the deadline phrasing
  // that reads as pressure but is not yet overdue.
  'attention', 'due soon',
  // The Campaign pulse contributor vocabulary (b02b-3): a contributor row that
  // says "Pay attention" is the one row on that list that has to read as
  // attention, and it is the same word the ramp already files under this state.
  'pay attention',
]);

const QUEUED_LABELS = new Set([
  'queued', 'new', 'draft', 'planned', 'preview', 'pending', 'scheduled',
  'requested', 'waiting', 'not started', 'sample', 'unassigned',
]);

/**
 * Best-effort state for a record whose status arrives as free text (issue rows,
 * campaign cards). Anything unrecognised is treated as live work, which is the
 * state that carries no special emphasis beyond the aubergine dot.
 */
export function statusStateForLabel(label: string): StatusState {
  const value = label.trim().toLowerCase();
  if (DONE_LABELS.has(value)) return 'done';
  if (ATTENTION_LABELS.has(value)) return 'attention';
  if (QUEUED_LABELS.has(value)) return 'queued';
  return 'active';
}
