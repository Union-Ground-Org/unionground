// REQ-UG-QUOTES-MINI-LESSONS-20260928: the mini-lesson library inside
// Know your rights (the native Learn surface). The existing rights lessons and
// articles above it are untouched; this section adds the governed
// mini-lessons, forty at a time, the member's Home restore control, and the
// entry to the bounded editor for accounts that manage the scope.

import { Ionicons } from '@expo/vector-icons';
import { useState } from 'react';
import { StyleSheet, View } from 'react-native';
import { Text } from '../../components/Text';

import { Body, Button, Card, Heading, StateMessage } from '../../components/ui';
import { useTheme } from '../../theme/ThemeProvider';
import { spacing } from '../../theme/tokens';
import { LearningLinkButton } from './LearningControls';
import { LearningItemView } from './LearningItemView';
import { useLearningCopy, useLearningLibrary } from './useLearningContent';

import { typeface } from '../../theme/typeface';
export function LearningLibrarySection({ onManage }: { onManage: () => void }) {
  const theme = useTheme();
  const copy = useLearningCopy();
  const { scope, controller, snapshot } = useLearningLibrary();
  const [openID, setOpenID] = useState<string | null>(null);
  if (!scope) return null;

  const policy = snapshot.policy;
  // Render-time delivery check, like Home: expired, foreign-locale or
  // disabled-kind rows never draw, even between polls.
  const lessons = controller ? controller.lessons(Date.now()) : [];
  const canManage = Boolean(policy && (policy.canManage || policy.isPlatformOwner));
  // BUG-UG-MINI-LESSONS-OFF-SECTION-IS-A-DEAD-END-THAT-BLAMES-THE-UNION-20261124
  // (record 9839): the policy is platform AND organization AND chapter, so off can
  // come from a switch nobody in the chapter holds. A section a person can
  // never use is not offered; a manager keeps the way into the editor.
  if (snapshot.status === 'disabled' && !canManage) return null;

  return (
    <View style={styles.section}>
      <Heading level={2}>{copy.learnHeading}</Heading>
      <Body muted>{copy.learnIntro}</Body>

      {policy?.homeHidden ? (
        <Card>
          <Text style={[styles.cardTitle, { color: theme.cardForeground }]}>{copy.homeHiddenTitle}</Text>
          <Body muted>{copy.homeHiddenBody}</Body>
          {snapshot.restoreError ? <Text accessibilityLiveRegion="polite" style={[styles.error, { color: theme.destructive }]}>{copy.restoreError}</Text> : null}
          <Button label={copy.restore} busy={snapshot.restoring} onPress={() => { void controller?.restoreHome(); }} />
        </Card>
      ) : snapshot.restoredJustNow ? (
        <View accessibilityLiveRegion="polite"><Body>{copy.restored}</Body></View>
      ) : null}

      {scope.chapterId === null ? (
        <StateMessage compact title={copy.learnNoChapterTitle} body={copy.learnNoChapterBody} />
      ) : snapshot.status === 'unavailable' ? (
        <StateMessage
          compact
          title={copy.learnErrorTitle}
          body={copy.learnErrorBody}
          action={<Button label={copy.retry} variant="secondary" onPress={() => { void controller?.refreshPolicy(); }} />}
        />
      ) : snapshot.status === 'disabled' ? (
        <StateMessage compact title={copy.learnDisabledTitle} body={copy.learnDisabledBody} />
      ) : snapshot.status !== 'ready' ? (
        <StateMessage compact title={copy.learnLoadingTitle} body={copy.learnLoadingBody} />
      ) : lessons.length === 0 && !snapshot.hasMore ? (
        // Honest and language-specific: no English lesson stands in for a
        // missing Spanish one.
        <StateMessage compact title={copy.learnEmptyTitle} body={copy.learnEmptyBody} />
      ) : (
        <>
          {lessons.map((lesson) => {
            const open = openID === lesson.id;
            return (
              <Card key={lesson.id}>
                <LearningItemView item={lesson} copy={copy} compact expanded={open} />
                <LearningLinkButton
                  label={open ? copy.closeLesson : copy.readLesson}
                  accessibilityLabel={open ? copy.closeLessonLabel(lesson.title) : copy.readLessonLabel(lesson.title)}
                  expanded={open}
                  onPress={() => setOpenID(open ? null : lesson.id)}
                />
              </Card>
            );
          })}
          {snapshot.loadMoreError ? <Text accessibilityLiveRegion="polite" style={[styles.error, { color: theme.destructive }]}>{copy.learnErrorBody}</Text> : null}
          {snapshot.hasMore ? (
            <Button
              label={copy.loadMoreLessons}
              variant="secondary"
              busy={snapshot.loadingMore}
              onPress={() => { void controller?.loadMore(); }}
            />
          ) : null}
        </>
      )}

      {canManage ? (
        <Button
          label={copy.manage}
          variant="secondary"
          icon={<Ionicons name="create-outline" size={18} color={theme.secondaryForeground} accessibilityElementsHidden />}
          onPress={onManage}
        />
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  section: { gap: spacing.md },
  cardTitle: { fontSize: 17, lineHeight: 23, ...typeface.heading },
  error: { fontSize: 14, lineHeight: 19, ...typeface.control },
});
