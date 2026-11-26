// REQ-UG-PROVENANCE-CONTRACT-20261012: the provenance helper every
// loader and translator uses, and the JSON Schema it publishes, held in step.

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  CAPTURE_METHODS,
  EXTRACTION_METHODS,
  ProvenanceError,
  QUOTE_BINDINGS,
  REQUIRED_PATHS,
  REUSE_BASES,
  REVIEWER_ROLES,
  REVIEW_STATUSES,
  assertProvenance,
  canonicalJson,
  collectProvenance,
  fingerprint,
  sha256Hex,
  stamp,
  validate,
  validateDocument,
} from "../scripts/lib/provenance.mjs";

const schema = JSON.parse(readFileSync(join(process.cwd(), "schemas", "provenance.schema.json"), "utf8"));
const NOW = Date.parse("2026-10-11T08:00:00Z");
const BYTES = "<html>Decision 2026-03-14</html>";

function captured(overrides = {}) {
  return stamp({
    bytes: BYTES,
    source: { url: "https://www.mass.gov/dlr/decisions/example", publisher: "Massachusetts Department of Labor Relations", title: "Decision example" },
    retrievedAt: "2026-10-11T07:01:22Z",
    capture: { method: "http-get", tool: "node-fetch@22", run_id: "P0-test" },
    extraction: { method: "verbatim", extractor: "fixture@1", quote_binding: "exact-substring" },
    asOf: "2026-03-14",
    reuse: { basis: "public-record" },
    ...overrides,
  });
}

function without(record, path) {
  const copy = structuredClone(record);
  const keys = path.split(".");
  const last = keys.pop();
  delete keys.reduce((node, key) => node[key], copy)[last];
  return copy;
}

function refingerprint(record) {
  return { ...record, provenance_id: fingerprint(record) };
}

describe("stamp", () => {
  it("builds a complete record bound to the captured bytes", () => {
    const record = captured();
    expect(record.content_sha256).toBe(createHash("sha256").update(BYTES).digest("hex"));
    expect(record.provenance_id).toBe(fingerprint(record));
    expect(record.provenance_id).toMatch(/^prov-[0-9a-f]{64}$/);
    expect(record.retrieved_at).toBe("2026-10-11T07:01:22.000Z");
    expect(record.review).toEqual({ status: "unreviewed", reviewed_at: null });
    expect(validate(record, { now: NOW })).toEqual({ ok: true, errors: [] });
  });

  it("hashes a string and the same UTF-8 bytes identically, and accepts a streamed digest", () => {
    const fromBytes = captured({ bytes: new TextEncoder().encode(BYTES) });
    expect(fromBytes.content_sha256).toBe(captured().content_sha256);
    const streamed = captured({ bytes: undefined, contentSha256: sha256Hex(BYTES) });
    expect(streamed.provenance_id).toBe(captured().provenance_id);
  });

  it("stores the capture time in UTC whatever offset it was given", () => {
    expect(captured({ retrievedAt: new Date("2026-10-11T03:01:22-04:00") }).retrieved_at).toBe("2026-10-11T07:01:22.000Z");
  });

  it("refuses rather than defaulting anything the contract requires", () => {
    expect(() => captured({ source: { url: "https://example.org/a" } })).toThrow(/source\.publisher is required/);
    expect(() => captured({ asOf: undefined })).toThrow(/as_of is required/);
    expect(() => captured({ capture: {} })).toThrow(/capture\.method is required/);
    expect(() => captured({ contentSha256: sha256Hex("x") })).toThrow(/exactly one of bytes or contentSha256/);
    expect(() => captured({ bytes: undefined })).toThrow(/exactly one of bytes or contentSha256/);
    expect(() => captured({ retrievedAt: "yesterday" })).toThrow(/retrievedAt must be a Date or an ISO timestamp/);
    try {
      captured({ source: {} });
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(ProvenanceError);
      expect(error.errors).toEqual(expect.arrayContaining(["source.url is required", "source.publisher is required"]));
    }
  });
});

describe("stamp hardening (gate round 1)", () => {
  it("refuses an impossible timestamp instead of rolling it into another day", () => {
    for (const retrievedAt of ["2026-02-30T07:01:22Z", "2026-10-11T24:00:00Z", "2026-10-11T07:01:22+24:00", "2026-10-11 07:01:22"]) {
      expect(() => captured({ retrievedAt }), retrievedAt).toThrow(/real date, time and offset/);
    }
    expect(captured({ retrievedAt: "2026-10-11T03:01:22.5-04:00" }).retrieved_at).toBe("2026-10-11T07:01:22.500Z");
  });

  it("owns and freezes what it returns, so the id cannot go stale", () => {
    const derivedFrom = ["example-org/example-data@0123abc:data/pay.csv"];
    const review = { status: "unreviewed", reviewed_at: null };
    const record = captured({
      capture: { method: "computed" },
      extraction: { method: "script", extractor: "scripts/example.mjs@1" },
      derivedFrom,
      review,
    });
    derivedFrom.push("example-org/example-data@0123abc:other.csv");
    review.status = "reviewed";
    expect(record.derived_from).toHaveLength(1);
    expect(record.review.status).toBe("unreviewed");
    expect(Object.isFrozen(record) && Object.isFrozen(record.review) && Object.isFrozen(record.derived_from)).toBe(true);
    expect(() => { record.review.status = "reviewed"; }).toThrow(TypeError);
    expect(validate(record, { now: NOW }).ok).toBe(true);
  });

  it("refuses sparse arrays rather than fingerprinting a hole as nothing", () => {
    const sparse = new Array(2);
    expect(() => canonicalJson(sparse)).toThrow(/sparse array/);
    const record = captured();
    const { errors } = validate({ ...record, derived_from: new Array(1) }, { now: NOW });
    expect(errors).toEqual(expect.arrayContaining([
      "record has no canonical form: canonicalJson: sparse array",
      "derived_from[0] must be a prov- id or an owner/repo@<commit>:<path> reference",
    ]));
    expect(() => captured({ capture: { method: "computed" }, extraction: { method: "script", extractor: "x@1" }, derivedFrom: new Array(1) })).toThrow(ProvenanceError);
  });
});

