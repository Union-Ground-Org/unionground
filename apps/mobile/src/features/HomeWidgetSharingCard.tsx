import { useNativeUi } from "../lib/useNativeUi";
import { useState, useSyncExternalStore } from 'react';

import { useHomeWidgetScope } from '../components/HomeWidgetGate';
import { Body, Button, Card, Heading, Notice } from '../components/ui';
import { homeWidgets, homeWidgetsAvailable, readHomeWidgetSnapshot } from '../services/homeWidgets';
import { useApp } from '../state/AppProvider';

export function HomeWidgetSharingCard() {
  const { t } = useNativeUi();
  const scope = useHomeWidgetScope();
  const { session, error, refreshing, sessionRestrictionPending, locked, privacyCovered, signOutBusy } = useApp();
  const enabled = useSyncExternalStore(homeWidgets.subscribe, homeWidgets.enabled, () => false);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  if (!scope || !homeWidgetsAvailable) return null;
  const blocked = busy || Boolean(error) || refreshing || sessionRestrictionPending || locked || privacyCovered || signOutBusy;
  async function change() {
    if (blocked || !scope || !session) return;
    setBusy(true);
    setNotice(null);
    try {
      if (enabled) {
        await homeWidgets.disable();
        // Turning sharing off also retires consent; retain the authorized scope
        // so a later deliberate enable can start a new generation.
        await homeWidgets.setScope(scope);
        setNotice(t("Widget sharing is off."));
      } else {
        await homeWidgets.setScope(scope);
        await homeWidgets.enable(scope);
        await homeWidgets.refresh(scope, () => readHomeWidgetSnapshot(session, scope));
        setNotice(t("Counts refreshed. Add Today or Unread messages from your home-screen widget picker."));
      }
    } catch {
      setNotice(t("Counts are unavailable. Open your workspace and try again."));
    } finally { setBusy(false); }
  }
  return <Card>
    <Heading level={2}>{t("Home-screen widgets")}</Heading>
    <Body>{t("Share only Today and unread inbox counts with this device’s home screen. Anyone who can see your home screen can see these counts.")}</Body>
    <Body>{t("Your phone may keep an older widget image briefly after counts expire or sharing stops.")}</Body>
    <Body muted>{t("Counts expire after five minutes or at midnight. Open the app to refresh. Sharing starts off after a cold launch, sign-out, or campaign change. No message text or names are shared.")}</Body>
    <Button label={busy ? t("Updating widgets…") : enabled ? t("Stop sharing widget counts") : t("Share widget counts on this device")} disabled={blocked} onPress={() => { void change(); }} />
    {enabled ? <Button label={t("Refresh widget counts")} disabled={blocked} onPress={() => {
      if (!scope || !session) return;
      setBusy(true);
      void homeWidgets.refresh(scope, () => readHomeWidgetSnapshot(session, scope))
        .then(() => setNotice(t("Widget counts refreshed.")))
        .catch(() => setNotice(t("Counts are unavailable. Open your workspace and try again.")))
        .finally(() => setBusy(false));
    }} /> : null}
    {notice ? <Notice>{notice}</Notice> : null}
  </Card>;
}
