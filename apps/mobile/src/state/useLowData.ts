import { useSyncExternalStore } from 'react';

import { getLowDataSnapshot, subscribeLowData } from '../services/lowData';

export function useLowData() {
  return useSyncExternalStore(subscribeLowData, getLowDataSnapshot, getLowDataSnapshot);
}
