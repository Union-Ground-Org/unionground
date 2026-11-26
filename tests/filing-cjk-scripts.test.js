// @vitest-environment node
// REQ-UG-FILING-COPY-DRAWS-CJK-ARABIC-HEBREW-DEVANAGARI-TEXT-20261114 (#8725), step 2:
// Chinese, Japanese and Korean names and answers are drawn on the official
// filing copy in Noto Sans CJK (embedded as a subset CFF program), and a copy
// whose CJK font cannot be read prints codes with the note, as before. The
// tests use a small subset of the pinned font
// (tests/fixtures/fonts/NotoSansCJKsc-test-subset.otf); the 16 MB font itself
// is fetched only by the Vercel build.
import { existsSync, readFileSync } from "node:fs";
import { inflateSync } from "node:zlib";
import { afterEach, describe, expect, it, vi } from "vitest";
import { filingFont } from "../api/_lib/filingFont.js";
import { loadFilingShaper } from "../api/_lib/filingShaper.js";
import { renderFormFilingPdf } from "../src/lib/formFilingPdf.js";
import { CJK_FONT, sha256Hex } from "../scripts/fetch-filing-cjk-font.mjs";

const FIXTURE = new URL("./fixtures/fonts/NotoSansCJKsc-test-subset.otf", import.meta.url);
const MISSING = new URL("./fixtures/fonts/no-such-cjk-font.otf", import.meta.url);
const shaper = await loadFilingShaper({ cjkFont: FIXTURE });
const CHINESE_NAME = "李小王";
const JAPANESE_NAME = "山田 はなこ";
const KOREAN_NAME = "이지은";
const ANSWER = "中文字 加有支付 尽快处理";

const typed = (name) => ({ kind: "typed", name });
const copy = () => ({
  form: { id: "f2010001-1111-4111-8111-111111111111", template_key: "service_request", template_version: 1, answers: { description: ANSWER } },
  template: { label_en: "Service request", label_es: "Solicitud", field_schema: { steps: [{ title: { en: "Request", es: "Solicitud" }, fields: [{ key: "description", label: { en: "Description", es: "Descripción" } }] }] } },
  filer: { id: "u1", name: CHINESE_NAME },
  filerSignature: { signedAt: "2026-11-14T15:00:00Z", signatureDigest: "sig", strokes: typed(CHINESE_NAME) },
  cosigners: [
    { id: "c1", name: JAPANESE_NAME, status: "accepted", signedAt: "2026-11-14T15:05:00Z", signatureDigest: "d1", strokes: typed(JAPANESE_NAME) },
    { id: "c2", name: KOREAN_NAME, status: "accepted", signedAt: "2026-11-14T15:06:00Z", signatureDigest: "d2", strokes: typed(KOREAN_NAME) },
  ],
  attachments: [],
  approval: { approvedBy: "s1", approvedAt: "2026-11-14T16:00:00Z", reviewerName: "Steward", note: null, artifactDigest: "artifact" },
});
const latin1 = (bytes) => Buffer.from(bytes).toString("latin1");
const actualTexts = (pdf) => [...pdf.matchAll(/\/ActualText <FEFF([0-9A-F]*)>/g)]
  .map(([, hex]) => String.fromCharCode(...(hex.match(/.{4}/g) || []).map((unit) => parseInt(unit, 16))));

