// The path a campaign walks from first conversations to a first contract, in
// the plain words the Campaign tab shows. Recognition and an election are
// separate outcomes, and a card majority is never shown as certification
// (PRODUCT.md design principle 4).
export type OrganizingStageStatus = 'complete' | 'current' | 'upcoming';

export type OrganizingStage = {
  key: 'committee' | 'majority' | 'path' | 'recognition' | 'first-contract';
  title: string;
  body: string;
};

export const ORGANIZING_STAGES: readonly OrganizingStage[] = [
  { key: 'committee', title: 'Build the committee', body: 'Map the workplace and form a representative organizing committee.' },
  { key: 'majority', title: 'Build majority support', body: 'Have real conversations and record authorization privately.' },
  { key: 'path', title: 'Choose a recognition path', body: 'Compare voluntary recognition and election requirements.' },
  { key: 'recognition', title: 'Win recognition', body: 'Record the formal outcome. A card majority alone is not certification.' },
  { key: 'first-contract', title: 'Bargain a first contract', body: 'Turn priorities into proposals after recognition.' },
];

export function organizingStageStatuses(currentKey: OrganizingStage['key'] | null): OrganizingStageStatus[] {
  const current = currentKey ? ORGANIZING_STAGES.findIndex((stage) => stage.key === currentKey) : -1;
  return ORGANIZING_STAGES.map((_, index) => (
    current < 0 ? 'upcoming' : index < current ? 'complete' : index === current ? 'current' : 'upcoming'
  ));
}

// Whole-number share of an estimate, or null when there is nothing to divide
// by. Counts are campaign-private and never a vote or certification tally.
export function shareOfEstimate(count: number, estimate: number): number | null {
  if (!Number.isFinite(count) || !Number.isFinite(estimate) || estimate <= 0 || count < 0) return null;
  return Math.min(100, Math.round((count / estimate) * 100));
}
