// REQ-UG-QUOTES-MINI-LESSONS-20260928: the one compact learning card
// on Home. It renders a single item from the day's stable order, re-checks the
// publication window and locale at every render, and shows nothing at all when
// the policy is unknown, disabled or hidden, or when nothing is published in
// the member's language. Next is an explicit, local, unanimated step; hiding is
// the member's durable server preference, reversed from Know your rights.

import { Ionicons } from '@expo/vector-icons';
import { useRouter } from 'expo-router';
import { useEffect, useState } from 'react';
import { StyleSheet, View } from 'react-native';
import { Text } from '../../components/Text';

import { Body, Button, Card, Heading } from '../../components/ui';
import { useTheme } from '../../theme/ThemeProvider';
import { spacing } from '../../theme/tokens';
import { LearningLinkButton } from './LearningControls';
import { LearningItemView } from './LearningItemView';
import { useLearningCopy, useLearningHome, useLearningLocale } from './useLearningContent';

import { typeface } from '../../theme/typeface';
export function LearningHomeCard({ heading = 'heading' }: {
  /** Live Home titles sections with a heading; the PREVIEW feed uses eyebrows. */
  heading?: 'heading' | 'eyebrow';
}) {
  const theme = useTheme();
  const router = useRouter();
  const copy = useLearningCopy();
  const locale = useLearningLocale();
  const { controller, snapshot } = useLearningHome();
  const [expanded, setExpanded] = useState(false);
  // Render-time delivery check: an item whose window closed since the last
  // read, or that belongs to another locale or a disabled kind, is never drawn.
  const view = controller ? controller.view(Date.now()) : null;
  const currentID = view?.current?.id ?? null;
  useEffect(() => { setExpanded(false); }, [currentID]);

  const title = heading === 'heading'
    ? <Heading level={2}>{copy.homeHeading}</Heading>
    : <Text accessibilityRole="header" style={[styles.eyebrowHeading, { color: theme.mutedForeground }]}>{copy.homeHeading.toLocaleUpperCase(locale === 'es' ? 'es-US' : 'en-US')}</Text>;

  if (snapshot.hiddenJustNow) {
    return (
      <View style={styles.section}>
        {title}
        <Card>
          <Body>{copy.hiddenNote}</Body>
          <LearningLinkButton
            label={copy.openLearn}
            icon={<Ionicons name="chevron-forward" size={16} color={theme.primary} accessibilityElementsHidden />}
            onPress={() => router.push('/feature/rights')}
          />
        </Card>
      </View>
    );
  }

  if (!controller || !view?.current) return null;
  const item = view.current;
  const lesson = item.kind === 'mini_lesson';

  return (
    <View style={styles.section}>
      {title}
      <Card>
        <LearningItemView item={item} copy={copy} compact expanded={expanded} />
        {lesson ? (
          <LearningLinkButton
            label={expanded ? copy.showLess : copy.readMore}
            expanded={expanded}
            onPress={() => setExpanded((current) => !current)}
          />
        ) : null}
        {snapshot.hideError ? <Text accessibilityLiveRegion="polite" style={[styles.error, { color: theme.destructive }]}>{copy.hideError}</Text> : null}
        <View style={styles.footer}>
          <Text style={[styles.position, { color: theme.mutedForeground }]}>{copy.position(view.position, view.total)}</Text>
          <View style={styles.actions}>
            <Button
              label={copy.next}
              variant="secondary"
              disabled={view.total <= 1 || snapshot.hiding}
              icon={<Ionicons name="arrow-forward" size={18} color={view.total <= 1 || snapshot.hiding ? theme.mutedForeground : theme.secondaryForeground} accessibilityElementsHidden />}
              onPress={() => controller.next()}
            />
            <Button
              label={copy.hide}
              variant="secondary"
              busy={snapshot.hiding}
              onPress={() => { void controller.hide(); }}
            />
          </View>
        </View>
      </Card>
    </View>
  );
}

const styles = StyleSheet.create({
  section: { gap: spacing.sm },
  eyebrowHeading: { fontSize: 11, ...typeface.controlStrong, letterSpacing: 1.5, marginHorizontal: 4 },
  footer: { gap: spacing.sm, marginTop: spacing.xs },
  position: { fontSize: 14, lineHeight: 19, ...typeface.control, fontVariant: ['tabular-nums'] },
  actions: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm },
  error: { fontSize: 14, lineHeight: 19, ...typeface.control },
});
