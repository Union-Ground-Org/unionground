import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { LanguageProvider } from "../src/lib/LanguageContext.jsx";
import { t } from "../src/lib/i18n.js";
import { NumbersView } from "../src/views/NumbersView.jsx";
import { OrgStructureView } from "../src/views/OrgStructureView.jsx";
import { CASE_EXPORT_COLUMNS, downloadCaseCsv } from "../src/lib/caseExport.js";
import { parseCsv } from "./helpers/csv.js";

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

const prose = 'Tamarack, "José"\nActualización';
function downloads() {
  const blobs = [];
  vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});
  vi.stubGlobal("URL", { createObjectURL: (blob) => { blobs.push(blob); return "blob:csv"; }, revokeObjectURL: () => {} });
  return blobs;
}

function writtenRows(body, lang, surface) {
  const dir = mkdtempSync(join(tmpdir(), "c56-csv-"));
  try {
    const file = join(dir, `${surface}-${lang}.csv`);
    writeFileSync(file, body, "utf8");
    const bytes = readFileSync(file);
    expect(new TextDecoder("utf-8", { fatal: true }).decode(bytes)).toBe(body);
    return parseCsv(bytes.toString("utf8"));
  } finally { rmSync(dir, { recursive: true, force: true }); }
}

describe.each(["en", "es"])("%s CSV download language", (lang) => {
  const translate = (key, vars) => t(lang, key, vars);
  it("writes report headings in the reader language with unchanged authored report text", async () => {
    const blobs = downloads();
    // No points card in this edition: the actions card carries the authored value.
    const data = { member: { initials: "TF" }, rewards: { actionsYtd: prose }, reportPreferences: {
      order: ["actions"], hidden: ["streak"], custom: [],
    } };
    render(<LanguageProvider lang={lang}><NumbersView data={data} /></LanguageProvider>);
    fireEvent.click(screen.getByRole("button", { name: translate("reports.export") }));
    expect(blobs).toHaveLength(1);
    const rows = writtenRows(await blobs[0].text(), lang, "reports");
    expect(rows[0]).toEqual(lang === "es" ? ["clave", "título", "período", "valor", "detalle"] : ["key", "title", "period", "value", "detail"]);
    expect(rows.some((row) => row[3] === prose)).toBe(true);
  });

  it("writes chart headings and controlled kinds without changing names or ISO source dates", async () => {
    const blobs = downloads();
    const node = { id: "tamarack-seat", label: prose, nodeKind: "role", parentId: null, chapterId: "tamarack-chapter", seatStatus: "unknown", sourceAsOf: "2026-07-06" };
    const custom = { ...node, id: "tamarack-custom", label: "Tamarack custom position", nodeKind: "tamarack_custom" };
    const structure = { organizationId: "tamarack-org", chapterId: "tamarack-chapter", charts: [{ chartKind: "union", nodes: [node, custom], edges: [] }] };
    render(<LanguageProvider lang={lang}><OrgStructureView structure={structure} /></LanguageProvider>);
    fireEvent.click(screen.getByRole("button", { name: translate("orgStructure.download") }));
    expect(blobs).toHaveLength(1);
    const rows = writtenRows(await blobs[0].text(), lang, "chart");
    expect(rows[0]).toEqual(lang === "es"
      ? ["Organización", "Campaña", "Organigrama", "Nivel", "Ruta", "Puesto", "Tipo", "Detalle", "Reporta a", "Estado del puesto", "Vacante", "Última revisión", "Fuente", "Fuente al"]
      : ["Organization", "Campaign", "Chart", "Level", "Path", "Position", "Kind", "Detail", "Reports to", "Seat status", "Vacant", "Reviewed on", "Source", "Source as of"]);
    expect(rows).toHaveLength(3);
    expect(rows[1][5]).toBe(prose);
    expect(rows[1][6]).toBe(lang === "es" ? "Puesto" : "role");
    expect(rows[1][9]).toBe(lang === "es" ? "Desconocido" : "Unknown");
    expect(rows[1][13]).toBe("2026-07-06");
    expect(rows[2][6]).toBe("tamarack_custom");
  });

  it("writes only the selected case rows with localized canonical states and stable date-only values", async () => {
    const blobs = downloads();
    const rows = [
      { id: "one", reference: "TM-1", memberName: prose, title: prose, step: "Step 3", status: "active", deadline: "2026-07-06" },
      { id: "two", reference: "TM-2", memberName: "Tamarack", title: "Filed", step: "Closed", status: "resolved", deadline: "" },
      { id: "three", reference: "TM-3", title: "Authored", step: "Custom phase", status: "custom-status" },
    ];
    const snapshot = structuredClone(rows);
    downloadCaseCsv(rows, CASE_EXPORT_COLUMNS, translate, { prefix: "tamarack" });
    expect(blobs).toHaveLength(1);
    const parsed = writtenRows(await blobs[0].text(), lang, "cases");
    expect(parsed[0]).toEqual(lang === "es" ? ["Referencia", "Trabajador", "Título", "Vence", "Estado"] : ["Reference", "Worker", "Title", "Due", "Status"]);
    expect(parsed.slice(1).map((row) => row[0])).toEqual(["TM-1", "TM-2", "TM-3"]);
    expect(parsed[1]).toEqual(["TM-1", prose, prose, "2026-07-06", lang === "es" ? "Activo" : "active"]);
    expect(parsed[2][3]).toBe("");
    expect(parsed[2][4]).toBe(lang === "es" ? "Resuelto" : "resolved");
    expect(parsed[3][3]).toBe("");
    expect(parsed[3][4]).toBe("custom-status");
    expect(rows).toEqual(snapshot);
  });
});
