import React from "react";
import { readFileSync } from "node:fs";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { LanguageProvider } from "../src/lib/LanguageContext.jsx";
import { catalogue } from "../src/lib/i18n.js";
import { TelemetryDisclosureView } from "../src/views/TelemetryDisclosureView.jsx";
import { AI_DISCLOSURE_CLAIMS, renderTelemetryMarkdown, telemetry } from "../src/lib/telemetryDisclosure.js";
import {
  collectTelemetrySources, publishedTelemetrySources, readStagedTelemetryPins, readStagedTelemetryWriters, readTelemetrySources, telemetrySourcePin,
  telemetryWriterFailures,
} from "../scripts/lib/telemetry-disclosure-sources.mjs";

describe("telemetry and AI disclosure", () => {
  it("falls back to English for the entire inventory and AI copy", () => {
    const html = renderToStaticMarkup(<LanguageProvider lang="fr"><TelemetryDisclosureView /></LanguageProvider>);
    const text = new DOMParser().parseFromString(html, "text/html").body.textContent;
    expect(text).toContain(telemetry.copy.en.title);
    expect(text).toContain(telemetry.copy.en.attribution);
    expect(text).toContain(telemetry.copy.en.diagnostics);
    for (const row of telemetry.storage) expect(text).toContain(row.purpose.en);
    for (const row of telemetry.cookies) expect(text).toContain(row.purpose?.en || telemetry.copy.en.cookiePurpose);
    expect(text).toContain(catalogue.en["legal.aiDisclosure.sent.body"]);
    expect(text).not.toContain("telemetry.");
  });
  it.each(["en", "es"])("publishes the storage inventory and exact AI claims in %s", (lang) => {
    const html = renderToStaticMarkup(<LanguageProvider lang={lang}><TelemetryDisclosureView /></LanguageProvider>);
    for (const vendor of telemetry.vendors) expect(html).toContain(vendor);
    for (const row of telemetry.storage) {
      for (const key of row.keys) expect(html).toContain(key);
      expect(html).toContain(row.purpose[lang]);
    }
    for (const row of telemetry.cookies) expect(html).toContain(row.key);
    // Decode through the DOM because React escapes apostrophes and ampersands.
    const document = new DOMParser().parseFromString(html, "text/html");
    for (const key of ["sent", "controls", "connector"]) {
      expect(document.body.textContent).toContain(catalogue[lang][`legal.aiDisclosure.${key}.body`]);
    }
    expect(document.body.textContent).toContain(telemetry.copy[lang].attribution);
    expect(document.body.textContent).toContain(telemetry.copy[lang].diagnostics);
    expect(html).toContain('href="/subprocessors"');
    expect(telemetry.copy[lang].attribution).not.toMatch(/never retained|never trained|nunca se conservan|nunca se entrenan/i);
  });
  it("pins the complete storage-writer set, key constructors, SDKs and enabled vendor configuration", () => {
    const retained = readTelemetrySources();
    const collected = collectTelemetrySources();
    const staged = readStagedTelemetryWriters();
    // Pending declarations may also stage SDK and configuration pins for the next release.
    const stagedPins = readStagedTelemetryPins();
    expect(publishedTelemetrySources(collected, staged, retained, stagedPins)).toEqual(retained);
    expect(telemetryWriterFailures(collected, retained, staged)).toEqual([]);
    const calls = ["localStorage.setItem(\"chart\", \"1\")"];
    const extra = {
      ...collected,
      browserWrites: { ...collected.browserWrites, "src/lib/chartCache.js": calls },
    };
    const pin = telemetrySourcePin(calls);
    const stagedWriter = { source: "src/lib/chartCache.js", pin, release: "next" };
    expect(publishedTelemetrySources(extra, [...staged, stagedWriter], retained, stagedPins)).toEqual(retained);
    expect(telemetryWriterFailures(extra, retained, [...staged, stagedWriter])).toEqual([]);
    expect(telemetryWriterFailures(extra, retained, staged)).toEqual(["src/lib/chartCache.js"]);
    // A new cookie writer is staged the same way, as a cookie writer (ledger 749).
    const cookieCalls = ["response.setHeader(\"Set-Cookie\", connectCookie(binding))"];
    const cookieExtra = { ...collected, cookieWrites: { ...collected.cookieWrites, "api/connect.js": cookieCalls } };
    const stagedCookie = { kind: "cookie", source: "api/connect.js", pin: telemetrySourcePin(cookieCalls), release: "next" };
    expect(publishedTelemetrySources(cookieExtra, [...staged, stagedCookie], retained, stagedPins)).toEqual(retained);
    expect(telemetryWriterFailures(cookieExtra, retained, [...staged, stagedCookie])).toEqual([]);
    expect(telemetryWriterFailures(cookieExtra, retained, staged)).toEqual(["api/connect.js"]);
    const sources = new Set(telemetry.storage.flatMap((row) => row.sources));
    for (const writer of Object.keys(retained.browserWrites)) expect(sources.has(writer), writer).toBe(true);
    expect(telemetry.vendors).toEqual(["Sentry", "PostHog", "Cloudflare"]);
    // Babel parses every src/ and api/ module and hashes the pinned SDK files;
    // on a cold checkout that exceeds the default budget. The bound is
    // headroom for the I/O, not a reduction in what the pin compares.
  }, 60_000);
  it("covers IndexedDB and service-worker storage, and pins key constants the heuristics miss", () => {
    const retained = readTelemetrySources();
    expect(retained.browserWrites["src/lib/outbox.js"]).toEqual(["idb.open(DB_NAME, DB_VERSION)"]);
    expect(Object.keys(retained.config)).toEqual(expect.arrayContaining(["src/lib/nativeAppNudge.js", "public/sw.js"]));
    expect(telemetry.storage.find((row) => row.id === "offline")).toMatchObject({ storage: "IndexedDB", keys: ["sg-outbox"] });
    expect(telemetry.storage.find((row) => row.id === "offline-assets")).toMatchObject({ storage: "Cache Storage" });
    expect(telemetry.copy.en.diagnostics).toContain("Sentry error monitoring is off unless the operator sets a Sentry DSN");
    expect(telemetry.copy.en.diagnostics).toContain("PostHog error reporting can also run independently");
    expect(telemetry.copy.en.diagnostics).toContain("fixed diagnostics identity, with person profiles and geolocation disabled");
    expect(telemetry.copy.en.diagnostics).toContain("Account and worker identifiers, request data, URLs, free text, breadcrumbs, screen and device details and attachments are discarded");
    expect(telemetry.copy.en.diagnostics).toContain("native crash forwarding are disabled");
    expect(telemetry.copy.en.diagnostics).not.toContain("internal account identifier");
    expect(telemetry.copy.es.diagnostics).toContain("salvo que el operador configure un DSN de Sentry");
    expect(telemetry.copy.es.diagnostics).toContain("Los informes de errores de PostHog también pueden funcionar de forma independiente");
    // Union Ground has no membership card, so no saved card copy is stored
    // or disclosed, and no writer for one is pinned.
    expect(telemetry.storage.find((row) => row.id === "card")).toBeUndefined();
    expect(JSON.stringify(telemetry.storage)).not.toContain("membership-card");
    expect(Object.keys(retained.browserWrites).filter((path) => /membershipCard/i.test(path))).toEqual([]);
  });
  // The shared Markdown renderer is what the page's published document depends
  // on; the donor repository's docs/legal drafts are not part of Union Ground.
  it.each(["en", "es"])("renders the published %s Markdown from the shared source", (lang) => {
    const copy = telemetry.copy[lang];
    const markdown = renderTelemetryMarkdown(lang);
    expect(markdown.startsWith(`## ${copy.title}`)).toBe(true);
    expect(markdown).toContain(telemetry.reviewed);
    for (const section of [copy.inventory, copy.cookies, copy.ai]) expect(markdown).toContain(`### ${section}`);
    for (const row of telemetry.storage) {
      expect(markdown).toContain(`- **${row.storage}: ${row.keys.join(", ")}** — ${row.purpose[lang]}`);
    }
    // Both cookie shapes are real: most rows inherit the shared purpose, two carry their own.
    const inherited = telemetry.cookies.filter((row) => !row.purpose);
    const explicit = telemetry.cookies.filter((row) => row.purpose);
    expect(inherited.length && explicit.length).toBeTruthy();
    for (const row of inherited) expect(markdown).toContain(`- **${row.key}** — ${copy.cookiePurpose}`);
    for (const row of explicit) expect(markdown).toContain(`- **${row.key}** — ${row.purpose[lang]}`);
    for (const key of AI_DISCLOSURE_CLAIMS) expect(markdown).toContain(catalogue[lang][`legal.aiDisclosure.${key}.body`]);
    expect(markdown).toContain(copy.attribution);
    expect(markdown).toContain(copy.diagnostics);
    expect(markdown.endsWith(`[${copy.register}](/subprocessors)`)).toBe(true);
  });
  it("keeps bilingual structure and a real route", () => {
    expect(Object.keys(telemetry.copy.en).sort()).toEqual(Object.keys(telemetry.copy.es).sort());
    for (const row of telemetry.storage) expect(Object.keys(row.purpose).sort()).toEqual(["en", "es"]);
    expect(readFileSync("src/AppRouter.jsx", "utf8")).toContain('"/telemetry": TelemetryDisclosureView');
    expect(readFileSync("scripts/public-route-metadata.mjs", "utf8")).toContain('"/telemetry"');
  });
});
