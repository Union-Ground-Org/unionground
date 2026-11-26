import { useEffect, useState } from 'react';
import { Linking, StyleSheet, View } from 'react-native';

import { STAFF_TWO_STEP_NOTICE_TITLE, staffTwoStepSettings } from '../lib/staffTwoStepNotice';
import { loadStaffTwoStepPaused } from '../services/staffTwoStepStanding';
import { useApp } from '../state/AppProvider';
import { spacing } from '../theme/tokens';
import { Body, Button, Card, Heading } from './ui';

const twoStep = staffTwoStepSettings();

// Home notice for a staff member whose roles are paused until a second step is
// set up. Renders nothing for everyone else and while the answer is unknown.
export function StaffTwoStepNotice() {
  const { mode, session, dashboard } = useApp();
  const userID = session?.user.id;
  const [paused, setPaused] = useState(false);
  const [openFailed, setOpenFailed] = useState(false);

  // Another account or mode starts from nothing.
  useEffect(() => {
    setPaused(false);
    setOpenFailed(false);
  }, [mode, userID]);

  // The standing is read again whenever Home's data is (re)loaded, so a pull to
  // refresh picks up a pause an administrator just applied or lifted.
  useEffect(() => {
    if (mode !== 'authenticated' || !userID) return undefined;
    let active = true;
    void loadStaffTwoStepPaused().then((next) => { if (active) setPaused(next); }).catch(() => undefined);
    return () => { active = false; };
  }, [mode, userID, dashboard]);

  if (!paused) return null;
  return (
    <Card>
      <View style={styles.stack}>
        <Heading level={3}>{STAFF_TWO_STEP_NOTICE_TITLE}</Heading>
        <Body muted>{twoStep.body}</Body>
        <Button
          label={twoStep.action}
          variant="secondary"
          onPress={() => {
            setOpenFailed(false);
            void Linking.openURL(twoStep.url).catch(() => setOpenFailed(true));
          }}
        />
        {openFailed ? <Body accessibilityRole="alert">{twoStep.openFailed}</Body> : null}
      </View>
    </Card>
  );
}

const styles = StyleSheet.create({
  stack: { gap: spacing.sm },
});
