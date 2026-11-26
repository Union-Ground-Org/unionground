import { useMemo } from 'react';

import type { FeatureKey } from '../../lib/featureCatalog';
import { explicitLiveStaffHat } from '../../lib/hatFunctions';
import { buildNativeActor, isMi1FeatureKey } from '../../lib/mi1Shared';
import { useApp } from '../../state/AppProvider';
import { IntegrationControlsScreen } from './IntegrationControlsScreen';
import { OperationsHealthScreen } from './OperationsHealthScreen';

export function Mi1FeatureScreen({ featureKey }: { featureKey: FeatureKey }) {
  const { mode, dashboard, previewHat, authorizedRoles, chapterMemberships, organizationID, organizationRoles, chapterRoles } = useApp();
  const selectedMembership = chapterMemberships.find((entry) => entry.selected) ?? null;
  const selectedOrganizationHat = mode === 'preview'
    ? previewHat && previewHat !== 'member' && organizationRoles.includes(previewHat) ? previewHat : null
    : explicitLiveStaffHat(organizationRoles);
  const actor = useMemo(() => buildNativeActor({
    userId: dashboard?.member.id ?? null,
    organizationId: organizationID,
    chapterId: selectedMembership?.chapterID ?? dashboard?.member.chapterID ?? null,
    roles: authorizedRoles,
    organizationRoles,
    chapterRoles,
    selectedHat: selectedOrganizationHat,
    authenticated: mode === 'authenticated' || mode === 'preview',
    mfaSatisfied: mode === 'authenticated' || mode === 'preview',
  }), [authorizedRoles, chapterRoles, dashboard?.member.chapterID, dashboard?.member.id, mode, organizationID, organizationRoles, selectedMembership?.chapterID, selectedOrganizationHat]);

  if (!isMi1FeatureKey(featureKey)) return null;
  if (featureKey === 'integrations') {
    return <IntegrationControlsScreen actor={actor} persisted={mode === 'authenticated'} />;
  }
  return <OperationsHealthScreen actor={actor} live={mode === 'authenticated'} />;
}
