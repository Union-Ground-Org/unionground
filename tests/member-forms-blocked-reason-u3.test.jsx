//  unit 3: "Go to" lands on the named answer (ledger 765), Save signature asks
// for the drawing alone once the box is ticked (W3b-7), and the demo Voice buttons
// name their minimums (W3b-14).
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { DemoVoiceMember } from "../src/components/DemoVoiceMember.jsx";
import { FormFilingControls } from "../src/components/FormFilingControls.jsx";
import { catalogue } from "../src/lib/i18n.js";
import { LanguageProvider } from "../src/lib/LanguageContext.jsx";
import { FormsView } from "../src/views/FormsView.jsx";

const described = node => (node.getAttribute("aria-describedby") || "").split(" ").filter(Boolean)
  .map(id => document.getElementById(id)?.textContent || "").join(" ");
const expectReason = (name, text) => {
  const button = screen.getAllByRole("button", { name })[0];
  expect(button).toHaveAttribute("aria-disabled", "true");
  expect(described(button)).toContain(text);
};

describe("Go to on a form's Review step (ledger 765)", () => {
  it.each(["en", "es"])("puts focus on the named answer, not the step heading, in %s", (code) => {
    const c = catalogue[code];
    render(<LanguageProvider lang={code}><FormsView data={{ member: { initials: "FT" }, forms: [] }} focus={{ templateKey: "alt_work" }}
      onSaveDraft={vi.fn().mockResolvedValue("draft")} onSubmit={vi.fn()} /></LanguageProvider>);
    const requested = c["forms.f.requested"];
    fireEvent.click(screen.getByRole("button", { name: c["forms.next"] }));
    fireEvent.click(screen.getByRole("button", { name: c["forms.next"] }));
    fireEvent.click(screen.getByRole("button", { name: c["forms.goToField"].replace("{label}", requested) }));
    expect(document.activeElement).toBe(screen.getByRole("textbox", { name: requested }));
    // The step it opened is still said, once, in a polite region.
    const stepSaid = `${screen.getByRole("heading", { level: 2 }).textContent}. ${c["forms.stepOf"].replace("{current}", "1").replace("{total}", "3")}`;
    expect(screen.getAllByRole("status").map((node) => node.textContent)).toContain(stepSaid);
    // Next and Back still land on the step heading.
    fireEvent.click(screen.getByRole("button", { name: c["forms.next"] }));
    expect(document.activeElement).toBe(screen.getByRole("heading", { level: 2 }));
    expect(screen.getAllByRole("status").map((node) => node.textContent)).not.toContain(stepSaid);
  });
});

describe("Save signature (W3b-7)", () => {
  it.each(["en", "es"])("asks for the drawing alone once the box is ticked, in %s", (code) => {
    const t = key => catalogue[code][`forms.filing.${key}`] || key;
    render(<FormFilingControls t={t} editable files={[]} onSaveSignature={vi.fn()} />);
    fireEvent.click(screen.getByRole("checkbox"));
    expectReason(t("saveSignature"), t("signatureSignFirst"));
  });
});

describe("the demo Voice forms (W3b-14)", () => {
  it.each(["en", "es"])("name each hidden minimum beside its held button, in %s", (code) => {
    window.sessionStorage.clear();
    const c = catalogue[code];
    render(<DemoVoiceMember lang={code} />);
    expectReason(c["voiceDemo.postQuestion"], c["voiceDemo.qaNeeds"].replace("{title}", "8").replace("{body}", "12"));
    expectReason(c["voiceDemo.submitToPool"], c["voiceDemo.weeklyNeeds"].replace("{count}", "10").replace("{options}", "2"));
    expectReason(c["voiceDemo.postReply"], c["voiceDemo.replyNeeds"].replace("{count}", "4"));
  });
});
