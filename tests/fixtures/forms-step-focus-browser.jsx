import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { FormsView } from "../../src/views/FormsView.jsx";
import { LanguageProvider } from "../../src/lib/LanguageContext.jsx";
import "../../src/lib/i18n/allLanguages.js";
import "../../src/sg-tokens.css";
import "../../src/styles.css";

const lang = new URLSearchParams(location.search).get("lang") === "es" ? "es" : "en";
window.__savedDrafts = [];
createRoot(document.getElementById("root")).render(<StrictMode>
  <LanguageProvider lang={lang}>
    <a href="#main">Skip to form</a>
    <nav aria-label="Fixture rail"><button type="button">Home</button></nav>
    <main id="main" className="sg-app" data-workspace-theme="union-ground" style={{ colorScheme: "light", padding: 16 }}>
      <FormsView data={{ member: { initials: "FT" }, forms: [] }}
        focus={{ templateKey: "alt_work" }} demo
        onSaveDraft={async (draft) => { window.__savedDrafts.push(draft); return "fixture-draft"; }}
        onSubmit={async () => null} onAddFormFile={async () => null}
      />
    </main>
  </LanguageProvider>
</StrictMode>);
