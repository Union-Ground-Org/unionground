import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  attributeCensus,
  censusEsUsted,
  formatCensusReport,
  loadInventory,
} from "../scripts/census-es-usted.mjs";
import { t } from "../src/lib/i18n.js";
import { FORMAL_IMPERATIVES, TIER1_MARKERS, TIER1_WORDS, TIER2_MARKERS } from "./i18nRegisterMarkers.js";

// UX-UG-ES-USTED-CENSUS-TIER2-20260917
//
// The census counts with the same markers the i18n guards import. Tier 1 must
// match the committed inventory key for key, so it only moves with a reviewed
// inventory change. Tier 2 was triaged once; later drift is reported.

const RECORD_ID = /^(UX|BUG)-UG-[A-Z0-9-]+-\d{8}$/;

describe("ES usted census", () => {
  const inventory = loadInventory();
  const census = attributeCensus(censusEsUsted(), inventory);

  it("counts with the one marker module the guards import", () => {
    expect(TIER1_WORDS).toEqual(expect.arrayContaining(["usted", "ustedes", ...FORMAL_IMPERATIVES]));
    expect(TIER1_WORDS).toHaveLength(2 + FORMAL_IMPERATIVES.length);
    const script = readFileSync("scripts/census-es-usted.mjs", "utf8");
    expect(script).toContain('from "../tests/i18nRegisterMarkers.js"');
    const tier1Test = readFileSync("tests/es-usted-tier1-register.test.jsx", "utf8");
    expect(tier1Test).toContain('import { TIER1_MARKERS } from "./i18nRegisterMarkers.js"');
    expect(tier1Test).not.toMatch(/const TIER1_WORDS\s*=/);
  });

  it("keeps letter-class boundaries on both tiers", () => {
    expect("Dé los hechos primero.").toMatch(TIER1_MARKERS);
    expect("Inténtalo de nuevo.").not.toMatch(TIER1_MARKERS);
    expect("Ya leí el aviso.").not.toMatch(TIER2_MARKERS);
    expect("Revisa sus casos.").toMatch(TIER2_MARKERS);
  });

  it("matches the committed tier-1 inventory key for key", () => {
    expect(census.errors).toEqual([]);
    // The public Spanish Terms use tú here, and the removed dues feature
    // has no catalogue copy. The held-recovery line remains a false positive.
    expect(census.tier1).toHaveLength(15);
    expect(inventory.tier1.keys).not.toHaveProperty("dues.stripeNotConnectedNote");
    expect(census.tier1.filter((row) => row.owner == null)).toHaveLength(9);
  });

  it("dispositions the held-recovery third-person subjunctive with its existing full-copy pin", () => {
    const entry = inventory.tier1.keys["reset.recoveryHeld"];
    expect(entry).toMatchObject({ disposition: "false_positive", owner: null });
    expect(entry.note).toContain("('cuando lo haga')");
    expect(entry.note).toContain("tests/es-usted-tier1-register.test.jsx LATER_FALSE_POSITIVES");
    expect(census.tier1.find((row) => row.key === "reset.recoveryHeld"))
      .toMatchObject({ disposition: "false_positive", owner: null });
    const registerTest = readFileSync("tests/es-usted-tier1-register.test.jsx", "utf8");
    expect(registerTest).toContain(JSON.stringify(t("es", "reset.recoveryHeld")));
  });

  it("triages the measured tier-2 keys once, into exactly one class", () => {
    expect(inventory.tier2.reader_addressed).toHaveLength(8);
    // 65 before dues.reminderDelivery left with the dues copy.
    expect(inventory.tier2.third_person).toHaveLength(64);
    expect(inventory.tier2.third_person).not.toContain("dues.reminderDelivery");
    expect(inventory.history).toContain("dues.reminderDelivery left the tier-2 third-person class");
    const reader = new Set(inventory.tier2.reader_addressed);
    expect(inventory.tier2.third_person.filter((key) => reader.has(key))).toEqual([]);
  });

  it("gives every tier-1 key a disposition and a record id or an explicit null owner", () => {
    for (const [key, row] of Object.entries(inventory.tier1.keys)) {
      expect(["false_positive", "legal_frozen", "reader_addressed"], key).toContain(row.disposition);
      if (row.owner !== null) expect(row.owner, key).toMatch(RECORD_ID);
      expect(row.note, key).toBeTruthy();
    }
    expect(inventory.tier2.follow_up_record.reader_addressed).toMatch(RECORD_ID);
  });

  it("fails on tier-1 drift and reports tier-2 drift", () => {
    const es = { "extra.key": "Elija un valor.", "extra.possessive": "Revisa su cuenta." };
    const drift = attributeCensus(censusEsUsted(es), inventory);
    expect(drift.errors).toContain("tier-1 key extra.key is not in the inventory");
    expect(drift.errors).toContain("inventory tier-1 key hub.intake.convertHelp no longer matches; remove it");
    expect(drift.errors.join("\n")).not.toContain("extra.possessive");
    expect(drift.tier2).toEqual([{ key: "extra.possessive", value: "Revisa su cuenta.", class: "untriaged" }]);
    expect(formatCensusReport(drift, inventory)).toContain("Tier 2 triage entries that no longer match: ");
  });

  it("prints both tiers from the command line", () => {
    const report = execFileSync(process.execPath, ["scripts/census-es-usted.mjs"], { encoding: "utf8" });
    expect(report).toBe(`${formatCensusReport(census, inventory)}\n`);
    expect(report).toContain("Tier 1 (usted/ustedes + formal-imperative union): 15");
    expect(report).toContain("UNOWNED: 9");
    expect(report).toMatch(/Tier 2 \(su\/sus\/le\/les only\): \d+ \(\d+ reader-addressed, \d+ third-person, \d+ untriaged\)/);
    expect(report).toContain("  hub.intake.convertHelp\treader_addressed\tUNOWNED\tElija");
    expect(report).toContain("  reset.recoveryHeld\tfalse_positive\tUNOWNED\thaga");
  });
});

