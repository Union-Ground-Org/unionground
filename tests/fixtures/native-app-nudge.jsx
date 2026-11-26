import React from "react";
import { createRoot } from "react-dom/client";
import { NativeAppNudge } from "../../src/components/NativeAppNudge.jsx";
import { LanguageProvider } from "../../src/lib/LanguageContext.jsx";
import "../../src/sg-tokens.css";
import "../../src/styles.css";

const lang = new URLSearchParams(location.search).get("lang") === "es" ? "es" : "en";
createRoot(document.getElementById("nudge-proof")).render(
  <LanguageProvider lang={lang}>
    <main style={{ maxWidth: "100%", padding: 16 }}>
      <h1>Native app nudge — functional check</h1>
      <NativeAppNudge pathname="/m/messages" />
      <p>This isolated component uses no account or member data.</p>
      <a href="/privacy">Privacy</a>
    </main>
  </LanguageProvider>,
);
