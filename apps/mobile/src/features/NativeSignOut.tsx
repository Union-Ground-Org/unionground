import { useNativeUi } from "../lib/useNativeUi";
import { useEffect, useId, useRef, useState } from 'react';
import { Platform, View } from 'react-native';

import { Body, Button, Card, Heading } from '../components/ui';
import { queueAccessibilityAnnouncement } from '../lib/announce';
import { useApp } from '../state/AppProvider';
import { spacing } from '../theme/tokens';

// Account keeps this entry beside the profile, before the long settings list.
// Confirmation uses app-owned light surfaces, including on an OS-dark phone.
// The provider still owns revocation, protected-state cleanup and navigation.
export function NativeSignOut() {
  const { t } = useNativeUi();
  const { mode, signOut, signOutBusy, signOutError, sampleEntryBusy } = useApp();
  const [confirming, setConfirming] = useState(false);
  const [working, setWorking] = useState(false);
  const [unexpectedError, setUnexpectedError] = useState<string | null>(null);
  const started = useRef(false);
  const announcementOwner = useId();
  const announcementAttempt = useRef(0);
  const preview = mode === 'preview';
  const busy = working || signOutBusy || sampleEntryBusy;
  const heading = preview ? t("Exit preview?") : t("Sign out of this phone?");
  const error = signOutError ?? unexpectedError;
  const confirmLabel = preview ? t("Confirm exit preview") : t("Confirm sign out");

  useEffect(() => {
    if (Platform.OS === 'ios' && confirming) {
      return queueAccessibilityAnnouncement(heading, `${announcementOwner}:${++announcementAttempt.current}`);
    }
    return undefined;
  }, [announcementOwner, confirming, heading]);
  useEffect(() => {
    if (Platform.OS === 'ios' && error) {
      return queueAccessibilityAnnouncement(error, `${announcementOwner}:${++announcementAttempt.current}`);
    }
    return undefined;
  }, [announcementOwner, error]);

  async function confirm() {
    if (started.current || busy) return;
    started.current = true;
    setUnexpectedError(null);
    setWorking(true);
    try {
      await signOut();
    } catch {
      // The provider normally reports a refusal through signOutError. Keep an
      // unexpected rejection recoverable too, without an unhandled callback.
      setUnexpectedError(t("Sign-out was not confirmed. Try again."));
    } finally {
      started.current = false;
      setWorking(false);
      setConfirming(false);
    }
  }

  return (
    <Card>
      {confirming ? (
        <View accessibilityLiveRegion="polite" style={{ gap: spacing.md }}>
          <Heading level={3}>{heading}</Heading>
          <Body>{preview ? t("Return to sign-in and leave this preview.") : t("You’ll need to sign in again on this phone. Your other devices stay signed in.")}</Body>
          <Button label={working ? preview ? t("Exiting preview…") : t("Signing out…") : confirmLabel} variant="danger" busy={busy} disabled={busy} onPress={() => { void confirm(); }} testID="native-account-confirm-sign-out" />
          <Button label={t("Cancel")} variant="secondary" disabled={busy} onPress={() => setConfirming(false)} />
        </View>
      ) : (
        <Button label={preview ? t("Exit preview") : t("Sign out")} variant="danger" disabled={busy} onPress={() => setConfirming(true)} testID="native-account-sign-out" />
      )}
      {error ? <Body accessibilityRole="alert">{error}</Body> : null}
    </Card>
  );
}
