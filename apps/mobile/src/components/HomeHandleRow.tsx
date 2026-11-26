import { useEffect } from 'react';
import { StyleSheet, View } from 'react-native';

import { claimHomeHandleRow, syncHomeHandleRowTop } from '../lib/chrome';
import { minimumTouchTarget } from '../theme/tokens';

// The two drawer open handles' own row in the Home feed (the October 9
// capture, item 5 of docs/mobile/top-chrome-progressive-blur-spec-20261010.md).
// The feed reserves it so the handles never cover the next section (gate round
// 1 on PR #4266), and publishes its top because the carousel shell that draws
// the handles is a different subtree. Live Home reserved nothing, so its
// handles fell back to the screen's vertical centre and sat over the member
// summary and the section under it
// (BUG-UG-NATIVE-HOME-EDGE-PILLS-COVER-SECTION-HEADING-20261103).
// The published row belongs to this mount: a hat switch, the move to or from a
// live session, or a loading or welcome-back Home that has no row must not
// leave the handles on a stale offset. A text-size change remounts the row in
// place, so the clear is skipped when a successor row takes over
// (BUG-UG-NATIVE-HOME-HANDLES-STAY-AT-UNSCROLLED-POSITION-AFTER-TEXT-SIZE-CHANGE-IOS-20261103).
export function HomeHandleRow() {
  useEffect(() => claimHomeHandleRow(), []);
  return (
    <View
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
      onLayout={(event) => syncHomeHandleRowTop(event.nativeEvent.layout.y)}
      pointerEvents="none"
      style={styles.handleRow}
    />
  );
}

const styles = StyleSheet.create({
  handleRow: { height: minimumTouchTarget },
});
