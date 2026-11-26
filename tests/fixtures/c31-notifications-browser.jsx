import { useState } from "react";
import { createRoot } from "react-dom/client";
import { NotificationsDialog } from "../../src/components/Dialogs.jsx";
import { ScreenHeader } from "../../src/components/Primitives.jsx";
import { LanguageProvider } from "../../src/lib/LanguageContext.jsx";
import { loadLanguage } from "../../src/lib/i18n.js";
import "../../src/sg-tokens.css";
import "../../src/styles.css";
import "../../src/motion.css";

const params = new URLSearchParams(location.search);
const lang = params.get("lang") === "es" ? "es" : "en";
const SettingsView = params.has("sessions") ? (await import("../../src/views/SettingsView.jsx")).SettingsView : null;
await loadLanguage(lang);
document.documentElement.lang = lang;
const items = Array.from({ length: 40 }, (_, id) => ({
  id: `tamarack-${id}`, title: `Tamarack update ${id + 1}`, body: "Fictional notification for keyboard and status checks.",
  created_at: id % 2 ? "2026-07-15T17:05:00Z" : "2026-01-15T17:05:00Z",
  read_at: params.has("read") || id % 3 ? "2026-11-08T17:00:00Z" : null,
  kind: "general", copy_key: null,
}));
const sessionRows = ["2026-01-15T17:05:00Z", "2026-07-15T17:05:00Z", null, "invalid"].map((lastActiveAt, id) => ({
  handle: `${id}`.repeat(64), deviceLabel: "windows_computer", browserLabel: "chrome", lastActiveAt,
}));
const loadSessions = async () => sessionRows;

function Fixture() {
  const [notifications, setNotifications] = useState(items);
  const [open, setOpen] = useState(false);
  if (SettingsView) return <LanguageProvider lang={lang}><main id="main-content" className="sg-app" data-workspace-theme="union-ground"><SettingsView data={{ member: { initials: "TF" }, roles: [] }} lang={lang} onLoadSessions={loadSessions} /></main></LanguageProvider>;
  return <LanguageProvider lang={lang}><main id="main-content" className="sg-app" data-workspace-theme="union-ground" tabIndex={-1}>
    <ScreenHeader title="Tamarack notification fixture" notifications={notifications.filter((item) => !item.read_at).length} onNotifications={() => setOpen(true)} />
    <p>Fictional browser fixture. Changes stay in this page.</p>
    {open && <NotificationsDialog notifications={notifications} onClose={() => setOpen(false)} onReadAll={() => setNotifications((current) => current.map((item) => ({ ...item, read_at: "2026-11-08T17:00:00Z" })))} />}
  </main></LanguageProvider>;
}
createRoot(document.getElementById("root")).render(<Fixture />);