// UX-UG-ES-USTED-TIER2-READER-ADDRESSED-20260919
//
// The reader-addressed tier-2 keys read in tú. Only the legal.* keys remain in
// that class: every legal.* line feeds LEGAL_COPY_FINGERPRINT, so their register
// change waits for a legal review. The two mixed keys keep their third-person
// su and moved to third_person.
describe("ES tier-2 reader-addressed repair", () => {
  const inventory = loadInventory();
  const REPAIRED = [
    "operations.audit.sourceUnavailable", "accessHistory.sub", "pay.publisherHelp",
    "hub.governance.sub", "hub.lifecycle.exportTitle", "hub.lifecycle.exportBody", "hub.lifecycle.exported",
    "hub.lifecycle.deleteTitle", "hub.lifecycle.deleteBody", "hub.lifecycle.deleteDialogTitle", "hub.lifecycle.deleteWarning",
    "hub.lifecycle.deleteRetained", "hub.lifecycle.deleteNotPermitted", "hub.lifecycle.deletedPendingAudit", "civic.unavailable",
    "accessHistory.loading", "accessHistory.empty", "accessHistory.failure.unauthorized", "accessHistory.action.viewed_profile",
    "accessHistory.action.viewed_case", "accessHistory.action.updated_profile", "accessHistory.action.updated_case",
    "accessHistory.action.granted_role", "accessHistory.action.revoked_role",
  ];

  it("leaves no su/sus/le/les on the repaired strings", () => {
    for (const key of REPAIRED) {
      const value = t("es", key);
      expect(value, key).not.toBe(key);
      expect(value, key).not.toMatch(TIER2_MARKERS);
      expect(value, key).not.toMatch(TIER1_MARKERS);
    }
    expect(t("es", "hub.lifecycle.deleteTitle")).toBe("Elimina tu cuenta");
    expect(t("es", "accessHistory.sub")).toMatch(/^Mira cuándo .* tus asuntos, .* en tu cuenta\./);
    expect(t("es", "accessHistory.action.granted_role")).toBe("te dio un rol de personal");
  });

  it("changes only the reader clause of the two mixed keys", () => {
    expect(t("es", "procedure.settingsHelp")).toMatch(/^Tu organización define sus propios pasos/);
    expect(t("es", "inbox.redacted.retention_expired")).toBe("Este mensaje superó el período de retención de tu organización y su texto fue eliminado.");
    for (const key of ["procedure.settingsHelp", "inbox.redacted.retention_expired"]) {
      expect(inventory.tier2.third_person, key).toContain(key);
      expect(inventory.tier2.reader_addressed, key).not.toContain(key);
    }
  });

  it("keeps only legal-review copy reader-addressed", () => {
    for (const key of REPAIRED) expect(inventory.tier2.reader_addressed, key).not.toContain(key);
    expect(inventory.tier2.reader_addressed.every((key) => key.startsWith("legal."))).toBe(true);
    expect(t("es", "legal.privacy.control.title")).toBe("Su control");
  });
});