// The CIDs of a bare CID-keyed CFF program, by glyph index, and its
// Registry-Ordering-Supplement strings' presence.
function cffCids(cff) {
  const u16 = (at) => (cff[at] << 8) | cff[at + 1];
  const index = (at) => {
    const count = u16(at);
    if (!count) return { items: [], end: at + 2 };
    const size = cff[at + 2];
    const offset = (n) => { let value = 0; for (let byte = 0; byte < size; byte += 1) value = (value * 256) + cff[at + 3 + (n * size) + byte]; return value; };
    const data = at + 3 + ((count + 1) * size) - 1;
    return { items: Array.from({ length: count }, (_, n) => [data + offset(n), data + offset(n + 1)]), end: data + offset(count) };
  };
  const names = index(cff[2]);
  const top = index(names.end).items[0];
  const operators = new Map();
  let operands = [];
  for (let at = top[0]; at < top[1];) {
    const byte = cff[at];
    if (byte === 12) { operators.set(1200 + cff[at + 1], operands); operands = []; at += 2; }
    else if (byte <= 21) { operators.set(byte, operands); operands = []; at += 1; }
    else if (byte === 28) { operands.push((u16(at + 1) << 16) >> 16); at += 3; }
    else if (byte === 29) { operands.push((u16(at + 1) << 16) | u16(at + 3)); at += 5; }
    else if (byte === 30) { at += 1; while ((cff[at] & 0x0f) !== 0x0f && (cff[at] >> 4) !== 0x0f) at += 1; at += 1; operands.push(0); }
    else if (byte <= 246) { operands.push(byte - 139); at += 1; }
    else if (byte <= 250) { operands.push(((byte - 247) * 256) + cff[at + 1] + 108); at += 2; }
    else { operands.push(-((byte - 251) * 256) - cff[at + 1] - 108); at += 2; }
  }
  const glyphCount = index(operators.get(17)[0]).items.length;
  const cids = [0];
  let at = operators.get(15)[0];
  const format = cff[at];
  at += 1;
  while (cids.length < glyphCount) {
    if (format === 0) { cids.push(u16(at)); at += 2; continue; }
    const first = u16(at);
    const left = format === 1 ? cff[at + 2] : u16(at + 2);
    for (let cid = first; cid <= first + left; cid += 1) cids.push(cid);
    at += format === 1 ? 3 : 4;
  }
  return { cids, cidKeyed: operators.has(1230) };
}

afterEach(() => vi.restoreAllMocks());

