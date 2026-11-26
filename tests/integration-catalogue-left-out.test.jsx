// Integrations Union Ground does not offer (owner decisions, 2026-10-15):
// the CBA ingest, because there is no collective bargaining agreement before a
// first contract and contract articles are left out; and the Stripe dues
// integration with its dues jobs, because dues are left out. Their inert
// database rows may still exist; no catalogue, control plane, native screen,
// job list, ingest path or copy may offer them again.
import { readFileSync } from "node:fs";
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { createActor } from "../src/features/integrations/authorization.js";
import {
  INTEGRATION_PROVIDER_CATALOG,
  INTEGRATION_PROVIDER_IDS,
  isIntegrationProvider,
} from "../src/features/integrations/catalog.js";
import { IntegrationControlPlane } from "../src/features/integrations/IntegrationControlPlane.jsx";
import { createIntegrationControlStore } from "../src/features/integrations/store.js";
import { DONOR_REJECTED, DONOR_REUSE } from "../src/features/integrations/provenance.js";
import { JOB_KINDS } from "../src/features/integrations/jobs.js";
import { PRODUCT_JOBS } from "../src/features/operations/jobRegistry.js";
import { isLeftOutSetting } from "../src/lib/organizationSettingsAdmin.js";
import { catalogue } from "../src/lib/i18n.js";
import { LanguageProvider } from "../src/lib/LanguageContext.jsx";

const ORG_A = "11111111-1111-4111-8111-111111111111";
const admin = () => createActor({
  userId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  selectedOrganizationId: ORG_A,
  roles: ["admin"],
  membershipStatus: "active",
  mfaSatisfied: true,
});

const LEFT_OUT_PROVIDERS = ["cba_ingest", "stripe_dues"];
const LEFT_OUT_LABELS = /CBA|collective[- ]bargaining|convenio|Stripe|\bdues\b|cuotas/i;

describe("left-out integrations", () => {
  it("are absent from the shared catalogue the web and native screens list", () => {
    for (const provider of LEFT_OUT_PROVIDERS) {
      expect(INTEGRATION_PROVIDER_IDS, provider).not.toContain(provider);
      expect(INTEGRATION_PROVIDER_CATALOG[provider], provider).toBeUndefined();
      expect(isIntegrationProvider(provider), provider).toBe(false);
    }
    for (const entry of Object.values(INTEGRATION_PROVIDER_CATALOG)) {
      expect(`${entry.label} ${entry.setupSummary}`, entry.id).not.toMatch(LEFT_OUT_LABELS);
      expect(entry.capabilities, entry.id).not.toContain("documents:normalize");
      expect(entry.capabilities.filter((capability) => capability.startsWith("dues:")), entry.id).toEqual([]);
      expect(entry.category, entry.id).not.toBe("payments");
      expect(entry.setupSurface ?? null, entry.id).not.toBe("dues");
    }
    // The native integration screen lists the same shared ids, unfiltered:
    // there is no dues entry left to hide.
    const native = readFileSync("apps/mobile/src/lib/mi1Shared.ts", "utf8");
    expect(native).toContain("src/features/integrations/catalog.js");
    const nativeScreen = readFileSync("apps/mobile/src/features/mi1/IntegrationControlsScreen.tsx", "utf8").replace(/\/\/.*$/gm, "");
    expect(nativeScreen).not.toMatch(/'dues'|stripe/i);
  });

  it("leave no dues job, job kind, admin switch or provenance claim", () => {
    const jobs = PRODUCT_JOBS.map((job) => `${job.jobName} ${job.title}`);
    expect(jobs.filter((text) => /dues|stripe/i.test(text))).toEqual([]);
    expect(JOB_KINDS.filter((kind) => /dues|stripe/i.test(kind))).toEqual([]);
    const crons = JSON.parse(readFileSync("vercel.json", "utf8")).crons.map((cron) => cron.path);
    expect(crons.filter((path) => /dues|stripe/i.test(path))).toEqual([]);
    for (const key of ["features.notifications.dues_reminders", "limits.notifications.dues_reminder_days_past_due"]) {
      expect(isLeftOutSetting({ key }), key).toBe(true);
    }
    // The donor ledger records that no dues or card-payment planner was ever
    // ported, and names no payment vendor as reused.
    expect(JSON.stringify(DONOR_REUSE)).not.toMatch(/Stripe|dues/i);
    expect(DONOR_REJECTED.join("\n")).toMatch(/adp-dues-import\.ts and sibling vendor planners — Union Ground leaves dues out/);
  });

  it("have no catalogue copy in either language", () => {
    for (const lang of ["en", "es"]) {
      const keys = Object.keys(catalogue[lang]).filter((key) => key.startsWith("integrations.provider."));
      for (const provider of LEFT_OUT_PROVIDERS) {
        expect(keys.filter((key) => key.startsWith(`integrations.provider.${provider}.`)), `${lang} ${provider}`).toEqual([]);
      }
      const values = keys.map((key) => catalogue[lang][key]);
      expect(values.filter((value) => LEFT_OUT_LABELS.test(value)), lang).toEqual([]);
      // No dues workspace, Stripe setup or dues reminder copy survives.
      expect(Object.keys(catalogue[lang]).filter((key) => /^dues\.|dues_reminder|^nav\.dues$|topicDues|cat_dues|dues_notice/.test(key)), lang).toEqual([]);
      expect(Object.values(catalogue[lang]).filter((value) => typeof value === "string" && /\bStripe\b/.test(value)), lang).toEqual([]);
      // The campaign connection the inert schema still calls "cba" reads as
      // the reference library on the web exactly as it does on native.
      const connections = Object.keys(catalogue[lang]).filter((key) => key.startsWith("admin.chapterLifecycle.capability."));
      expect(connections.map((key) => catalogue[lang][key]).filter((value) => LEFT_OUT_LABELS.test(value)), lang).toEqual([]);
    }
    expect(catalogue.en["admin.chapterLifecycle.capability.cba"]).toBe("Campaign reference library");
    expect(readFileSync("apps/mobile/src/features/FeatureScreen.tsx", "utf8")).toContain("cba: 'Campaign reference library'");
  });

  it.each(["en", "es"])("never render on the %s control plane", async (lang) => {
    render(<LanguageProvider lang={lang}><IntegrationControlPlane store={createIntegrationControlStore()} actor={admin()} /></LanguageProvider>);
    await screen.findAllByText(lang === "es" ? /Sin configurar/ : /Not set up/);
    expect(screen.queryByText(LEFT_OUT_LABELS)).toBeNull();
  });

  it("leave no contract-article ingest path in the API or the upload form", () => {
    const ingest = readFileSync("api/knowledge-ingest.js", "utf8").replace(/\/\/.*$/gm, "");
    expect(ingest).not.toMatch(/normalizeCbaArticles|replace_cba_knowledge_drafts|category === "contract"/);
    const panel = readFileSync("src/features/knowledge/KnowledgeWorkspacePanel.jsx", "utf8").replace(/\/\/.*$/gm, "");
    expect(panel).not.toMatch(/"contract"|knowledge\.contractChapter/);
  });
});
