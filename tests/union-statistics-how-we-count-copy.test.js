import { describe, expect, it } from "vitest";
import { t } from "../src/lib/i18n.js";

// BUG-UG-UNION-STATISTICS-REOPENED-OUTCOMES-AND-OWN-RECORD-COPY-20261102 (#6777):
// the note under the Statistics page sits below union-wide panels, so it must
// not say every figure is the member's own.
describe("Statistics how-we-count note", () => {
  it.each([
    // Gate r1s1: a chart is withheld whole, but the chapter table stays and
    // withholds a small chapter's member count and the open-cases column.
    ["en", /your own record/, /union-wide panels/, /count everyone in your union/, /too small to stay anonymous is hidden whole/, /small campaign's worker count, and the open-issues column/],
    ["es", /tu propio historial/, /paneles de todo el sindicato/, /todas las personas de tu sindicato/, /mantener el anonimato se oculta completa/, /los trabajadores de una campaña pequeñ[oa] y la columna de asuntos abiertos/],
  ])("separates the member's own figures from the union-wide ones in %s", (lang, own, panels, everyone, whole, table) => {
    const note = t(lang, "altTakePart.statsHowWeCount");
    for (const pattern of [own, panels, everyone, whole, table]) expect(note).toMatch(pattern);
    expect(note).not.toMatch(/every figure on this page comes from your own record|cada cifra de esta página sale de tu propio historial/);
  });
});
