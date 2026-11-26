// Geometry for the Home sheet over its drawers: the render sample, the
// sheet's animated corner radius and the widget rail insets. Pure functions,
// so tests can assert them at any progress without React Native.

export type OpenDrawer = 'features' | 'work' | null;

// One immutable render sample supplies every visible part of a drawer frame.
// Animated.Value is only a clock; it must not also drive native view props.
export function drawerFrame(offset: number, width: number, maxRadius: number) {
  const x = width > 0 && Number.isFinite(offset) ? Math.max(-width, Math.min(width, offset)) : 0;
  const featuresProgress = width > 0 ? Math.max(0, x / width) : 0;
  const workProgress = width > 0 ? Math.max(0, -x / width) : 0;
  const reveal = featuresProgress + workProgress;
  const side: OpenDrawer = x > 0 ? 'features' : x < 0 ? 'work' : null;
  return { x, side, reveal, featuresProgress, workProgress,
    radius: continuousRadius(reveal, maxRadius),
    featureRadius: continuousRadius(featuresProgress, maxRadius),
    workRadius: continuousRadius(workProgress, maxRadius) };
}

export function interactiveDrawer(visible: OpenDrawer, settled: OpenDrawer, moving: boolean): OpenDrawer {
  return !moving && visible === settled ? settled : null;
}

// A full-height rail is shaved by the rounded parent. Its square ends must
// start after the corner tangent, where the clip is straight.
export function straightRailInsets(cornerRadius: number) {
  const inset = Math.max(0, cornerRadius);
  return { top: inset, bottom: inset };
}

// The sheet's clip and its shadow host consume this continuous radius in one
// render, so the two corners never diverge during a drag.
export function continuousRadius(progress: number, maxRadius: number): number {
  const bounded = Math.max(0, Math.min(1, Number.isFinite(progress) ? progress : 0));
  return bounded * maxRadius;
}
