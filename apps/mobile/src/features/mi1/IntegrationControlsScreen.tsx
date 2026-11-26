import type { NativeUiKey } from '../../lib/nativeUiCopy';
import { useNativeUi } from '../../lib/useNativeUi';
import { useEffect, useState } from 'react';
import { View } from 'react-native';

import { StatusPill } from '../../components/StatusPill';
import { Body, Button, Card, Heading, Screen, StateMessage } from '../../components/ui';
import {
  canManageIntegrations,
  defaultProviderRecord,
  getScimControlSurface,
  INTEGRATION_PROVIDER_CATALOG,
  INTEGRATION_PROVIDER_IDS,
  integrationControlSurface,
  isActivatableProvider,
  showsProviderStatusCards,
  toIntegrationActor,
  type IntegrationLoadState,
  type NativeOrganizationActor,
} from '../../lib/mi1Shared';
import {
  isMfaRequiredRpcError,
  isNotAuthorizedRpcError,
  loadMobileIntegrationProviders,
  loadMobileScimReleased,
  type MobileIntegrationProvider,
} from '../../services/supabase';
import { statusStateForLabel } from '../../theme/statusRamp';

const connectionStatusLabels = new Map<string, NativeUiKey>([
  ['unset', 'Not set up'],
  ['requested', 'Setup requested'],
  ['configured', 'Configured'],
  ['connected', 'Connected'],
  ['degraded', 'Needs attention'],
  ['revoked', 'Revoked'],
  ['disabled', 'Disabled'],
]);

export function IntegrationControlsScreen({ actor, persisted }: { actor: NativeOrganizationActor; persisted: boolean }) {
  // The shared authorization helper is untyped JavaScript; pin its verdict to
  // a boolean at this boundary.
  const { catalogLabel, t } = useNativeUi();
  const manager: boolean = canManageIntegrations(toIntegrationActor(actor)) === true;
  const scim = getScimControlSurface();
  const [providers, setProviders] = useState<MobileIntegrationProvider[]>([]);
  const [loadState, setLoadState] = useState<IntegrationLoadState>('idle');
  const [attempt, setAttempt] = useState(0);
  // Status is org-scoped. Reset before paint when the actor organization
  // changes so a prior ready/mfa/error frame cannot render under a new tenant.
  const [statusOrganizationId, setStatusOrganizationId] = useState(actor.organizationId);
  if (statusOrganizationId !== actor.organizationId) {
    setStatusOrganizationId(actor.organizationId);
    setProviders([]);
    setLoadState('idle');
  }

  // Directory sync (SCIM) is held with single sign-on (#9037): its card shows
  // only after this organization's read answers released. Held, unread, or in
  // the preview catalog, no card names it. Try again reads it again too.
  const [scimRelease, setScimRelease] = useState<{ organizationId: string | null; released: boolean } | null>(null);
  useEffect(() => {
    let active = true;
    if (!manager || !persisted) return () => { active = false; };
    const organizationId = actor.organizationId;
    loadMobileScimReleased()
      .then((released) => { if (active) setScimRelease({ organizationId, released }); })
      .catch(() => { if (active) setScimRelease({ organizationId, released: false }); });
    return () => { active = false; };
  }, [actor.organizationId, manager, persisted, attempt]);
  const scimReleased = scimRelease?.organizationId === actor.organizationId && scimRelease.released;

  useEffect(() => {
    let active = true;
    if (!manager || !persisted) {
      setProviders([]);
      setLoadState('idle');
      return () => { active = false; };
    }
    setProviders([]);
    setLoadState('loading');
    loadMobileIntegrationProviders().then((rows) => {
      if (!active) return;
      setProviders(rows);
      setLoadState('ready');
    }).catch((error: unknown) => {
      if (!active) return;
      setProviders([]);
      setLoadState(
        isMfaRequiredRpcError(error)
          ? 'mfa'
          : isNotAuthorizedRpcError(error)
            ? 'unauthorized'
            : 'error',
      );
    });
    return () => { active = false; };
  }, [actor.organizationId, manager, persisted, attempt]);

  const boundLoadState: IntegrationLoadState = statusOrganizationId === actor.organizationId
    ? loadState
    : 'idle';
  const surface = integrationControlSurface(manager, persisted, boundLoadState);
  const showStatusCards = showsProviderStatusCards(surface);
  // The shared catalogue carries no Stripe dues entry (Union Ground leaves
  // dues out); directory sync shows only once it is released.
  const catalogIds = INTEGRATION_PROVIDER_IDS.filter((id) => id !== 'scim' || (showStatusCards && scimReleased));

  return (
    <Screen>
      <Heading>{catalogLabel('Connected services')}</Heading>
      <Body muted>Optional connections stay unset until this organization completes its own setup.</Body>
      {surface === 'forbidden' ? (
        <StateMessage title="Admin or campaign chair only" body={catalogLabel('Only organization administrators and the campaign chair set up connected services. This role cannot start a connection.')} />
      ) : surface === 'preview' ? (
        <StateMessage title="Preview catalog" body="This preview shows the connection catalog. Current status is not loaded here." />
      ) : surface === 'loading' ? (
        <StateMessage title="Loading setup" body="Loading current connection status." />
      ) : surface === 'mfa' ? (
        <StateMessage title="Two-step required" body={catalogLabel('Complete two-step sign-in, then reopen connected services.')} />
      ) : surface === 'error' ? (
        <StateMessage
          title="Setup unavailable"
          body="Connection status could not be loaded. Try again."
          action={<Button label="Try again" variant="secondary" onPress={() => setAttempt((value) => value + 1)} />}
        />
      ) : (
        <StateMessage title="Organization setup" body={t('Current provider status appears below. Open Integrations in the web app to make changes.')} />
      )}
      {(surface === 'preview' || showStatusCards) ? catalogIds.map((id) => {
        const entry = INTEGRATION_PROVIDER_CATALOG[id as keyof typeof INTEGRATION_PROVIDER_CATALOG];
        // Status pills may only carry truth read for this organization: the
        // preview catalog stays status-free, and unset/disabled fallbacks
        // exist solely on the ready surface after a successful status read.
        const persistedRecord = showStatusCards ? providers.find((row) => row.provider === id) : undefined;
        const record = persistedRecord ?? (showStatusCards ? defaultProviderRecord(id) : undefined);
        const status = record?.status ?? 'unset';
        const activatable = isActivatableProvider(id);
        return (
          <Card key={id}>
            <View style={{ gap: 8 }}>
              <Heading level={3}>{entry.label}</Heading>
              {showStatusCards ? (
                <StatusPill
                  label={t(connectionStatusLabels.get(status) ?? 'Connection status unavailable')}
                  state={statusStateForLabel(status)}
                />
              ) : null}
              <Body muted>{entry.setupSummary}</Body>
              {id === 'scim' ? (
                <Body>{scim.publicMessage}</Body>
              ) : activatable ? (
                <Body muted>
                  {persistedRecord?.allowChapterOverrides ? 'Campaign controls are enabled. ' : ''}
                  {t('Open Integrations in the web app to change this connection.')}
                </Body>
              ) : null}
            </View>
          </Card>
        );
      }) : null}
    </Screen>
  );
}