describe("Chinese, Japanese and Korean on the official filing copy", () => {
  it("draws Chinese, Japanese and Korean names and answers in the embedded CJK font, with each line's text in ActualText", () => {
    for (const lang of ["en", "es"]) {
      const pdf = latin1(renderFormFilingPdf(copy(), lang, { font: filingFont(), shaper }));
      expect(pdf).toMatch(/^%PDF-1\.5/);
      expect(pdf).toMatch(/\/Subtype \/CIDFontType0 \/BaseFont \/[A-Z]{6}\+NotoSansCJKsc-Regular /);
      expect(pdf).toMatch(/\/FontFile3 \d+ 0 R/);
      expect(pdf).toMatch(/<< \/Length \d+ \/Subtype \/CIDFontType0C \/Filter \/FlateDecode >>/);
      expect(actualTexts(pdf)).toEqual(expect.arrayContaining([
        `${lang === "es" ? "Descripción" : "Description"}: ${ANSWER}`, CHINESE_NAME, JAPANESE_NAME, KOREAN_NAME,
      ]));
      expect(pdf).toMatch(/<[0-9A-F]{4}> <674E>/);
      expect(pdf).toMatch(/<[0-9A-F]{4}> <C774>/);
      expect(pdf).not.toContain("[U+");
      expect(pdf).not.toContain("Characters this copy cannot draw");
    }
  });

  it("draws every CJK glyph by a CID its embedded CFF program has, with a width, and embeds only those glyphs", () => {
    const bytes = renderFormFilingPdf(copy(), "en", { font: filingFont(), shaper });
    const pdf = latin1(bytes);
    const drawn = new Set();
    for (const [, body] of pdf.matchAll(/BT \/S5 [\d.]+ Tf((?: [\d.-]+ [\d.-]+ Td <[0-9A-F]{4}> Tj)+) ET/g)) {
      for (const [, hex] of body.matchAll(/<([0-9A-F]{4})>/g)) drawn.add(parseInt(hex, 16));
    }
    expect(drawn.size).toBeGreaterThan(10);
    const match = /<< \/Length (\d+) \/Subtype \/CIDFontType0C \/Filter \/FlateDecode >>\nstream\n/.exec(pdf);
    const start = match.index + match[0].length;
    const program = inflateSync(Buffer.from(bytes.subarray(start, start + Number(match[1]))));
    const { cids, cidKeyed } = cffCids(program);
    expect(cidKeyed).toBe(true);
    for (const cid of drawn) expect(cids, `CID ${cid}`).toContain(cid);
    expect(cids.length).toBe(drawn.size + 1);
    const widths = /\/Subtype \/CIDFontType0 [^\n]*\/W \[(.*)\] >>/.exec(pdf)[1];
    for (const cid of drawn) expect(widths).toContain(`${cid} [`);
  });

  it("sets a line with kana in Japanese glyph forms and one with Hangul in Korean ones", () => {
    const glyph = (text) => shaper.layout(text, { size: 10, width: 500 }).lines[0].runs.find((run) => run.key === "cjk").glyphs[0].g;
    const chinese = glyph("直");
    expect(glyph("直あ")).not.toBe(chinese);
    expect(glyph("直 가")).not.toBe(chinese);
  });

  it("breaks a long sentence without spaces between characters, inside the frame", () => {
    const text = "中文字加有支付尽快处理".repeat(12);
    const { lines } = shaper.layout(text, { size: 10, width: 300 });
    expect(lines.length).toBeGreaterThan(2);
    for (const line of lines) expect(line.width).toBeLessThanOrEqual(300);
    for (const line of lines.slice(0, -1)) expect(line.width).toBeGreaterThan(280);
    expect(lines.map((line) => line.actualText).join("")).toBe(text);
  });

  it("prints codes with the note, byte for byte as without the shaper, when the CJK font cannot be read, and says so once", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const missing = await loadFilingShaper({ cjkFont: MISSING });
    const expected = Buffer.from(renderFormFilingPdf(copy(), "en", { font: filingFont() }));
    expect(Buffer.from(renderFormFilingPdf(copy(), "en", { font: filingFont(), shaper: missing })).equals(expected)).toBe(true);
    expect(latin1(expected)).toContain("Characters this copy cannot draw are written as their Unicode code in brackets");
    renderFormFilingPdf(copy(), "es", { font: filingFont(), shaper: missing });
    expect(error).toHaveBeenCalledTimes(1);
    expect(error).toHaveBeenCalledWith("[form-filing] CJK font unavailable", { error: expect.stringContaining("no-such-cjk-font.otf") });
  });

  // The CJK font is offered only for
  // CJK characters, so a symbol it also has (①, ★) prints the same whether or
  // not this instance has already drawn a CJK copy.
  it("draws a copy without CJK text byte for byte the same before and after the instance drew a CJK copy", async () => {
    const fresh = await loadFilingShaper({ cjkFont: FIXTURE });
    const arabic = copy();
    arabic.form.answers.description = "الدوام ① ★ مدفوع";
    arabic.filer.name = "محمد علي";
    arabic.filerSignature = { signedAt: "2026-11-14T15:00:00Z", signatureDigest: "sig", strokes: typed("محمد ★") };
    arabic.cosigners = [];
    const before = Buffer.from(renderFormFilingPdf(arabic, "en", { font: filingFont(), shaper: fresh }));
    expect(latin1(before)).toContain("Characters this copy cannot draw are written as their Unicode code in brackets");
    renderFormFilingPdf(copy(), "en", { font: filingFont(), shaper: fresh });
    expect(Buffer.from(renderFormFilingPdf(arabic, "en", { font: filingFont(), shaper: fresh })).equals(before)).toBe(true);
    // Within one copy too: an Arabic answer after a CJK name still writes the code.
    const mixed = copy();
    mixed.form.answers.description = "الدوام ① مدفوع";
    expect(actualTexts(latin1(renderFormFilingPdf(mixed, "en", { font: filingFont(), shaper: fresh })))).toContain("Description: الدوام [U+2460] مدفوع");
    // A symbol right after a CJK character joins that character's run.
    expect(fresh.layout("李①", { size: 10, width: 500 })).toMatchObject({ uncovered: false });
  });

  // The review of #8761, P1: characters CJK writers type that are not in a
  // CJK script (the long-vowel mark ー is Script=Common) are drawn from the
  // CJK font by block. Its P3: CJK-only symbols (㎡, ㈱) draw after a Latin
  // word in a CJK line too. Both on a cold and on a warm instance.
  it("draws the long-vowel mark in katakana words and names, and CJK-only symbols after a Latin word", async () => {
    for (const each of [await loadFilingShaper({ cjkFont: FIXTURE }), shaper]) {
      for (const text of ["コーヒー", "ユーコ", "山田 ユーコ", "中 Room 5㎡", "中 Acme ㈱"]) {
        expect(each.layout(text, { size: 10, width: 500 }).uncovered, text).toBe(false);
      }
    }
    const japanese = copy();
    japanese.form.answers.description = "コーヒー ユーコ";
    japanese.filerSignature = { signedAt: "2026-11-14T15:00:00Z", signatureDigest: "sig", strokes: typed("ユーコ") };
    japanese.cosigners = [];
    const pdf = latin1(renderFormFilingPdf(japanese, "en", { font: filingFont(), shaper }));
    expect(actualTexts(pdf)).toEqual(expect.arrayContaining(["Description: コーヒー ユーコ", "ユーコ"]));
    expect(pdf).not.toContain("[U+");
    expect(pdf).not.toContain("Characters this copy cannot draw");
  });

  // In a text that holds a
  // CJK character, the CJK font is offered for every character, so ①, ★,
  // → and ○ draw at the start of an answer and after its "Label: " or a
  // Latin word; the choice depends only on the text, so cold equals warm.
  it("draws a symbol anywhere in a text that holds a CJK character, the same cold and warm", async () => {
    const answer = copy();
    answer.form.answers.description = "① 山田 ★ OK → ○";
    answer.filer.name = "Member";
    answer.filerSignature = { signedAt: "2026-11-14T15:00:00Z", signatureDigest: "sig", strokes: typed("① 山田") };
    answer.cosigners = [];
    const cold = await loadFilingShaper({ cjkFont: FIXTURE });
    const first = Buffer.from(renderFormFilingPdf(answer, "en", { font: filingFont(), shaper: cold }));
    const pdf = latin1(first);
    expect(actualTexts(pdf)).toEqual(expect.arrayContaining(["Description: ① 山田 ★ OK → ○", "① 山田"]));
    expect(pdf).not.toContain("[U+");
    expect(pdf).not.toContain("Characters this copy cannot draw");
    renderFormFilingPdf(copy(), "en", { font: filingFont(), shaper: cold });
    expect(Buffer.from(renderFormFilingPdf(answer, "en", { font: filingFont(), shaper: cold })).equals(first)).toBe(true);
    expect(Buffer.from(renderFormFilingPdf(answer, "en", { font: filingFont(), shaper })).equals(first)).toBe(true);
  });

  // An answer whose only CJK characters are fullwidth
  // forms, the postal mark or a lone long-vowel mark is drawn too; without
  // the CJK font it prints codes and the note, as before; a Western copy
  // with a symbol only the CJK font has stays as it was.
  it("draws an answer of fullwidth digits, the postal mark or a lone long-vowel mark, and leaves other Western copies unchanged", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const missing = await loadFilingShaper({ cjkFont: MISSING });
    const western = (text) => {
      const each = copy();
      each.form.answers.description = text;
      each.filer.name = "Member";
      each.filerSignature = { signedAt: "2026-11-14T15:00:00Z", signatureDigest: "sig", strokes: typed("Member") };
      each.cosigners = [];
      return each;
    };
    for (const text of ["０９０－１２３４－５６７８", "〒１２３－４５６７", "ー"]) {
      const pdf = latin1(renderFormFilingPdf(western(text), "en", { font: filingFont(), shaper }));
      expect(actualTexts(pdf), text).toContain(`Description: ${text}`);
      expect(pdf, text).not.toContain("[U+");
      const fontOnly = Buffer.from(renderFormFilingPdf(western(text), "en", { font: filingFont() }));
      expect(latin1(fontOnly)).toContain("Characters this copy cannot draw are written as their Unicode code in brackets");
      expect(Buffer.from(renderFormFilingPdf(western(text), "en", { font: filingFont(), shaper: missing })).equals(fontOnly), text).toBe(true);
    }
    expect(error).toHaveBeenCalledWith("[form-filing] CJK font unavailable", expect.anything());
    const symbol = western("Steps ① ★ → ○ done");
    expect(Buffer.from(renderFormFilingPdf(symbol, "en", { font: filingFont(), shaper })).equals(Buffer.from(renderFormFilingPdf(symbol, "en", { font: filingFont() })))).toBe(true);
  });

  // The answer line asks the shaper about the trimmed text it
  // draws, so an ideographic space at its end, trimmed and never drawn, no
  // longer shapes it alone. Typed names, and an answer's leading U+3000 (inside
  // the line, after its label), are drawn exactly as before.
  it("leaves an answer whose only CJK character is a trailing ideographic space unshaped, and keeps typed names and a leading one as they were", () => {
    const western = (answer, name = "Member") => {
      const each = copy();
      each.form.answers.description = answer;
      each.filer.name = "Member";
      each.filerSignature = { signedAt: "2026-11-14T15:00:00Z", signatureDigest: "sig", strokes: typed(name) };
      each.cosigners = [];
      return each;
    };
    const trailing = western("room B\u3000");
    expect(Buffer.from(renderFormFilingPdf(trailing, "en", { font: filingFont(), shaper }))
      .equals(Buffer.from(renderFormFilingPdf(trailing, "en", { font: filingFont() })))).toBe(true);
    for (const name of ["\u3000Ann Lee", "Ann Lee\u3000", "\u3000Ann Lee\u3000"]) {
      const pdf = latin1(renderFormFilingPdf(western("room B", name), "en", { font: filingFont(), shaper }));
      expect(actualTexts(pdf), JSON.stringify(name)).toContain("Ann Lee");
      expect(pdf, JSON.stringify(name)).not.toContain("[U+");
      expect(pdf, JSON.stringify(name)).not.toContain("Characters this copy cannot draw");
    }
    const leading = latin1(renderFormFilingPdf(western("\u3000room B"), "en", { font: filingFont(), shaper }));
    expect(actualTexts(leading)).toContain("Description: \u3000room B");
    expect(leading).not.toContain("[U+");
  });

  it("never reads the CJK font for a copy without Chinese, Japanese or Korean text", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const missing = await loadFilingShaper({ cjkFont: MISSING });
    const arabic = copy();
    arabic.form.answers.description = "الدوام الإضافي غير مدفوع ❤";
    arabic.filer.name = "محمد علي";
    arabic.filerSignature = { signedAt: "2026-11-14T15:00:00Z", signatureDigest: "sig", strokes: typed("محمد علي") };
    arabic.cosigners = [];
    expect(latin1(renderFormFilingPdf(arabic, "en", { font: filingFont(), shaper: missing }))).toContain("/ActualText");
    expect(error).not.toHaveBeenCalled();
  });

  // Runs where the pinned font has been fetched (the Vercel build, or
  // `node scripts/fetch-filing-cjk-font.mjs`); CI has no copy of it.
  it.skipIf(!existsSync(CJK_FONT.path))("with the pinned font, draws a whole Korean answer", async () => {
    expect(await sha256Hex(readFileSync(CJK_FONT.path))).toBe(CJK_FONT.sha256);
    const full = await loadFilingShaper();
    const korean = copy();
    korean.form.answers.description = "초과 근무 수당을 받지 못했습니다";
    korean.filerSignature = { signedAt: "2026-11-14T15:00:00Z", signatureDigest: "sig", strokes: typed("이지은") };
    const pdf = latin1(renderFormFilingPdf(korean, "en", { font: filingFont(), shaper: full }));
    expect(pdf).not.toContain("[U+");
    expect(actualTexts(pdf)).toEqual(expect.arrayContaining(["이지은", "Description: 초과 근무 수당을 받지 못했습니다"]));
  });
});
