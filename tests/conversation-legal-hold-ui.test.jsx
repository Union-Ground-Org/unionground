import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ConversationLegalHoldControls } from "../src/components/ConversationLegalHoldControls.jsx";
import { LanguageProvider } from "../src/lib/LanguageContext.jsx";
import { expectHeldWriteFocus } from "./helpers/busyWriteFocus.js";

function setup({ held = false, canManage = true, lang = "en", overrides = {} } = {}) {
  let status = { held, canManage, reasonCode: held && canManage ? "arbitration" : null };
  const api = {
    loadLegalHold: vi.fn(async () => status),
    placeLegalHold: vi.fn(async (_, reasonCode) => { status = { ...status, held: true, reasonCode }; return { held: true }; }),
    releaseLegalHold: vi.fn(async () => { status = { ...status, held: false }; return { released: true }; }),
    ...overrides,
  };
  const onNotice = vi.fn(); const onChange = vi.fn();
  render(<LanguageProvider lang={lang}><ConversationLegalHoldControls conversationId="conversation-1" api={api} onNotice={onNotice} onChange={onChange} /></LanguageProvider>);
  return { api, onNotice, onChange };
}

describe("conversation legal hold controls", () => {
  it("confirms a chosen reason, places the hold and reflects the server marker", async () => {
    const { api, onChange } = setup();
    fireEvent.click(await screen.findByRole("button", { name: "Place legal hold" }));
    expect(api.placeLegalHold).not.toHaveBeenCalled();
    fireEvent.change(screen.getByRole("combobox", { name: "Reason for the hold" }), { target: { value: "arbitration" } });
    fireEvent.click(screen.getByRole("button", { name: "Place hold" }));
    await waitFor(() => expect(api.placeLegalHold).toHaveBeenCalledWith("conversation-1", "arbitration"));
    expect(await screen.findByTestId("legal-hold-marker")).toHaveTextContent("Arbitration");
    expect(onChange).toHaveBeenCalledWith("conversation-1", true);
  });
  it("cancels without mutation and confirms release before removing the marker", async () => {
    const { api, onChange } = setup({ held: true });
    fireEvent.click(await screen.findByRole("button", { name: "Release legal hold" }));
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(api.releaseLegalHold).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Release legal hold" }));
    fireEvent.click(screen.getByRole("button", { name: "Release hold" }));
    await waitFor(() => expect(screen.queryByTestId("legal-hold-marker")).not.toBeInTheDocument());
    expect(onChange).toHaveBeenCalledWith("conversation-1", false);
  });
  it("lets staff see preservation without exposing management controls", async () => {
    const { api } = setup({ held: true, canManage: false });
    expect(await screen.findByTestId("legal-hold-marker")).toHaveTextContent("Under legal hold");
    expect(screen.queryByRole("button", { name: /legal hold/i })).not.toBeInTheDocument();
    expect(api.releaseLegalHold).not.toHaveBeenCalled();
  });
  it("fails closed on status errors and retries", async () => {
    setup({ overrides: { loadLegalHold: vi.fn().mockRejectedValueOnce(new Error("private server detail")).mockResolvedValue({ held: false, canManage: true }) } });
    expect(await screen.findByText(/Legal hold status could not be loaded/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Place legal hold" })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(await screen.findByRole("button", { name: "Place legal hold" })).toBeInTheDocument();
  });
  it("keeps failed releases visible and translates the failure in Spanish", async () => {
    const { onNotice, onChange } = setup({ held: true, lang: "es", overrides: { releaseLegalHold: vi.fn().mockRejectedValue(new Error("internal SQL detail")) } });
    fireEvent.click(await screen.findByRole("button", { name: "Levantar retención legal" }));
    fireEvent.click(screen.getByRole("button", { name: "Levantar retención" }));
    await waitFor(() => expect(onNotice).toHaveBeenCalledWith("No se pudo cambiar la retención legal."));
    expect(screen.getByTestId("legal-hold-marker")).toBeInTheDocument();
    expect(onChange).not.toHaveBeenCalled();
  });
  it("moves keyboard focus into the place confirm form and back to the trigger on cancel", async () => {
    setup();
    fireEvent.click(await screen.findByRole("button", { name: "Place legal hold" }));
    const select = screen.getByRole("combobox", { name: "Reason for the hold" });
    expect(select).toHaveFocus();
    expect(document.activeElement).not.toBe(document.body);
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.getByRole("button", { name: "Place legal hold" })).toHaveFocus();
  });
  it("moves keyboard focus into the release confirm group and back to the trigger on cancel", async () => {
    setup({ held: true });
    fireEvent.click(await screen.findByRole("button", { name: "Release legal hold" }));
    expect(screen.getByRole("button", { name: "Release hold" })).toHaveFocus();
    expect(document.activeElement).not.toBe(document.body);
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.getByRole("button", { name: "Release legal hold" })).toHaveFocus();
  });
  it("keeps the held state and manage controls rendered while the post-place reload is in flight", async () => {
    let finishReload;
    const api = {
      loadLegalHold: vi.fn()
        .mockResolvedValueOnce({ held: false, canManage: true, reasonCode: null })
        .mockImplementationOnce(() => new Promise((resolve) => { finishReload = resolve; })),
      placeLegalHold: vi.fn(async () => ({ held: true })),
      releaseLegalHold: vi.fn(async () => ({ released: true })),
    };
    const onNotice = vi.fn();
    render(<LanguageProvider lang="en"><ConversationLegalHoldControls conversationId="conversation-1" api={api} onNotice={onNotice} onChange={vi.fn()} /></LanguageProvider>);
    fireEvent.click(await screen.findByRole("button", { name: "Place legal hold" }));
    fireEvent.click(screen.getByRole("button", { name: "Place hold" }));
    await waitFor(() => expect(api.placeLegalHold).toHaveBeenCalled());
    await waitFor(() => expect(api.loadLegalHold).toHaveBeenCalledTimes(2));
    // The in-flight state agrees with the completed place: marker and the
    // manage controls stay rendered instead of a loading-only paragraph.
    expect(screen.getByTestId("legal-hold-marker")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Release legal hold" })).toBeInTheDocument();
    expect(screen.queryByText("Loading Union Ground…")).not.toBeInTheDocument();
    finishReload({ held: true, canManage: true, reasonCode: "arbitration" });
    await waitFor(() => expect(screen.getByTestId("legal-hold-marker")).toHaveTextContent("Arbitration"));
  });
  it("keeps the released state rendered while the post-release reload is in flight", async () => {
    let finishReload;
    const api = {
      loadLegalHold: vi.fn()
        .mockResolvedValueOnce({ held: true, canManage: true, reasonCode: "arbitration" })
        .mockImplementationOnce(() => new Promise((resolve) => { finishReload = resolve; })),
      placeLegalHold: vi.fn(async () => ({ held: true })),
      releaseLegalHold: vi.fn(async () => ({ released: true })),
    };
    render(<LanguageProvider lang="en"><ConversationLegalHoldControls conversationId="conversation-1" api={api} onNotice={vi.fn()} onChange={vi.fn()} /></LanguageProvider>);
    fireEvent.click(await screen.findByRole("button", { name: "Release legal hold" }));
    fireEvent.click(screen.getByRole("button", { name: "Release hold" }));
    await waitFor(() => expect(api.releaseLegalHold).toHaveBeenCalled());
    await waitFor(() => expect(api.loadLegalHold).toHaveBeenCalledTimes(2));
    // The in-flight state agrees with the completed release: no held marker,
    // and the manage controls offer to place a hold again.
    expect(screen.queryByTestId("legal-hold-marker")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Place legal hold" })).toBeInTheDocument();
    expect(screen.queryByText("Loading Union Ground…")).not.toBeInTheDocument();
    finishReload({ held: false, canManage: true, reasonCode: null });
    await waitFor(() => expect(screen.getByRole("button", { name: "Place legal hold" })).toBeInTheDocument());
  });
  it("returns focus to the trigger and announces failure when placement fails", async () => {
    const { onNotice } = setup({ overrides: { placeLegalHold: vi.fn().mockRejectedValue(new Error("internal detail")) } });
    fireEvent.click(await screen.findByRole("button", { name: "Place legal hold" }));
    fireEvent.click(screen.getByRole("button", { name: "Place hold" }));
    await waitFor(() => expect(onNotice).toHaveBeenCalledWith("The legal hold could not be changed."));
    expect(screen.getByRole("button", { name: "Place legal hold" })).toHaveFocus();
  });
  it("prevents repeated writes while placement is pending", async () => {
    let finish;
    const { api } = setup({ overrides: { placeLegalHold: vi.fn(() => new Promise((resolve) => { finish = resolve; })) } });
    fireEvent.click(await screen.findByRole("button", { name: "Place legal hold" }));
    const confirm = screen.getByRole("button", { name: "Place hold" });
    fireEvent.click(confirm); fireEvent.click(confirm);
    expect(confirm).toHaveAttribute("aria-disabled", "true");
    expect(api.placeLegalHold).toHaveBeenCalledTimes(1);
    finish({ held: true });
    await waitFor(() => expect(screen.queryByRole("button", { name: "Place hold" })).not.toBeInTheDocument());
  });
});

describe("legal hold writes keep focus while they run (record 8435)", () => {
  it("keeps Place hold focused while the hold is placed, and places it once", async () => {
    const { api } = setup();
    fireEvent.click(await screen.findByRole("button", { name: "Place legal hold" }));
    await expectHeldWriteFocus(api.placeLegalHold, screen.getByRole("button", { name: "Place hold" }));
    expect(api.placeLegalHold).toHaveBeenCalledTimes(1);
  });
});

// Record 8435: Release hold is held like Place hold.
describe("conversation legal hold release keeps focus", () => {
  it("keeps Release hold focused while the hold is released, and releases it once", async () => {
    const { api } = setup({ held: true });
    fireEvent.click(await screen.findByRole("button", { name: "Release legal hold" }));
    await expectHeldWriteFocus(api.releaseLegalHold, screen.getByRole("button", { name: "Release hold" }));
    expect(api.releaseLegalHold).toHaveBeenCalledTimes(1);
  });
});
