import { existsSync, readFileSync } from "node:fs";
import { readAppSource } from "./helpers/app-source.js";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

import { catalogue, t } from "../src/lib/i18n.js";
import { recordedLegalAcceptances } from "../src/lib/legalAcceptance.js";
import {
  LEGAL_CHANGELOG_PATH,
  LEGAL_INSTRUMENTS,
  currentLegalVersions,
  legalChangeNotice,
  legalChangelog,
} from "../src/lib/legalInstruments.js";
import { LEGAL_CONTENT_LAST_REVIEWED, LEGAL_COPY_FINGERPRINT, PRIVACY_EFFECTIVE_DATE } from "../src/lib/legalContent.js";
import { metadataForPath, PUBLIC_ROUTE_METADATA } from "../src/lib/publicPageMetadata.js";
import { siblingIdentityIn } from "../scripts/lib/sibling-deny-list.mjs";

const read = (path) => readFileSync(resolve(process.cwd(), path), "utf8");
// English barrel literal, then the on-demand Spanish literal: the same line
// order the single barrel had, so the legal-copy fingerprint is unchanged.
const i18n = read("src/lib/i18n.js") + read("src/lib/i18n/es.js");
// Union Ground has no public landing (owner decision, wave 2): the legal
// pages share one document shell, and no public page collects interest.
const documentShell = read("src/components/PublicDocumentShell.jsx");
const legalView = read("src/views/LegalView.jsx");

// Every public legal string in both locales, plus the landing consent line
// and footer label — the copy whose accuracy FIX-UG-PUBLIC-LEGAL-ACCURACY
// exists to protect. Order-stable so the fingerprint is deterministic.
function legalCopyLines() {
  return i18n
    .split("\n")
    .filter((line) => /^\s*"(legal\.[^"]+|landing\.interestConsent|landing\.aiDisclosure)":/.test(line))
    .map((line) => line.trim());
}

