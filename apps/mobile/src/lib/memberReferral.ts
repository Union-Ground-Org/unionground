// REQ-UG-NATIVE-MEMBER-REFERRAL-CODE-20261111 (#8175): the native
// twin of the web referral code, invitation field and recruited count
// (#8152). The copy is the web English (rewards.referral*, inviteAccept.referral*,
// rewards.kind.referral in src/lib/i18n/locales/en); native member copy is
// English only by owner ruling (September 20, 2026, confirmed October 20, 2026).

export type MemberReferralSummary = { code: string | null; recruitedYtd: number | null };
export type ReferralRule = { points: number; weeklyCap: number | null };

export const REFERRAL_COPY = {
  title: 'Your referral code',
  share: 'Share code',
  shareMessage: (code: string) => `My Union Ground referral code is ${code}. Enter it when you accept your invitation.`,
  codeLabel: (code: string) => `Referral code ${code}`,
  count: (count: number) => `Workers recruited this year: ${count}`,
  // Shown when the referral rule could not be read: the terms sentence only.
  bodyUnknown: 'When someone you bring in accepts their invitation from an administrator, they can enter this code.',
  fieldLabel: 'Referral code (optional)',
  fieldHint: 'If a worker of this organization brought you in, enter their code so they get credit.',
  homeLabel: 'Recruited this year',
} as const;

function count(value: unknown): number | null {
  return Number.isSafeInteger(value) && (value as number) >= 0 ? value as number : null;
}

// The caller's own code and recruited count from get_member_referral_summary,
// or null when the server gave neither (not a member, or an older deployment).
export function normalizeReferralSummary(value: unknown): MemberReferralSummary | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  const code = typeof row.code === 'string' && /^[0-9A-F]{12}$/.test(row.code) ? row.code : null;
  const recruitedYtd = count(row.recruitedYtd);
  return code || recruitedYtd !== null ? { code, recruitedYtd } : null;
}

// The rewards summary's recruitedYtd, or null when the summary predates the
// referral wave: Home then shows no recruited count rather than a zero.
export function recruitedYtdFrom(summary: unknown): number | null {
  return summary && typeof summary === 'object' && !Array.isArray(summary)
    ? count((summary as Record<string, unknown>).recruitedYtd) : null;
}

// Three groups of four, as the web Rewards card shows it.
export function groupReferralCode(code: string): string {
  return code.match(/.{1,4}/g)?.join('-') ?? code;
}

// The live referral rule's terms (an administrator can change its points and
// weekly cap), never fixed figures: null rule means referral points are off,
// undefined means the rule could not be read.
export function referralTermsText(rule: ReferralRule | null | undefined): string {
  if (rule === undefined) return REFERRAL_COPY.bodyUnknown;
  if (!rule || !(rule.points > 0)) {
    return 'When someone you bring in accepts their invitation from an administrator, they can enter this code, and they count toward the workers you recruited. Referral points are off right now.';
  }
  return Number.isInteger(rule.weeklyCap) && (rule.weeklyCap as number) > 0
    ? `${REFERRAL_COPY.bodyUnknown} You earn ${rule.points} points when they first check in at a meeting, up to ${rule.weeklyCap} a week.`
    :`${REFERRAL_COPY.bodyUnknown} You earn ${rule.points} points when they first check in at a meeting.`;
}
