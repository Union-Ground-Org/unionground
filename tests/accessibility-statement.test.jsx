import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { catalogue } from "../src/lib/i18n.js";
import { LanguageProvider } from "../src/lib/LanguageContext.jsx";
import { LegalView } from "../src/views/LegalView.jsx";
import { PUBLIC_ROUTE_METADATA } from "../src/lib/publicPageMetadata.js";
import { PUBLIC_STATIC_ROUTES } from "../scripts/public-route-metadata.mjs";
import { siblingIdentityIn } from "../scripts/lib/sibling-deny-list.mjs";

// REQ-UG-FORMAL-ACCESSIBILITY-STATEMENT-20261010,
// of 2026-10-10 (option A). The statement is published on its own route in both
// shipped locales and must name the WCAG 2.2 AA target, declare partial
// conformance, name the 2026-09-13 VoiceOver evaluation, list the known
// exception categories and give the channel that already exists. Every sentence
// it publishes is traceable to
// and the September 27 follow-up
// at

const read = (path) => readFileSync(resolve(process.cwd(), path), "utf8");
const STATEMENT_ROUTE = "/accessibility/statement";
const wrap = (lang) => render(
  <LanguageProvider lang={lang}><LegalView page="accessibilityStatement" /></LanguageProvider>,
);
const statementKeys = (locale) => Object.entries(catalogue[locale])
  .filter(([key]) => key.startsWith("legal.accessibilityStatement."));

