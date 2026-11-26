import React from "react";
import { t } from "../lib/i18n.js";
import { preferredLanguage } from "../lib/preferredLanguage.js";

// A render error anywhere below this point used to unmount the whole tree and
// leave a blank white document: no message, no way back, and nothing on screen
// to tell the member whether the case note they had just written was saved.
// (BargainingWriterDialog could reach that state from one missing browser API.)
// A boundary cannot repair the fault, but it can keep the failure legible and
// offer the one action that reliably clears it.
//
// Deliberately not translated through LanguageProvider: this has to render when
// the app that provides that context is the thing that just failed, so it reads
// the saved language directly, the way the pre-auth routes do.
export class AppErrorBoundary extends React.Component {
  constructor(props) {
    super(props);
    this.state = { failed: false };
  }

  static getDerivedStateFromError() {
    return { failed: true };
  }

  render() {
    if (!this.state.failed) return this.props.children;
    const lang = preferredLanguage();
    return (
      <div className="sg-app">
        <main className="app-column data-error" role="alert" aria-atomic="true">
          <span className="eyebrow">{t(lang, "app.crashEyebrow")}</span>
          <h1>{t(lang, "app.crashTitle")}</h1>
          <p>{t(lang, "app.crashBody")}</p>
          <div className="error-actions">
            <button className="dialog-primary" type="button" onClick={() => window.location.reload()}>{t(lang, "app.reload")}</button>
          </div>
        </main>
      </div>
    );
  }
}
