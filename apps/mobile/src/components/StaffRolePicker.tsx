import { StyleSheet, View } from 'react-native';

import { LIVE_STAFF_ROLE_LABELS } from '../lib/hatFunctions';
import { haptics } from '../services/haptics';
import { useApp } from '../state/AppProvider';
import { spacing } from '../theme/tokens';
import { Body, Button } from './ui';

// A live account holding more than one server-confirmed staff role picks which
// one the app works as. The pick lasts for the session and narrows the desks
// shown; every server check still runs on the real assignments. One-role
// accounts have nothing to choose and see nothing.
export function StaffRolePicker() {
  const { mode, staffRoleChoices, chosenStaffRole, chooseStaffRole } = useApp();
  if (mode !== 'authenticated' || staffRoleChoices.length < 2) return null;
  return (
    <View style={styles.group} accessibilityRole="radiogroup" accessibilityLabel="Staff role">
      <Body muted>
        {chosenStaffRole
          ? `You hold more than one staff role. Working as ${LIVE_STAFF_ROLE_LABELS[chosenStaffRole]}. Choose another to switch:`
          : 'You hold more than one staff role. Choose which one to work as:'}
      </Body>
      {staffRoleChoices.map((role) => (
        <Button
          key={role}
          label={LIVE_STAFF_ROLE_LABELS[role]}
          variant="secondary"
          selected={chosenStaffRole === role}
          onPress={() => {
            void haptics.select();
            chooseStaffRole(role);
          }}
        />
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  group: { gap: spacing.sm },
});
