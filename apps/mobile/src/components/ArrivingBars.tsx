import type { ReactNode } from 'react';
import { View } from 'react-native';

import { arrivalLength, barProgress, growStyle } from '../lib/chartArrival';
import { useChartArrival } from '../lib/useChartArrival';

/**
 * A run of horizontal bars drawn as Views (poll results, shares) that arrives
 * once as one chart, the first time it is seen (
 * 2026; lib/chartArrival.ts). The group lays its rows out with `gap`, the gap
 * its parent used, so wrapping rows in it moves nothing. `children` gets the
 * style for bar `index`'s fill: a transform while it grows, null once whole.
 */
export function ArrivingBars({ arrivalKey, count, gap, children }: {
  arrivalKey: string;
  count: number;
  gap: number;
  children: (grow: (index: number) => ReturnType<typeof growStyle>) => ReactNode;
}) {
  const { ref, elapsed } = useChartArrival(arrivalKey, arrivalLength({ bars: count }));
  return (
    <View ref={ref} style={{ gap }}>
      {children((index) => growStyle(barProgress(elapsed, index, count), 'x'))}
    </View>
  );
}
