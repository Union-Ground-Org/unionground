// UX-UG-COMPASS-CHAT-SCROLL-REGION-NOT-KEYBOARD-REACHABLE-20261108 (#7472).
//
// Axe reported scrollable-region-focusable on the Compass conversation: once
// it scrolls, a keyboard user could not reach it to read earlier answers. The
// region is in the tab order now, still labelled "Compass conversation", and
// nothing moves focus to it. Axe cannot judge this rule without layout (jsdom
// reports it incomplete), so the Axe regression runs in the browser suite:
// e2e/assurance-smoke.spec.js, "Compass conversation is keyboard-reachable
// once it scrolls".
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { Assistant } from "../src/components/FloatingControls.jsx";
import { LanguageProvider } from "../src/lib/LanguageContext.jsx";
import { t } from "../src/lib/i18n.js";

const threads = [{
  id: "t1",
  title: "Grievances",
  messages: Array.from({ length: 12 }, (_, index) => ({
    id: `m${index}`,
    role: index % 2 ? "assistant" : "user",
    body: index % 2 ? "Article 14 sets a 30 calendar day deadline for Step 1." : "How long do I have to file a grievance?",
    sources: index % 2 ? [{ title: "Grievance procedure", ref: "Contract · Article 14" }] : [],
  })),
}];

describe("the Compass conversation region", () => {
  it.each(["en", "es"])("is a labelled tab stop under lang=%s", (lang) => {
    render(<LanguageProvider lang={lang}><main id="main-content"><Assistant onClose={vi.fn()} onSend={vi.fn()} threads={threads} /></main></LanguageProvider>);
    const region = screen.getByRole("region", { name: t(lang, "guide.conversation") });
    expect(region).toHaveAttribute("tabindex", "0");
    region.focus();
    expect(document.activeElement).toBe(region);
  });

  it("never takes focus on its own: opening and typing leave focus where they were", () => {
    render(<LanguageProvider lang="en"><main id="main-content"><Assistant onClose={vi.fn()} onSend={vi.fn()} threads={threads} /></main></LanguageProvider>);
    const region = screen.getByRole("region", { name: t("en", "guide.conversation") });
    expect(document.activeElement).not.toBe(region);
    const composer = screen.getByLabelText(t("en", "compass.askAria"));
    composer.focus();
    fireEvent.change(composer, { target: { value: "What is just cause?" } });
    expect(document.activeElement).toBe(composer);
  });
});
