// Dev has no full-sheet slot. In builds it starts as a non-blocking preload;
// activating it only after attaching listeners avoids missing an early load
// or error while the entry module was downloading. Its DOM position is fixed
// before any route stylesheet, and no inline event handler is needed by CSP.
export function waitForFullStyles(document) {
  const link = document.querySelector("link[data-full-styles]");
  if (!link) return Promise.resolve();
  return new Promise((resolve) => {
    const finish = () => {
      link.removeEventListener("load", finish);
      link.removeEventListener("error", finish);
      resolve();
    };
    link.addEventListener("load", finish, { once: true });
    link.addEventListener("error", finish, { once: true });
    link.rel = "stylesheet";
    if (link.sheet) finish();
  });
}
