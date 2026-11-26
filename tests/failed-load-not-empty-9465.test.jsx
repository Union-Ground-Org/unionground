// #9465: a failed read says so with Try again; empty answers and refusals keep Main's view.
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { LanguageProvider } from "../src/lib/LanguageContext.jsx";
import { t } from "../src/lib/i18n.js";
import { AppointmentsView } from "../src/views/AppointmentsView.jsx";
import { MySeniorityCard } from "../src/features/seniority/MySeniorityCard.jsx";
import { seniorityCatalogue } from "../src/lib/i18n/seniority.js";

const S = seniorityCatalogue.en;
const wrap = (node, lang = "en") => render(<LanguageProvider lang={lang}>{node}</LanguageProvider>);
const refusal = (code) => Object.assign(new Error("refused"), { code });
const deferred = () => { let resolve, reject; const promise = new Promise((ok, fail) => { resolve = ok; reject = fail; }); return { promise, resolve, reject }; };
const settle = () => act(async () => { await new Promise((resolve) => setTimeout(resolve, 20)); });
const entry = { id: "e1", chapterName: "Kinsey Central", seniorityDate: "2008-01-15" };
const ok = { entries: [entry], bids: [] };

function book(stewards, lang = "en") {
  wrap(<AppointmentsView data={{ member: { initials: "PR" }, appointments: [] }} api={{ stewards, slots: vi.fn() }} onBook={vi.fn()} onCancel={vi.fn()} onReschedule={vi.fn()} />, lang);
  fireEvent.click(screen.getByRole("button", { name: lang === "es" ? "Pedir una reunión individual" : "Request a one-on-one" }));
}
const card = (mine, question = vi.fn()) => wrap(<MySeniorityCard api={{ mine, question }} />);

describe("W4-3 appointment booking", () => {
  it("a failed read says so, with Try again", async () => {
    const stewards = vi.fn().mockRejectedValueOnce(new Error("offline")).mockResolvedValue([{ id: "st-1", name: "Sam Okafor" }]);
    book(stewards);
    expect(await screen.findByRole("alert")).toHaveTextContent("Committee members could not be loaded. Check your connection and try again.");
    expect(screen.queryByText("No committee members are taking one-on-ones right now.")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(await screen.findByRole("button", { name: "Sam Okafor" })).toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("a successful empty read keeps the empty answer (Spanish)", async () => {
    book(vi.fn().mockResolvedValue([]), "es");
    expect(await screen.findByText(t("es", "appt.stewardsEmpty"))).toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(t("es", "appt.stewardsFailed")).not.toBe(t("en", "appt.stewardsFailed"));
  });

  it.each(["22023", "42501"])("keeps Main's empty sentence for a %s refusal", async (code) => {
    book(vi.fn().mockRejectedValue(refusal(code)));
    expect(await screen.findByText("No committee members are taking one-on-ones right now.")).toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("never shows loading and the old alert together after Try again", async () => {
    let together = null;
    const stewards = vi.fn().mockRejectedValueOnce(new Error("offline")).mockImplementation(() => {
      together = Boolean(screen.queryByText("Loading committee members…")) && Boolean(screen.queryByRole("alert"));
      return new Promise(() => {});
    });
    book(stewards);
    await screen.findByRole("alert");
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    await waitFor(() => expect(stewards).toHaveBeenCalledTimes(2));
    expect(together).toBe(false);
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });
});

// W4-5 (civic) is left out: civic action is deferred in Union Ground.

describe("W5-12 your seniority", () => {
  it("a failed read keeps the card, says so, with Try again", async () => {
    card(vi.fn().mockRejectedValueOnce(new Error("offline")).mockResolvedValue(ok));
    expect(await screen.findByRole("alert")).toHaveTextContent(S["seniority.myLoadFailed"]);
    fireEvent.click(screen.getByRole("button", { name: S["seniority.retry"] }));
    expect(await screen.findByText(/Kinsey Central/)).toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(seniorityCatalogue.es["seniority.myLoadFailed"]).toBeTruthy();
  });

  it("keeps the card hidden, as on Main, for a 42501 refusal", async () => {
    const { container } = card(vi.fn().mockRejectedValue(refusal("42501")));
    await settle();
    expect(container).toBeEmptyDOMElement();
  });

  it("Try again is pending while a read runs", async () => {
    const retry = deferred();
    const mine = vi.fn().mockRejectedValueOnce(new Error("offline")).mockReturnValueOnce(retry.promise);
    card(mine);
    await screen.findByRole("alert");
    const button = screen.getByRole("button", { name: S["seniority.retry"] });
    fireEvent.click(button);
    await waitFor(() => expect(mine).toHaveBeenCalledTimes(2));
    expect(button).toHaveAttribute("aria-busy", "true");
    fireEvent.click(button);
    await settle();
    expect(mine).toHaveBeenCalledTimes(2);
    await act(async () => { retry.resolve(ok); });
    expect(await screen.findByText(/Kinsey Central/)).toBeInTheDocument();
  });

  it("only the newest read writes the card", async () => {
    const older = deferred(), newer = deferred();
    const mine = vi.fn().mockResolvedValueOnce(ok).mockReturnValueOnce(older.promise).mockReturnValueOnce(newer.promise);
    card(mine, vi.fn().mockResolvedValue(null));
    for (const note of ["First", "Second"]) {
      fireEvent.change(await screen.findByLabelText(S["seniority.myQuestionLabel"]), { target: { value: note } });
      fireEvent.click(screen.getByRole("button", { name: S["seniority.myQuestionSend"] }));
    }
    await waitFor(() => expect(mine).toHaveBeenCalledTimes(3));
    await act(async () => { newer.resolve(ok); });
    await act(async () => { older.reject(new Error("offline")); });
    expect(screen.getByText(/Kinsey Central/)).toBeInTheDocument();
    expect(screen.queryByText(S["seniority.myLoadFailed"])).not.toBeInTheDocument();
  });
});
