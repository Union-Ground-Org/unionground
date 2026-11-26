import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { organizationAdminStrings as organizationAdminCatalogue } from "../src/lib/i18n/locales/en/organizationAdmin.js";
import { organizationAdminStrings as organizationAdminCatalogueSpanish } from "../src/lib/i18n/locales/es/organizationAdmin.js";

// UX-UG-NOTICE-OPENS-MESSAGES-UNSELECTED-AND-READ-UNCLEAR-20261111:
// a Home notice opened Messages with nothing selected, and the copy about how
// a notice counts as read disagreed with what web and phone offer.
const source = (path) => readFileSync(new URL(path, import.meta.url), "utf8");

describe("how a notice counts as read says the same thing everywhere", () => {
  it("tells officers that opening counts as read and that Home and the phone offer Mark read", () => {
    expect(organizationAdminCatalogue["notices.sub"]).toBe(
      "Workers see it under Announcements. Opening it there counts as read, and their Home card and the phone app also offer Mark read. You see how many have read it, and who.",
    );
    expect(organizationAdminCatalogueSpanish["notices.sub"]).toBe(
      "Los trabajadores lo ven en Comunicados. Abrirlo ahí cuenta como leído, y su tarjeta de Inicio y la app del teléfono también ofrecen Marcar como leído. Tú ves cuántos lo leyeron y quiénes.",
    );
    for (const text of [organizationAdminCatalogue["notices.wearToPost"], organizationAdminCatalogueSpanish["notices.wearToPost"]]) {
      expect(text).not.toMatch(/mark as read|marcan como leídos/);
    }
  });

  it("the phone's Mark read controls the copy names are real", () => {
    const takeover = source("../apps/mobile/src/features/home/HomeTakeoverCards.tsx");
    expect(takeover).toContain('label="Mark read"');
    expect(source("../src/features/memberHome/HomeTakeover.jsx")).toContain('t("homeTakeover.markRead")');
  });

});
