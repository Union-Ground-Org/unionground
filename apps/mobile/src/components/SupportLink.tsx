import { Ionicons } from '@expo/vector-icons';
import { useState } from 'react';
import { Linking, Pressable, StyleSheet, View } from 'react-native';
import { Text } from './Text';

import { Body, Notice } from './ui';
import { openSupportEmailWithFallback, supportEmail, supportLinkCopy, type SupportLanguage } from '../lib/supportContact';
import { useTheme } from '../theme/ThemeProvider';
import { minimumTouchTarget, spacing } from '../theme/tokens';

import { typeface } from '../theme/typeface';
/**
 * REQ-UG-NATIVE-HELP-AND-SUPPORT-ENTRY-20261018. The one Help and
 * support control, shared by Account, sign-in, the MFA screen, Messages and
 * account deletion. Same shape as Account's privacy-policy link: a link role
 * (not a button) whose visible words are its spoken name, a 48 pt target, a
 * busy state while the mail app opens, and an in-app notice when the OS
 * refuses the mailto URL so the address stays readable. Linking comes from
 * react-native, not expo-linking: suites that render sign-in or Messages mock
 * react-native, and expo-linking's module init needs __DEV__ under node.
 */
// `footer`: the sign-in footer's quiet link, plain text in the footer links'
// size and weight with no envelope, so it pairs with public downloads on one
// centred row.
export function SupportLink({ language = 'en', description, maxFontSizeMultiplier, variant = 'standalone' }: { language?: SupportLanguage; description?: string; maxFontSizeMultiplier?: number; variant?: 'standalone' | 'footer' }) {
  const theme = useTheme();
  const copy = supportLinkCopy[language];
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);

  async function open() {
    setBusy(true);
    setFailure(null);
    try {
      const result = await openSupportEmailWithFallback((url) => Linking.openURL(url), language);
      setFailure(result.opened ? null : result.message);
    } finally {
      setBusy(false);
    }
  }

  // No published support mailbox: nothing to link to (lib/supportContact).
  if (!supportEmail) return null;
  const color = busy ? theme.mutedForeground : theme.primary;
  return (
    <View style={styles.block}>
      <Pressable
        accessibilityRole="link"
        accessibilityLabel={copy.label}
        accessibilityHint={copy.hint}
        accessibilityState={{ busy, disabled: busy }}
        disabled={busy}
        onPress={() => { void open(); }}
        style={({ pressed }) => [variant === 'footer' ? styles.footerLink : styles.link, { opacity: pressed ? 0.82 : 1 }]}
      >
        {/* The envelope sits inside the label's own line of text, so it grows
            and wraps with the first line instead of floating between two lines
            at accessibility sizes (build c proof, Nov 6, 2026). A caller that
            caps its text size passes the cap. */}
        {variant === 'footer' ? (
          <Text maxFontSizeMultiplier={maxFontSizeMultiplier} style={[styles.footerLabel, { color }]}>{copy.label}</Text>
        ) : (
          <Text maxFontSizeMultiplier={maxFontSizeMultiplier} style={[styles.label, { color }]}>
            <Ionicons name="mail-outline" size={18} color={color} style={styles.icon} />
            <Text style={styles.icon}>{' '}</Text>{copy.label}
          </Text>
        )}
      </Pressable>
      {description ? <Body muted>{description}</Body> : null}
      {failure ? <Notice>{failure}</Notice> : null}
    </View>
  );
}

const styles = StyleSheet.create({
  block: { gap: spacing.xs },
  link: { minHeight: minimumTouchTarget, justifyContent: 'center', alignSelf: 'flex-start' },
  label: { fontSize: 16, lineHeight: 22, ...typeface.controlStrong, textDecorationLine: 'underline' },
  icon: { textDecorationLine: 'none' },
  // Placed by the footer row, so a mail failure notice beside it keeps the
  // link centred over it.
  footerLink: { minHeight: minimumTouchTarget, justifyContent: 'center' },
  footerLabel: { fontSize: 15, lineHeight: 20, ...typeface.bodyMedium, textDecorationLine: 'underline', textAlign: 'center' },
});
