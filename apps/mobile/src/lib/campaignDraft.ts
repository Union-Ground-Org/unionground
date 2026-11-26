// BUG-UG-NATIVE-OFFICERS-CANNOT-INVITE-SCHEDULE-OR-DRAFT-ON-THE-PHONE-20261118
// (#9099, part 3 of 4): a president or other campaign manager writes a vote
// (ballot) or pulse survey draft on the phone, through the RPC the website's
// Campaigns page saves with (src/lib/campaignApi.js saveCampaignDraft ->
// save_vote_campaign_draft). The defaults are the website form's
// (src/views/CampaignsView.jsx emptyDraft) and the limits are the RPC's own;
// the server checks the role, the scope and every field again.
import type { CampaignKind } from '../services/campaignRegistry';

export type CampaignScope = 'chapter' | 'union';
export type DraftOption = { labelEn: string; labelEs: string };

export type CampaignDraft = {
  kind: CampaignKind;
  scope: CampaignScope;
  titleEn: string;
  titleEs: string;
  bodyEn: string;
  closesAt: Date;
  quorumTarget: number;
  options: DraftOption[];
};

export type CampaignDraftProblem = 'title' | 'details' | 'closes' | 'quorum' | 'options' | null;

export const DRAFT_MIN_OPTIONS = 2;
export const DRAFT_MAX_OPTIONS = 20;
export const DRAFT_MAX_QUORUM = 1_000_000;
const CLOSE_STEP_MINUTES = 15;

/** A week from now, on the next quarter hour of the phone's clock. */
export function defaultCampaignClose(now: Date): Date {
  const close = new Date(now.getTime() + 7 * 86_400_000);
  close.setSeconds(0, 0);
  const rest = close.getMinutes() % CLOSE_STEP_MINUTES;
  if (rest) close.setMinutes(close.getMinutes() + CLOSE_STEP_MINUTES - rest);
  return close;
}

export function emptyCampaignDraft(now: Date, scope: CampaignScope): CampaignDraft {
  return {
    kind: 'ballot',
    scope,
    titleEn: '',
    titleEs: '',
    bodyEn: '',
    closesAt: defaultCampaignClose(now),
    quorumTarget: 1,
    options: [{ labelEn: '', labelEs: '' }, { labelEn: '', labelEs: '' }],
  };
}

export function stepCampaignCloseDay(close: Date, days: number): Date {
  const next = new Date(close.getTime());
  next.setDate(next.getDate() + days);
  return next;
}

export function stepCampaignCloseTime(close: Date, steps: number): Date {
  const next = new Date(close.getTime());
  next.setMinutes(next.getMinutes() + steps * CLOSE_STEP_MINUTES);
  return next;
}

export function stepQuorum(value: number, steps: number): number {
  return Math.min(DRAFT_MAX_QUORUM, Math.max(1, value + steps));
}

/** The website sends the English text again when the Spanish box is empty. */
function spanishOrEnglish(english: string, spanish: string): string {
  return spanish.trim() || english.trim();
}

function fits(value: string, min: number, max: number): boolean {
  const length = value.trim().length;
  return length >= min && length <= max;
}

/** The first field the server would refuse, so the phone names it before sending. */
export function campaignDraftProblem(draft: CampaignDraft, now: Date): CampaignDraftProblem {
  if (!fits(draft.titleEn, 3, 160) || !fits(spanishOrEnglish(draft.titleEn, draft.titleEs), 3, 160)) return 'title';
  if (draft.bodyEn.trim().length > 1000) return 'details';
  if (draft.closesAt.getTime() <= now.getTime()) return 'closes';
  if (draft.kind === 'ballot' && !(Number.isInteger(draft.quorumTarget) && draft.quorumTarget >= 1 && draft.quorumTarget <= DRAFT_MAX_QUORUM)) return 'quorum';
  if (draft.options.length < DRAFT_MIN_OPTIONS || draft.options.length > DRAFT_MAX_OPTIONS
    || draft.options.some((option) => !fits(option.labelEn, 1, 160) || !fits(spanishOrEnglish(option.labelEn, option.labelEs), 1, 160))) return 'options';
  return null;
}

export type SaveCampaignDraftArgs = {
  p_kind: CampaignKind;
  p_campaign_id: null;
  p_scope: CampaignScope;
  p_title_en: string;
  p_title_es: string;
  p_closes_at: string;
  p_quorum_target: number | null;
  p_body_en: string;
  p_body_es: string;
  p_options: { labelEn: string; labelEs: string }[];
};

/** A new draft, sent exactly as the website's saveCampaignDraft sends it. */
export function saveCampaignDraftArgs(draft: CampaignDraft): SaveCampaignDraftArgs {
  return {
    p_kind: draft.kind,
    p_campaign_id: null,
    p_scope: draft.scope,
    p_title_en: draft.titleEn.trim(),
    p_title_es: spanishOrEnglish(draft.titleEn, draft.titleEs),
    p_closes_at: draft.closesAt.toISOString(),
    p_quorum_target: draft.kind === 'ballot' ? draft.quorumTarget : null,
    p_body_en: draft.bodyEn.trim(),
    p_body_es: '',
    p_options: draft.options.map((option) => ({ labelEn: option.labelEn.trim(), labelEs: spanishOrEnglish(option.labelEn, option.labelEs) })),
  };
}
