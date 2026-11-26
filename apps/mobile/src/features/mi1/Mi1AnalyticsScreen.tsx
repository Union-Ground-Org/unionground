import { useMemo } from 'react';

import {
  ANALYTICS_STAFF_HATS,
  buildNativeActor,
  createPreviewAnalyticsSnapshot,
  createPreviewAnalyticsViewer,
  createPreviewAnalyticsWorkspace,
} from '../../lib/mi1AnalyticsShared';
import { useApp } from '../../state/AppProvider';
import { explicitLiveStaffHat } from '../../lib/hatFunctions';
import { loadMobileOrganizationAnalyticsSnapshot, loadMobileOrganizationAnalyticsWorkspace } from '../../services/supabase';
import { AnalyticsCoreScreen } from './AnalyticsCoreScreen';

export function Mi1AnalyticsScreen() {
  const { mode, dashboard, previewHat, authorizedRoles, chapterMemberships, organizationID, organizationRoles, chapterRoles } = useApp();
  const selectedMembership = chapterMemberships.find((entry) => entry.selected) ?? null;
  const selectedOrganizationHat = useMemo(() => {
    if (mode === 'preview') {
      return previewHat && previewHat !== 'member'
        && ANALYTICS_STAFF_HATS.includes(previewHat) && authorizedRoles.includes(previewHat)
        ? previewHat
        : null;
    }
    return explicitLiveStaffHat(organizationRoles.filter((role) => ANALYTICS_STAFF_HATS.includes(role)));
  }, [authorizedRoles, mode, organizationRoles, previewHat]);
  const previewViewer = useMemo(() => createPreviewAnalyticsViewer({
    selectedHat: selectedOrganizationHat,
    roles: authorizedRoles,
    organizationRoles,
    chapterRoles,
  }), [authorizedRoles, chapterRoles, organizationRoles, selectedOrganizationHat]);
  const actor = useMemo(() => buildNativeActor({
    userId: mode === 'preview' ? previewViewer.userId : dashboard?.member.id ?? null,
    organizationId: mode === 'preview' ? previewViewer.organizationId : organizationID,
    chapterId: mode === 'preview' ? previewViewer.chapterId : selectedMembership?.chapterID ?? dashboard?.member.chapterID ?? null,
    roles: authorizedRoles,
    organizationRoles,
    chapterRoles,
    selectedHat: selectedOrganizationHat,
    authenticated: mode === 'authenticated' || mode === 'preview',
    mfaSatisfied: mode === 'authenticated' || mode === 'preview',
  }), [authorizedRoles, chapterRoles, dashboard?.member.chapterID, dashboard?.member.id, mode, organizationID, organizationRoles, previewViewer.chapterId, previewViewer.organizationId, previewViewer.userId, selectedMembership?.chapterID, selectedOrganizationHat]);

  const loadSnapshot = useMemo(() => {
    if (mode === 'authenticated') return loadMobileOrganizationAnalyticsSnapshot;
    if (mode === 'preview') return async () => createPreviewAnalyticsSnapshot();
    return null;
  }, [mode]);
  const loadWorkspace = useMemo(() => {
    if (mode === 'authenticated') return loadMobileOrganizationAnalyticsWorkspace;
    if (mode === 'preview') return async () => createPreviewAnalyticsWorkspace();
    return null;
  }, [mode]);

  return (
    <AnalyticsCoreScreen
      actor={actor}
      loadSnapshot={loadSnapshot}
      loadWorkspace={loadWorkspace}
      preview={mode === 'preview'}
    />
  );
}
