import { PinnedHeaderScreen } from '../../src/components/PinnedHeader';
import { contentStartInset, useNativeTabContentInset } from '../../src/lib/chrome';
import { CompassPanel } from '../../src/components/CompassPanel';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

// The Guide is a dock root: no Back control, and its composer rests above the
// native tab bar rather than the bare safe area.
export default function GuideScreen() {
  return <PinnedHeaderScreen screenName="Guide" onBack={null}><GuideScreenContent /></PinnedHeaderScreen>;
}

function GuideScreenContent() {
  const insets = useSafeAreaInsets();
  const bottomInset = useNativeTabContentInset();
  // CompassPanel scopes itself to the signed-in identity, so a session check
  // (booting) keeps the typed question instead of remounting the panel.
  return (
    <CompassPanel
      topPad={contentStartInset(insets.top)}
      bottomSafeArea={bottomInset}
    />
  );
}
