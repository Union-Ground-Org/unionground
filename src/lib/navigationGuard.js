// User-initiated SPA navigation must offer an active editor the same chance
// to protect an unsaved draft as the browser's beforeunload event.
export function allowWorkspaceNavigation(path) {
  return window.dispatchEvent(new CustomEvent("sg:before-navigate", { cancelable: true, detail: { path } }));
}
