import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { AdvisorView } from "../src/views/AdvisorView.jsx";
import { LanguageProvider } from "../src/lib/LanguageContext.jsx";
import { fallbackData } from "./fixtures/retired-pre-bot/src/data/fallback.js";

function renderAdvisor(lang = "en", overrides = {}) {
  const api = overrides.api || { loadDesk: vi.fn().mockResolvedValue(JSON.parse(JSON.stringify(fallbackData.advisorDesk))) };
  render(
    <LanguageProvider lang={lang}>
      <AdvisorView data={{ member: { initials: "CL" } }} api={api} onProfile={overrides.onProfile} />
    </LanguageProvider>,
  );
  return api;
}

describe("advisor view", () => {
  it.each([["en", "Profile"], ["es", "Perfil"]])("names the profile with its visible initials first in %s", async (lang, label) => {
    const profile = vi.fn();
    renderAdvisor(lang, { onProfile: profile });
    const avatar = screen.getByRole("button", { name: `CL ${label}` });
    expect(avatar).toHaveTextContent(/^CL$/);
    fireEvent.click(avatar);
    expect(profile).toHaveBeenCalledTimes(1);
    await screen.findByText(lang === "es" ? "Personas incluidas en la cobertura" : "People counted for coverage");
  });

  it("renders chapter aggregates, the resolution rate, and the coverage ratio", async () => {
    renderAdvisor();
    expect(await screen.findByText("People counted for coverage")).toBeInTheDocument();
    expect(screen.getByText("812")).toBeInTheDocument();
    expect(screen.getByText("Workers per committee member")).toBeInTheDocument();
    expect(screen.getByText("135")).toBeInTheDocument();
    // Every field the overview RPC computes is rendered: 21 resolved, 75%.
    expect(screen.getByText("Resolved issues")).toBeInTheDocument();
    expect(screen.getByText("21")).toBeInTheDocument();
    expect(screen.getByText("Resolution rate")).toBeInTheDocument();
    // The rate reads as a percentage inside the KPI tile (PlaneKpi has no
    // suffix slot), so the unit travels with the number.
    expect(screen.getByText("75%")).toBeInTheDocument();
    // Turnout from the latest closed ballot: 213/300 = 71%.
    expect(screen.getByText("71% of quorum")).toBeInTheDocument();
    expect(screen.getByText("213 of 300 votes needed for quorum")).toBeInTheDocument();
  });

  it("renders the anonymized workload categories with the period banner", async () => {
    renderAdvisor();
    expect(await screen.findByText("Previous full quarter 2026-Q2 · latest log per worker · 25-49 submitters")).toBeInTheDocument();
    expect(screen.getByText("Unread docs")).toBeInTheDocument();
    expect(screen.getByText("41")).toBeInTheDocument();
    expect(screen.getByText(/Full-time/)).toBeInTheDocument();
  });

  it("draws only the categories the server published (#7180)", async () => {
    const seed = JSON.parse(JSON.stringify(fallbackData.advisorDesk));
    seed.workload.categories = seed.workload.categories.filter((row) => row.key !== "aged_cases");
    renderAdvisor("en", { api: { loadDesk: vi.fn().mockResolvedValue(seed) } });
    await screen.findByText("Unread docs");
    expect(document.querySelectorAll("#advisor-workload .ach-bar__name")).toHaveLength(seed.workload.categories.length);
    expect(screen.queryByText("Aged issues")).toBeNull();
  });

  it("shows the honest under-threshold state when workload stats are gated", async () => {
    const seed = JSON.parse(JSON.stringify(fallbackData.advisorDesk));
    seed.workload = { enoughData: false, minSubmitters: 25, period: "2026-Q2" };
    renderAdvisor("en", { api: { loadDesk: vi.fn().mockResolvedValue(seed) } });
    expect(await screen.findByText(/stats unlock once at least 25 workers have logged/)).toBeInTheDocument();
  });
  it("keeps unmeasured workload tiles unavailable", async () => {
    const seed = JSON.parse(JSON.stringify(fallbackData.advisorDesk));
    seed.workload.tiles = { pctFullTime: null, pctPartTime: null, avgOtHours: null };
    renderAdvisor('en', { api: { loadDesk: vi.fn().mockResolvedValue(seed) } });
    await screen.findByText('Unread docs');
    expect([...document.querySelectorAll('#advisor-workload .ach-tile__value')].map(node => node.textContent)).toEqual(['—', '—', '—']);
  });
  it("keeps omitted workload tiles unavailable when the independent overview read is absent", async () => {
    renderAdvisor('en', { api: { loadDesk: vi.fn().mockResolvedValue({ overview: null, workload: { enoughData: true }, stewards: [] }) } });
    await screen.findByText('Full-time');
    expect([...document.querySelectorAll('#advisor-workload .ach-tile__value')].map(node => node.textContent)).toEqual(['—', '—', '—']);
    expect(document.querySelector('#advisor-workload .ach-bars')).toBeEmptyDOMElement();
  });

  it("says 'unavailable' — not 'below threshold' — when the workload RPC failed", async () => {
    const seed = JSON.parse(JSON.stringify(fallbackData.advisorDesk));
    seed.workload = null; // loadAdvisorDesk's degrade sentinel for an RPC error
    renderAdvisor("en", { api: { loadDesk: vi.fn().mockResolvedValue(seed) } });
    expect(await screen.findByText(/Workplace log stats couldn't be loaded/)).toBeInTheDocument();
    // A transient failure must never claim submissions are below the K gate.
    expect(screen.queryByText(/stats unlock once at least/)).not.toBeInTheDocument();
  });

  it("renders no percentage bar when the latest ballot has no quorum target", async () => {
    const seed = JSON.parse(JSON.stringify(fallbackData.advisorDesk));
    seed.overview.turnout = { title: "Ratification vote", totalVotes: null, quorumTarget: null };
    seed.overview.resolutionRate = null;
    seed.workload = null; // keep the workload bars out so the track query is unambiguous
    renderAdvisor("en", { api: { loadDesk: vi.fn().mockResolvedValue(seed) } });
    expect(await screen.findByText("0 votes cast")).toBeInTheDocument();
    // No quorum → no percentage exists; a full-width bar would assert 100%.
    // (workload is null in this seed, so the only track that could exist is
    // the turnout one.)
    expect(document.querySelector(".ach-track")).toBeNull();
    expect(screen.queryByText(/\d+%/)).not.toBeInTheDocument();
    // Null resolution rate renders an em-dash, mirroring the coordinator KPI.
    expect(screen.getAllByText("—").length).toBeGreaterThan(0);
  });

  it("surfaces at-risk signals and the roster", async () => {
    renderAdvisor();
    expect(await screen.findByText("2 active issues are past their deadline.")).toBeInTheDocument();
    expect(screen.getByText("Taylor Morgan")).toBeInTheDocument();
    expect(screen.getByText("Campaign chair")).toBeInTheDocument();
  });

  // E1 card layer — see the matching guard in vp-view.test.jsx. The roster has
  // no .plane-card ancestor of its own, so a dropped class cannot be masked by
  // one of the sibling plane cards.
  it("keeps the .plane-card surface on the roster and the plane sections", async () => {
    renderAdvisor();
    const rosterRow = await screen.findByText("Taylor Morgan");
    expect(rosterRow.closest(".plane-card")).not.toBeNull();
    // Turnout, workload and at-risk are plane surfaces too.
    expect(document.querySelectorAll(".plane-card").length).toBeGreaterThan(1);
  });

  // Wave 2e — the plane wears the prototype's Campaign 360 chrome: the shared
  // .phead strip, six accent-left KPI tiles, and the reflowing roster grid.
  it("renders the prototype plane chrome (header strip, KPI tiles, roster grid)", async () => {
    renderAdvisor();
    expect(await screen.findByText("People counted for coverage")).toBeInTheDocument();
    expect(document.querySelector(".phead")).not.toBeNull();
    expect(screen.getByRole("heading", { level: 1, name: "Campaign health" })).toBeInTheDocument();
    expect(document.querySelectorAll(".pkpi").length).toBe(6);
    // Five leadership hats plus the campaign's organizer.
    expect(document.querySelectorAll(".ach-roster__row").length).toBe(6);
    expect(screen.getByText("Organizer")).toBeInTheDocument();
    // The workload bars are the real category averages, not scored drivers.
    expect(document.querySelectorAll(".ach-bars .ach-track").length).toBe(8);
  });

  it("shows the calm empty state when nothing is at risk", async () => {
    const seed = JSON.parse(JSON.stringify(fallbackData.advisorDesk));
    seed.overview.atRisk = { overdueCases: 0, unstaffed: false };
    renderAdvisor("en", { api: { loadDesk: vi.fn().mockResolvedValue(seed) } });
    expect(await screen.findByText("No risk flags right now.")).toBeInTheDocument();
  });

  it("renders fully in Spanish", async () => {
    renderAdvisor("es");
    expect(await screen.findByText("Salud de la campaña")).toBeInTheDocument();
    expect(screen.getByText("Personas incluidas en la cobertura")).toBeInTheDocument();
    expect(screen.getByText("Registro colectivo del centro de trabajo")).toBeInTheDocument();
    expect(screen.getByText("Trimestre completo anterior 2026-Q2 · último registro por trabajador · 25-49 participantes")).toBeInTheDocument();
  });

  //: the Leadership team is the open chapter's, and its line says so.
  it.each([
    ["en", "Leadership team", "Everyone holding a staff role in this campaign right now."],
    ["es", "Equipo de liderazgo", "Quienes tienen un rol de personal en esta campaña ahora mismo."],
  ])("says the Leadership team is this campaign's in %s", async (lang, title, sub) => {
    renderAdvisor(lang);
    const roster = (await screen.findAllByText(title)).map((node) => node.closest("#advisor-leadership")).find(Boolean);
    expect(roster).toBeTruthy();
    expect(within(roster).getByText(sub)).toBeInTheDocument();
  });

  it("shows an inline error card with retry instead of blanking on load failure", async () => {
    const api = { loadDesk: vi.fn().mockRejectedValueOnce(new Error("Advisor overview: denied")).mockResolvedValue(JSON.parse(JSON.stringify(fallbackData.advisorDesk))) };
    renderAdvisor("en", { api });
    expect(await screen.findByText("Load failed")).toBeInTheDocument();
    expect(screen.queryByText("Advisor overview: denied")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(await screen.findByText("People counted for coverage")).toBeInTheDocument();
  });
});
