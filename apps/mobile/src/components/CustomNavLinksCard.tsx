import { Ionicons } from '@expo/vector-icons';
import * as Linking from 'expo-linking';
import { useIsFocused } from 'expo-router';
import { useEffect, useState } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';
import { Text } from './Text';

import { Body, Button, Heading, Notice } from './ui';
import { customLinkHost, type CustomNavLink } from '../lib/customNavLinks';
import { loadMobileCustomNavLinks } from '../services/customNavLinks';
import { useNativeUi } from '../lib/useNativeUi';
import { useApp } from '../state/AppProvider';
import { useTheme } from '../theme/ThemeProvider';
import { minimumTouchTarget, radii, spacing } from '../theme/tokens';

import { typeface } from '../theme/typeface';
// REQ-UG-CUSTOM-NAV-LINKS-20261001: the organization's admin-set links on
// the native Account menu (the old app showed them in its mobile menu). Each
// row is an explicit link that names the host it opens in the browser; nothing
// opens implicitly, and My union stays free of external resources. With no
// link set or a preview, nothing renders. #9969 (carved from #9465): a failed
// read keeps the Links heading, says so and offers Try again; while that read
// runs the section stays with a loading line.
export function CustomNavLinksCard() {
  const theme = useTheme();
  const { mode, organizationID } = useApp();
  const { t } = useNativeUi();
  const focused = useIsFocused();
  const [links, setLinks] = useState<CustomNavLink[]>([]);
  const [failed, setFailed] = useState<string | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);
  const [retrying, setRetrying] = useState(false);
  const [attempt, setAttempt] = useState(0);
  // The notice is for a read that has just failed while the screen is
  // focused; an earlier failure (from before focus was lost, or while a new
  // read runs) is plain text, so it is not announced again.
  const [freshFailure, setFreshFailure] = useState(false);

  useEffect(() => {
    if (mode !== 'authenticated' || !focused) {
      // A retry whose read was cancelled (focus lost, sign-out, preview) is over.
      setRetrying(false);
      setFreshFailure(false);
      if (mode !== 'authenticated') { setLinks([]); setLoadFailed(false); }
      return undefined;
    }
    let current = true;
    setFreshFailure(false);
    void loadMobileCustomNavLinks()
      .then((next) => { if (current) { setLinks(next); setLoadFailed(false); } })
      .catch((failure: unknown) => {
        if (!current) return;
        setLinks([]);
        // A refusal (42501: no session, or the membership check) is not a load
        // Try again can cure; it shows nothing, as before #9969.
        const shown = (failure as { code?: unknown } | null)?.code !== '42501';
        setLoadFailed(shown);
        setFreshFailure(shown);
      })
      .finally(() => { if (current) setRetrying(false); });
    return () => { current = false; };
  }, [focused, mode, organizationID, attempt]);

  if (mode !== 'authenticated') return null;
  if (links.length === 0) {
    if (!loadFailed && !retrying) return null;
    const unavailable = t("Your organization's links could not be loaded.");
    return (
      <View style={styles.section} testID="custom-nav-links">
        <Heading level={2}>{t("Links")}</Heading>
        {retrying ? <Body>{t("Loading your organization's links.")}</Body> : focused && freshFailure ? <Notice>{unavailable}</Notice> : <Body>{unavailable}</Body>}
        <Button label={t('Try again')} variant="secondary" busy={retrying} onPress={() => { setRetrying(true); setLoadFailed(false); setAttempt((count) => count + 1); }} />
      </View>
    );
  }

  async function open(link: CustomNavLink) {
    setFailed(null);
    try {
      await Linking.openURL(link.url);
    } catch {
      setFailed(t('{label} could not open. The address is {url}.', { label: link.label, url: link.url }));
    }
  }

  return (
    <View style={styles.section} testID="custom-nav-links">
      <Heading level={2}>{t("Links")}</Heading>
      {links.map((link) => {
        const host = customLinkHost(link.url);
        return (
          <View key={link.key} style={[styles.row, { borderColor: theme.border }]}>
            <Ionicons name="link-outline" size={24} color={theme.primary} accessible={false} accessibilityElementsHidden importantForAccessibility="no-hide-descendants" />
            <View style={styles.flex}>
              <Pressable
                accessibilityRole="link"
                accessibilityLabel={link.label}
                accessibilityHint={t('Opens {host} in your browser.', { host })}
                onPress={() => { void open(link); }}
                style={({ pressed }) => [styles.link, { opacity: pressed ? 0.82 : 1 }]}
              >
                <Text style={[styles.title, { color: theme.primary }]}>{link.label}</Text>
                <Ionicons name="open-outline" size={18} color={theme.primary} />
              </Pressable>
              <Body muted>{t('Opens {host} in your browser. Your organization added this link.', { host })}</Body>
            </View>
          </View>
        );
      })}
      {failed ? <Notice>{failed}</Notice> : null}
    </View>
  );
}

const styles = StyleSheet.create({
  section: { gap: spacing.sm },
  row: { flexDirection: 'row', alignItems: 'center', gap: spacing.md, borderWidth: 1, borderRadius: radii.md, padding: spacing.md },
  flex: { flex: 1, gap: spacing.xs },
  link: { minHeight: minimumTouchTarget, flexDirection: 'row', alignItems: 'center', gap: spacing.xs },
  title: { fontSize: 16, lineHeight: 22, ...typeface.heading, textDecorationLine: 'underline' },
});
