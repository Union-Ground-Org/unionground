// @vitest-environment node
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { classifiedCompassSource, classifiedEmbeddingText, COMPASS_DOCUMENT_RULE_VERSION } from "../api/_lib/compassDocumentClassification.js";

const sha = (text) => createHash("sha256").update(text).digest("hex");
const body = "El empleador no podrá imponer una sanción sin causa justificada.";
const ready = { version: COMPASS_DOCUMENT_RULE_VERSION, status: "ready", rule: "published-document" };
const filing = { identity: "Synthetic LM-2 filing", source: "https://example.invalid/filing", year: 2024 };
const embedding = () => ({ ...ready, body_sha256: sha(body), text: body, text_sha256: sha(body) });
const source = () => {
  const value = { source_id: "kb:synthetic-contract", kind: "contract", title: "Artículo 12", ref: "Convenio colectivo", snippet: body };
  value.document_classification = { ...ready, payload_sha256: sha([value.title, value.ref, value.snippet].join("\u001f")) };
  return value;
};

describe("Compass document receipt boundary", () => {
  it("preserves accented document text for embedding and chat", () => {
    expect(classifiedEmbeddingText(body, embedding())).toBe(body);
    expect(classifiedCompassSource(source())).toEqual({ title: "Artículo 12", ref: "Convenio colectivo", snippet: body, provenance: "" });
  });

  it.each([undefined, null, {}, { ...ready, version: "unrecognized" }, { ...ready, status: "review-required" }, { ...ready, rule: "member-record" }])("refuses unavailable or unknown assurance: %j", (receipt) => {
    expect(classifiedEmbeddingText(body, receipt)).toBeNull();
    expect(classifiedCompassSource({ ...source(), document_classification: receipt })).toBeNull();
  });

  it.each([null, 7, "edited body"])("refuses a changed or non-text embedding body: %j", (changed) => {
    expect(classifiedEmbeddingText(changed, embedding())).toBeNull();
  });

  it.each([undefined, null, 7, "", "   ", "x".repeat(100001), "edited approved text"])("refuses invalid, oversized or changed approved embedding text", (text) => {
    expect(classifiedEmbeddingText(body, { ...embedding(), text })).toBeNull();
  });

  it("requires both the original-body and approved-text digests", () => {
    expect(classifiedEmbeddingText(body, { ...embedding(), body_sha256: "wrong" })).toBeNull();
    expect(classifiedEmbeddingText(body, { ...embedding(), text_sha256: "wrong" })).toBeNull();
    const approved = "Published contract text.";
    expect(classifiedEmbeddingText(body, { ...embedding(), text: approved, text_sha256: sha(approved) })).toBe(approved);
  });

  it.each([undefined, null, {}, { ...source(), source_id: undefined }, { ...source(), source_id: "case:synthetic" }, { ...source(), kind: "case" }])("refuses missing sources and case sources", (value) => {
    expect(classifiedCompassSource(value)).toBeNull();
  });

  for (const [field, limit] of [["title", 160], ["ref", 120], ["snippet", 400]]) {
    it.each([undefined, null, 7, "", "   ", "x".repeat(limit + 1), "text\nwith control", "changed text"])(`refuses malformed or changed source ${field}`, (value) => {
      expect(classifiedCompassSource({ ...source(), [field]: value })).toBeNull();
    });
    it(`permits a ${field} exactly at its length bound`, () => {
      const value = { ...source(), [field]: "x".repeat(limit) };
      value.document_classification.payload_sha256 = sha([value.title, value.ref, value.snippet].join("\u001f"));
      expect(classifiedCompassSource(value)?.[field]).toBe(value[field]);
    });
  }

  it("rejects a mismatched source payload digest", () => {
    const value = source(); value.document_classification.payload_sha256 = "wrong";
    expect(classifiedCompassSource(value)).toBeNull();
  });

  const publicSource = (provenance) => {
    const value = source(); value.document_classification = { ...value.document_classification, rule: "public-filing", filing: provenance };
    return value;
  };
  it("attaches the public filing's identity, source and year", () => {
    expect(classifiedCompassSource(publicSource(filing))?.provenance).toBe(` Filing: ${filing.identity}; source: ${filing.source}; year: 2024.`);
  });
  it.each([
    null, {}, { ...filing, identity: 7 }, { ...filing, identity: " " }, { ...filing, identity: "x".repeat(201) }, { ...filing, identity: "filing\ninvalid" },
    { ...filing, source: 7 }, { ...filing, source: `https://${"x".repeat(1000)}` }, { ...filing, source: "file:///synthetic" }, { ...filing, source: "https://user@example.invalid" },
    { ...filing, year: "2024" }, { ...filing, year: 2024.5 }, { ...filing, year: 1899 }, { ...filing, year: 2100 },
  ])("rejects incomplete or invalid filing provenance", (provenance) => {
    expect(classifiedCompassSource(publicSource(provenance))).toBeNull();
  });
  it.each([1900, 2099])("permits the supported filing-year boundary %i", (year) => {
    expect(classifiedCompassSource(publicSource({ ...filing, year }))?.provenance).toContain(`year: ${year}.`);
  });
});
