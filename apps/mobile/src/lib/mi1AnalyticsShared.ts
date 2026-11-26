// Typed seams over the cherry-picked analytics engines. Native screens never
// import the web JSX desk; explicit preview history remains isolated here.

export {
  ANALYTICS_DESK_TABS,
  ANALYTICS_REQUESTED_RPCS,
  ANALYTICS_STAFF_HATS,
} from '../../../../src/features/analytics/contract.js';
export { authorizeAnalyticsAccess } from '../../../../src/features/analytics/authorization.js';
export { createAnalyticsCoreAdapter } from '../../../../src/features/analytics/adapter.js';
export { composeAnalyticsCore } from '../../../../src/features/analytics/dashboard.js';
export {
  normalizeMemberReportCard,
  paginateAnalyticsLayouts,
  paginateAnalyticsMembers,
} from '../../../../src/features/analytics/parity.js';
export {
  createPreviewAnalyticsSnapshot,
  createPreviewAnalyticsViewer,
  createPreviewAnalyticsWorkspace,
} from '../../../../src/features/analytics/preview.js';

export const MI1_ANALYTICS_NATIVE_PERSISTENCE = Object.freeze({
  analyticsSnapshot: true,
  analyticsWorkspace: true,
  memberReportCard: true,
});

export type NativeOrganizationActor = {
  userId: string | null;
  organizationId: string | null;
  chapterId: string | null;
  roles: string[];
  organizationRoles: string[];
  chapterRoles: string[];
  selectedHat: string | null;
  membershipStatus: 'active' | 'revoked';
  organizationStatus: 'active' | 'suspended' | 'archived';
  mfaSatisfied: boolean;
  authenticated: boolean;
};

export function buildNativeActor(input: {
  userId?: string | null;
  organizationId?: string | null;
  chapterId?: string | null;
  roles?: readonly string[];
  organizationRoles?: readonly string[];
  chapterRoles?: readonly string[];
  selectedHat?: string | null;
  authenticated?: boolean;
  mfaSatisfied?: boolean;
} = {}): NativeOrganizationActor {
  return {
    userId: input.userId ?? null,
    organizationId: input.organizationId ?? null,
    chapterId: input.chapterId ?? null,
    roles: [...(input.roles ?? [])],
    organizationRoles: [...(input.organizationRoles ?? [])],
    chapterRoles: [...(input.chapterRoles ?? [])],
    selectedHat: input.selectedHat ?? null,
    membershipStatus: 'active',
    organizationStatus: 'active',
    mfaSatisfied: Boolean(input.mfaSatisfied),
    authenticated: Boolean(input.authenticated),
  };
}

export function toAnalyticsViewer(actor: NativeOrganizationActor) {
  return {
    organizationId: actor.organizationId,
    chapterId: actor.chapterId,
    selectedHat: actor.selectedHat && actor.selectedHat !== 'member' ? actor.selectedHat : null,
    roles: actor.roles,
    organizationRoles: actor.organizationRoles,
    chapterRoles: actor.chapterRoles,
    userId: actor.userId,
  };
}
