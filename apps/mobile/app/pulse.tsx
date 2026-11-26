import { PinnedHeaderScreen } from '../src/components/PinnedHeader';
import PulseScreen from '../src/features/PulseScreen';
import { SavedPulseProvider } from '../src/features/SavedPulseCharts';

// Campaign pulse moved off the dock; it opens from the Campaign tab and All tools.
export default function PulseRoute() {
  return <PinnedHeaderScreen screenName="Campaign pulse"><SavedPulseProvider><PulseScreen /></SavedPulseProvider></PinnedHeaderScreen>;
}
