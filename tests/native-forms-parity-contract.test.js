// REQ-UG-NATIVE-FORMS-FULL-PARITY-WITH-THE-WEBSITE-20261113 (#8699):
// the phone fills, signs and submits forms through the website's own server
// paths. These checks keep the phone's copies of the server's rules in step:
// which templates are sealed, how a drawn signature is shaped, and which
// transport carries sealed answers.
import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { SEALED_FORM_TEMPLATES } from "../api/_lib/sensitiveContent.js";
import { SEALED_FORM_TEMPLATE_KEYS } from "../src/lib/memberApi.js";
import { MAX_STROKES } from "../src/components/SignaturePad.jsx";
import {
  MAX_POINTS_PER_STROKE, MAX_SIGNATURE_POINTS, MAX_SIGNATURE_STROKES, SIGNATURE_LIMIT, signatureIsSendable,
} from "../apps/mobile/src/lib/signatureStrokes.ts";

const root = process.cwd();
const read = (path) => readFileSync(resolve(root, path), "utf8");
const phoneForms = read("apps/mobile/src/services/memberForms.ts");

function strokeValidatorSql() {
  const files = readdirSync(resolve(root, "supabase/migrations")).filter((name) => name.endsWith(".sql")).sort();
  let latest = null;
  for (const name of files) {
    const text = read(`supabase/migrations/${name}`);
    const start = text.search(/create (or replace )?function private\.validate_form_signature_strokes/i);
    if (start >= 0) latest = text.slice(start, text.indexOf("$$;", text.indexOf("$$", start) + 2));
  }
  return latest;
}

describe("phone forms keep the website's server rules", () => {
  it("seals exactly the templates the sensitive-content API seals", () => {
    const literal = phoneForms.match(/SEALED_FORM_TEMPLATE_KEYS: ReadonlySet<string> = new Set\(\[([^\]]*)\]\)/u)?.[1] ?? "";
    const phone = [...literal.matchAll(/'([a-z_]+)'/gu)].map((match) => match[1]).sort();
    expect(phone).toEqual([...SEALED_FORM_TEMPLATES].sort());
    expect(phone).toEqual([...SEALED_FORM_TEMPLATE_KEYS].sort());
  });

  it("sends sealed answers only through the website's sensitive-content transport", () => {
    expect(phoneForms).toContain("import { sensitiveContentRpc as webSensitiveContentRpc } from '../../../../src/lib/sensitiveContentApi.js';");
    for (const operation of ["prepare_sealed_form", "save_sealed_form_draft", "get_sealed_forms"]) {
      expect(phoneForms).toContain(`'${operation}'`);
    }
    // The sealed branch returns before the ordinary save_form_draft call.
    const sealedBranch = phoneForms.indexOf("if (SEALED_FORM_TEMPLATE_KEYS.has(template.key)) {\n    const origin");
    expect(sealedBranch).toBeGreaterThan(0);
    expect(phoneForms.indexOf("rpc('save_form_draft'")).toBeGreaterThan(sealedBranch);
  });

  it("shapes a drawn signature as the server's stroke validator and the web pad do", () => {
    const sql = strokeValidatorSql();
    expect(sql).toBeTruthy();
    expect(sql).toContain(`not between 1 and ${MAX_SIGNATURE_STROKES}`);
    expect(sql).toContain(`not between 2 and ${MAX_POINTS_PER_STROKE}`);
    expect(sql).toContain(`point_count > ${MAX_SIGNATURE_POINTS}`);
    expect(sql).toContain(`not between 0 and ${SIGNATURE_LIMIT}`);
    expect(MAX_SIGNATURE_STROKES).toBe(MAX_STROKES);
    expect(read("src/components/SignaturePad.jsx")).toContain(`const LIMIT = ${SIGNATURE_LIMIT};`);
    expect(signatureIsSendable([[{ x: 0, y: 0 }, { x: SIGNATURE_LIMIT, y: SIGNATURE_LIMIT }]])).toBe(true);
    expect(signatureIsSendable([[{ x: 0, y: 0 }, { x: SIGNATURE_LIMIT + 1, y: 0 }]])).toBe(false);
    expect(signatureIsSendable(Array.from({ length: MAX_SIGNATURE_STROKES + 1 }, () => [{ x: 1, y: 1 }, { x: 2, y: 2 }]))).toBe(false);
  });
});
