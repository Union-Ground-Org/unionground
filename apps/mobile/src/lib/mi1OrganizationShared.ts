export {
  DIGITAL_ACTION_KINDS,
  DIGITAL_ACTION_PARTICIPATION_KINDS,
  DIGITAL_ACTION_STATUSES,
  LEADERSHIP_TIMELINE_KINDS,
  ORGANIZATION_CHART_KINDS,
  ORGANIZATION_INTELLIGENCE_STAFF_HATS,
  ORGANIZATION_NODE_KINDS,
  RELATIONSHIP_KINDS,
  TOPIC_PROGRESS_STATES,
} from '../../../../src/features/organizationIntelligence/contract.js';
export {
  canExportCollectiveActionParticipants,
  canManageCollectiveActions,
  canWriteOrganizationIntelligence,
  normalizeOrganizationIntelligenceActor,
} from '../../../../src/features/organizationIntelligence/authorization.js';
export {
  composeCollectiveActions,
  composeOrganizationIntelligence,
} from '../../../../src/features/organizationIntelligence/model.js';
export { buildDigitalActionParticipantCsv } from '../../../../src/features/organizationIntelligence/export.js';

export type OrganizationIntelligenceActor = {
  userId: string | null;
  organizationId: string | null;
  chapterId: string | null;
  selectedHat: string;
  organizationRoles: string[];
  membershipStatus: string;
  mfaSatisfied: boolean;
};

export const MI1_ORGANIZATION_NATIVE_PERSISTENCE = Object.freeze({
  organizationIntelligence: true,
  collectiveActions: true,
  protectedParticipantExport: true,
});

export type CollectiveActionParticipationKind = 'signature' | 'attendee' | 'volunteer';

export function participationKindForAction(kind: string): CollectiveActionParticipationKind {
  if (kind === 'rally') return 'attendee';
  if (kind === 'petition') return 'signature';
  if (kind === 'picket' || kind === 'meeting') return 'attendee';
  return 'volunteer';
}

export function applyPreviewCollectiveActionJoin<T extends {
  id: string;
  kind: string;
  viewerParticipation: string | null;
  participantCount: number | null;
}>(actions: T[], actionId: string): T[] {
  return actions.map((entry) => {
    if (entry.id !== actionId) return entry;
    const joined = Boolean(entry.viewerParticipation);
    return {
      ...entry,
      viewerParticipation: joined ? null : participationKindForAction(entry.kind),
      participantCount: entry.participantCount === null ? null : Math.max(0, Number(entry.participantCount) + (joined ? -1 : 1)),
    };
  });
}
