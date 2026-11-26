import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { LanguageProvider } from "../src/lib/LanguageContext.jsx";
import { WorkloadView } from "../src/views/WorkloadView.jsx";

const data = {
  workload: {
    entries: [],
    stats: { enoughData: false, minSubmitters: 25, period: "2026-Q2" },
  },
};

function renderWorkload(lang) {
  render(
    <LanguageProvider lang={lang}>
      <WorkloadView data={data} />
    </LanguageProvider>,
  );
  fireEvent.click(screen.getByRole("button", { name: lang === "es" ? "Estadísticas" : "Stats" }));
}

describe("member workload aggregate period", () => {
  it("labels the previous full quarter and sample semantics in English below the privacy floor", () => {
    renderWorkload("en");
    expect(screen.getByText("Previous full quarter 2026-Q2 · latest log per worker")).toBeInTheDocument();
  });

  it("labels the same window and sample semantics in Spanish", () => {
    renderWorkload("es");
    expect(screen.getByText("Trimestre completo anterior 2026-Q2 · último registro por trabajador")).toBeInTheDocument();
  });
});
