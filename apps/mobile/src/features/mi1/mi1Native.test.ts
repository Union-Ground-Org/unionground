import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { canOpenFeature, FEATURE_KEYS, isStaffOnlyFeatureKey } from '../../lib/featureCatalog';
import {
  buildNativeActor,
  canClientInsertAudit,
  canManageIntegrations,
  clientMayCallRecordAudit,
  getScimControlSurface,
  integrationControlSurface,
  isMi1FeatureKey,
  MI1_FEATURE_KEYS,
  MI1_NATIVE_PERSISTENCE,
  nativeOrganizationId,
  PRODUCT_JOBS,
  showsProviderStatusCards,
  SCIM_SWITCH_KEY,
  toIntegrationActor,
  toOperationsSession,
} from '../../lib/mi1Shared';
import { routeFromNotification } from '../../lib/routes';
import { nativeUiText, type NativeUiKey } from '../../lib/nativeUiCopy';

function source(relativeFromThisFile: string): string {
  return readFileSync(fileURLToPath(new URL(relativeFromThisFile, import.meta.url)), 'utf8');
}

describe('MI1 native integration-control wiring', () => {
  it('registers the integration and operations destinations with their exact staff gates', () => {
    expect(FEATURE_KEYS).toEqual(expect.arrayContaining([...MI1_FEATURE_KEYS]));
    expect(MI1_FEATURE_KEYS).toEqual(['integrations', 'operations']);
    expect(isMi1FeatureKey('integrations')).toBe(true);
    expect(isMi1FeatureKey('qa')).toBe(false);
    expect(canOpenFeature('preview', 'integrations', 'admin')).toBe(true);
    expect(canOpenFeature('preview', 'integrations', 'vp')).toBe(true);
    expect(canOpenFeature('preview', 'integrations', 'steward')).toBe(false);
    expect(isStaffOnlyFeatureKey('integrations')).toBe(true);
    expect(routeFromNotification({ screen: 'integrations' })).toBeNull();
    expect(isMi1FeatureKey('operations')).toBe(true);
    expect(canOpenFeature('preview', 'operations', 'admin')).toBe(true);
    expect(canOpenFeature('preview', 'operations', 'vp')).toBe(false);
    expect(isStaffOnlyFeatureKey('operations')).toBe(true);
    expect(routeFromNotification({ screen: 'operations' })).toBeNull();
  });

  it('keeps optional persistence honestly unavailable and never invents a tenant', () => {
    expect(MI1_NATIVE_PERSISTENCE).toEqual({
      integrationSecrets: false,
      scimLive: false,
      operationsLedger: true,
    });

    const empty = buildNativeActor({ userId: 'member-1', chapterId: 'wor', roles: ['admin'], selectedHat: 'admin', authenticated: true });
    expect(empty.organizationId).toBeNull();
    expect(canManageIntegrations(toIntegrationActor(empty))).toBe(false);

    const scoped = buildNativeActor({
      userId: 'member-1',
      organizationId: '11111111-1111-4111-8111-111111111111',
      chapterId: 'wor',
      roles: ['admin'],
      organizationRoles: ['admin'],
      authenticated: true,
      mfaSatisfied: true,
    });
    expect(scoped.organizationId).toBe('11111111-1111-4111-8111-111111111111');
    expect(canManageIntegrations(toIntegrationActor(scoped))).toBe(true);
    expect(nativeOrganizationId()).toBeNull();
    expect(canClientInsertAudit()).toBe(false);
    expect(clientMayCallRecordAudit()).toBe(false);
    // The native build re-exports the one shared registry, so this list pins
    // every job it exposes in src/features/operations/jobRegistry.js order: a
    // job added there reaches the phones the moment it lands, and this row is
    // where that shows up.
    expect(PRODUCT_JOBS.map((job) => job.jobName)).toEqual([
      'mi1-job-health-sync',
      'integration-webhooks-dispatch-tick',
      'notifications-dispatch-tick',
      'account-deletion-reconcile-tick',
      'notifications-expiry-sweep',
      'deadline-notices-tick',
      'ballot-notices-tick',
      'event-notices-tick',
      'appointment-reminders-tick',
      'member-messaging-dispatch',
      'workload-reminders-tick',
      'ballot-choices-mix',
      'ballot-choices-mix-recent',
      'task-files-reconcile-tick',
      'task-maintenance-daily',
      'casework-alert-escalation-tick',
      'casework-reminder-delivery-tick',
      'weekly-question-selection-tick',
      'live-poll-schedule-tick',
      'survey-operations-sweep',
      'minutes-pre-event-notices-tick',
      'knowledge-source-health-tick',
      'organization-automation-tick',
      'mi1-analytics-receipt-retention',
      'event-checkin-token-retention',
      'union-ground-organization-retention',
      'mesh-agency-usage-aggregate-tick',
      'casework-retaliation-timing-tick',
      'casework-deadline-reminder-tick',
      'issue-intelligence-weekly-digest',
      'analytics-usage-digest',
      'learning-period-end-tick',
      'pulse-weekly-snapshots',
      'chapter-leadership-claims-tick',
    ]);
    // Union Ground leaves dues, public meetings and the public directory's
    // claims, ULP deadlines and SSO out (owner decision, 2026-10-13); the
    // shared registry dropped their jobs, so the phones expose none of them.
    const names = PRODUCT_JOBS.map((job) => job.jobName);
    for (const retired of ['dues-reminders-dispatch-tick', 'dues-stripe-reconcile-tick', 'mi1-public-rsvp-retention', 'organization-claim-retention', 'casework-ulp-deadline-tick', 'sso-identity-link-sweep']) {
      expect(names).not.toContain(retired);
    }
    expect(names.filter((name) => /dues|ulp|sso|public-rsvp/.test(name))).toEqual([]);
  });

  // Each denial below flips exactly one field away from an actor the same case
  // proves authorized, so dropping any single check in canManageIntegrations
  // fails its own row instead of hiding behind the other unmet requirements.
  it('denies integration management for one unmet requirement at a time', () => {
    type NativeActorInput = NonNullable<Parameters<typeof buildNativeActor>[0]>;

    const authorized: NativeActorInput = {
      userId: 'member-1',
      organizationId: '11111111-1111-4111-8111-111111111111',
      chapterId: 'wor',
      roles: ['admin'],
      organizationRoles: ['admin'],
      selectedHat: 'admin',
      authenticated: true,
      mfaSatisfied: true,
    };
    expect(canManageIntegrations(toIntegrationActor(buildNativeActor(authorized)))).toBe(true);

    const denials: ReadonlyArray<readonly [string, NativeActorInput]> = [
      ['no user id', { userId: null }],
      ['no organization id', { organizationId: null }],
      ['revoked membership', { membershipStatus: 'revoked' }],
      ['mfa unsatisfied', { mfaSatisfied: false }],
      ['hat outside the integration-manager set', { selectedHat: 'steward' }],
      ['no organization-wide roles', { organizationRoles: [] }],
    ];
    for (const [reason, override] of denials) {
      const actor = buildNativeActor({ ...authorized, ...override });
      expect(canManageIntegrations(toIntegrationActor(actor)), reason).toBe(false);
    }
  });

  it('points SCIM setup to the website without minting tokens', () => {
    const scim = getScimControlSurface();
    expect(scim.switchKey).toBe(SCIM_SWITCH_KEY);
    expect(scim.switchKey).toBe('features.integrations.scim');
    expect(scim.publicMessage).toContain('on the website');
    expect(scim.publicMessage).toContain('nobody gets an account until they accept one');
  });

  it('names the web Integrations destination in the native overview and provider cards', () => {
    const integrations = source('./IntegrationControlsScreen.tsx');
    const webNavigation = source('../../../../../src/lib/workspacePages.js');
    expect(webNavigation).toContain('base: "/m/integrations"');
    const instructions: Array<[NativeUiKey, string]> = [
      ['Current provider status appears below. Open Integrations in the web app to make changes.',
        'El estado actual de los proveedores aparece abajo. Abre Integraciones en la aplicación web para hacer cambios.'],
      ['Open Integrations in the web app to change this connection.',
        'Abre Integraciones en la aplicación web para cambiar esta conexión.'],
    ];
    for (const [english, spanish] of instructions) {
      expect(integrations).toContain(`t('${english}')`);
      expect(nativeUiText('es')(english)).toBe(spanish);
    }
  });

  it('reuses the shared engine without mounting web JSX or SCIM token minting', () => {
    const shared = source('../../lib/mi1Shared.ts');
    const integrations = source('./IntegrationControlsScreen.tsx');
    const featureScreen = source('./Mi1FeatureScreen.tsx');
    const supabaseService = source('../../services/supabase.ts');
    const appProvider = source('../../state/AppProvider.tsx');
    const feature = source('../FeatureScreen.tsx');

    expect(shared).toContain("from '../../../../src/features/integrations/catalog.js'");
    expect(shared).not.toContain('features/qa');
    expect(shared).not.toContain('features/pay');
    expect(shared).not.toContain('features/analytics');
    expect(shared).not.toContain('features/publicDirectory');
    expect(shared).not.toContain('IntegrationControlPlane');
    expect(shared).not.toContain('buildScimTokenCustody');
    expect(integrations).toContain('getScimControlSurface()');
    expect(integrations).toContain('loadMobileIntegrationProviders()');
    expect(integrations.match(/id === 'scim'/g)).toHaveLength(1);
    expect(integrations).not.toContain('buildScimTokenCustody');
    const operations = source('./OperationsHealthScreen.tsx');
    expect(operations).toContain('Review recent organization activity and scheduled work.');
    expect(operations).not.toMatch(/rpc\(/);
    expect(featureScreen).toContain('organizationID, organizationRoles, chapterRoles } = useApp()');
    expect(featureScreen).toContain("persisted={mode === 'authenticated'}");
    expect(integrations).toContain('integrationControlSurface(manager, persisted, boundLoadState)');
    expect(integrations).toContain("surface === 'preview'");
    expect(integrations).toContain('Preview catalog');
    expect(integrations).toContain('This preview shows the connection catalog. Current status is not loaded here.');
    expect(integrations).not.toContain('Sign in to continue');
    expect(integrations).not.toContain('Sign in to view current connection status.');
    expect(integrationControlSurface(false, false, 'idle')).toBe('forbidden');
    expect(integrationControlSurface(true, false, 'ready')).toBe('preview');
    expect(integrationControlSurface(true, false, 'loading')).toBe('preview');
    expect(integrationControlSurface(true, true, 'loading')).toBe('loading');
    expect(integrationControlSurface(true, true, 'idle')).toBe('loading');
    expect(integrationControlSurface(true, true, 'mfa')).toBe('mfa');
    expect(integrationControlSurface(true, true, 'unauthorized')).toBe('forbidden');
    expect(integrationControlSurface(true, true, 'error')).toBe('error');
    expect(integrationControlSurface(true, true, 'ready')).toBe('ready');
    expect(integrationControlSurface(true, true, 'ready')).not.toBe('preview');
    expect(integrationControlSurface(true, false, 'idle')).not.toBe('loading');
    expect(featureScreen).toContain("featureKey === 'integrations'");
    expect(featureScreen).toContain("<OperationsHealthScreen actor={actor} live={mode === 'authenticated'} />");
    expect(supabaseService).toContain("organizationID: typeof entry.organizationId === 'string'");
    expect(supabaseService).toContain("supabase.rpc('list_organization_integrations')");
    expect(appProvider).toContain('PREVIEW_ORGANIZATION_ID');
    expect(appProvider).toContain('organizationID: PREVIEW_ORGANIZATION_ID');
    expect(feature).toContain('if (isMi1FeatureKey(featureKey))');
    expect(feature).toContain('<Mi1FeatureScreen featureKey={featureKey} />');
  });

  it('shows provider status cards only after a live status read succeeded', () => {
    expect(showsProviderStatusCards('ready')).toBe(true);
    expect(showsProviderStatusCards('forbidden')).toBe(false);
    expect(showsProviderStatusCards('preview')).toBe(false);
    expect(showsProviderStatusCards('loading')).toBe(false);
    expect(showsProviderStatusCards('mfa')).toBe(false);
    expect(showsProviderStatusCards('error')).toBe(false);
    expect(showsProviderStatusCards(integrationControlSurface(true, true, 'unauthorized'))).toBe(false);
  });

  it('binds live status to the actor organization and classifies remaining 42501 denials', () => {
    const integrations = source('./IntegrationControlsScreen.tsx');
    const supabaseService = source('../../services/supabase.ts');

    expect(integrations).toContain('const boundLoadState: IntegrationLoadState = statusOrganizationId === actor.organizationId');
    expect(integrations).toContain('statusOrganizationId !== actor.organizationId');
    expect(integrations).toContain('setStatusOrganizationId(actor.organizationId)');
    expect(integrations).toContain('isNotAuthorizedRpcError(error)');
    expect(integrations).toContain("? 'unauthorized'");
    expect(supabaseService).toContain('export function isNotAuthorizedRpcError');
    expect(supabaseService).toContain('/not authorized|authentication required|active organization membership required/i');
    expect(supabaseService).toContain("if (/mfa required/i.test(message)) return false;");
  });
});
