import * as Haptics from 'expo-haptics';
import { AppState, Platform } from 'react-native';

import { getHapticPreferenceState, initializeHapticPreference } from './hapticPreference';

type Feedback = 'select' | 'success' | 'warning' | 'impact';

async function emit(feedback: Feedback): Promise<void> {
  // Native feedback only. A resolved native call is not evidence of a felt pulse.
  if (Platform.OS !== 'ios' && Platform.OS !== 'android') return;
  const { preference, ready, saving } = getHapticPreferenceState();
  if (!ready) { void initializeHapticPreference(); return; }
  if (saving || preference === 'off' || AppState.currentState !== 'active') return;
  try {
    if (Platform.OS === 'android') {
      // View haptics respect Android's touch-feedback setting. Avoid the legacy
      // Vibrator waveform path and never bypass the OS with an ignore flag.
      const api = Number(Platform.Version);
      const selection = api >= 34 ? Haptics.AndroidHaptics.Segment_Tick : Haptics.AndroidHaptics.Clock_Tick;
      const gentle = api >= 34 ? Haptics.AndroidHaptics.Segment_Frequent_Tick : Haptics.AndroidHaptics.Clock_Tick;
      const kind = preference === 'subtle' ? gentle
        : feedback === 'success' ? (api >= 30 ? Haptics.AndroidHaptics.Confirm : Haptics.AndroidHaptics.Virtual_Key)
        : feedback === 'warning' ? (api >= 30 ? Haptics.AndroidHaptics.Reject : Haptics.AndroidHaptics.Long_Press)
        : feedback === 'impact' ? Haptics.AndroidHaptics.Virtual_Key
        : selection;
      await Haptics.performAndroidHapticsAsync(kind);
    } else if (preference === 'subtle' || feedback === 'select') {
      await Haptics.selectionAsync();
    } else if (feedback === 'impact') {
      await Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    } else {
      await Haptics.notificationAsync(feedback === 'success'
        ? Haptics.NotificationFeedbackType.Success : Haptics.NotificationFeedbackType.Warning);
    }
  } catch {
    // Missing engines/modules and OS refusals must not interrupt the action.
  }
}

export const haptics = {
  select: () => emit('select'),
  success: () => emit('success'),
  warning: () => emit('warning'),
  impact: () => emit('impact'),
};