describe("formal accessibility statement route", () => {
  it("is a public document route with its own metadata, sitemap entry and view", () => {
    expect(Object.keys(PUBLIC_ROUTE_METADATA)).toContain(STATEMENT_ROUTE);
    expect(PUBLIC_ROUTE_METADATA[STATEMENT_ROUTE].path).toBe(STATEMENT_ROUTE);
    expect(PUBLIC_STATIC_ROUTES).toContain(STATEMENT_ROUTE);
    // Union Ground has no public origin, so the sitemap lists no absolute
    // location at all and never a Union Ground one.
    const sitemap = read("public/sitemap.xml");
    expect(sitemap).not.toContain("<loc>");
    expect(sitemap).not.toMatch(/unionground\.net/i);
    expect(siblingIdentityIn(sitemap)).toEqual([]);
    expect(read("src/AppRouter.jsx")).toContain(`"${STATEMENT_ROUTE}": AccessibilityStatementView,`);
  });

  it("is reachable from the accessibility summary and links back to it", () => {
    const legalView = read("src/views/LegalView.jsx");
    expect(legalView).toContain(`["${STATEMENT_ROUTE}", "legal.accessibility.links.statement"]`);
    expect(legalView).toContain('["/accessibility", "legal.accessibilityStatement.links.summary"]');
    wrap("en");
    expect(screen.getByRole("link", { name: "Accessibility summary" })).toHaveAttribute("href", "/accessibility");
  });

  it("publishes every key in both shipped locales", () => {
    const en = statementKeys("en").map(([key]) => key).sort();
    const es = statementKeys("es").map(([key]) => key).sort();
    expect(en.length).toBeGreaterThan(0);
    expect(es).toEqual(en);
    for (const locale of ["en", "es"]) {
      for (const [key, value] of statementKeys(locale)) {
        expect(value, `${locale} ${key}`).toBeTypeOf("string");
        expect(value.trim(), `${locale} ${key} is empty`).not.toBe("");
      }
    }
  });

  // Acceptance 1: the WCAG 2.2 AA target and partial conformance, never a
  // conformance claim.
  it("names the WCAG 2.2 AA target and makes no conformance claim in English", () => {
    wrap("en");
    expect(screen.getByRole("heading", { level: 1, name: "Accessibility statement" })).toBeInTheDocument();
    expect(screen.getByText(/Union Ground targets WCAG 2\.2 level AA\./)).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Conformance status" })).toBeInTheDocument();
    expect(screen.getByText(/Not yet evaluated\. No conformance claim is made for this preview\./)).toBeInTheDocument();
  });

  it("names the WCAG 2.2 AA target and makes no conformance claim in Spanish", () => {
    wrap("es");
    expect(screen.getByRole("heading", { level: 1, name: "Declaración de accesibilidad" })).toBeInTheDocument();
    expect(screen.getByText(/Union Ground tiene como objetivo WCAG 2\.2 nivel AA\./)).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Estado de cumplimiento" })).toBeInTheDocument();
    expect(screen.getByText(/Todavía sin evaluar\. No se afirma ningún nivel de cumplimiento para esta vista previa\./)).toBeInTheDocument();
  });

  it("never claims conformance or an external audit in either locale", () => {
    for (const locale of ["en", "es"]) {
      // Never let this pass because the statement copy is absent.
      expect(statementKeys(locale).length, `${locale} statement copy`).toBeGreaterThan(0);
      for (const [key, value] of statementKeys(locale)) {
        expect(value, `${locale} ${key}`).not.toMatch(/fully conformant|fully conforms|cumple totalmente|totalmente conforme/i);
        expect(value, `${locale} ${key}`).not.toMatch(/\bVPAT\b|certified|certificad/i);
      }
    }
  });

  // Acceptance 2: Union Ground has not been evaluated yet, so the statement
  // says how it will be evaluated, lists no exceptions it has not found, names
  // the whole product as unevaluated, and publishes no accessibility mailbox.
  it("says how the product will be evaluated and that nothing has been evaluated yet", () => {
    wrap("en");
    expect(screen.getByRole("heading", { name: "How it will be evaluated" })).toBeInTheDocument();
    const body = screen.getByText(/Before live accounts open\./);
    expect(body).toHaveTextContent(/VoiceOver on iPhone and TalkBack on Android, on physical devices/);
    expect(body).not.toHaveTextContent(/September 13, 2026|16 defects/);
    expect(screen.getByRole("heading", { name: "Known exceptions" })).toBeInTheDocument();
    expect(screen.getByText(/None recorded yet, because no evaluation has been run\./)).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Not yet evaluated" })).toBeInTheDocument();
    expect(screen.getByText(/The whole product\. No evaluation and no third-party audit has been performed\./)).toBeInTheDocument();

    wrap("es");
    expect(screen.getByRole("heading", { name: "Cómo se evaluará" })).toBeInTheDocument();
    expect(screen.getByText(/Antes de que se abran las cuentas activas\./)).toHaveTextContent(
      /VoiceOver en iPhone y TalkBack en Android, en dispositivos físicos/,
    );
    expect(screen.getByRole("heading", { name: "Excepciones conocidas" })).toBeInTheDocument();
    expect(screen.getByText(/Ninguna registrada todavía, porque no se ha hecho ninguna evaluación\./)).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Todavía sin evaluar" })).toBeInTheDocument();
    expect(screen.getByText(/Todo el producto\. No se ha hecho ninguna evaluación ni ninguna auditoría externa\./)).toBeInTheDocument();
  });

  it("does not claim the web test coverage of an evaluation it has not run, in both languages", () => {
    expect(catalogue.en["legal.accessibilityStatement.scope.body"]).toMatch(/web app, its public pages, and the Union Ground mobile app/);
    expect(catalogue.es["legal.accessibilityStatement.scope.body"]).toMatch(/aplicación web de Union Ground, sus páginas públicas y la aplicación móvil/);
    for (const locale of ["en", "es"]) {
      expect(catalogue[locale]["legal.accessibilityStatement.scope.body"]).not.toMatch(/every change|cada cambio|CI/);
    }
  });

  // Union Ground's Spanish addresses the reader as tú throughout (the
  // glossary in the sync brief), so the statement must never switch to usted.
  it("keeps the reader address in tú in the Spanish statement, never switching to usted", () => {
    const copy = ["feedback.body", "alternative.body"].map((key) => catalogue.es[`legal.accessibilityStatement.${key}`]).join(" ");
    expect(copy).not.toMatch(/\b(?:usted|Usted|Use|use|escriba|elija|Incluya|incluya|Avise|avise|pida|Pida|su|sus|le)\b/);
    expect(copy).toMatch(/\b(?:te|tu)\b/);
  });

  it("gives the contact who provisioned the account and adds no accessibility mailbox", () => {
    wrap("en");
    expect(screen.getByRole("heading", { name: "Report a barrier" })).toBeInTheDocument();
    const feedback = screen.getByText(/Tell the contact who provisioned your account/);
    expect(feedback).toHaveTextContent(/No accessibility or support address is published yet/);
    // The statement renders the one canonical contact (none is published); no
    // address literal may live in its copy, so a mailbox cannot be published
    // from here.
    for (const locale of ["en", "es"]) {
      for (const [key, value] of statementKeys(locale)) {
        expect(value, `${locale} ${key}`).not.toMatch(/@/);
      }
    }
    expect(read("src/views/LegalView.jsx")).toContain(
      'accessibilityStatement: ["legal.contact.supportBody", publicContact("support")],',
    );
    expect(screen.getByText(catalogue.en["legal.contact.none"], { exact: false })).toBeInTheDocument();
    wrap("es");
    expect(screen.getByRole("heading", { name: "Reportar una barrera" })).toBeInTheDocument();
    expect(screen.getByText(/Avísale al contacto que te dio acceso/)).toHaveTextContent(
      /Todavía no se publica ninguna dirección de accesibilidad ni de soporte/i,
    );
  });

  // Acceptance 3: BUG-UG-ACCESSIBILITY-DARK-MODE-CLAIM-20261007. The
  // September 12 owner decision removed the light/dark-mode claim from the
  // published accessibility copy (delivered by). The statement cannot
  // reintroduce it, in either locale, and the summary intro stays claim-free.
  it("does not contradict the retained dark-mode accessibility claim decision", () => {
    const patterns = [/dark mode/i, /light mode/i, /modo oscuro/i, /modos? claros?/i, /modo claro/i];
    for (const locale of ["en", "es"]) {
      expect(statementKeys(locale).length, `${locale} statement copy`).toBeGreaterThan(0);
      for (const [key, value] of statementKeys(locale)) {
        for (const pattern of patterns) {
          expect(value, `${locale} ${key} reintroduces the retired claim`).not.toMatch(pattern);
        }
      }
      for (const pattern of patterns) {
        expect(catalogue[locale]["legal.accessibility.intro"], `${locale} summary intro`).not.toMatch(pattern);
      }
    }
  });

  it("states the review date on the statement rather than calling it a summary", () => {
    wrap("en");
    expect(screen.getByText(/This is the Union Ground preview accessibility statement\./)).toBeInTheDocument();
    expect(screen.queryByText(/plain-language summary of how Union Ground works/)).toBeNull();
    expect(screen.getByText(/Content last reviewed:/)).toBeInTheDocument();
  });
});
