import { useEffect, useState, type PropsWithChildren } from 'react';
import { StyleSheet, View } from 'react-native';
import { useIsFocused, useRouter } from 'expo-router';

import { Body, Button, Card, Heading } from './ui';
import {
  nextQuarterlyGateVisit, quarterLabel, quarterlyGateContextKey, quarterlyGateStatusFor, type QuarterlyGateCheck, type QuarterlyGateVisit,
} from '../lib/memberSurveysShared';
import { useNativeUi } from '../lib/useNativeUi';
import { loadMobileQuarterlySurveyGateStatus } from '../services/memberSurveys';
import { useApp } from '../state/AppProvider';
import { spacing } from '../theme/tokens';

// REQ-UG-QUARTERLY-SURVEY-GATE-ENFORCED-20261001 (CR-002, "give to view"),
// server-enforced since REQ-UG-QUARTERLY-SURVEY-GATE-SERVER-ENFORCED-20261002
// . get_quarterly_survey_gate decides everything: the
// organization switch, the admin exemption and every fail-open case, and the
// worker report reads behind these screens return a locked payload under the
// same rule. The native half therefore renders the reports, workplace log and
// analytics content only once the server says the page is open. While locked,
// one card explains why and opens the surveys (Votes holds them on native);
// a failed or malformed read is locked too, with a retry, so stale data never
// shows. Signed-out previews are not gated. The gate is re-read whenever the
// screen regains focus, so returning from a submitted survey unlocks it.
// Every answer is stored with the account, organization and visit it was read
// for; the first render after a switch of organization or account, or after
// the screen regains focus, is already "checking" and never shows the content
// on the previous answer.
export function QuarterlySurveyGate({ children }: PropsWithChildren) {
  const { t } = useNativeUi();
  const { mode, organizationID, session } = useApp();
  const router = useRouter();
  const focused = useIsFocused();
  // Updated during render (React's "adjust state when a prop changes"
  // pattern), so the render that regains focus already belongs to the new
  // visit instead of waiting for an effect after paint.
  const [visit, setVisit] = useState<QuarterlyGateVisit>(() => ({ focused, mode, count: 0 }));
  const nextVisit = nextQuarterlyGateVisit(visit, focused, mode);
  if (nextVisit !== visit) setVisit(nextVisit);
  const key = quarterlyGateContextKey(session?.user.id, organizationID, nextVisit);
  const [check, setCheck] = useState<QuarterlyGateCheck | null>(null);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    if (mode !== 'authenticated' || !focused) return undefined;
    let current = true;
    void loadMobileQuarterlySurveyGateStatus()
      .then((next) => {
        if (!current) return;
        setCheck({ key, status: next.status, gate: next.gate });
      })
      .catch(() => {
        if (!current) return;
        setCheck({ key, status: 'error', gate: null });
      });
    return () => { current = false; };
  }, [attempt, focused, key, mode]);

  const status = quarterlyGateStatusFor(check, key);
  const gate = status === 'checking' ? null : check?.gate ?? null;
  if (mode !== 'authenticated' || status === 'open') {
    return <View testID="quarterly-gate-content" style={styles.content}>{children}</View>;
  }
  if (status === 'checking') return <Body muted fitWords>{t('Checking this quarter’s survey…')}</Body>;
  const failed = status === 'error';
  const quarter = quarterLabel(gate?.periodKey, t);
  return (
    <Card>
      <Heading level={3} fitWords>
        {failed
          ? t('We couldn’t check this quarter’s survey')
          : quarter ? t('Unlock your {quarter} stats and charts', { quarter }) : t('Unlock this quarter’s stats and charts')}
      </Heading>
      <Body muted fitWords>
        {failed
          ? t('These stats and charts stay hidden until the check works. Try again, or take the survey now.')
          : t('Take this quarter’s short survey so the campaign can organize with real data. Your voice unlocks these stats and charts.')}
      </Body>
      {failed ? <Button fitWords label={t('Try again')} variant="secondary" onPress={() => setAttempt((count) => count + 1)} /> : null}
      <Button fitWords label={t('Take the survey')} onPress={() => router.push('/feature/voting' as never)} />
    </Card>
  );
}

// The open wrapper keeps the Screen's own spacing between the cards it holds.
const styles = StyleSheet.create({
  content: { gap: spacing.lg },
});
