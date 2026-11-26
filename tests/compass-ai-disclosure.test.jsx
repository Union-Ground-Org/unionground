import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { Assistant } from "../src/components/FloatingControls.jsx";
import { LanguageProvider } from "../src/lib/LanguageContext.jsx";
import { catalogue } from "../src/lib/i18n.js";
import { LegalView } from "../src/views/LegalView.jsx";

function wrap(child, lang = "en") {
  return render(<LanguageProvider lang={lang}>{child}</LanguageProvider>);
}

describe("public Compass AI provider disclosure", () => {
  // Union Ground ships with no AI provider configured: the disclosure says
  // so, says nothing is sent, and promises the details before live AI is on.
  it("states that no provider is configured, nothing is sent, and what will be published first, in English", () => {
    wrap(<LegalView page="aiDisclosure" />);
    expect(screen.getByRole("heading", { name: "How the Guide uses AI" })).toBeInTheDocument();
    expect(screen.getByText(/No AI provider is configured for Union Ground in this preview, so no question is sent to one/)).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "AI provider" })).toBeInTheDocument();
    expect(screen.getByText(/None is configured\. Which provider would process a question will be published here before live AI is enabled/)).toBeInTheDocument();
    expect(screen.getByText(/the subprocessor register will name it with a dated notice first/)).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "What is sent" })).toBeInTheDocument();
    expect(screen.getByText(/Nothing is sent to an AI provider in this preview/)).toBeInTheDocument();
    // What a live request includes is still unpublished; what is kept (the
    // optional, default-off training samples) is stated in the same paragraph.
    expect(screen.getByText(/What a live request would include will be published here before live AI is enabled\. Optional training retention/)).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Safeguards" })).toBeInTheDocument();
    expect(screen.getByText(/The safeguards that will apply to a live request will be described here/)).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Backup provider" })).toBeInTheDocument();
    expect(screen.getByText(/No backup AI provider is configured either/)).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Not legal advice" })).toBeInTheDocument();
    expect(screen.getByText(/It does not give legal conclusions/)).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Protect sensitive information" })).toBeInTheDocument();
    expect(screen.getByText(/Do not enter passwords, Social Security numbers, medical details, or coworker lists/)).toBeInTheDocument();
  });

  it("ships the complete disclosure in Spanish and links it from legal navigation", () => {
    wrap(<LegalView page="aiDisclosure" />, "es");
    expect(screen.getByRole("heading", { name: "Cómo usa la IA la Guía" })).toBeInTheDocument();
    expect(screen.getByText(/En esta vista previa no hay ningún proveedor de IA configurado para Union Ground/)).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Proveedor de IA" })).toBeInTheDocument();
    expect(screen.getByText(/No hay ninguno configurado\. Qué proveedor procesaría una pregunta se publicará aquí/)).toBeInTheDocument();
    expect(screen.getByText(/En esta vista previa no se envía nada a ningún proveedor de IA/)).toBeInTheDocument();
    expect(screen.getByText(/Las medidas de protección que se aplicarán a una solicitud en vivo/)).toBeInTheDocument();
    expect(screen.getByText(/Tampoco hay ningún proveedor de IA de respaldo configurado/)).toBeInTheDocument();
    expect(screen.getByText(/No da conclusiones legales/)).toBeInTheDocument();
    expect(screen.getByText(/No escribas contraseñas, números de Seguro Social/)).toBeInTheDocument();
    expect(screen.getAllByRole("link", { name: "Cómo usa la IA la Guía" }).map((link) => link.getAttribute("href"))).toContain("/ai-disclosure");
  });

  it("carries no retired vendor claim in either locale", () => {
    for (const locale of ["en", "es"]) {
      for (const [key, value] of Object.entries(catalogue[locale])) {
        if (!key.startsWith("legal.aiDisclosure.")) continue;
        expect(value, `${locale} ${key}`).not.toMatch(/gemini-3-flash/i);
        expect(value, `${locale} ${key}`).not.toMatch(/Vercel AI Gateway/i);
        expect(value, `${locale} ${key}`).not.toMatch(/Gateway compliance metadata|metadatos de cumplimiento devueltos por Gateway/i);
      }
    }
    expect(catalogue.en["legal.aiDisclosure.route.body"]).not.toMatch(/cannot substitute another gateway or model/);
    expect(catalogue.es["legal.aiDisclosure.route.body"]).not.toMatch(/no puede sustituir/);
  });

  it("carries no vendor-era Gateway wording in Compass admin, Compass or guide copy", () => {
    // UX-UG-COMPASS-ADMIN-ATTESTATION-RETIRED-GATEWAY-COPY-20260920: the
    // attestation covers the current provider route (in-house mesh or agency
    // connector). Placeholders such as {gateway} are field names, not copy.
    for (const locale of ["en", "es"]) {
      for (const [key, value] of Object.entries(catalogue[locale])) {
        if (!/^(admin\.compass|compass\.|guide\.)/.test(key)) continue;
        expect(value.replace(/\{[^}]*\}/g, ""), `${locale} ${key}`).not.toMatch(/\bGateway\b/);
      }
    }
    expect(catalogue.en["admin.compassConfirmZdr"]).toMatch(/exact provider route and model/);
    expect(catalogue.es["admin.compassConfirmZdr"]).toMatch(/ruta del proveedor y el modelo exactos/);
  });

  it("has every disclosure sentence in both catalogues", () => {
    for (const key of [
      "hub.aiDisclosure", "legal.aiDisclosure.title", "legal.aiDisclosure.intro",
      "legal.aiDisclosure.route.title", "legal.aiDisclosure.route.body",
      "legal.aiDisclosure.sent.title", "legal.aiDisclosure.sent.body",
      "legal.aiDisclosure.controls.title", "legal.aiDisclosure.controls.body",
      "legal.aiDisclosure.connector.title", "legal.aiDisclosure.connector.body",
      "legal.aiDisclosure.chapter.title", "legal.aiDisclosure.chapter.body",
      "legal.aiDisclosure.sensitive.title", "legal.aiDisclosure.sensitive.body",
      "compass.providerDisclosure",
    ]) {
      expect(catalogue.en[key], `missing en: ${key}`).toBeTruthy();
      expect(catalogue.es[key], `missing es: ${key}`).toBeTruthy();
    }
  });

  it("keeps the disclosure link beside the safety notice in fresh and active conversations", () => {
    const props = { onClose: vi.fn(), onSend: vi.fn(), threads: [] };
    const { rerender } = wrap(<Assistant {...props} />);
    expect(screen.getByText(catalogue.en["guide.safetyNotice"])).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "How the Guide uses AI" })).toHaveAttribute("href", "/ai-disclosure");

    rerender(
      <LanguageProvider lang="en">
        <Assistant {...props} threads={[{ id: "t1", title: "Active", messages: [{ id: "m1", role: "user", body: "Question" }] }]} />
      </LanguageProvider>,
    );
    expect(screen.getByText(catalogue.en["guide.safetyNotice"])).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "How the Guide uses AI" })).toBeInTheDocument();
  });
});
