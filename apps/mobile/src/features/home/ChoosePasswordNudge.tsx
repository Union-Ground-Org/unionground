// REQ-UG-TEMPORARY-PASSWORD-CHANGE-PROMPT-20261018, native half: the
// emailed sign-in password says "change it after you sign in", so Home asks
// once. The stamp is user_metadata.union_ground_password_issued_at on the
// session (set when the password is emailed, deleted by the member's own
// password change). A prompt only: nothing authorizes on it.

import { Ionicons } from '@expo/vector-icons';
import { useRouter } from 'expo-router';
import { useEffect, useState, type ReactNode } from 'react';
import { StyleSheet, View } from 'react-native';

import { Body, Button, Card, Heading } from '../../components/ui';
import { passwordIssuedAt } from '../../lib/passwordIssued';
import { haptics } from '../../services/haptics';
import { dismissPasswordPrompt, isPasswordPromptDismissed } from '../../services/homeNudges';
import { useApp } from '../../state/AppProvider';
import { useTheme } from '../../theme/ThemeProvider';
import { spacing } from '../../theme/tokens';
import { NEW_PASSWORD_RULE } from '../../../../../src/lib/passwordPolicy.js';

export function ChoosePasswordNudge({ children = null }: { children?: ReactNode }) {
  const router = useRouter();
  const theme = useTheme();
  const { mode, session } = useApp();
  const userID = mode === 'authenticated' ? session?.user.id ?? null : null;
  const issuedAt = userID ? passwordIssuedAt(session?.user.user_metadata) : null;
  // null until the device-local answer is read, so the card never flashes.
  const [answer, setAnswer] = useState<{ userID: string; issuedAt: string; dismissed: boolean } | null>(null);
  const dismissed = answer?.userID === userID && answer?.issuedAt === issuedAt ? answer.dismissed : null;

  useEffect(() => {
    if (!userID || !issuedAt) { setAnswer(null); return undefined; }
    let active = true;
    void isPasswordPromptDismissed(userID, issuedAt).then((value) => { if (active) setAnswer({ userID, issuedAt, dismissed: value }); });
    return () => { active = false; };
  }, [userID, issuedAt]);

  if (!userID || !issuedAt || dismissed === true) return <>{children}</>;
  if (dismissed === null) return null;
  return (
    <Card>
      <View style={styles.head}>
        <Ionicons name="key-outline" size={18} color={theme.primary} accessibilityElementsHidden />
        <Heading level={3}>Choose your own password</Heading>
      </View>
      <Body muted>You are still signing in with the password we emailed you. Choose one only you know in Account.</Body>
      <Body>{NEW_PASSWORD_RULE.en}</Body>
      <View style={styles.actions}>
        <Button label="Choose a password" onPress={() => { router.push('/account' as never); }} />
        <Button
          label="Not now"
          variant="secondary"
          onPress={() => { void haptics.select(); setAnswer({ userID, issuedAt, dismissed: true }); void dismissPasswordPrompt(userID, issuedAt); }}
        />
      </View>
    </Card>
  );
}

const styles = StyleSheet.create({
  head: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  actions: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm },
});