describe("validate", () => {
  it("names each required path that is missing or blank", () => {
    const record = captured();
    for (const path of REQUIRED_PATHS) {
      const { ok, errors } = validate(without(record, path), { now: NOW });
      expect(ok, path).toBe(false);
      expect(errors, path).toContain(`${path} is required`);
    }
    const blank = refingerprint({ ...record, source: { ...record.source, publisher: "   " } });
    expect(validate(blank, { now: NOW }).errors).toContain("source.publisher is required");
  });

  it("refuses fields outside the contract at every level", () => {
    const record = captured();
    expect(validate(refingerprint({ ...record, grievant: "x" }), { now: NOW }).errors).toContain("unknown field grievant");
    expect(validate(refingerprint({ ...record, source: { ...record.source, offsets: [1, 4] } }), { now: NOW }).errors)
      .toContain("unknown field source.offsets");
  });

  it("detects a record edited after it was fingerprinted", () => {
    const record = captured();
    const edited = { ...record, as_of: "2026-03-15" };
    expect(validate(edited, { now: NOW }).errors).toContain("provenance_id does not match the record's fingerprint");
  });

  it("fingerprints canonical JSON, so key order does not change the id", () => {
    const record = captured();
    const reordered = Object.fromEntries(Object.entries(record).reverse());
    expect(fingerprint(reordered)).toBe(record.provenance_id);
    expect(canonicalJson({ b: 1, a: [true, null, { d: "x", c: undefined }] })).toBe('{"a":[true,null,{"d":"x"}],"b":1}');
    expect(() => canonicalJson({ at: new Date() })).toThrow(/not a JSON value/);
  });

  it("accepts only http(s) source URLs without credentials", () => {
    for (const url of ["javascript:alert(1)", "ftp://example.org/x", "https://user:pw@example.org/x", "/relative/path", " https://example.org"]) {
      const record = refingerprint({ ...captured(), source: { ...captured().source, url } });
      expect(validate(record, { now: NOW }).ok, url).toBe(false);
    }
  });

  it("requires real UTC timestamps and dates that are not in the future", () => {
    const base = captured();
    const cases = [
      [{ retrieved_at: "2026-10-11T07:01:22+00:00" }, "retrieved_at must be an RFC 3339 UTC timestamp ending in Z"],
      [{ retrieved_at: "2026-02-30T07:01:22Z" }, "retrieved_at must be an RFC 3339 UTC timestamp ending in Z"],
      [{ retrieved_at: "2026-10-11T09:00:00Z" }, "retrieved_at is in the future"],
      [{ as_of: "2026-13-01" }, "as_of must be a YYYY-MM-DD date or an RFC 3339 UTC timestamp"],
      [{ content_sha256: "ABC" }, "content_sha256 must be 64 lowercase hex characters"],
    ];
    for (const [change, message] of cases) {
      expect(validate(refingerprint({ ...base, ...change }), { now: NOW }).errors).toContain(message);
    }
    expect(validate(refingerprint({ ...base, as_of: "2026-03-14T00:00:00Z" }), { now: NOW }).ok).toBe(true);
  });

  it("makes a computed value list its inputs and name its script", () => {
    const input = captured();
    const computed = stamp({
      bytes: "42",
      source: { url: "https://github.com/example-org/example-repo/blob/main/scripts/example.mjs", publisher: "Union Ground analysis" },
      retrievedAt: "2026-10-11T07:30:00Z",
      capture: { method: "computed", run_id: "P0-test" },
      extraction: { method: "script", extractor: "scripts/example.mjs@1" },
      asOf: "2026-03-14",
      derivedFrom: [input.provenance_id, "example-org/example-data@0123abc:data/pay.csv"],
    });
    expect(validate(computed, { now: NOW }).ok).toBe(true);
    const noInputs = refingerprint({ ...computed, derived_from: [] });
    expect(validate(noInputs, { now: NOW }).errors).toContain("a computed record must list every input in derived_from");
    const noScript = refingerprint({ ...computed, extraction: { method: "script" } });
    expect(validate(noScript, { now: NOW }).errors).toContain("a computed record must name its script and version in extraction.extractor");
    const authored = refingerprint({ ...computed, capture: { method: "authored" }, derived_from: [] });
    expect(validate(authored, { now: NOW }).errors).toContain("an authored record must list the sources it rests on in derived_from");
  });

  it("checks derived_from references and refuses repeats", () => {
    const record = captured();
    const bad = refingerprint({ ...record, derived_from: ["somewhere", record.provenance_id, record.provenance_id] });
    const { errors } = validate(bad, { now: NOW });
    expect(errors).toContain("derived_from[0] must be a prov- id or an owner/repo@<commit>:<path> reference");
    expect(errors).toContain("derived_from repeats a reference");
  });

  it("requires when and by whom for a reviewed record", () => {
    const record = captured();
    const reviewed = refingerprint({ ...record, review: { status: "reviewed" } });
    expect(validate(reviewed, { now: NOW }).errors).toEqual(expect.arrayContaining([
      "a reviewed record needs review.reviewed_at",
      "a reviewed record needs review.reviewer_role",
    ]));
    const complete = refingerprint({ ...record, review: { status: "reviewed", reviewed_at: "2026-10-11T07:45:00Z", reviewer_role: "platform_editor", note: "Checked against the agency page." } });
    expect(validate(complete, { now: NOW }).ok).toBe(true);
  });

  it("never throws on malformed input", () => {
    for (const value of [null, undefined, "prov", 3, [], { source: "x", capture: [], review: 1 }]) {
      expect(validate(value, { now: NOW }).ok).toBe(false);
    }
    expect(() => assertProvenance({}, "row 7")).toThrow(/^row 7: provenance refused: /);
  });
});

