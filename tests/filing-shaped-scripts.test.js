// @vitest-environment node
// REQ-UG-FILING-COPY-DRAWS-CJK-ARABIC-HEBREW-DEVANAGARI-TEXT-20261114 (#8725), step 1:
// Arabic, Hebrew and Devanagari names and answers are shaped and drawn on the
// official filing copy, and every embedded font is subset to what the copy
// draws. These tests run without the CJK font (as CI does), so Chinese,
// Japanese and Korean stay [U+XXXX] codes with the note here; step 2 draws
// them with it (tests/filing-cjk-scripts.test.js).
import { readFileSync } from "node:fs";
import { inflateSync } from "node:zlib";
import { describe, expect, it, vi } from "vitest";
import { extractText, getDocumentProxy } from "unpdf";
import * as harfbuzz from "harfbuzzjs";
import bidiFactory from "bidi-js";
import { filingFont } from "../api/_lib/filingFont.js";
import { createShaper, filingShaper, loadFilingShaper } from "../api/_lib/filingShaper.js";
import { readFilingFont } from "../src/lib/filingFont.js";
import { renderFormFilingPdf } from "../src/lib/formFilingPdf.js";

// A CJK font path that does not exist: the shaper logs once and writes codes.
vi.spyOn(console, "error").mockImplementation(() => {});
const shaper = await loadFilingShaper({ cjkFont: new URL("./fixtures/fonts/no-such-cjk-font.otf", import.meta.url) });
const ARABIC_NAME = "محمد علي";
const ARABIC_ANSWER = "الدوام الإضافي (2024) غير مدفوع";
const HEBREW_NAME = "דוד כהן";
const DEVANAGARI_NAME = "प्रिया शर्मा";
const CJK = "李小龍";

const base = () => ({
  form: { id: "f2010001-1111-4111-8111-111111111111", template_key: "service_request", template_version: 1, answers: { description: "Proof" } },
  template: { label_en: "Service request", label_es: "Solicitud", field_schema: { steps: [{ title: { en: "Request", es: "Solicitud" }, fields: [{ key: "description", label: { en: "Description", es: "Descripción" } }] }] } },
  filer: { id: "u1", name: "Member" },
  filerSignature: { signedAt: "2026-11-14T15:00:00Z", signatureDigest: "sig", strokes: [[{ x: 10, y: 10 }, { x: 900, y: 900 }]] },
  cosigners: [],
  attachments: [],
  approval: { approvedBy: "s1", approvedAt: "2026-11-14T16:00:00Z", reviewerName: "Steward", note: null, artifactDigest: "artifact" },
});
const scripts = () => {
  const copy = base();
  copy.form.answers.description = ARABIC_ANSWER;
  copy.filer.name = ARABIC_NAME;
  copy.filerSignature = { signedAt: "2026-11-14T15:00:00Z", signatureDigest: "sig", strokes: { kind: "typed", name: ARABIC_NAME } };
  copy.cosigners = [
    { id: "c1", name: HEBREW_NAME, status: "accepted", signedAt: "2026-11-14T15:05:00Z", signatureDigest: "d1", strokes: { kind: "typed", name: HEBREW_NAME } },
    { id: "c2", name: DEVANAGARI_NAME, status: "accepted", signedAt: "2026-11-14T15:06:00Z", signatureDigest: "d2", strokes: { kind: "typed", name: DEVANAGARI_NAME } },
  ];
  return copy;
};
const latin1 = (bytes) => Buffer.from(bytes).toString("latin1");
const actualTexts = (pdf) => [...pdf.matchAll(/\/ActualText <FEFF([0-9A-F]*)>/g)]
  .map(([, hex]) => String.fromCharCode(...(hex.match(/.{4}/g) || []).map((unit) => parseInt(unit, 16))));

