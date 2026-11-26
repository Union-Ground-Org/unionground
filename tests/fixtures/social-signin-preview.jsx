// Dev-only browser fixture: provider refusals and existing-user responses are
// simulated. No credentials, hosted accounts or hardware ceremonies are used.
import React, { useState } from "react";
import { createRoot } from "react-dom/client";
import { AuthScreen } from "../../src/components/AuthScreen.jsx";
import { MfaSettings } from "../../src/components/MfaSettings.jsx";
import { LanguageProvider } from "../../src/lib/LanguageContext.jsx";
import "../../src/sg-tokens.css";
import "../../src/styles.css";
import "../../src/coordinator-theme.css";
import "../../src/motion.css";

const params = new URLSearchParams(location.search);
const scenario = params.get("scenario") || "signin";
const originalFetch = globalThis.fetch;
globalThis.fetch = (input, init) => String(input).includes("/api/auth-signin-options")
  ? Promise.resolve(new Response(JSON.stringify({ providers: {
    google: scenario !== "disabled", apple: scenario !== "disabled",
  } })))
  : originalFetch(input, init);
const refuse = async () => ({ error: new Error("Simulated refusal") });
const client = { auth: {
  signInWithOAuth: scenario === "loading" ? async () => new Promise(() => {}) : refuse,
  linkIdentity: refuse,
  getUser: async () => ({ data: { user: { id: "fictional-preview-member", identities: [{ provider: "google" }] } }, error: null }),
  signInWithPasskey: refuse,
  registerPasskey: refuse,
  mfa: { listFactors: async () => ({ data: { all: [] }, error: null }) },
  passkey: { list: async () => ({ data: [], error: null }), startRegistration: refuse, verifyRegistration: refuse },
}, rpc: async () => ({ data: null, error: null }) };

function Preview() {
  const [lang, setLang] = useState(params.get("lang") === "es" ? "es" : "en");
  return <LanguageProvider lang={lang}>
    <p className="mfa-caution">Controlled authentication UI preview: simulated providers; no live sign-in.</p>
    {scenario === "settings" ? <div className="sg-app" data-workspace-theme={params.get("theme") || "union-ground"}>
      <section className="setin-card"><div className="setin-card__body"><MfaSettings client={client} /></div></section>
    </div> : <AuthScreen client={client} lang={lang} onLanguageChange={setLang} onDemo={params.has("demo") ? () => {} : undefined} />}
  </LanguageProvider>;
}

createRoot(document.getElementById("root")).render(<Preview />);
