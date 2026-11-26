// A click the app may take over for in-app navigation: the primary button with
// no modifier. Anything else (new tab, new window, download, an earlier handler
// that already took it) stays the browser's.
export function plainClick(event) {
  return event.button === 0
    && !event.defaultPrevented
    && !(event.metaKey || event.ctrlKey || event.shiftKey || event.altKey);
}
