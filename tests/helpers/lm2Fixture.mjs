// REQ-UG-LM2-TRANSPARENCY-20261012: a small, clearly fictional
// artifact (file numbers 900001 and up, example.test URLs, "Test" union names)
// in the exact shape 's derive_lm_summaries.py writes, so the loader,
// the RPCs and the view run without any filer's real data. Every record is
// made by P0's stamp().
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import { canonicalJson, sha256Hex, stamp } from "../../scripts/lib/provenance.mjs";

const AT = "2026-10-01T12:00:00.000Z";
const RUN = "test-lm2";

export function fixtureSource(year) {
  return stamp({
    bytes: `test yearly file ${year}`,
    source: { url: `https://example.test/olms/${year}.zip`, publisher: "Example test publisher", title: `Test yearly data ${year}` },
    retrievedAt: AT,
    capture: { method: "bulk-file", tool: "test", run_id: RUN },
    extraction: { method: "verbatim", extractor: "none", quote_binding: "none" },
    asOf: "2026-10-01",
    reuse: { basis: "public-record" },
  });
}

/** One artifact row; `receipts` sets total receipts and `members` the size. */
export function fixtureRow(source, { fNum, year = 2024, form = "LM-3", aff = "TST", band = "100-499", members = 200, receipts = 100000, ...extra } = {}) {
  const lm2 = form === "LM-2";
  const lm4 = form === "LM-4";
  const disbursements = receipts * 0.9;
  const data = {
    aff_abbr: aff,
    amendment: 0,
    designation: { name: "LU", number: String(fNum % 1000), prefix: null, suffix: null },
    dues_and_fees_per_member: lm4 ? null : Number(((receipts * 0.8) / members).toFixed(2)),
    dues_and_fees_receipts: lm4 ? null : receipts * 0.8,
    dues_receipts: lm4 ? null : receipts * 0.8,
    employee_disbursements_gross: lm4 ? null : disbursements * 0.2,
    employee_disbursements_net: lm4 ? null : disbursements * 0.15,
    f_num: fNum,
    fees_receipts: lm4 ? null : 0,
    form_type: form,
    fye_month: 12,
    lm2_functional: lm2 ? { benefits: 0, contributions_gifts_grants: 0, general_overhead: disbursements * 0.2, political_and_lobbying: disbursements * 0.05, representational: disbursements * 0.5, strike_benefits: 0, union_administration: disbursements * 0.1 } : null,
    members,
    net_assets: receipts * 2,
    officer_disbursements_gross: lm4 ? null : disbursements * 0.1,
    officer_disbursements_net: lm4 ? null : disbursements * 0.08,
    per_capita_tax_disbursements: lm4 ? null : disbursements * 0.3,
    period_from: `${year}-01-01`,
    period_to: `${year}-12-31`,
    receipts_per_member: Number((receipts / members).toFixed(2)),
    receive_date: `${year + 1}-03-01`,
    rpt_id: fNum * 10 + (year - 2020),
    schedule_totals_missing: false,
    size_band: band,
    state: "MA",
    superseded_rpt_ids: [],
    terminal_report: false,
    total_assets: receipts * 3,
    total_disbursements: disbursements,
    total_liabilities: receipts,
    total_receipts: receipts,
    union_name: `Test Workers Union ${fNum}`,
    unit_name: null,
    yr_covered: year,
    ...extra,
  };
  return {
    ...data,
    provenance: stamp({
      bytes: canonicalJson(data),
      source: { url: "https://example.test/olms/report", publisher: "Example test publisher", title: `Test report ${fNum} ${year}` },
      retrievedAt: AT,
      capture: { method: "computed", tool: "test", run_id: RUN },
      extraction: { method: "script", extractor: "tests/helpers/lm2Fixture.mjs", quote_binding: "none" },
      asOf: `${year}-12-31`,
      derivedFrom: [source.provenance_id],
      reuse: { basis: "public-record" },
    }),
  };
}

/** Seven 2024 TST filers of 100-499 members, a 2023 year for 900001 and one lone TSU LM-4. */
export function fixtureArtifactParts() {
  const s2023 = fixtureSource(2023);
  const s2024 = fixtureSource(2024);
  const rows = [
    fixtureRow(s2024, { fNum: 900001, members: 200, receipts: 100000 }),
    fixtureRow(s2023, { fNum: 900001, year: 2023, members: 190, receipts: 95000 }),
    fixtureRow(s2024, { fNum: 900002, members: 150, receipts: 60000 }),
    fixtureRow(s2024, { fNum: 900003, members: 300, receipts: 240000 }),
    fixtureRow(s2024, { fNum: 900004, members: 400, receipts: 200000 }),
    fixtureRow(s2024, { fNum: 900005, members: 250, receipts: 50000 }),
    fixtureRow(s2024, { fNum: 900006, members: 120, receipts: 144000 }),
    fixtureRow(s2024, { fNum: 900007, form: "LM-2", members: 480, receipts: 480000 }),
    fixtureRow(s2024, { fNum: 900008, form: "LM-4", aff: "TSU", band: "under-100", members: 40, receipts: 8000 }),
  ];
  return { sources: [s2023, s2024], rows };
}

/** Write an artifact directory; `lines` replaces the gz lines and `manifestPatch` overrides manifest fields. */
export function writeFixtureArtifact({ sources, rows }, { lines, manifestPatch = {} } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "lm2-fixture-"));
  const gz = gzipSync(Buffer.from(`${(lines ?? rows.map((row) => JSON.stringify(row))).join("\n")}\n`));
  const sourcesJson = JSON.stringify(sources, null, 1);
  writeFileSync(join(dir, "olms-lm-summaries-v1.jsonl.gz"), gz);
  writeFileSync(join(dir, "sources.json"), sourcesJson);
  writeFileSync(join(dir, "manifest.json"), JSON.stringify({
    artifact: "olms-lm-summaries-v1.jsonl.gz",
    artifact_sha256: sha256Hex(gz),
    sources_json_sha256: sha256Hex(sourcesJson),
    rows: rows.length,
    ...manifestPatch,
  }));
  return dir;
}
