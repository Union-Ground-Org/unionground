import { useEffect } from 'react';
import { BackHandler } from 'react-native';

// Follow-up 2 from the #1021 rounds. A pushed surface that opens a *view*
// inside itself — the rights reading list opening one lesson — had no way to
// answer Back: the pinned header's chevron and the Android hardware button both
// popped the whole feature, so a member who opened Weingarten and pressed Back
// landed on Home instead of back on the list they had been reading. The reading
// view is a second level of navigation and has to behave like one.
//
// This is the interception half of the filed remedy rather than a second route.
// A route would need its own entry in the navigation surface, its own chrome
// host and its own deep-link contract for something that is one lesson inside
// one feature; interception keeps the surface as it is and only teaches Back
// which level it is on. The registration is a single slot on purpose: exactly
// one surface is on top of the stack at a time, and a second registrant would
// mean two screens both believed they were.
//
// Which makes the caller's obligation explicit (iab review, F4): **register
// only while the screen is focused.** Mount is not the same thing as being on
// top. A screen pushed over a surface that has an interceptor registered —
// the drawer opening a conversation over an open rights lesson — leaves the
// covered surface mounted, and a mount-keyed registration would keep the slot
// held by a screen the member can no longer see, so the first Back press on
// the new top screen would be swallowed by the old one. Callers pass
// `useIsFocused() && <own condition> ? handler : null` (or wrap the
// registration in `useFocusEffect`); the module deliberately does not reach
// for navigation state itself, so it stays a plain slot with no router
// dependency of its own.
type ScreenBackInterceptor = () => boolean;

let interceptor: ScreenBackInterceptor | null = null;

/**
 * Runs the registered interceptor, if any.
 *
 * @returns true when a surface handled Back itself and the stack must not pop.
 */
export function runScreenBackInterceptor(): boolean {
  return interceptor ? interceptor() === true : false;
}

/**
 * Registers `handler` while it is non-null. The handler returns true when it
 * consumed the press; returning false lets Back fall through to the stack.
 *
 * Pass a stable callback — a fresh identity each render would re-register on
 * every keystroke. Both entry points are covered here so the header chevron and
 * the Android hardware button can never disagree about which level Back is on.
 *
 * Pass `null` whenever the screen is not focused. See the module note above:
 * the slot is global, and a covered-but-mounted screen holding it swallows the
 * first Back press on whatever is actually on top.
 */
export function useScreenBackInterceptor(handler: ScreenBackInterceptor | null): void {
  useEffect(() => {
    if (!handler) return;
    interceptor = handler;
    const subscription = BackHandler.addEventListener('hardwareBackPress', () => handler());
    return () => {
      if (interceptor === handler) interceptor = null;
      subscription.remove();
    };
  }, [handler]);
}
