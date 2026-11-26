import { parseAppRoute, routerPath, type AppRoute } from '../lib/routes';

export const NATIVE_QUICK_ACTION_IDS = ['home', 'compass', 'messages', 'work'] as const;
export type NativeQuickActionID = typeof NATIVE_QUICK_ACTION_IDS[number];

const routeByAction: Record<NativeQuickActionID, string> = {
  home: 'unionground://home',
  compass: 'unionground://compass',
  messages: 'unionground://messages',
  work: 'unionground://work',
};

export function parseNativeQuickActionID(value: unknown): NativeQuickActionID | null {
  return typeof value === 'string' && NATIVE_QUICK_ACTION_IDS.includes(value as NativeQuickActionID)
    ? value as NativeQuickActionID
    : null;
}

export function routeFromNativeQuickAction(value: unknown): AppRoute | null {
  const identifier = parseNativeQuickActionID(value);
  return identifier ? parseAppRoute(routeByAction[identifier]) : null;
}

export function nativeQuickActionDestinationPath(value: unknown): string | null {
  const route = routeFromNativeQuickAction(value);
  return route ? routerPath(route) : null;
}

export function nativeQuickActionGatePath(value: unknown): string | null {
  const identifier = parseNativeQuickActionID(value);
  return identifier ? `/os-quick-action/${identifier}` : null;
}

export function nativeQuickActionIDFromSystemPath(value: string): NativeQuickActionID | null {
  if (!value || value.length > 256 || /[\u0000-\u001f\u007f]/.test(value)) return null;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if (url.protocol !== 'unionground:' || url.hostname !== 'os-quick-action'
    || url.username || url.password || url.port || url.search || url.hash || /%2f/i.test(url.pathname)) {
    return null;
  }
  const parts = url.pathname.split('/').filter(Boolean);
  return parts.length === 1 ? parseNativeQuickActionID(parts[0]) : null;
}

export function nativeQuickActionGatePathFromSystemPath(value: string): string | null {
  return nativeQuickActionGatePath(nativeQuickActionIDFromSystemPath(value));
}
