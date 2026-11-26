// First import: the supported browser floor lacks Object.hasOwn, which the
// bootstrap below calls before React mounts.
import "./lib/objectHasOwnCompat.js";
import "./memberShellStyles.js";
import React from "react";
import { createRoot } from "react-dom/client";
import { App } from "./AppRouter.jsx";
import { CrashScreenContent } from "./components/CrashScreen.jsx";
import { RootErrorBoundary } from "./components/RootErrorBoundary.jsx";
import { bootLanguage } from "./lib/bootLanguage.js";
import { loadLanguage } from "./lib/i18n.js";
import { bootObservability } from "./lib/deferredObservability.js";
import { initRowHighlight } from "./lib/rowHighlight.js";
import { observeAppReady } from "./lib/appReadyMark.js";
import { applySiteLook } from "./lib/siteLook.js";
import { waitForFullStyles } from "./lib/fullStylesReady.js";
import "./sg-tokens.css";
import "./styles.css";
import "./coordinator-theme.css";
import "./motion.css";
// Union Ground's organizing lifecycle surfaces (OrganizeView).
import "./lifecycle.css";
import "./popups.css";

// Which of the signed-out site's two looks the stylesheets paint; set before
// the first render and never stored (src/lib/siteLook.js).
applySiteLook();
// Sentry and PostHog load later (src/lib/deferredObservability.js); this only
// applies the analytics switch and queues errors raised before they load.
bootObservability();
const stopRowHighlight = initRowHighlight();
if (import.meta.hot) import.meta.hot.dispose(stopRowHighlight);
// The "ug:app-ready" mark the weekly performance budget run reads.
observeAppReady(document.getElementById("root"));

// A visitor whose boot language is not in the entry chunk (Spanish) waits for
// that catalogue before the first paint, so the first screen is never English
// copy that then flips. loadLanguage() never rejects: a chunk that fails twice
// still renders, in English, and a later switch to Spanish tries again.
// Fetch the catalogue and full styles in parallel. The crawl fallback can
// paint with the critical copy, but React never commits a partly styled app.
Promise.all([loadLanguage(bootLanguage()), waitForFullStyles(document)]).then(() => createRoot(document.getElementById("root")).render(
  <React.StrictMode>
    <RootErrorBoundary fallback={(
      <main role="alert" className="loading-screen">
        <CrashScreenContent />
      </main>
    )}>
      <App />
    </RootErrorBoundary>
  </React.StrictMode>,
));

// Installable-app path: production only, so dev never fights a stale worker.
if (import.meta.env.PROD && "serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("/sw.js").catch(() => {});
  });
}
