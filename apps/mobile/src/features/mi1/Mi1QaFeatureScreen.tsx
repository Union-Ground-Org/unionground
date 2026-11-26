import { useMemo } from 'react';

import { buildNativeQaActor } from '../../lib/mi1QaShared';
import { explicitLiveStaffHat } from '../../lib/hatFunctions';
import { useApp } from '../../state/AppProvider';
import { MemberQaScreen } from './MemberQaScreen';

export function Mi1QaFeatureScreen() {
  const { mode, dashboard, previewHat, authorizedRoles, chapterMemberships, organizationID, organizationRoles, chapterRoles } = useApp();
  const selectedMembership = chapterMemberships.find((entry) => entry.selected) ?? null;
  const actor = useMemo(() => buildNativeQaActor({
    userId: dashboard?.member.id ?? null,
    organizationId: organizationID,
    chapterId: selectedMembership?.chapterID ?? dashboard?.member.chapterID ?? null,
    roles: authorizedRoles,
    organizationRoles,
    chapterRoles,
    selectedHat: mode === 'preview' ? previewHat : explicitLiveStaffHat(authorizedRoles),
    authenticated: mode === 'authenticated',
    mfaSatisfied: mode === 'authenticated',
  }), [authorizedRoles, chapterRoles, dashboard?.member.chapterID, dashboard?.member.id, mode, organizationID, organizationRoles, previewHat, selectedMembership?.chapterID]);

  return <MemberQaScreen actor={actor} language={dashboard?.member.language ?? 'en'} live={mode === 'authenticated'} />;
}
