// REQ-UG-ISSUE-INTELLIGENCE-SIGNALS-20261001: the member issue banner on
// Home (old components/issue-threads/issue-thread-banner.tsx plus the
// guidance boost). It renders nothing unless the server returns an active,
// privacy-floored family for the member's organization; a failed read also
// renders nothing, because the banner is advisory and Home must not degrade.

import { Ionicons } from '@expo/vector-icons';
import { useRouter, type Href } from 'expo-router';
import { useEffect, useState } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';
import { Text } from '../components/Text';

import { Body, Card, Heading } from '../components/ui';
import { issueSignalCopy, normalizeMemberIssueSignals, type MemberIssueSignal } from '../lib/issueIntelligence';
import { haptics } from '../services/haptics';
import { loadMobileMemberIssueSignals } from '../services/supabase';
import { useTheme } from '../theme/ThemeProvider';
import { minimumTouchTarget, radii, spacing } from '../theme/tokens';

import { typeface } from '../theme/typeface';
export function IssueSignalHomeCard({ refreshKey }: { refreshKey: unknown }) {
  const theme = useTheme();
  const router = useRouter();
  const [signal, setSignal] = useState<MemberIssueSignal | null>(null);
  const [expanded, setExpanded] = useState(false);

  useEffect(() => {
    let active = true;
    loadMobileMemberIssueSignals()
      .then((payload) => { if (active) setSignal(normalizeMemberIssueSignals(payload)[0] ?? null); })
      .catch(() => { if (active) setSignal(null); });
    return () => { active = false; };
  }, [refreshKey]);

  if (!signal) return null;
  const copy = issueSignalCopy(signal);
  return (
    <View style={styles.section}>
      <Heading level={2}>Relevant right now</Heading>
      <Card>
        <Text style={[styles.headline, { color: theme.foreground }]}>{copy.headline}</Text>
        <Body muted>{copy.reason}</Body>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={expanded ? 'Hide details' : 'Why this matters now'}
          accessibilityState={{ expanded }}
          onPress={() => { void haptics.select(); setExpanded((value) => !value); }}
          style={({ pressed }) => [styles.toggle, { borderColor: theme.border, opacity: pressed ? 0.7 : 1 }]}
        >
          <Text style={[styles.toggleLabel, { color: theme.primary }]}>{expanded ? 'Hide details' : 'Why this matters now'}</Text>
        </Pressable>
        {expanded ? (
          <View style={styles.details}>
            <Body>{copy.whatItIs}</Body>
            <Body muted>{copy.whyItMatters}</Body>
            {copy.guidance.map((link) => (
              <Pressable
                key={link.kind}
                accessibilityRole="button"
                accessibilityLabel={`${link.title}. ${link.description}`}
                onPress={() => { void haptics.select(); router.push(link.route as Href); }}
                style={({ pressed }) => [styles.link, { borderColor: theme.border, backgroundColor: theme.card, opacity: pressed ? 0.7 : 1 }]}
              >
                <View style={styles.linkCopy}>
                  <Text style={[styles.linkTitle, { color: theme.foreground }]}>{link.title}</Text>
                  <Body muted>{link.description}</Body>
                </View>
                <Ionicons name="chevron-forward" size={18} color={theme.mutedForeground} accessibilityElementsHidden />
              </Pressable>
            ))}
          </View>
        ) : null}
      </Card>
    </View>
  );
}

const styles = StyleSheet.create({
  section: { gap: spacing.sm },
  headline: { fontSize: 17, lineHeight: 23, ...typeface.heading },
  toggle: { alignSelf: 'flex-start', minHeight: minimumTouchTarget, justifyContent: 'center', paddingHorizontal: spacing.md, borderWidth: 1, borderRadius: radii.md, marginTop: spacing.xs },
  toggleLabel: { fontSize: 16, ...typeface.controlStrong },
  details: { gap: spacing.sm, marginTop: spacing.xs },
  link: { minHeight: minimumTouchTarget, flexDirection: 'row', alignItems: 'center', gap: spacing.sm, padding: spacing.sm, borderWidth: 1, borderRadius: radii.md },
  linkCopy: { flex: 1, gap: 2 },
  linkTitle: { fontSize: 16, ...typeface.controlStrong },
});
