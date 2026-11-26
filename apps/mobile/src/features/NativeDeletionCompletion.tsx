import { useEffect, useRef } from 'react';
import { Keyboard, Platform, View } from 'react-native';
import { deletionCompletionCopy } from '../../../../src/lib/accountDeletionCompletion';
import { Body, Button, Heading, Notice, Screen } from '../components/ui';
import { queueAccessibilityAnnouncement } from '../lib/announce';
import { useApp } from '../state/AppProvider';

export function NativeDeletionCompletion() {
  const { deletionOutcome, deletionCleanup, retryDeletionCleanup, acknowledgeDeletion } = useApp();
  const announcementAttempt = useRef(0);
  useEffect(() => {
    if (!deletionOutcome) return;
    Keyboard.dismiss();
    const copy = deletionCompletionCopy[deletionOutcome.language];
    if (Platform.OS === 'ios') {
      return queueAccessibilityAnnouncement(
        deletionOutcome.uncertain ? copy.uncertainTitle : copy.title,
        `deletion-completion:${++announcementAttempt.current}`,
      );
    }
  }, [deletionOutcome]);
  if (!deletionOutcome) return null;
  const copy = deletionCompletionCopy[deletionOutcome.language];
  return <Screen><Heading>{deletionOutcome.uncertain ? copy.uncertainTitle : copy.title}</Heading>
    <View accessibilityLiveRegion="polite"><Body>{deletionOutcome.uncertain ? copy.uncertainBody : deletionOutcome.audited ? copy.body : copy.pending}</Body></View>
    {deletionCleanup === 'pending' ? <Body>{copy.cleanup}</Body> : null}
    {deletionCleanup === 'failed' ? <Notice>{copy.cleanupFailed}</Notice> : null}
    {deletionCleanup === 'failed'
      ? <Button label={copy.retry} onPress={() => { void retryDeletionCleanup(); }} />
      : <Button label={copy.continue} disabled={deletionCleanup !== 'done'} onPress={acknowledgeDeletion} />}
  </Screen>;
}
