import { useEffect, useRef, useState } from 'react';
import { Switch, View } from 'react-native';
import { Body, Button, Card, Heading } from '../components/ui';
import { DisabledStateBoundary } from '../components/DisabledStateBoundary';
import { loadPulseScorePreference, savePulseScorePreference } from '../services/stewardPulse';
import { useApp } from '../state/AppProvider';
import { useTheme } from '../theme/ThemeProvider';
import { minimumTouchTarget, spacing } from '../theme/tokens';

export function PulseScorePrivacyCard() {
  const { mode, session, sessionRestricted } = useApp();
  return <ScorePreference key={`${mode}:${session?.user.id}:${sessionRestricted}`} />;
}

function ScorePreference() {
  const { mode, session, sessionRestricted } = useApp();
  const theme = useTheme();
  const userID = session?.user.id;
  const [value, setValue] = useState<boolean | null>(mode === 'preview' ? true : null);
  const [failed, setFailed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  useEffect(() => {
    if (mode !== 'authenticated' || !userID || sessionRestricted) return;
    let active = true;
    setValue(null); setFailed(false);
    void loadPulseScorePreference(userID).then((visible) => { if (active) setValue(visible); })
      .catch(() => { if (active) setFailed(true); });
    return () => { active = false; };
  }, [attempt, mode, sessionRestricted, userID]);
  if ((mode !== 'authenticated' && mode !== 'preview') || sessionRestricted) return null;
  async function save(visible: boolean) {
    if (mode === 'preview') { setValue(visible); return; }
    if (!userID || busy || value === null) return;
    setBusy(true); setFailed(false);
    try { const saved = await savePulseScorePreference(userID, visible); if (mounted.current) setValue(saved); }
    catch { if (mounted.current) setFailed(true); }
    finally { if (mounted.current) setBusy(false); }
  }
  return <Card>
    <Heading level={2}>Pulse privacy</Heading>
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: spacing.md, minHeight: minimumTouchTarget }}>
      <View style={{ flex: 1 }}><Body>Show my score to my committee member</Body></View>
      <DisabledStateBoundary disabled={value === null || busy} accessibilityRole="switch" accessibilityLabel={`Show my score to my committee member, ${busy ? 'saving' : 'preference unavailable'}`} checked={value === true}>
        <Switch accessibilityLabel="Show my score to my committee member" accessibilityState={{ disabled: value === null || busy, busy }} disabled={value === null || busy} value={value === true} onValueChange={(visible) => { void save(visible); }} trackColor={{ false: theme.muted, true: theme.primary }} thumbColor={value ? theme.primaryForeground : theme.mutedForeground} hitSlop={12} />
      </DisabledStateBoundary>
    </View>
    <Body muted>On by default. Turning it off hides your score and last activity from the committee on every device. Your name remains on their authorized worker list.</Body>
    {value === null && !failed ? <Body muted>Loading your saved preference…</Body> : null}
    {failed ? <><Body>Your preference could not be {value === null ? 'loaded' : 'saved'}. Your saved choice has not changed.</Body><Button label="Retry score preference" variant="secondary" onPress={() => setAttempt((previous) => previous + 1)} /></> : null}
  </Card>;
}