describe("validateDocument", () => {
  it("checks every record under a provenance key and resolves prov- inputs inside the document", () => {
    const cell = captured();
    const file = stamp({
      bytes: "ma.json",
      source: { url: "https://app.example.org/reference/state-labor-law/ma", publisher: "Union Ground reference compilation" },
      retrievedAt: "2026-10-11T07:40:00Z",
      capture: { method: "authored" },
      asOf: "2026-10-12",
      derivedFrom: [cell.provenance_id],
    });
    const document = { jurisdiction: "MA", provenance: file, cells: { ulp_limit: { value: "six months", provenance: cell } } };
    expect(collectProvenance(document).map((entry) => entry.path)).toEqual(["$.provenance", "$.cells.ulp_limit.provenance"]);
    expect(validateDocument(document, { now: NOW })).toEqual({ ok: true, errors: [], records: 2 });

    const orphan = { provenance: file };
    expect(validateDocument(orphan, { now: NOW }).errors).toContain(`$.provenance: derived_from ${cell.provenance_id} is not a complete record in this document`);
    expect(validateDocument({ rows: [] }, { now: NOW }).errors).toContain("document carries no provenance record");
    expect(validateDocument({ provenance: { source: {} } }, { now: NOW }).ok).toBe(false);
    expect(validateDocument("text").ok).toBe(false);
  });
});

describe("schemas/provenance.schema.json", () => {
  it("publishes the same required fields and vocabularies as the helper", () => {
    expect(schema.$schema).toBe("https://json-schema.org/draft/2020-12/schema");
    expect(schema.additionalProperties).toBe(false);
    const topLevelRequired = [...new Set(REQUIRED_PATHS.map((path) => path.split(".")[0]))].sort();
    expect([...schema.required].sort()).toEqual(topLevelRequired);
    for (const path of REQUIRED_PATHS.filter((entry) => entry.includes("."))) {
      const [parent, child] = path.split(".");
      expect(schema.properties[parent].required, path).toContain(child);
    }
    expect(schema.properties.capture.properties.method.enum).toEqual([...CAPTURE_METHODS]);
    expect(schema.properties.extraction.properties.method.enum).toEqual([...EXTRACTION_METHODS]);
    expect(schema.properties.extraction.properties.quote_binding.enum).toEqual([...QUOTE_BINDINGS]);
    expect(schema.properties.review.properties.status.enum).toEqual([...REVIEW_STATUSES]);
    expect(schema.properties.review.properties.reviewer_role.enum).toEqual([...REVIEWER_ROLES, null]);
    expect(schema.properties.reuse.properties.basis.enum).toEqual([...REUSE_BASES]);
  });

  it("describes every field a stamped record can carry and nothing more", () => {
    const record = captured({ review: { status: "reviewed", reviewed_at: "2026-10-11T07:45:00Z", reviewer_role: "lane", note: "" } });
    expect(Object.keys(schema.properties).sort()).toEqual(Object.keys(record).sort());
    for (const [name, value] of Object.entries(record)) {
      if (value && typeof value === "object" && !Array.isArray(value)) {
        for (const key of Object.keys(value)) expect(schema.properties[name].properties, `${name}.${key}`).toHaveProperty(key);
      }
    }
    expect(new RegExp(schema.properties.provenance_id.pattern).test(record.provenance_id)).toBe(true);
    expect(new RegExp(schema.$defs.utcTimestamp.pattern).test(record.retrieved_at)).toBe(true);
  });
});