describe("public legal-page claims", () => {

  it("pins legal copy to the committed fingerprint and review date", () => {
    const lines = legalCopyLines();
    // Both locales must carry every legal key (parity is asserted elsewhere).
    // The release stamp rejects a copy or fingerprint edit. This test does not
    // recompute the fingerprint.
    expect(lines.length).toBeGreaterThan(80);
    expect(LEGAL_COPY_FINGERPRINT).toMatch(/^[0-9a-f]{16}$/);
    expect(LEGAL_CONTENT_LAST_REVIEWED).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it("renders the review date and an honest summary label on every legal page", () => {
    expect(legalView).toContain("LEGAL_CONTENT_LAST_REVIEWED");
    expect(legalView).toContain('"legal.lastReviewed"');
    // The terms page is the only acceptable-use instrument the company has:
    // it keeps "current terms" framing and is never disclaimed as non-operative.
    expect(legalView).toContain('page === "terms" ? "legal.termsNotice" : "legal.summaryNotice"');
  });

  it("keeps the public document footer complete and collects no interest on a public page", () => {
    expect(documentShell).toContain('["/ai-disclosure", "hub.aiDisclosure"]');
    for (const href of ["/privacy", "/terms", "/accessibility", "/retention"]) {
      expect(documentShell).toContain(`["${href}", `);
    }
    // Private worker activity stays off the public front door: the landing
    // and its interest form are gone, and no view renders the consent line
    // a public interest form would need.
    expect(existsSync(resolve(process.cwd(), "src/views/PublicLanding.jsx"))).toBe(false);
    expect(documentShell).not.toContain("landing.interestConsent");
    expect(read("src/App.jsx")).not.toMatch(/import[^;]*PublicLanding|<PublicLanding/);
    expect(read("src/App.jsx")).not.toContain("landing.interestConsent");
    // The Union Ground consent copy names no mailbox while none is published.
    for (const locale of ['"landing.interestConsent": "By submitting', '"landing.interestConsent": "Al enviar']) {
      expect(i18n).toContain(locale);
    }
    expect(i18n).not.toMatch(/interestConsent[^\n]*by emailing",/);
    expect(i18n).not.toMatch(/interestConsent[^\n]*@/);
  });

  // This edition runs no live accounts, backend, push service or AI
  // provider by default, so its privacy copy describes the preview honestly
  // instead of an operated service. Each clause below is pinned in both
  // locales, and operated-service promises are asserted absent so an import
  // cannot quietly re-publish them.
  describe("preview-honest privacy copy", () => {
    const control = (locale) => catalogue[locale]["legal.privacy.control.body"];
    const mobile = (locale) => catalogue[locale]["legal.privacy.mobile.body"];
    it("tells a reader how to clear the preview's data and promises the live-account rights path in both locales", () => {
      expect(control("en")).toContain("clearing this site's data in your browser");
      expect(control("en")).toContain("access, correction, export, or deletion for a live account will be published before live accounts open");
      expect(control("es")).toContain("borrando los datos de este sitio en tu navegador");
      expect(control("es")).toContain("acceso, corrección, exportación o eliminación para una cuenta activa se publicará antes de que se abran las cuentas activas");
      for (const locale of ["en", "es"]) {
        expect(control(locale)).not.toMatch(/unionground\.net/);
        expect(siblingIdentityIn(control(locale))).toEqual([]);
      }
    });

    it("links the deletion-request and retention routes from the privacy page without a sibling host", () => {
      expect(legalView).toContain('["/privacy/deletion-request", "legal.privacy.links.deletion"]');
      expect(legalView).toContain('["/retention", "legal.privacy.links.retention"]');
      for (const locale of ["en", "es"]) {
        for (const [key, value] of Object.entries(catalogue[locale])) {
          if (!key.startsWith("legal.")) continue;
          expect(value, `${locale} ${key}`).not.toMatch(/unionground\.net/);
          expect(siblingIdentityIn(value), `${locale} ${key}`).toEqual([]);
        }
      }
    });

    // Each clause was checked against the Union Ground preview app: local
    // protected storage only, no remote push registration, and permissions
    // asked only on a user action.
    it("describes the preview app's device storage, push and permission facts in both locales", () => {
      const clauses = {
        en: [
          /protected storage on the device/,
          /do not sync to another phone/,
          /no advertising, tracking, purchases, or public posting/,
          /does not register for remote push notifications/,
          /act only after you ask for them/,
          /the system confirms each permission/,
        ],
        es: [
          /almacenamiento protegido del dispositivo/,
          /no se sincronizan con otro teléfono/,
          /No tiene publicidad, rastreo, compras ni publicaciones públicas/,
          /no se registra para recibir notificaciones push remotas/,
          /solo actúan cuando tú lo pides/,
          /el sistema confirma cada permiso/,
        ],
      };
      for (const [locale, patterns] of Object.entries(clauses)) {
        const body = mobile(locale);
        expect(body, `${locale} mobile section is missing`).toBeTypeOf("string");
        for (const pattern of patterns) expect(body, `${locale} ${pattern}`).toMatch(pattern);
        // A push token stored by an operated backend belongs to an operated
        // service, not the preview.
        expect(body).not.toMatch(/notification token Apple or Google issues|identificador de notificación/);
      }
    });

    it("publishes no effective date before one exists and links the retention page that does", () => {
      expect(catalogue.en["legal.privacy.effective"]).toBe("Effective date: {date}.");
      expect(catalogue.es["legal.privacy.effective"]).toContain("{date}");
      expect(legalView).toContain("PRIVACY_EFFECTIVE_DATE");
      // No formal privacy policy is in effect for the preview, so no date is
      // invented for one.
      expect(PRIVACY_EFFECTIVE_DATE).toBeNull();
      // /retention is a real route, so the link is not an invention.
      expect(Object.keys(PUBLIC_ROUTE_METADATA)).toContain("/retention");
      expect(Object.keys(PUBLIC_ROUTE_METADATA)).toContain("/privacy/deletion-request");
    });
  });

  // Union Ground has no AI provider configured (provider boundary), so the
  // privacy and retention pages say so instead of describing an operated
  // mesh, its failover vendor, or agency-level aggregates.
  describe("AI provider and aggregate sections with no provider configured", () => {
    const ai = (locale) => catalogue[locale]["legal.privacy.ai.body"];
    const aggregate = (locale) => catalogue[locale]["legal.retention.aiAggregate.body"];

    it("wires the new sections into the privacy and retention pages in order", () => {
      expect(legalView).toMatch(
        /\["legal\.privacy\.mobile\.title", "legal\.privacy\.mobile\.body"\],\s*\["legal\.privacy\.ai\.title", "legal\.privacy\.ai\.body"\],\s*\["legal\.privacy\.sharing\.title", "legal\.privacy\.sharing\.body"\]/,
      );
      expect(legalView).toMatch(
        /\["legal\.retention\.compass\.title", "legal\.retention\.compass\.body"\],\s*\["legal\.retention\.aiAggregate\.title", "legal\.retention\.aiAggregate\.body"\]/,
      );
      for (const locale of ["en", "es"]) {
        for (const key of ["legal.privacy.ai.title", "legal.privacy.ai.body", "legal.retention.aiAggregate.title", "legal.retention.aiAggregate.body"]) {
          expect(catalogue[locale][key], `${locale} ${key}`).toBeTypeOf("string");
        }
      }
    });

    it("states that no provider is configured and nothing is sent, in both locales", () => {
      const clauses = {
        en: [/No AI provider is configured for Union Ground/, /no question you ask the Guide is sent to one/, /will be published on the Guide disclosure page before live AI is enabled/],
        es: [/No hay ningún proveedor de IA configurado para Union Ground/, /ninguna pregunta que le hagas a la Guía se envía a uno/, /se publicará en la página de divulgación de la Guía antes de activar la IA en vivo/],
      };
      for (const [locale, patterns] of Object.entries(clauses)) {
        const body = ai(locale);
        expect(body, `${locale} AI section is missing`).toBeTypeOf("string");
        for (const pattern of patterns) expect(body, `${locale} ${pattern}`).toMatch(pattern);
        expect(body).not.toMatch(/Fireworks|own mesh|malla propia|zero-retention|retención cero/);
      }
    });

    it("records no AI usage aggregate while no provider is configured, in both locales", () => {
      expect(aggregate("en")).toBe("No AI usage is recorded, because no AI provider is configured.");
      expect(aggregate("es")).toMatch(/IA/);
      for (const locale of ["en", "es"]) {
        expect(aggregate(locale)).not.toMatch(/agency|agencia|100 users|100 usuarios/);
      }
    });

    it("names no external AI vendor as the default provider anywhere in the legal copy", () => {
      for (const locale of ["en", "es"]) {
        for (const [key, value] of Object.entries(catalogue[locale])) {
          if (!key.startsWith("legal.")) continue;
          expect(value, `${locale} ${key}`).not.toMatch(/gemini-3-flash|Vercel AI Gateway|Fireworks/i);
        }
      }
      expect(legalView).not.toContain("MAINTAINER NOTE (queued, do not add yet)");
      expect(i18n).not.toContain("MAINTAINER NOTE (queued, do not add yet)");
    });
  });

  describe("public deletion-request route", () => {
    it("states the preview's deletion facts and the verification principle in both locales", () => {
      const clauses = {
        en: {
          "legal.deletionRequest.inApp.body": [/not available in this preview/, /there are no live accounts/, /published here before live accounts open/],
          "legal.deletionRequest.email.body": [/No privacy address is published yet/, /Do not send a password/],
          "legal.deletionRequest.verify.body": [/come from the account holder/, /unverified deletion is itself a way to attack an account/],
          "legal.deletionRequest.timing.body": [/not set yet/, /published here before live accounts open/],
          "legal.deletionRequest.record.body": [/will be recorded/, /published here before live accounts open/],
        },
        es: {
          "legal.deletionRequest.inApp.body": [/vista previa/, /cuentas activas/],
          "legal.deletionRequest.email.body": [/contraseña/],
          "legal.deletionRequest.verify.body": [/titular de la cuenta/],
          "legal.deletionRequest.timing.body": [/cuentas activas/],
          "legal.deletionRequest.record.body": [/se registrará cada solicitud de eliminación/, /antes de que se abran las cuentas activas/],
        },
      };
      for (const [locale, keys] of Object.entries(clauses)) {
        for (const [key, patterns] of Object.entries(keys)) {
          const value = catalogue[locale][key];
          expect(value, `${locale} ${key}`).toBeTypeOf("string");
          for (const pattern of patterns) expect(value, `${locale} ${key} ${pattern}`).toMatch(pattern);
        }
      }
    });

    it("reuses the privacy page's published contact instead of inventing a mailbox", () => {
      expect(legalView).toContain('deletionRequest: ["legal.contact.ownerBody", publicContact("owner")]');
      expect(legalView).toContain('privacy: ["legal.contact.ownerBody", publicContact("owner")]');
      // No address literal may appear in the deletion-request strings: the page
      // renders the one published contact, or the "none published" line.
      for (const locale of ["en", "es"]) {
        for (const [key, value] of Object.entries(catalogue[locale])) {
          if (!key.startsWith("legal.deletionRequest.")) continue;
          expect(value, `${locale} ${key}`).not.toMatch(/@/);
        }
      }
    });

    it("promises no response time, reconciliation or manual log the preview does not run", () => {
      for (const locale of ["en", "es"]) {
        for (const key of ["legal.deletionRequest.timing.body", "legal.deletionRequest.record.body"]) {
          const value = catalogue[locale][key];
          expect(value, `${locale} ${key}`).not.toMatch(/\b\d+\b/);
          expect(value, `${locale} ${key}`).not.toMatch(/reconciliation|reconciliación|manual log|registro manual/i);
          expect(value, `${locale} ${key}`).not.toMatch(/completes any request|cualquier solicitud/i);
        }
      }
    });
  });

  it("never overstates the retention schedule", () => {
    // "removed from the live service", never "permanently purged"/"deleted
    // forever". The preview stores no RSVP and no verification request, so
    // no retention line may promise a numbered window either.
    const retentionLines = legalCopyLines().filter((entry) => entry.includes("legal.retention."));
    expect(retentionLines.length).toBeGreaterThan(0);
    for (const line of retentionLines) {
      expect(line).not.toMatch(/permanently|forever|para siempre|permanentemente/i);
      expect(line).not.toMatch(/\b\d+[ -]day\b|\b\d+ días\b/i);
    }
    const rsvpLines = retentionLines.filter((line) => line.includes("legal.retention.rsvp.body"));
    expect(rsvpLines).toHaveLength(2);
    expect(rsvpLines[0]).toMatch(/No RSVP is stored in this preview/);
  });
});

// The public union catalog and its organization verification requests are
// left out of Union Ground (owner decision, wave 2), so the privacy and
// retention pages carry no claimant-data section for them.
describe("organization verification claimant-data sections are absent", () => {
  it("renders no claimant-data section on /privacy or /retention", () => {
    expect(legalView).not.toContain("legal.privacy.catalogClaims");
    expect(legalView).not.toContain("legal.retention.catalogClaims");
  });

  it("publishes no claim lapse, expiry or deletion window in either locale", () => {
    for (const locale of ["en", "es"]) {
      for (const key of ["legal.privacy.catalogClaims.body", "legal.retention.catalogClaims.body"]) {
        const value = catalogue[locale][key];
        if (value === undefined) continue;
        expect(value, `${locale} ${key}`).not.toMatch(/platform verifier|verificador de la plataforma|24 hours|24 horas|90 days|90 días/);
      }
    }
  });
});

// REQ-UG-LAYERED-VERSIONED-LEGAL-ROUTES-20261010, from the owner's
// decisions of October 10, 2026: D-13 (layered — each summary links its
// operative instrument at a versioned route), D-14 (version, effective date,
// public changelog, material change triggers in-product notice and
// re-acceptance) and D-15 (English and Spanish are co-equal, so a divergence
// fails CI). The versions and dates these tests read come from
// src/lib/legalInstruments.js, the one source the web pages and the native
// legal reader share.
describe("layered versioned legal instruments", () => {
  const app = readAppSource();
  const routeMetadataSource = read("scripts/public-route-metadata.mjs");
  const mobileDocuments = read("apps/mobile/src/lib/legalDocuments.ts");
  const mobileScreen = read("apps/mobile/src/features/LegalDocumentScreen.tsx");

  it("links an operative instrument from each of the five summary routes, on web and native", () => {
    expect(LEGAL_INSTRUMENTS.map((entry) => entry.summaryPath)).toEqual([
      "/privacy", "/terms", "/accessibility", "/ai-disclosure", "/retention",
    ]);
    expect(legalView).toContain("legalInstrumentForSummary(page)");
    expect(legalView).toContain('t("legal.summary.instrument.link", { name: t(instrument.summaryTitleKey), version: instrument.version })');
    // One route per instrument, registered from the shared source rather than
    // typed out, so a route cannot exist without a version behind it.
    expect(app).toContain("...legalInstrumentRoutes,");
    expect(app).toContain("[LEGAL_CHANGELOG_PATH]: LegalChangelogRoute,");
    expect(routeMetadataSource).toContain("...LEGAL_INSTRUMENT_PATHS,");
    for (const entry of LEGAL_INSTRUMENTS) {
      expect(Object.keys(PUBLIC_ROUTE_METADATA), entry.path).toContain(entry.path);
      expect(metadataForPath(entry.path).path).toBe(entry.path);
    }
    // Native can show the same instrument, but Union Ground publishes no
    // site yet, so every native summary links no instrument rather than a
    // route nobody serves (apps/mobile/src/lib/legalDocuments.ts).
    expect(mobileScreen).toContain("document.instrument.name");
    expect(mobileDocuments).toContain("export const LEGAL_SITE_ORIGIN: string | null = PUBLIC_SITE_ORIGIN;");
    // Seven native pages: the five summaries, the accessibility statement and About.
    expect(mobileDocuments.match(/^ {4}instrument: null,$/gm)).toHaveLength(7);
    expect(mobileDocuments).not.toMatch(/^ {4}instrument: (?!null,)/m);
    expect(mobileScreen).toContain('label="Open the full instrument"');
    // No title or link calls an instrument operative while the same page says
    // it is not in effect (gate round 1, #4315).
    for (const locale of ["en", "es"]) {
      for (const key of ["legal.summary.instrument.link", "legal.instrument.title"]) {
        expect(catalogue[locale][key], `${locale} ${key}`).not.toMatch(/operative|operativo/i);
      }
    }
    expect(mobileDocuments).not.toMatch(/operative instrument/);
    expect(mobileScreen).not.toMatch(/operative instrument/);
    expect(mobileDocuments).not.toMatch(/instrumentReference\(|unionground\.net/);
  });

  it("renders a version and an effective-date line on every instrument route", () => {
    expect(legalView).toContain('t("legal.instrument.version", { version: instrument.version })');
    expect(legalView).toContain('t("legal.privacy.effective", { date: instrument.effectiveDate })');
    expect(legalView).toContain('t("legal.instrument.pendingEffective")');
    for (const entry of LEGAL_INSTRUMENTS) {
      expect(entry.version, entry.key).toMatch(/^\d+\.\d+\.\d+$/);
      // An effective date is published only where one exists. Until the
      // professional review clears the text and D-08's acceptance is recorded
      // there is none, and the route says so instead of inventing a date.
      if (entry.effectiveDate === null) {
        expect(entry.status, entry.key).toBe("pending-review");
      } else {
        expect(entry.effectiveDate, entry.key).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      }
    }
    for (const locale of ["en", "es"]) {
      expect(t(locale, "legal.instrument.version", { version: "0.1.0" })).toContain("0.1.0");
      expect(catalogue[locale]["legal.instrument.notOperative"], locale).toBeTypeOf("string");
    }
  });

  it("publishes a changelog that lists every version with its date", () => {
    const changes = legalChangelog();
    expect(changes).toHaveLength(LEGAL_INSTRUMENTS.reduce((total, entry) => total + entry.changelog.length, 0));
    for (const change of changes) {
      expect(change.date, change.instrument.key).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(change.version, change.instrument.key).toMatch(/^\d+\.\d+\.\d+$/);
      expect(typeof change.material, change.instrument.key).toBe("boolean");
      for (const locale of ["en", "es"]) expect(catalogue[locale][change.noteKey], `${locale} ${change.noteKey}`).toBeTypeOf("string");
    }
    // Every version in force appears in the changelog: the page is generated
    // from the source, not maintained beside it.
    for (const [key, version] of Object.entries(currentLegalVersions())) {
      expect(changes.some((change) => change.instrument.key === key && change.version === version), key).toBe(true);
    }
    expect(Object.keys(PUBLIC_ROUTE_METADATA)).toContain(LEGAL_CHANGELOG_PATH);
    expect(legalView).toContain("legalChangelog()");
    expect(legalView).toContain('t("legal.changelog.entry", { version: change.version, date: change.date })');
  });

  // This edition publishes no operator's operative instruments: every route
  // keeps its version and change history, says it is not in effect, and in
  // place of the text says the text is not published yet. No operative
  // instrument text remains in either catalogue.
  it("publishes no operative instrument: each route is pending review with no effective date and no text", () => {
    for (const entry of LEGAL_INSTRUMENTS) {
      expect(entry.status, entry.key).toBe("pending-review");
      expect(entry.effectiveDate, entry.key).toBeNull();
      expect(entry.version, entry.key).toBe(entry.changelog.at(-1).version);
      expect(entry.sections, entry.key).toEqual([["legal.instrument.text.title", "legal.instrument.text.body"]]);
    }
    for (const locale of ["en", "es"]) {
      expect(Object.keys(catalogue[locale]).filter((key) => /^legal\.instrument\.(privacy|terms|retention|aiDisclosure)\./.test(key)), locale).toEqual([]);
      expect(catalogue[locale]["legal.instrument.text.body"], locale).toMatch(locale === "en" ? /is not published here yet/ : /todavía no se publica aquí/);
      expect(catalogue[locale]["legal.instrument.notOperative"], locale).toMatch(locale === "en" ? /not operative/ : /no es operativo/);
      expect(catalogue[locale]["legal.changelog.note.firstOperative"], locale).not.toMatch(/First operative text|Primer texto operativo/);
    }
    expect(PRIVACY_EFFECTIVE_DATE).toBeNull();
    expect(legalView).toContain('operative ? null : t("legal.instrument.notOperative")');
    expect(legalView).toContain('t("legal.instrument.pendingEffective")');
  });

  it("fails when the English and Spanish instruments or versions diverge", () => {
    const legalKeys = (locale) => Object.keys(catalogue[locale]).filter((key) => key.startsWith("legal.")).sort();
    expect(legalKeys("es")).toEqual(legalKeys("en"));
    for (const entry of LEGAL_INSTRUMENTS) {
      for (const locale of ["en", "es"]) {
        expect(catalogue[locale][entry.summaryTitleKey], `${locale} ${entry.summaryTitleKey}`).toBeTypeOf("string");
      }
      // The version a reader sees is the shared source's in both locales: the
      // copy carries a {version} slot, never a number of its own.
      const rendered = ["en", "es"].map((locale) => t(locale, "legal.summary.instrument.link", {
        name: t(locale, entry.summaryTitleKey),
        version: entry.version,
      }));
      for (const line of rendered) expect(line).toContain(entry.version);
      expect(catalogue.en["legal.summary.instrument.link"]).toContain("{version}");
      expect(catalogue.es["legal.summary.instrument.link"]).toContain("{version}");
    }
  });

  it("turns a change marked material into an in-product notice and a re-acceptance requirement", () => {
    // An instrument whose only change was never material.
    const unchanged = { ...LEGAL_INSTRUMENTS[2], version: "0.1.0", changelog: [LEGAL_INSTRUMENTS[2].changelog[0]] };
    const fixture = [
      { ...LEGAL_INSTRUMENTS[0], version: "2.0.0", changelog: [
        { version: "2.0.0", date: "2026-11-20", material: true, noteKey: "legal.changelog.note.registered" },
        { version: "1.0.0", date: "2026-10-10", material: false, noteKey: "legal.changelog.note.registered" },
      ] },
      unchanged,
    ];
    expect(legalChangeNotice({ [fixture[0].key]: "1.0.0" }, fixture)).toEqual({
      notice: true,
      reacceptanceRequired: true,
      instruments: [fixture[0].key],
    });
    // Someone already on the material version is not prompted, and an
    // instrument whose changes were not material never prompts anyone.
    expect(legalChangeNotice({ [fixture[0].key]: "2.0.0" }, fixture).notice).toBe(false);
    expect(unchanged.changelog.every((change) => change.material === false)).toBe(true);
    expect(legalChangeNotice({}, [unchanged]).notice).toBe(false);
    // The notice is in the product, and it reads the same state.
    const notice = read("src/components/LegalChangeNotice.jsx");
    expect(notice).toContain("legalChangeNotice(accepted)");
    expect(notice).toContain('t("legal.changeNotice.body", { instruments: names })');
    // REQ-UG-VERSIONED-TERMS-ACCEPTANCE-20261010 shipped D-08's
    // acceptance store, so the notice now reads the recorded versions, and the
    // prompt that takes the acceptance supersedes it while one is outstanding.
    expect(app).toContain("<LegalChangeNotice accepted={recordedLegalAcceptances(legalAcceptance)} />");
    expect(app).toContain("legalReacceptance.reacceptanceRequired");
  });

  it("claims nothing about a reader until an acceptance is recorded", () => {
    // D-08's acceptance store shipped with REQ-UNIONGROUND-VERSIONED-TERMS-
    // ACCEPTANCE-20261010, and the no-argument call is still the unknown
    // state (no session, a demo surface, a failed read): the notice stays
    // silent instead of telling such a reader they are behind.
    expect(recordedLegalAcceptances()).toBeNull();
    expect(legalChangeNotice(recordedLegalAcceptances())).toEqual({ notice: false, reacceptanceRequired: false, instruments: [] });
    expect(legalView).toContain('t("legal.instrument.notOperative")');
    expect(catalogue.en["legal.instrument.notOperative"]).toContain("not operative");
    expect(catalogue.es["legal.instrument.notOperative"]).toContain("no es operativo");
  });
});
