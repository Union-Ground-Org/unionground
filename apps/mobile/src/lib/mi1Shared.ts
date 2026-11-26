// Typed seams over the cherry-picked MI1 integration-control modules.
// Native screens never import the web JSX desk or SCIM token minting.

import { withoutJobsBesideHeldSwitches } from '../../../../src/lib/heldSettingCompanions.js';

export {
  INTEGRATION_PROVIDER_CATALOG,
  INTEGRATION_PROVIDER_IDS,
  defaultProviderRecord,
  isActivatableProvider,
} from '../../../../src/features/integrations/catalog.js';
export { canManageIntegrations, createActor as createIntegrationActor } from '../../../../src/features/integrations/authorization.js';
export { getScimControlSurface, SCIM_SWITCH_KEY } from '../../../../src/features/integrations/scim.js';
export { PRODUCT_JOBS } from '../../../../src/features/operations/jobRegistry.js';
export { buildJobHealthDesk, normalizePersistedJobHealthRows } from '../../../../src/features/operations/jobHealth.js';
export { JOB_ACTS_BESIDE } from '../../../../src/lib/heldSettingCompanions.js';
export { authorizeAuditQuery, canClientInsertAudit } from '../../../../src/features/operations/auditAuthorization.js';
export { authorizeJobQuery } from '../../../../src/features/operations/jobAuthorization.js';
export {
  OPERATIONS_RPCS,
  clientMayCallRecordAudit,
  clientMayCallRpc,
} from '../../../../src/features/operations/operationsAdapter.js';

export const MI1_NATIVE_PERSISTENCE = Object.freeze({
  integrationSecrets: false,
  scimLive: false,
  operationsLedger: true,
});

export const MI1_FEATURE_KEYS = ['integrations', 'operations'] as const;
export type Mi1FeatureKey = (typeof MI1_FEATURE_KEYS)[number];

export function isMi1FeatureKey(value: string): value is Mi1FeatureKey {
  return (MI1_FEATURE_KEYS as readonly string[]).includes(value);
}

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
  membershipStatus?: NativeOrganizationActor['membershipStatus'];
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
    membershipStatus: input.membershipStatus ?? 'active',
    organizationStatus: 'active',
    mfaSatisfied: Boolean(input.mfaSatisfied),
    authenticated: Boolean(input.authenticated),
  };
}

export function nativeOrganizationId(): string | null {
  return null;
}

export function toIntegrationActor(actor: NativeOrganizationActor) {
  return {
    userId: actor.userId,
    selectedOrganizationId: actor.organizationId,
    roles: actor.organizationRoles,
    organizationRoles: actor.organizationRoles,
    chapterRoles: actor.chapterRoles,
    selectedHat: actor.selectedHat,
    membershipStatus: actor.membershipStatus,
    mfaSatisfied: actor.mfaSatisfied,
  };
}

export function toOperationsSession(actor: NativeOrganizationActor) {
  return {
    authenticated: actor.authenticated,
    mfaSatisfied: actor.mfaSatisfied,
    membershipStatus: actor.membershipStatus,
    organizationStatus: actor.organizationStatus,
    selectedOrganizationId: actor.organizationId,
    role: actor.organizationRoles.includes('admin') ? 'admin' : actor.selectedHat,
    actorKind: 'browser',
  };
}

export type IntegrationLoadState = 'idle' | 'loading' | 'ready' | 'mfa' | 'unauthorized' | 'error';

export type IntegrationControlSurface = 'forbidden' | 'preview' | 'loading' | 'mfa' | 'error' | 'ready';

export function integrationControlSurface(
  manager: boolean,
  persisted: boolean,
  loadState: IntegrationLoadState,
): IntegrationControlSurface {
  if (!manager) return 'forbidden';
  if (!persisted) return 'preview';
  if (loadState === 'loading' || loadState === 'idle') return 'loading';
  if (loadState === 'mfa') return 'mfa';
  if (loadState === 'unauthorized') return 'forbidden';
  if (loadState === 'error') return 'error';
  return 'ready';
}

// Provider status cards carry per-organization truth, so they may render only
// after a live status read succeeded ('ready'). The preview catalog is a
// status-free listing and never shows a catalogue-default unset/disabled pill.
export function showsProviderStatusCards(surface: IntegrationControlSurface): boolean {
  return surface === 'ready';
}

// What Operations health knows about held switches: the keys of the admin
// settings list (null while unread or after a failed read) and whether the
// viewer is a Compass AI platform operator.
export type HeldJobScope = {
  listedSettingKeys: readonly string[] | null;
  platformOperator: boolean;
};

export const UNREAD_HELD_JOB_SCOPE: HeldJobScope = Object.freeze({ listedSettingKeys: null, platformOperator: false });

// The web Job health rule, from the same map (JOB_ACTS_BESIDE in
// src/lib/heldSettingCompanions.js): a job that serves a switch the admin
// settings list left out (held) is not listed, and while the list is unread
// none of those jobs are. A released switch is listed again, so its job comes
// back with no app release.
export function withoutHeldJobs<T extends { jobName: string }>(jobs: T[], scope: HeldJobScope): T[] {
  const listed: T[] = withoutJobsBesideHeldSwitches(jobs, {
    listedSettingKeys: scope.listedSettingKeys ? [...scope.listedSettingKeys] : null,
    platformOperator: scope.platformOperator,
  });
  return listed;
}
