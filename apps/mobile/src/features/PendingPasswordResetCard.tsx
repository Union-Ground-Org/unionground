import { useFocusEffect } from 'expo-router';
import { useCallback, useState } from 'react';

import { Body, Button, Card, Heading } from '../components/ui';
import { loadPendingReset, sameResetAccount } from '../lib/pendingPasswordReset';
import { signedInResetAccount } from '../services/emailAuth';
import { useNativeUi } from '../lib/useNativeUi';
import { useApp } from '../state/AppProvider';

// BUG-UG-AUTHENTICATED-NATIVE-RESET-RESUME-20261021: a reset begun
// from an emailed link stays resumable for 15 minutes, but the sign-in screen
// that offers it sends a signed-in member straight to Home. Account says a
// reset is waiting and offers to sign out first. Finishing a reset ends every
// session of the account it changes, so the reset is never continued on top of
// this session: once signed out, the root layout opens sign-in, which offers
// the saved reset exactly as it does after a signed-out relaunch.
// The card appears only for a reset saved with this account's tag (#5595):
// another account's reset, or one saved before the tag existed, never signs
// this member out. The record and the tag are read again on every focus and
// on the press itself, so a reset that lapsed or finished meanwhile hides the
// card and leaves the session alone.
export function PendingPasswordResetCard() {
  const { session, signOut, signOutBusy } = useApp();
  const { t } = useNativeUi();
  const accessToken = session?.access_token ?? '';
  const [resumable, setResumable] = useState(false);
  const [checking, setChecking] = useState(false);
  const ownReset = useCallback(async () => {
    const pending = await loadPendingReset();
    if (!pending?.account) return false;
    return sameResetAccount(pending.account, await signedInResetAccount(accessToken));
  }, [accessToken]);
  useFocusEffect(useCallback(() => {
    let active = true;
    void ownReset().then((own) => { if (active) setResumable(own); }, () => { if (active) setResumable(false); });
    return () => { active = false; };
  }, [ownReset]));
  const finish = useCallback(async () => {
    setChecking(true);
    let own = false;
    try { own = await ownReset(); } catch { own = false; }
    setChecking(false);
    if (!own) { setResumable(false); return; }
    await signOut();
  }, [ownReset, signOut]);
  if (!resumable) return null;
  return (
    <Card>
      <Heading level={3}>{t("Finish resetting your password")}</Heading>
      <Body muted>{t("A password reset for this account was started from an emailed link on this phone in the last 15 minutes. To finish it, sign out here, then choose Continue resetting your password on the sign-in screen.")}</Body>
      <Button label={t("Sign out to finish the reset")} disabled={signOutBusy || checking} onPress={() => { void finish(); }} />
    </Card>
  );
}