// The glyph ids with outlines in an embedded TrueType program, and the
// component glyphs composite glyphs draw.
function outlinedGlyphs(program) {
  const u16 = (at) => (program[at] << 8) | program[at + 1];
  const u32 = (at) => ((program[at] << 24) >>> 0) + (program[at + 1] << 16) + (program[at + 2] << 8) + program[at + 3];
  const tables = new Map();
  for (let index = 0; index < u16(4); index += 1) {
    const at = 12 + (index * 16);
    tables.set(String.fromCharCode(...program.subarray(at, at + 4)), u32(at + 8));
  }
  const long = u16(tables.get("head") + 50) === 1;
  const count = u16(tables.get("maxp") + 4);
  const offset = (glyph) => (long ? u32(tables.get("loca") + (glyph * 4)) : u16(tables.get("loca") + (glyph * 2)) * 2);
  const outlined = new Set();
  const components = new Set();
  for (let glyph = 0; glyph < count; glyph += 1) {
    if (offset(glyph + 1) === offset(glyph)) continue;
    outlined.add(glyph);
    let at = tables.get("glyf") + offset(glyph);
    if ((u16(at) & 0x8000) === 0) continue;
    at += 10;
    for (let more = true; more;) {
      const flags = u16(at);
      components.add(u16(at + 2));
      at += 4 + (flags & 1 ? 4 : 2) + (flags & 8 ? 2 : flags & 0x40 ? 4 : flags & 0x80 ? 8 : 0);
      more = (flags & 0x20) !== 0;
    }
  }
  return { outlined, components };
}

