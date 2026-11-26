import { Redirect, useLocalSearchParams } from 'expo-router';
import { ActivityIndicator, StyleSheet, View } from 'react-native';

import { nativeQuickActionDestinationPath } from '../../src/services/nativeQuickActionRoutes';
import { useApp } from '../../src/state/AppProvider';
import { useTheme } from '../../src/theme/ThemeProvider';

export default function NativeQuickActionScreen() {
  const { id } = useLocalSearchParams<{ id?: string | string[] }>();
  const { mode } = useApp();
  const theme = useTheme();
  const identifier = Array.isArray(id) ? null : id;
  const destination = nativeQuickActionDestinationPath(identifier);

  if (!destination) return <Redirect href="/" />;
  if (mode === 'booting') {
    return (
      <View style={[styles.center, { backgroundColor: theme.background }]}>
        <ActivityIndicator color={theme.primary} />
      </View>
    );
  }
  if (mode === 'signedOut') {
    return <Redirect href={{ pathname: '/sign-in', params: { quickAction: identifier } }} />;
  }
  if (mode === 'mfaRequired') {
    return <Redirect href={{ pathname: '/mfa-challenge', params: { quickAction: identifier } }} />;
  }
  return <Redirect href={destination as never} />;
}

const styles = StyleSheet.create({
  center: { flex: 1, alignItems: 'center', justifyContent: 'center' },
});
