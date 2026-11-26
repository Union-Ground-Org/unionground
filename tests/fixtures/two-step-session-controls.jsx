import { useState } from "react";
import { createRoot } from "react-dom/client";
import { MfaSettings } from "../../src/components/MfaSettings.jsx";
import { SettingsView } from "../../src/views/SettingsView.jsx";
import { LanguageProvider } from "../../src/lib/LanguageContext.jsx";
import "../../src/sg-tokens.css";
import "../../src/styles.css";
import "../../src/coordinator-theme.css";

let verified = false;
const factor = { id: "synthetic-factor", factor_type: "totp", status: "verified" };
const client = {
  rpc: async () => ({ data: [], error: null }),
  auth: { mfa: {
    listFactors: async () => ({ data: { all: verified ? [factor] : [] }, error: null }),
    enroll: async () => ({ data: { id: factor.id, totp: {
      secret: "SYNTHETIC-TEST-KEY",
      qr_code: `data:image/svg+xml,${encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="180" height="180"><rect width="180" height="180" fill="white"/><path d="M10 10h50v50H10zm100 0h50v50h-50zM10 110h50v50H10zm80-20h30v30H90z" fill="black"/></svg>')}`,
    } }, error: null }),
    challenge: async () => ({ data: { id: "synthetic-challenge" }, error: null }),
    verify: async ({ code }) => {
      verified = code === "012346";
      return { error: verified ? null : { message: "Invalid code" } };
    },
    unenroll: async () => ({ error: null }),
  } },
};
const sessions = [
  { handle: "a".repeat(64), deviceLabel: "linux_computer", browserLabel: "chrome", current: true },
  { handle: "b".repeat(64), deviceLabel: "apple_mobile", browserLabel: "safari", current: false },
];
const loadSessions = async () => sessions;

function Fixture() {
  const [signedOut, setSignedOut] = useState(false);
  const [notice, setNotice] = useState("");
  return <LanguageProvider lang="en"><div className="sg-app" data-workspace-theme="union-ground">
    <main className="app-column">
      {signedOut ? <h1>Sign in to Union Ground</h1> : <>
        <div style={{ minHeight: "800px" }}><h1>Security controls regression</h1><p>Synthetic local test. No account or server connection.</p></div>
        <MfaSettings client={client} onStandingChanged={() => setNotice("Two-step verified")} />
        <p role="status">{notice}</p>
        <SettingsView data={{ member: {}, roles: [] }} lang="en" onLoadSessions={loadSessions}
          onRevokeSession={async () => undefined} onSignOut={async () => setSignedOut(true)} onSignOutEverywhere={async () => setSignedOut(true)} />
      </>}
    </main>
  </div></LanguageProvider>;
}
createRoot(document.getElementById("root")).render(<Fixture />);