describe("shaped scripts on the official filing copy", () => {
  it("loads the shaper with its fonts", async () => {
    expect(shaper).toBeTruthy();
    expect(await filingShaper()).toBeTruthy();
  });

  it("keeps each line's stored text exactly in ActualText, for Arabic, Hebrew and Devanagari, in English and Spanish", () => {
    for (const lang of ["en", "es"]) {
      const pdf = latin1(renderFormFilingPdf(scripts(), lang, { font: filingFont(), shaper }));
      expect(pdf).toMatch(/^%PDF-1\.5/);
      const texts = actualTexts(pdf);
      expect(texts).toEqual(expect.arrayContaining([
        `${lang === "es" ? "Descripción" : "Description"}: ${ARABIC_ANSWER}`,
        ARABIC_NAME, HEBREW_NAME, DEVANAGARI_NAME,
      ]));
      for (const name of ["NotoSansArabic-Regular", "NotoSansHebrew-Regular", "NotoSansDevanagari-Regular"]) {
        expect(pdf).toMatch(new RegExp(`/Subtype /CIDFontType2 /BaseFont /[A-Z]{6}\\+${name}`));
      }
      expect(pdf).not.toContain("[U+");
    }
  });

  it("lets a PDF reader that does its own right-to-left ordering (pdf.js) read Arabic and Hebrew names exactly", async () => {
    const bytes = renderFormFilingPdf(scripts(), "en", { font: filingFont(), shaper });
    const { text } = await extractText(await getDocumentProxy(new Uint8Array(bytes)), { mergePages: true });
    const lines = text.split("\n");
    expect(lines).toContain(ARABIC_NAME);
    expect(lines).toContain(HEBREW_NAME);
  });

  it("right-aligns a typed name written right to left inside its frame, and keeps label lines left to right", () => {
    const pdf = latin1(renderFormFilingPdf(scripts(), "en", { font: filingFont(), shaper }));
    const starts = (text) => {
      const hex = [...text].map((char) => char.charCodeAt(0).toString(16).toUpperCase().padStart(4, "0")).join("");
      const at = pdf.indexOf(`/ActualText <FEFF${hex}>`);
      return Number(/Tf ([\d.]+) [\d.-]+ Td/.exec(pdf.slice(at))[1]);
    };
    expect(starts(HEBREW_NAME)).toBeGreaterThan(400);
    expect(starts(ARABIC_NAME)).toBeGreaterThan(400);
    expect(starts(DEVANAGARI_NAME)).toBeLessThan(80);
    expect(starts(`${HEBREW_NAME} - Signed - Typed signature`)).toBe(48);
  });

  it("still writes Chinese, Japanese and Korean as codes with the note, as before the shaper", () => {
    const copy = base();
    copy.form.answers.description = `Name ${CJK} 이지은`;
    const pdf = latin1(renderFormFilingPdf(copy, "en", { font: filingFont(), shaper }));
    // Drawn in the full Noto Sans by glyph id (the code's own characters), as on Main.
    expect(pdf).toMatch(/BT \/F3 10 Tf [\d.]+ [\d.]+ Td <[0-9A-F]+> Tj ET/);
    expect(pdf).not.toMatch(/\/S\d \d+ 0 R/);
    expect(pdf).toContain("Characters this copy cannot draw are written as their Unicode code in brackets");
    expect(pdf).not.toContain("/ActualText");
  });

  it("embeds only the glyphs the copy draws, in fonts much smaller than the files", () => {
    const pdf = renderFormFilingPdf(scripts(), "en", { font: filingFont(), shaper });
    const text = latin1(pdf);
    const drawn = new Map();
    for (const [, resource, body] of text.matchAll(/BT \/S(\d) [\d.]+ Tf((?: [\d.-]+ [\d.-]+ Td <[0-9A-F]{4}> Tj)+) ET/g)) {
      const set = drawn.get(resource) ?? new Set([0]);
      for (const [, hex] of body.matchAll(/<([0-9A-F]{4})>/g)) set.add(parseInt(hex, 16));
      drawn.set(resource, set);
    }
    const programs = [...text.matchAll(/<< \/Length (\d+) \/Length1 \d+ \/Filter \/FlateDecode >>\nstream\n/g)];
    expect(programs).toHaveLength(4);
    for (const match of programs) {
      const start = match.index + match[0].length;
      const program = inflateSync(Buffer.from(pdf.subarray(start, start + Number(match[1]))));
      expect(Number(match[1])).toBeLessThan(40000);
      const { outlined, components } = outlinedGlyphs(program);
      const everyDrawn = new Set([...drawn.values()].flatMap((set) => [...set]));
      for (const glyph of outlined) expect(everyDrawn.has(glyph) || components.has(glyph), `glyph ${glyph}`).toBe(true);
    }
  });

  // #8737 review P1-1: only text Noto Sans cannot draw is shaped. Western
  // copies, typed names included, are drawn as with the font alone (Main).
  it("leaves every copy Noto Sans alone draws byte for byte as without the shaper: typed names, WinAnsi extras, Polish, CJK", () => {
    const typed = (name) => ({ signedAt: "2026-11-14T15:00:00Z", signatureDigest: "sig", strokes: { kind: "typed", name } });
    const variants = [
      (copy) => { copy.form.answers.description = "Señora Pérez — “horas” extra…"; },
      (copy) => { copy.filerSignature = typed("Griffin Office Waffle AVATAR"); },
      (copy) => { copy.filerSignature = typed("Jose Cosigner"); copy.cosigners = [{ id: "c1", name: "Ana Núñez", status: "accepted", signedAt: "2026-11-14T15:05:00Z", signatureDigest: "d1", strokes: { kind: "typed", name: "Ana Núñez" } }]; },
      (copy) => { copy.form.answers.description = "Paid € 40 to Œuvre™ Šimon žaba Ÿves ‰ ƒ"; copy.filer.name = "Œdipe Šťastný"; copy.filerSignature = typed("Œdipe Šťastný €"); },
      (copy) => { copy.form.answers.description = "Overtime at the Łódź warehouse"; copy.filerSignature = typed("Łukasz Kowalski"); },
      (copy) => { copy.form.answers.description = `Name ${CJK}`; copy.filerSignature = typed(`${CJK} Lee`); },
      // #8737 re-review P2-B: U+2212 is in the Devanagari font, but it is not
      // Devanagari text, so the copy is drawn as on Main (a code and the note).
      (copy) => { copy.form.answers.description = "Office coffee deduction \u2212$40, AVATAR"; copy.filerSignature = typed("Ann \u2212 Lee"); },
    ];
    for (const lang of ["en", "es"]) {
      for (const [index, change] of variants.entries()) {
        const copy = base();
        change(copy);
        const fontOnly = Buffer.from(renderFormFilingPdf(copy, lang, { font: filingFont() }));
        const shaped = Buffer.from(renderFormFilingPdf(copy, lang, { font: filingFont(), shaper }));
        expect(shaped.equals(fontOnly), `${lang} variant ${index}`).toBe(true);
        expect(latin1(shaped)).toMatch(/^%PDF-1\.4/);
      }
    }
    const plain = base();
    plain.form.answers.description = "Señora Pérez — “horas” extra";
    expect(Buffer.from(renderFormFilingPdf(plain, "en", { font: filingFont(), shaper })).equals(Buffer.from(renderFormFilingPdf(plain, "en")))).toBe(true);
  });

  // #8737 review P1-2: Arabic words are measured in their own direction, so
  // no line runs past the frame.
  it("keeps every line of a multi-line Arabic paragraph, with and without harakat, inside the frame", () => {
    const paragraphs = [
      "لم يتم دفع أجر العمل الإضافي عن الأسابيع الثلاثة الماضية رغم أنني طلبت ذلك من المشرف مرتين ولم أحصل على أي رد حتى الآن ".repeat(6),
      "كَتَبَ بِسْمِ اللَّهِ الرَّحْمَٰنِ الرَّحِيمِ وَعَمِلَ سَاعَاتٍ إِضَافِيَّةً ".repeat(8),
      "كتب ".repeat(80),
      "نبت ".repeat(80),
    ];
    for (const text of paragraphs) {
      for (const width of [504, 516, 400]) {
        const { lines } = shaper.layout(text.trim(), { size: 10, width });
        expect(lines.length).toBeGreaterThan(1);
        for (const line of lines) expect(line.width).toBeLessThanOrEqual(width);
        expect(lines.map((line) => line.actualText).join(" ")).toBe(text.trim());
      }
    }
    const copy = base();
    copy.form.answers.description = paragraphs[0].trim();
    const pdf = latin1(renderFormFilingPdf(copy, "en", { font: filingFont(), shaper }));
    expect(actualTexts(pdf).join(" ")).toBe(`Description: ${paragraphs[0].trim()}`);
  });

  // #8737 review P1-3: a word wider than a line breaks between grapheme
  // clusters, never between a consonant and its virama or vowel sign.
  it("breaks a spaceless Devanagari word wider than a line only between grapheme clusters, and fills each line", () => {
    const graphemes = new Intl.Segmenter("und", { granularity: "grapheme" });
    for (const word of ["क्षत्रिय".repeat(45), "प्रिया".repeat(60), "स्त्री".repeat(50)]) {
      const boundaries = new Set([...graphemes.segment(word)].map(({ index }) => index));
      for (const width of [516, 504, 300]) {
        const { lines } = shaper.layout(word, { size: 10, width });
        expect(lines.length).toBeGreaterThan(1);
        expect(lines.map((line) => line.actualText).join("")).toBe(word);
        let at = 0;
        for (const [index, line] of lines.entries()) {
          expect(boundaries.has(at), `line ${index} starts inside a cluster`).toBe(true);
          expect(line.actualText).not.toMatch(/^\p{M}/u);
          expect(line.width).toBeLessThanOrEqual(width);
          if (index < lines.length - 1) expect(line.width).toBeGreaterThan(width * 0.9);
          at += line.actualText.length;
        }
      }
    }
  });

  // #8737 re-review P1-A: a [U+XXXX] code in right-to-left text is drawn
  // left to right, exactly as written, and placed in right-to-left order.
  it("draws a [U+XXXX] code inside right-to-left text exactly, never reversed or mirrored", () => {
    const latinFont = filingFont();
    const chars = new Map([..."[]U+0123456789ABCDEF"].map((char) => [latinFont.glyph(char.codePointAt(0)), char]));
    const codeRuns = (shaped) => shaped.runs.filter((run) => run.key === "latin")
      .map((run) => ({ x: Math.min(...run.glyphs.map((glyph) => glyph.x)), text: [...run.glyphs].sort((a, b) => a.x - b.x).map((glyph) => chars.get(glyph.g) ?? "?").join("") }))
      .filter((run) => run.text.includes("[U+"));
    const name = (text) => shaper.layout(text, { size: 13, width: 468, direction: "auto" }).lines[0];
    expect(codeRuns(name("דוד כהן ❤")).map((run) => run.text)).toEqual(["[U+2764]"]);
    expect(codeRuns(name(`محمد ${CJK.slice(0, 1)} علي`)).map((run) => run.text)).toEqual(["[U+674E]"]);
    const embedded = shaper.layout(`Note: \u202Bשלום ${CJK.slice(0, 1)}\u202C`, { size: 10, width: 516 }).lines[0];
    expect(codeRuns(embedded).map((run) => run.text)).toEqual(["[U+674E]"]);
    // Two neutral codes between Hebrew letters read right to left: the first
    // stands to the right of the second.
    expect(codeRuns(name("דוד ❤☕ כהן")).sort((a, b) => a.x - b.x).map((run) => run.text)).toEqual(["[U+2615]", "[U+2764]"]);
    // Two strong left-to-right characters stay left to right (third review).
    expect(codeRuns(name("דוד 李王 כהן")).sort((a, b) => a.x - b.x).map((run) => run.text)).toEqual(["[U+674E]", "[U+738B]"]);
    // On the copy itself: the typed name's code is written glyph by glyph in order.
    const copy = base();
    copy.filerSignature = { signedAt: "2026-11-14T15:00:00Z", signatureDigest: "sig", strokes: { kind: "typed", name: "דוד כהן ❤" } };
    const pdf = latin1(renderFormFilingPdf(copy, "en", { font: latinFont, shaper }));
    const shown = [...pdf.matchAll(/BT \/S1 13 Tf((?: [\d.-]+ [\d.-]+ Td <[0-9A-F]{4}> Tj)+) ET/g)]
      .map(([, body]) => [...body.matchAll(/<([0-9A-F]{4})>/g)].map(([, hex]) => chars.get(parseInt(hex, 16)) ?? "?").join(""));
    expect(shown).toContain("[U+2764]");
    expect(pdf).toContain("Characters this copy cannot draw are written as their Unicode code in brackets");
  });

  // #8737 third review P1-B: bidi levels come from the characters a code
  // stands for, not its letters, so a symbol between two right-to-left words
  // in a left-to-right line keeps them in right-to-left order.
  it("keeps right-to-left words around a symbol in order in a left-to-right answer, note and name label", () => {
    const copy = base();
    copy.form.answers.description = "مرحبا ❤ عالم";
    copy.approval.note = "The note says שלום ☕ עולם today";
    copy.cosigners = [{ id: "c1", name: "דוד ❤ כהן", status: "accepted", signedAt: "2026-11-14T15:05:00Z", signatureDigest: "d1", strokes: { kind: "typed", name: "דוד ❤ כהן" } }];
    const pdf = latin1(renderFormFilingPdf(copy, "en", { font: filingFont(), shaper }));
    // The glyph ids of each right-to-left block of a line, in drawing order.
    const blocks = (needle, resource) => {
      const text = actualTexts(pdf).find((each) => each.includes(needle));
      const hex = [...text].map((char) => char.charCodeAt(0).toString(16).toUpperCase().padStart(4, "0")).join("");
      const at = pdf.indexOf(`/ActualText <FEFF${hex}>`);
      const span = pdf.slice(at, pdf.indexOf("EMC", at));
      return [...span.matchAll(new RegExp(`BT /${resource} [\\d.]+ Tf((?: [\\d.-]+ [\\d.-]+ Td <[0-9A-F]{4}> Tj)+) ET`, "g"))]
        .map(([, body]) => [...body.matchAll(/<([0-9A-F]{4})>/g)].map(([, glyph]) => parseInt(glyph, 16)));
    };
    const glyphs = (word) => shaper.layout(word, { size: 10, width: 516, direction: "rtl" }).lines[0].runs.flatMap((run) => run.glyphs.map((glyph) => glyph.g));
    for (const [needle, resource, first, second] of [
      ["مرحبا", "S2", "مرحبا", "عالم"],
      ["שלום", "S3", "שלום", "עולם"],
      ["דוד [U+2764] כהן - ", "S3", "דוד", "כהן"],
    ]) {
      const drawn = blocks(needle, resource);
      const block = (word) => drawn.findIndex((each) => JSON.stringify(each.slice(-glyphs(word).length)) === JSON.stringify(glyphs(word)));
      expect(block(first), needle).toBeGreaterThanOrEqual(0);
      expect(block(second), needle).toBeGreaterThanOrEqual(0);
      // Drawn left to right: the second word stands to the left of the first.
      expect(block(second), needle).toBeLessThan(block(first));
    }
  });

  // A code for a character outside the basic plane takes that
  // character's own bidi class, so math-styled digits read left to right as
  // a number between right-to-left words, and an emoji there is a neutral.
  it("keeps math-styled digits and an emoji outside the basic plane in order between right-to-left words", () => {
    const latinFont = filingFont();
    const chars = new Map([..."[]U+0123456789ABCDEF"].map((char) => [latinFont.glyph(char.codePointAt(0)), char]));
    const line = (text) => shaper.layout(text, { size: 10, width: 516 }).lines[0];
    const glyphs = (word) => shaper.layout(word, { size: 10, width: 516, direction: "rtl" }).lines[0].runs.flatMap((run) => run.glyphs.map((glyph) => glyph.g));
    const order = (placed, key, words) => {
      const blocks = placed.runs.filter((run) => run.key === key).map((run) => run.glyphs.map((glyph) => glyph.g));
      return words.map((word) => blocks.findIndex((block) => JSON.stringify(block.slice(-glyphs(word).length)) === JSON.stringify(glyphs(word))));
    };
    const digits = line("Paid \u062F\u0641\u0639 \u{1D7D2}\u{1D7CE} \u062F\u0648\u0644\u0627\u0631 today");
    const codes = digits.runs.filter((run) => run.key === "latin")
      .map((run) => [...run.glyphs].sort((a, b) => a.x - b.x).map((glyph) => chars.get(glyph.g) ?? "?").join(""))
      .filter((text) => text.startsWith("[U+"));
    expect(codes).toEqual(["[U+1D7D2]", "[U+1D7CE]"]);
    const [verb, noun] = order(digits, "arabic", ["\u062F\u0641\u0639", "\u062F\u0648\u0644\u0627\u0631"]);
    expect(noun).toBeGreaterThanOrEqual(0);
    expect(noun).toBeLessThan(verb);
    const emoji = line("Note \u0634\u0643\u0631\u0627 \u{1F64F} \u062C\u0632\u064A\u0644\u0627 end");
    const [thanks, much] = order(emoji, "arabic", ["\u0634\u0643\u0631\u0627", "\u062C\u0632\u064A\u0644\u0627"]);
    expect(much).toBeGreaterThanOrEqual(0);
    expect(much).toBeLessThan(thanks);
    expect(emoji.actualText).toBe("Note \u0634\u0643\u0631\u0627 [U+1F64F] \u062C\u0632\u064A\u0644\u0627 end");
  });

  // #8737 third review P3-1 and P3-3: ActualText is the line as printed, and
  // a single cluster wider than a line is broken between its units.
  it("puts a code into ActualText as printed, and breaks a cluster wider than a line", () => {
    const copy = base();
    copy.form.answers.description = `محمد ${CJK.slice(0, 1)} علي`;
    const pdf = latin1(renderFormFilingPdf(copy, "en", { font: filingFont(), shaper }));
    expect(actualTexts(pdf)).toContain("Description: محمد [U+674E] علي");
    const wide = `ب${"\u0F72\u0F74".repeat(10)}`;
    const { lines, uncovered } = shaper.layout(wide, { size: 10, width: 300 });
    expect(uncovered).toBe(true);
    expect(lines.length).toBeGreaterThan(1);
    for (const line of lines) expect(line.width).toBeLessThanOrEqual(300);
    expect(lines.map((line) => line.actualText).join("")).toBe(`ب${"[U+0F72][U+0F74]".repeat(10)}`);
  });

  // #8737 re-review P2-A: harfbuzzjs frees a buffer only when it is garbage
  // collected, so the shaper keeps one buffer and resets it for each run.
  it("shapes a long paragraph with one HarfBuzz buffer", () => {
    let created = 0;
    class CountingBuffer extends harfbuzz.Buffer {
      constructor(...args) { super(...args); created += 1; }
    }
    const hb = { ...harfbuzz, Buffer: CountingBuffer };
    const fonts = new Map(["NotoSans-Regular", "NotoSansArabic-Regular", "NotoSansHebrew-Regular", "NotoSansDevanagari-Regular"].map((file, index) => {
      const bytes = readFileSync(new URL(`../api/_lib/fonts/${file}.ttf`, import.meta.url));
      const metrics = readFilingFont(bytes);
      const key = ["latin", "arabic", "hebrew", "devanagari"][index];
      return [key, { key, bytes: metrics.bytes, metrics, font: new harfbuzz.Font(new harfbuzz.Face(new harfbuzz.Blob(bytes))), scale: 1 / metrics.unitsPerEm }];
    }));
    const counted = createShaper({ hb, bidi: bidiFactory(), fonts, subsetModule: null });
    const text = "a ب 1 ".repeat(400).trim();
    const { lines } = counted.layout(text, { size: 10, width: 504 });
    expect(lines.length).toBeGreaterThan(3);
    expect(lines.map((line) => line.actualText).join(" ")).toBe(text);
    expect(created).toBe(1);
  });

  it("is deterministic for the same copy", () => {
    const first = renderFormFilingPdf(scripts(), "es", { font: filingFont(), shaper });
    expect(Buffer.from(first).equals(Buffer.from(renderFormFilingPdf(scripts(), "es", { font: filingFont(), shaper })))).toBe(true);
  });
});
