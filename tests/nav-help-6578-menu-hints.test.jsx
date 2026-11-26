// REQ-UG-NAVIGATION-HELP-AND-SETUP-COPY-20261030, findings 85 and 99:
// Compass, Be heard and Member support carry a plain one-line explanation where
// the menu lists them, and the unexplained terms on Workload log and Messages
// (PER time, Attention Queue, "Choose how Messages works", the direct-contact
// reward) read plainly. Feature names themselves do not change.
import { render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { DesktopRail } from "../src/components/DesktopRail.jsx";
import { MobileCardNav } from "../src/components/MobileCardNav.jsx";
import { LanguageProvider } from "../src/lib/LanguageContext.jsx";
import { NAV_HINT_KEYS } from "../src/lib/mobileNav.js";
import { catalogue, t as translate } from "../src/lib/i18n.js";
import { keepKeyboardShortcutsOn } from "./helpers/keyboardShortcuts.js";

keepKeyboardShortcutsOn();

const en = (key, vars) => translate("en", key, vars);
const es = (key, vars) => translate("es", key, vars);

function rail(props = {}, lang = "en") {
  return render(<LanguageProvider lang={lang}><DesktopRail renderMode="desktop" active="today" onNavigate={vi.fn()} onAsk={vi.fn()} {...props} /></LanguageProvider>);
}

describe("menu explanations", () => {
  it("has an English and Spanish line for each explained entry, and keeps the names", () => {
    expect(Object.keys(NAV_HINT_KEYS)).toEqual(["compass", "voice", "member-support"]);
    for (const key of Object.values(NAV_HINT_KEYS)) {
      expect(catalogue.en[key], key).toEqual(expect.any(String));
      expect(catalogue.es[key], key).toEqual(expect.any(String));
      expect(catalogue.es[key]).not.toBe(catalogue.en[key]);
    }
    expect(en("nav.compass")).toBe("Union Ground Guide");
    expect(en("morehub.beHeard")).toBe("Be heard");
    expect(en("nav.memberSupport")).toBe("Worker support");
  });


  it("uses the Spanish lines in the Spanish rail", () => {
    rail({}, "es");
    const nav = screen.getByRole("navigation", { name: es("nav.primary") });
    expect(within(nav).getByRole("link", { name: es("morehub.beHeard") })).toHaveAccessibleDescription(es("nav.hint.voice"));
  });

});

describe("plain terms on Workload log and Messages", () => {
  // BUG-UG-WORKLOAD-SHOWS-ONE-OFFICES-PERFORMANCE-STANDARDS-TO-EVERY-UNION-20261122
  // (#9497): "PER" was one office's rating system; the line now says
  // performance review in plain words that fit every union.

  it("rewrites the Messages layout chooser in plain words", () => {
    expect(en("inbox.workflow.onboardingEyebrow")).toBe("Pick a layout for your messages");
    expect(en("inbox.workflow.onboardingBody")).not.toMatch(/organization changes/);
    expect(en("inbox.workflow.onboardingBody")).toContain("only how they are grouped");
    expect(es("inbox.workflow.onboardingEyebrow")).toBe("Elige un diseño para tus mensajes");
    expect(es("inbox.workflow.onboardingBody")).not.toMatch(/organización/);
  });

  // UX-UG-WORDING-AND-SPANISH-GAPS-FROM-REVIEWS-20261117 (tooling
  // ledger 297): the inbox layout is renamed so it no longer shares a name
  // with the held "Attention queue on the steward desk" feature.
  it("says what the To-do inbox is, under a name apart from the held attention queue", () => {
    expect(en("inbox.workflow.attention.title")).toBe("To-do inbox");
    expect(es("inbox.workflow.attention.title")).toBe("Bandeja de pendientes");
    expect(en("inbox.workflow.attention.title")).not.toMatch(/attention/i);
    expect(es("inbox.workflow.attention.title")).not.toMatch(/atención/i);
    expect(en("inbox.workflow.attention.summary")).toMatch(/^A to-do list for messages/);
    expect(es("inbox.workflow.attention.summary")).toMatch(/^Una lista de pendientes/);
  });

});
