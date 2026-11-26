import { useNativeUi } from "../lib/useNativeUi";
import { useRouter } from 'expo-router';

import { haptics } from '../services/haptics';
import { Button } from './ui';

export function AskCompassButton() {
  const { t } = useNativeUi();
  const router = useRouter();
  return <Button label={t("Ask the Guide")} variant="compass" onPress={() => { void haptics.select(); router.push('/compass'); }} />;
}
