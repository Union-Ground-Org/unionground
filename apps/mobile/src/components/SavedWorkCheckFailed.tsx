import { useRef, useSyncExternalStore } from 'react';
import { resumeDraftReadsFailed, subscribeResumeDrafts, type ResumeDraftReadFailure } from '../lib/resumeDraftHolder';
import { View } from 'react-native';
import { useNativeUi } from '../lib/useNativeUi';
import { useApp } from '../state/AppProvider';
import { spacing } from '../theme/tokens';
import { Button, Notice } from './ui';

// #9459 M1-21: said beside a form whose held work a failed session read keeps
// concealed. refresh() re-reads the workspace, memberships and staff roles.
export function SavedWorkCheckFailed({ fitWords = false, retryLabel }: { fitWords?: boolean; retryLabel?: string } = {}) {
  const { t } = useNativeUi();
  const { refresh, refreshing } = useApp();
  // The connection is named only when the read got no reply (#9482 pre-final).
  const noAnswer = useSyncExternalStore(subscribeResumeDrafts, resumeDraftReadsFailed, (): ResumeDraftReadFailure => false) === 'no-answer';
  // One refresh at a time, even for a second press before the busy state draws (#9482 round 1).
  const inFlight = useRef(false);
  const retry = () => {
    if (inFlight.current) return;
    inFlight.current = true;
    void refresh('user-refresh').finally(() => { inFlight.current = false; });
  };
  return (
    <View style={{ flex: 1, gap: spacing.sm }}>
      {/* Notice queues the iPhone announcement and is a polite live region (ledger 725). */}
      <Notice fitWords={fitWords}>{noAnswer ? t('Your saved work could not be checked. Check your connection and try again.') : t('Your saved work could not be checked. Try again.')}</Notice>
      <Button label={retryLabel ?? t('Try again')} variant="secondary" disabled={refreshing} busy={refreshing} onPress={retry} />
    </View>
  );
}
