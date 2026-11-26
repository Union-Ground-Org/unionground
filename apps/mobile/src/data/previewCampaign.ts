import type { OrganizingStage } from '../lib/organizingPath';

// The fictional campaign the PREVIEW workspace organizes. Every number is
// invented and stays on the device; none is a real card count or a vote.
export type PreviewCampaignSnapshot = {
  name: string;
  employerName: string;
  stage: OrganizingStage['key'];
  nextAction: string;
  contactedCount: number;
  eligibleEstimate: number;
  cardsSigned: number;
  committeeCount: number;
  nextMeeting: string;
};

export const PREVIEW_CAMPAIGN: PreviewCampaignSnapshot = {
  name: 'Harborview Care United',
  employerName: 'Fictional Harborview Care',
  stage: 'majority',
  nextAction: 'Talk with two evening-shift coworkers before Thursday.',
  contactedCount: 151,
  eligibleEstimate: 184,
  cardsSigned: 119,
  committeeCount: 14,
  nextMeeting: 'Thursday · 7:00 PM',
};
