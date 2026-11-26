import { render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { LanguageProvider } from "../src/lib/LanguageContext.jsx";
import { clearDeviceParityState } from "../src/lib/deviceParity.js";
import { CasesView } from "../src/views/CasesView.jsx";
import { CoordinatorView } from "../src/views/CoordinatorView.jsx";
import { TodayView } from "../src/views/TodayView.jsx";
import { NumbersView } from "../src/views/NumbersView.jsx";
import { fallbackData } from "./fixtures/retired-pre-bot/src/data/fallback.js";
import { seedDemoData } from "./fixtures/retired-pre-bot/src/data/demoSeed.js";

afterEach(() => clearDeviceParityState());

it("renders Member date-only deadlines from raw values and switches language on the mounted view", () => {
  const data = structuredClone(fallbackData);
  data.cases = [{ ...data.cases[0], deadlineValue: "2026-06-21", deadline: "STALE ENGLISH", overdue: true }];
  const view = (lang) => <LanguageProvider lang={lang}><CasesView data={data} /></LanguageProvider>;
  const { container, rerender } = render(view("en"));
  const row = container.querySelector(".mcases-case");
  expect(container.querySelector(".mcases-tl__due")).toHaveTextContent("Overdue — Jun 21");
  rerender(view("es"));
  expect(container.querySelector(".mcases-case")).toBe(row);
  expect(container.querySelector(".mcases-tl__due")).toHaveTextContent("Vencido — 21 jun");
  expect(container.textContent).not.toContain("STALE ENGLISH");
  expect(data.cases[0].deadline).toBe("STALE ENGLISH");
});

it("localizes Coordinator docket, queue and deadline chips on the mounted desk", async () => {
  const desk = structuredClone(fallbackData.coordinatorDesk);
  desk.cases = [{ ...desk.cases[0], deadline: "2026-07-22", deadlineLabel: "STALE ENGLISH" }];
  const api = { loadDesk: vi.fn().mockResolvedValue(desk) };
  const view = (lang) => <LanguageProvider lang={lang}><CoordinatorView data={{ member: { initials: "CC" } }} api={api} /></LanguageProvider>;
  const { container, rerender } = render(view("en"));
  await waitFor(() => expect(container.querySelector(".gq-docket__due")).toHaveTextContent("Jul 22"));
  const caption = container.querySelector(".gq-docket__due");
  expect(container.querySelector(".gq-duechip")).toHaveTextContent("Jul 22");
  rerender(view("es"));
  await waitFor(() => expect(container.querySelector(".gq-docket__due")).toHaveTextContent("22 jul"));
  expect(container.querySelector(".gq-duechip")).toHaveTextContent("22 jul");
  expect(container.textContent).not.toContain("STALE ENGLISH");
  expect(container.querySelector(".gq-docket__due")).toBe(caption);
});



it("supplies raw workload timestamps in the existing and expanded fixture shapes", () => {
  for (const data of [fallbackData, seedDemoData(fallbackData)]) {
    expect(data.workload.entries.length).toBeGreaterThan(0);
    for (const entry of data.workload.entries) expect(Number.isFinite(Date.parse(entry.createdAt))).toBe(true);
  }
});
