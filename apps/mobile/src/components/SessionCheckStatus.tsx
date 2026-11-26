import { useEffect, useRef, useState } from 'react';
import { ActivityIndicator, StyleSheet, View } from 'react-native';
import { Body, Button } from './ui';
import { useTheme } from '../theme/ThemeProvider';
import { spacing } from '../theme/tokens';

export function SessionCheckStatus({ label, onRetry, busy = false }: { label: string; onRetry(): Promise<boolean>; busy?: boolean }) {
  const theme = useTheme();
  const [delayed, setDelayed] = useState(false);
  const [pending, setPending] = useState(false);
  const checking = busy || pending;
  const mounted = useRef(false);
  useEffect(() => {
    mounted.current = true;
    const timer = setTimeout(() => setDelayed(true), 5_000);
    return () => { mounted.current = false; clearTimeout(timer); };
  }, []);
  return (
    <View style={styles.status}>
      <View accessible accessibilityRole="progressbar" accessibilityLabel={label} accessibilityLiveRegion="polite">
        <ActivityIndicator color={theme.primary} />
        <Body muted>{label}</Body>
      </View>
      {delayed ? <>
        <View accessible accessibilityLiveRegion="polite">
          <Body muted>This check is taking longer than expected. Check your connection and retry.</Body>
        </View>
        <Button label={checking ? 'Retrying…' : 'Retry'} busy={checking} disabled={checking} onPress={() => {
          setPending(true);
          void onRetry().catch(() => false).finally(() => { if (mounted.current) setPending(false); });
        }} />
      </> : null}
    </View>
  );
}

const styles = StyleSheet.create({
  status: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: spacing.md, padding: spacing.xl },
});
