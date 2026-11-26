import { Text } from './Text';
import { useNativeUi } from '../lib/useNativeUi';
import { useTheme } from '../theme/ThemeProvider';

// #9467 M1-15: a long text box near its limit says so, the way the connected
// message composer counts (ConnectedRecordActions). React Native's maxLength
// stops typing and trims a paste at the limit without a word, so the counter
// shows from LENGTH_COUNTER_NEAR of the limit and says when the limit is
// reached. It never says text was cut: maxLength drops the extra before the
// app sees it, so the app cannot know whether anything was lost. Renders
// nothing before LENGTH_COUNTER_NEAR.
export const LENGTH_COUNTER_NEAR = 0.8;

export function LengthCounter({ value, max }: { value: string; max: number }) {
  const { t } = useNativeUi();
  const theme = useTheme();
  const count = value.length;
  if (count < Math.ceil(max * LENGTH_COUNTER_NEAR)) return null;
  const atLimit = count >= max;
  return (
    <Text
      accessibilityLiveRegion={atLimit ? 'polite' : 'none'}
      accessibilityRole={atLimit ? 'alert' : 'text'}
      style={{ color: atLimit ? theme.foreground : theme.mutedForeground, fontWeight: atLimit ? '700' : '400' }}
    >
      {atLimit
        ? t('Limit reached: {max} characters.', { max })
        : t('{count} of {max} characters', { count, max })}
    </Text>
  );
}
