// UX-UG-DEVELOPER-AND-MACHINE-TEXT-SHOWN-TO-PEOPLE-20261122 (#9529), unit 2.
// Sentences written for developers were printed where admins and members read:
// "tenant", "allowlisted ... routes or authorization", "kill switch",
// "fail-closed provider route", "auth users", "Stage 0 rows", "docs-only
// handshake", "authorized ingest", "VP", "outside the logged surface". Each
// now says what it means in plain words, in English and Spanish.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { presentAccessHistory } from "../src/features/accessHistory/index.js";
import { presentCatalog } from "../src/features/pay/presenters.js";
import { catalogue } from "../src/lib/i18n.js";

const KEYS = [
  "admin.labels.sub",
  "admin.loginInbox.sub",
  "admin.command.organizationSub",
  "admin.chapterLifecycle.noDocumentHandshake",
  "admin.command.lifecycleRecoveryHelp",
  "admin.command.lifecycleCompassHelp",
  "admin.command.lifecycleRetentionHelp",
  "admin.passwordReissueHelp",
  "admin.compassGovernanceSub",
  "admin.automation.workspaceHelp",
  "memberOperations.imports.note",
  "memberOperations.imports.stage.none",
  "memberOperations.imports.stage.one",
  "memberOperations.imports.stage.many",
  "memberOperations.imports.rowsReady.one",
  "memberOperations.imports.rowsReady.many",
  "memberOperations.imports.staged",
  "memberOperations.imports.empty",
  "memberOperations.imports.committed",
  "pay.catalogEmpty",
  "pay.publisherHelp",
  "pay.publisherRestricted",
  "accessHistory.sub",
  "accessHistory.disclaimer",
  "accessHistory.empty",
];

const DEVELOPER_EN = /tenant|allowlist|routes or authorization|kill switch|fail-closed|auth users|organization database|docs-only|authorized ingest|\bCBA\b|\bVPs?\b|logged surface|bulk desk loads|out-of-band|invented timers|\bstag(e|ed)\b|atomically|attestation|in this window/i;
const DEVELOPER_ES = /cliente\b|etiquetas permitidas|autorizaciones|interruptor de apagado|falla de forma segura|usuarios de autenticación|base organizativa|limitado a documentos|carga autorizada|vicepresidente|superficie registrada|cargas masivas|fuera de la aplicación|inventar plazos|\bprepara(r|da|dos)\b|forma atómica|constancia|en esta ventana/i;

describe("developer phrases shown to people (#9529 unit 2)", () => {
  it("says each helper sentence in plain words, in English and Spanish", () => {
    for (const key of KEYS) {
      const en = catalogue.en[key];
      const es = catalogue.es[key];
      expect(en, `${key} en`).toBeTruthy();
      expect(es, `${key} es`).toBeTruthy();
      expect(es, `${key} es is translated`).not.toBe(en);
      expect(en, key).not.toMatch(DEVELOPER_EN);
      expect(es, key).not.toMatch(DEVELOPER_ES);
    }
  });

  it("names the organization's master switch the way the Automations workspace does", () => {
    expect(catalogue.en["admin.automation.workspaceHelp"]).toContain(catalogue.en["automation.master.switch"].toLowerCase());
    expect(catalogue.es["admin.automation.workspaceHelp"]).toContain(catalogue.es["automation.master.switch"].toLowerCase());
  });

  // The first read (Sol, FAIL 0/1/3/3) found sentences that promised more than
  // the screens do. The Compass lines say what the control records; the
  // retention line names no duration; the sign-in line says what is listed.
  it("promises nothing the screen does not do", () => {
    for (const key of ["admin.command.lifecycleCompassHelp", "admin.compassGovernanceSub"]) {
      expect(catalogue.en[key], key).not.toMatch(/keeps no data|does not learn|privacy promises/i);
      expect(catalogue.es[key], key).not.toMatch(/no guarda datos|aprende|garantías de privacidad/i);
      expect(catalogue.en[key], key).toMatch(/admin's confirmation of how the AI provider handles/);
      expect(catalogue.es[key], key).toMatch(/confirmación de un administrador sobre cómo el proveedor de IA trata/);
    }
    expect(catalogue.en["admin.command.lifecycleRetentionHelp"]).not.toMatch(/how long|days|months|years/i);
    expect(catalogue.es["admin.command.lifecycleRetentionHelp"]).not.toMatch(/cuánto tiempo|días|meses|años/i);
    expect(catalogue.en["admin.loginInbox.sub"]).not.toMatch(/never/i);
    expect(catalogue.es["admin.loginInbox.sub"]).not.toMatch(/nunca/i);
    // The role names are the ones the role switcher shows (demo.hatVp and friends).
    for (const lang of ["en", "es"]) {
      for (const key of ["pay.publisherHelp", "pay.publisherRestricted"]) {
        for (const hat of ["demo.hatAdvisor", "demo.hatAdmin", "demo.hatVp"]) {
          expect(catalogue[lang][key], `${lang} ${key}`).toContain(catalogue[lang][hat]);
        }
      }
    }
  });

  it("explains the access-history limits once, and the empty sentence names the range", () => {
    for (const lang of ["en", "es"]) {
      const sub = catalogue[lang]["accessHistory.sub"];
      const disclaimer = catalogue[lang]["accessHistory.disclaimer"];
      // The intro no longer repeats the footer's sentence about staff lists.
      expect(sub.length, lang).toBeLessThan(disclaimer.length / 2);
      expect(disclaimer, lang).toMatch(/staff list that shows only a summary|lista del personal que solo muestra un resumen/);
    }
    const ranges = {
      30: ["in the last 30 days.", "en los últimos 30 días."],
      90: ["in the last 90 days.", "en los últimos 90 días."],
      365: ["in the last 365 days.", "en los últimos 365 días."],
    };
    for (const [days, [en, es]] of Object.entries(ranges)) {
      expect(presentAccessHistory({ ok: true, events: [], rangeDays: Number(days) }, "en").message).toMatch(new RegExp(`${en.replace(".", "\\.")}$`));
      expect(presentAccessHistory({ ok: true, events: [], rangeDays: Number(days) }, "es").message).toMatch(new RegExp(`${es.replace(".", "\\.")}$`));
    }
    // A range the buttons do not offer falls back to the generic sentence.
    expect(presentAccessHistory({ ok: true, events: [], rangeDays: 7 }, "en").message).toBe(catalogue.en["accessHistory.empty"]);
  });

  it("gives the phone's empty pay-scale sentence the same plain words and a Spanish line", () => {
    const empty = presentCatalog({ ok: true, empty: true });
    expect(empty.message).toBe(catalogue.en["pay.catalogEmpty"]);
    const spanish = JSON.parse(readFileSync(resolve(process.cwd(), "apps/mobile/src/lib/nativeUiSpanish.json"), "utf8"));
    expect(spanish[empty.message]).toBe(catalogue.es["pay.catalogEmpty"]);
    const screen = readFileSync(resolve(process.cwd(), "apps/mobile/src/features/mi1/PayToolsScreen.tsx"), "utf8");
    expect(screen).not.toMatch(/\bVP\b/);
    expect(screen).toContain(`t('${catalogue.en["pay.publisherRestricted"]}')`);
    expect(spanish[catalogue.en["pay.publisherRestricted"]]).toBe(catalogue.es["pay.publisherRestricted"]);
  });
});
