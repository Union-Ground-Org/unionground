// #9460 slice 3: a member's blocked button names what is missing beside it.
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { FormFilingControls } from "../src/components/FormFilingControls.jsx";
import { catalogue } from "../src/lib/i18n.js";
import { LanguageProvider } from "../src/lib/LanguageContext.jsx";
import { VoiceView } from "../src/views/VoiceView.jsx";

const described = node => (node.getAttribute("aria-describedby") || "").split(" ").filter(Boolean)
  .map(id => document.getElementById(id)?.textContent || "").join(" ");
const expectReason = (name, text) => {
  const button = screen.getByRole("button", { name });
  expect(button).toHaveAttribute("aria-disabled", "true");
  expect(described(button)).toContain(text);
  fireEvent.click(button);
  expect(screen.getByRole("alert")).toHaveTextContent(text);
  return button;
};
const lang = (code, node) => <LanguageProvider lang={code}>{node}</LanguageProvider>;

describe("Use promotion (W4-14)", () => {
  it("shows the reason as text beside the button, not only as a tooltip", () => {
    const promote = vi.fn();
    const weekly = [{ id: "q", body: "Evening hours?", submittedByMe: true, priority: false, promotionAvailable: false, score: 0 }];
    render(lang("en", <VoiceView weeklyQuestions={weekly} onPromoteWeeklyQuestion={promote} />));
    const button = expectReason("Use promotion", "Priority promotion isn't available for this question right now.");
    expect(button).not.toHaveAttribute("title");
    expect(promote).not.toHaveBeenCalled();
  });
});

describe("Save signature (W3b-7)", () => {
  const draw = name => {
    const canvas = screen.getByLabelText(name);
    vi.spyOn(canvas, "getBoundingClientRect").mockReturnValue({ left: 0, top: 0, width: 100, height: 50, right: 100, bottom: 50, x: 0, y: 0, toJSON: () => ({}) });
    fireEvent.pointerDown(canvas, { clientX: 10, clientY: 10, pointerId: 1 });
    fireEvent.pointerMove(canvas, { clientX: 80, clientY: 40, pointerId: 1 });
    fireEvent.pointerUp(canvas, { pointerId: 1 });
  };
  it.each([
    ["en", "Draw or type your signature and tick the box above to save it.", "Tick the box above to confirm this is your signature."],
    ["es", "Dibuja o escribe tu firma y marca la casilla de arriba para guardarla.", "Marca la casilla de arriba para confirmar que es tu firma."],
  ])("names the missing signature, then the missing tick, in %s", (code, unsigned, unticked) => {
    const t = key => catalogue[code][`forms.filing.${key}`] || key;
    const onSaveSignature = vi.fn();
    render(<FormFilingControls t={t} editable files={[]} onSaveSignature={onSaveSignature} />);
    expectReason(t("saveSignature"), unsigned);
    draw(t("signature"));
    expectReason(t("saveSignature"), unticked);
    expect(onSaveSignature).not.toHaveBeenCalled();
  });
});
