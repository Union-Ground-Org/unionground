import { useRouter } from 'expo-router';
import { Pressable, StyleSheet, View } from 'react-native';

import { Body, Card, Heading } from './ui';
import { nativeTaskConversationRoute } from '../lib/connectedWorkflowRoutes';
import { deviceDateTime } from '../lib/evidenceTimestamp';
import { useNativeUi } from '../lib/useNativeUi';
import type { TaskDiscussion } from '../lib/taskDiscussions';
import { minimumTouchTarget, spacing } from '../theme/tokens';

// Messages > Task discussions: every chapter task conversation the person has
// sent or received a message in, with or without a staff role, newest first.
// Messages owns the list (useTaskDiscussions) and its search, so its result
// count and empty state include these rows. Each row opens the task
// conversation screen, which re-checks access
// (BUG-UG-NATIVE-CASE-ROWS-AND-TASK-TITLES-DO-NOT-OPEN-20261111).
export function TaskDiscussionsSection({ items, failed }: { items: readonly TaskDiscussion[]; failed: boolean }) {
  const router = useRouter();
  const { locale } = useNativeUi();
  if (items.length === 0) {
    return failed ? <Body muted>Task discussions could not load. Pull down to try again.</Body> : null;
  }
  return (
    <View style={styles.section}>
      <Heading level={2}>Task discussions</Heading>
      {items.map((item) => {
        const when = deviceDateTime(item.latestAt, locale);
        const preview = `${item.latestFromYou ? 'You: ' : ''}${item.latestPreview}`;
        return (
          <Pressable
            key={item.taskID}
            accessibilityRole="button"
            accessibilityLabel={`${item.title}, ${item.reference}. ${preview}`}
            accessibilityHint="Opens this task discussion."
            onPress={() => {
              const href = nativeTaskConversationRoute(item.taskID);
              if (href) router.push(href as never);
            }}
            style={({ pressed }) => [styles.row, { opacity: pressed ? 0.82 : 1 }]}
          >
            <Card>
              <Body muted>{item.reference}{when ? ` · ${when}` : ''}</Body>
              <Heading level={3}>{item.title}</Heading>
              <Body numberOfLines={2}>{preview}</Body>
            </Card>
          </Pressable>
        );
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  section: { gap: spacing.sm },
  row: { minHeight: minimumTouchTarget },
});
