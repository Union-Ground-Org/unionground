import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { ChoiceDialog } from "../src/components/Dialogs.jsx";
import { LanguageProvider } from "../src/lib/LanguageContext.jsx";
import { clearDeviceParityState } from "../src/lib/deviceParity.js";

const survey = { id: "survey-feedback", kind: "pulse", title: "Workplace priorities", options: [
  { id: "safety", label: "Safety" }, { id: "scheduling", label: "Scheduling" },
] };

function setup(onSubmit, lang = "en", item = survey) {
  const onClose = vi.fn();
  render(<LanguageProvider lang={lang}><ChoiceDialog item={item} onSubmit={onSubmit} onClose={onClose} /></LanguageProvider>);
  fireEvent.click(screen.getByRole("radio", { name: "Safety" }));
  return { onClose, form: screen.getByRole("radio", { name: "Safety" }).closest("form") };
}

afterEach(() => { clearDeviceParityState(); vi.useRealTimers(); });

describe("survey submission confirmation", () => {
  it.each(["en", "es"])("announces a failed save in %s, retains the answer, and confirms a successful retry", async (lang) => {
    const onSubmit = vi.fn().mockRejectedValueOnce(new Error("private RPC detail"))
      .mockResolvedValueOnce({ awardedPoints: 0 });
    const { onClose, form } = setup(onSubmit, lang);
    await act(async () => fireEvent.submit(form));
    expect(screen.getByRole("alert")).toHaveTextContent(lang === "en" ? "We couldn’t confirm your submission" : "No pudimos confirmar tu envío");
    expect(document.body).not.toHaveTextContent("private RPC detail");
    expect(screen.getByRole("radio", { name: "Safety" })).toBeChecked();
    expect(onClose).not.toHaveBeenCalled();
    await act(async () => fireEvent.submit(form));
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(screen.getByRole("status")).toHaveTextContent(lang === "en" ? "Answer in!" : "¡Respuesta enviada!");
    expect(onSubmit.mock.calls).toEqual([["safety"], ["safety"]]);
  });

  it.each(["", null, undefined, false])("does not celebrate an unconfirmed callback result (%s)", async (result) => {
    const { onClose, form } = setup(vi.fn().mockResolvedValue(result));
    await act(async () => fireEvent.submit(form));
    expect(screen.getByRole("alert")).toBeInTheDocument();
    expect(screen.queryByText("Answer in!")).not.toBeInTheDocument();
    expect(screen.getByRole("radio", { name: "Safety" })).toBeChecked();
    expect(onClose).not.toHaveBeenCalled();
  });

  it("freezes the submitted choice and blocks same-turn duplicate submits until the request settles", async () => {
    let finish;
    const onSubmit = vi.fn(() => new Promise((resolve) => { finish = resolve; }));
    const { form } = setup(onSubmit);
    act(() => { fireEvent.submit(form); fireEvent.submit(form); });
    expect(onSubmit).toHaveBeenCalledTimes(1);
    const choice = screen.getByRole("radio", { name: "Scheduling" });
    expect(choice).toBeEnabled();
    expect(choice.closest("fieldset")).toHaveAttribute("aria-disabled", "true");
    expect(screen.getByRole("button", { name: "Saving…" })).toHaveAttribute("aria-disabled", "true");
    await act(async () => finish({ awardedPoints: 0 }));
    expect(screen.getByRole("status")).toHaveTextContent("Answer in!");
  });

  it("keeps an empty ballot result unconfirmed without inventing a receipt or exposing a saved choice", async () => {
    const { onClose, form } = setup(vi.fn().mockResolvedValue(""), "en", { ...survey, kind: "ballot" });
    await act(async () => fireEvent.submit(form));
    expect(screen.getByRole("alert")).toBeInTheDocument();
    expect(onClose).not.toHaveBeenCalled();
    expect(screen.queryByText("Answer in!")).not.toBeInTheDocument();
  });

  // Closed and already-recorded refusals are final.
  it.each([
    ["closed", "pulse", "en", "Voting has closed for this item — the result is final."],
    ["closed", "ballot", "es", "La votación de este elemento ha cerrado — el resultado es definitivo."],
    ["already-recorded", "ballot", "en", "Your vote is already recorded — votes are final and can't be changed."],
    ["already-recorded", "ballot", "es", "Tu voto ya está registrado — los votos son definitivos y no se pueden cambiar."],
  ])("states a %s %s refusal in %s inside the dialog with no retry", async (refused, kind, lang, text) => {
    const onSubmit = vi.fn().mockResolvedValue({ refused });
    const { onClose, form } = setup(onSubmit, lang, { ...survey, kind });
    await act(async () => fireEvent.submit(form));
    expect(screen.getByRole("alert")).toHaveTextContent(text);
    expect(screen.queryByText(/Please try again|Inténtalo de nuevo/)).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Submit|Vote|Enviar|Votar/ })).not.toBeInTheDocument();
    expect(screen.queryByRole("radio")).not.toBeInTheDocument();
    expect(onClose).not.toHaveBeenCalled();
    expect(onSubmit).toHaveBeenCalledTimes(1);
  });

  it("closes a ballot whose write landed without a receipt string", async () => {
    const { onClose, form } = setup(vi.fn().mockResolvedValue(true), "en", { ...survey, kind: "ballot" });
    await act(async () => fireEvent.submit(form));
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("requires confirmation from the same visible campaign before treating a lookup miss as closed", () => {
    const app = readFileSync("src/App.jsx", "utf8");
    const start = app.indexOf("async function submitChoice(");
    const body = app.slice(start, app.indexOf("const navUsage = useNavUsage(", start));
    expect(body).toMatch(/let confirmedClosed = \/\(ballot\|pulse\) is closed\/i\.test/);
    expect(body).toMatch(/const lookupMiss = \/\(ballot\|pulse\) not found\/i\.test/);
    expect(body).toMatch(/if \(lookupMiss\) \{[\s\S]*?\.select\("id,campaign_state"\)\.eq\("id", activePlan\.id\)\.maybeSingle\(\)/);
    expect(body).toContain('confirmedClosed = !readError && campaign?.id === activePlan.id && campaign.campaign_state === "closed"');
    expect(body).toMatch(/if \(confirmedClosed\) \{[\s\S]*?setNotice\(tr\("toast.itemClosed"\)\)[\s\S]*?refresh\(session[\s\S]*?return \{ refused: "closed" \}/);
    expect(body).toMatch(/if \(\/your vote is already recorded\/i\.test[\s\S]*?return \{ refused: "already-recorded" \}/);
    expect(body).toContain("throw error;");
  });
});
