// @vitest-environment node
import { describe, expect, it } from "vitest";
import { renderFormFilingPdf } from "../src/lib/formFilingPdf.js";
import { filingFont } from "../api/_lib/filingFont.js";

const payload = {
  form: {
    id: "f2010001-1111-4111-8111-111111111111",
    template_key: "alliance_grievance",
    template_version: 4,
    status: "approved",
    answers: {
      summary: "Unsafe (and urgent) staffing\\coverage",
      shift: "night",
      affected: ["unit", "float"],
    },
  },
  template: {
    label_en: "Alliance grievance",
    label_es: "Queja de la alianza",
    field_schema: {
      steps: [{
        title: { en: "Incident", es: "Incidente" },
        fields: [
          { key: "summary", type: "textarea", label: { en: "Summary", es: "Resumen" } },
          {
            key: "shift", type: "select", label: { en: "Shift", es: "Turno" },
            options: [{ value: "night", label: { en: "Night", es: "Noche" } }],
          },
          {
            key: "affected", type: "multiselect", label: { en: "Affected", es: "Personas afectadas" },
            options: [
              { value: "unit", label: { en: "Unit", es: "Unidad" } },
              { value: "float", label: { en: "Float pool", es: "Equipo flotante" } },
            ],
          },
        ],
      }],
    },
  },
  filer: { id: "filer-1", name: "María Member" },
  filerSignature: {
    signedAt: "2026-08-12T14:00:00.000Z",
    signatureDigest: "filer-digest",
    strokes: [[{ x: 20, y: 300 }, { x: 500, y: 50 }, { x: 950, y: 500 }]],
  },
  cosigners: [
    {
      id: "cosign-1", email: "accepted@example.test", name: "José Cosigner",
      status: "accepted", signedAt: "2026-08-12T14:05:00.000Z",
      signatureDigest: "cosigner-digest",
      strokes: [[{ x: 10, y: 100 }, { x: 600, y: 900 }]],
    },
    { id: "cosign-2", email: "declined@example.test", status: "declined", strokes: null },
    { id: "cosign-3", email: "pending@example.test", status: "invited", strokes: null },
  ],
  attachments: [
    { filename: "staffing-note.pdf", mime_type: "application/pdf", size_bytes: 2048 },
  ],
  approval: {
    approvedBy: "steward-1",
    approvedAt: "2026-08-12T15:00:00.000Z",
    reviewerName: "Alex Steward",
    note: "Approved after review.",
    artifactDigest: "abc123artifact",
  },
};

const textOf = (bytes) => new TextDecoder("windows-1252").decode(bytes);

describe("renderFormFilingPdf", () => {
  it("returns deterministic, structurally valid PDF 1.4 bytes", () => {
    const first = renderFormFilingPdf(payload, "en");
    const second = renderFormFilingPdf(payload, "en");
    expect(first).toBeInstanceOf(Uint8Array);
    expect(textOf(first)).toMatch(/^%PDF-1\.4/);
    expect(textOf(first)).toContain("%%EOF");
    expect(Buffer.from(first).equals(Buffer.from(second))).toBe(true);
  });

  it("carries stable filing metadata without timestamps or private signature data", () => {
    const pdf = textOf(renderFormFilingPdf(payload, "en"));
    expect(pdf).toContain("/Title (Union Ground official filing copy - f2010001-1111-4111-8111-111111111111)");
    expect(pdf).toContain("/Author (Union Ground)");
    expect(pdf).toContain("/Subject (Approved Alliance grievance, version 4)");
    expect(pdf).toContain("/Creator (Union Ground filing renderer)");
    expect(pdf).toMatch(/\/Info \d+ 0 R/);
  });

  it("renders localized schema order, choice labels, and Spanish fallback", () => {
    const pdf = textOf(renderFormFilingPdf(payload, "es"));
    expect(pdf).toContain("Copia oficial de presentación de Union Ground");
    expect(pdf).toContain("Queja de la alianza");
    expect(pdf.indexOf("Resumen")).toBeLessThan(pdf.indexOf("Turno"));
    expect(pdf).toContain("Noche");
    expect(pdf).toContain("Unidad, Equipo flotante");

    const missingSpanish = structuredClone(payload);
    delete missingSpanish.template.field_schema.steps[0].fields[0].label.es;
    expect(textOf(renderFormFilingPdf(missingSpanish, "es"))).toContain("Summary");
  });

  it("draws signatures and states every unsigned co-signer outcome explicitly", () => {
    const pdf = textOf(renderFormFilingPdf(payload, "en"));
    expect(pdf).toContain("Filer signature - María Member");
    expect(pdf).toContain("José Cosigner - Signed");
    expect(pdf).toContain("declined@example.test - Declined - unsigned");
    expect(pdf).toContain("pending@example.test - Invited - unsigned");
    expect(pdf).toMatch(/\d+(?:\.\d+)? \d+(?:\.\d+)? m \d+(?:\.\d+)? \d+(?:\.\d+)? l S/);
  });

  it("prints typed signatures as the typed name marked typed, never as ink, in English and Spanish (#8701)", () => {
    const typed = structuredClone(payload);
    typed.filerSignature.strokes = { kind: "typed", name: "María L. Member" };
    typed.cosigners[0].strokes = { kind: "typed", name: "José A. Cosigner" };
    const english = textOf(renderFormFilingPdf(typed, "en"));
    expect(english).toContain("Filer signature - María Member - Typed signature");
    expect(english).toContain("(María L. Member) Tj");
    expect(english).toContain("José Cosigner - Signed - Typed signature");
    expect(english).toContain("(José A. Cosigner) Tj");
    expect(english.match(/Signed by typing this name and ticking the consent box\. Not a drawn signature\./g)).toHaveLength(2);
    expect(english).toContain("Signed: ");
    // No stroke path is drawn for a typed signature.
    expect(english).not.toMatch(/\d+(?:\.\d+)? \d+(?:\.\d+)? m \d+(?:\.\d+)? \d+(?:\.\d+)? l/);
    const spanish = textOf(renderFormFilingPdf(typed, "es"));
    expect(spanish).toContain("Firma escrita");
    expect(spanish).toContain("No es una firma dibujada.");
  });

  // What a PDF reader gets back from the embedded-font lines: each glyph id
  // through the copy's own ToUnicode map, checked against the font's glyph
  // for that character, so both the drawn glyphs and the text are exact.
  const typedLines = (pdf) => {
    const map = new Map([...pdf.matchAll(/<([0-9A-F]{4})> <([0-9A-F]+)>/g)].map(([, glyph, utf16]) => [
      parseInt(glyph, 16), String.fromCharCode(...utf16.match(/.{4}/g).map((unit) => parseInt(unit, 16)))]));
    const font = filingFont();
    return [...pdf.matchAll(/BT \/F3 13 Tf ([\d.]+) ([\d.]+) Td <([0-9A-F]+)> Tj ET/g)].map(([, , y, hex]) => {
      const text = hex.match(/.{4}/g).map((unit) => {
        const glyph = parseInt(unit, 16);
        const char = map.get(glyph);
        expect(font.glyph(char.codePointAt(0)), char).toBe(glyph);
        return char;
      }).join("");
      return { y: Number(y), text };
    });
  };

  it("prints filer and co-signer typed names outside WinAnsi exactly in the embedded font (#8701 gate r1s1)", () => {
    const typed = structuredClone(payload);
    typed.filerSignature.strokes = { kind: "typed", name: "\u0141ukasz Kowalski" };
    typed.cosigners[0].strokes = { kind: "typed", name: "\u0422\u0430\u0442\u044c\u044f\u043d\u0430 \u0160\u0165astn\u00e1 \u1ea0nh" };
    for (const lang of ["en", "es"]) {
      const pdf = textOf(renderFormFilingPdf(typed, lang, { font: filingFont() }));
      expect(typedLines(pdf).map((row) => row.text)).toEqual(["\u0141ukasz Kowalski", "\u0422\u0430\u0442\u044c\u044f\u043d\u0430 \u0160\u0165astn\u00e1 \u1ea0nh"]);
      expect(pdf).not.toContain("?ukasz");
      expect(pdf).toContain("/Subtype /Type0 /BaseFont /NotoSans-Regular /Encoding /Identity-H");
      expect(pdf).not.toContain("[U+");
    }
  });

  it("writes a character the font cannot draw as its bracketed code with a note, never as another character (#8701)", () => {
    const typed = structuredClone(payload);
    typed.filerSignature.strokes = { kind: "typed", name: "\u0410\u043d\u043d\u0430 \u09b8\u09c1\u09ae\u09a8 \u674e" };
    const pdf = textOf(renderFormFilingPdf(typed, "en", { font: filingFont() }));
    expect(typedLines(pdf).map((row) => row.text).join(" ")).toBe("\u0410\u043d\u043d\u0430 [U+09B8][U+09C1][U+09AE][U+09A8] [U+674E]");
    expect(pdf).toContain("Characters this copy cannot draw are written as their Unicode code in brackets");
    expect(textOf(renderFormFilingPdf(typed, "es", { font: filingFont() }))).toContain("se escriben con su c\u00f3digo Unicode entre corchetes");
    // Without the embedded font (the website's demo preview) WinAnsi decides: still no "?".
    const plain = textOf(renderFormFilingPdf({ ...typed, filerSignature: { ...typed.filerSignature, strokes: { kind: "typed", name: "\u0141ukasz Kowalski" } } }, "en"));
    expect(plain).toContain("([U+0141]ukasz Kowalski) Tj");
    expect(plain).toContain("Characters this copy cannot draw");
    expect(plain).not.toContain("?ukasz");
    expect(plain).not.toContain("/F3");
  });

  it("sizes the typed-signature frame to a wrapped name and keeps the note below it (#8701 gate r1s2)", () => {
    const typed = structuredClone(payload);
    const name = "Alexandria Catherine Elizabeth Francesca Genevieve Henrietta Isabella Josephine Katherine Louise";
    typed.filerSignature.strokes = { kind: "typed", name };
    for (const font of [filingFont(), null]) {
      const pdf = textOf(renderFormFilingPdf(typed, "en", { font }));
      const frame = /RG 1\.4 w [\d.]+ ([\d.]+) [\d.]+ ([\d.]+) re S\n((?:BT \/F[13] 13 Tf [^\n]*\n)+)BT \/F1 8 Tf [\d.]+ ([\d.]+) Td \(Signed by typing/.exec(pdf);
      expect(frame, font ? "embedded" : "plain").toBeTruthy();
      const [bottom, height, noteY] = [Number(frame[1]), Number(frame[2]), Number(frame[4])];
      const baselines = [...frame[3].matchAll(/Tf [\d.]+ ([\d.]+) Td/g)].map((match) => Number(match[1]));
      expect(baselines.length).toBeGreaterThan(1);
      // Every line sits inside the frame with room for descenders; the note starts below it.
      for (const baseline of baselines) {
        expect(baseline - 4).toBeGreaterThan(bottom);
        expect(baseline + 13).toBeLessThan(bottom + height + 1);
      }
      expect(noteY + 8).toBeLessThan(bottom);
      if (font) expect(typedLines(pdf).map((row) => row.text).join(" ")).toBe(name);
    }
  });

  it("breaks a typed name longer than a line between characters and keeps every line in the frame (#8701)", () => {
    const typed = structuredClone(payload);
    const name = `\u0141${"a".repeat(119)}`;
    typed.filerSignature.strokes = { kind: "typed", name };
    for (const font of [filingFont(), null]) {
      const pdf = textOf(renderFormFilingPdf(typed, "en", { font }));
      const frame = /RG 1\.4 w [\d.]+ ([\d.]+) [\d.]+ ([\d.]+) re S\n((?:BT \/F[13] 13 Tf [^\n]*\n)+)/.exec(pdf);
      const [bottom, height] = [Number(frame[1]), Number(frame[2])];
      const baselines = [...frame[3].matchAll(/Tf [\d.]+ ([\d.]+) Td/g)].map((match) => Number(match[1]));
      expect(baselines.length, font ? "embedded" : "plain").toBeGreaterThan(1);
      for (const baseline of baselines) {
        expect(baseline - 4).toBeGreaterThan(bottom);
        expect(baseline + 13).toBeLessThan(bottom + height + 1);
      }
      if (font) expect(typedLines(pdf).map((row) => row.text).join("")).toBe(name);
      else expect(pdf).toContain("([U+0141]aaa");
    }
  });

  it("prints a malformed signature material as unsigned rather than guessing (#8701)", () => {
    const odd = structuredClone(payload);
    odd.filerSignature.strokes = { kind: "typed", name: "María", extra: 1 };
    odd.cosigners[0].strokes = { kind: "drawn", name: "José" };
    const pdf = textOf(renderFormFilingPdf(odd, "en"));
    expect(pdf).toContain("Filer signature - unsigned");
    expect(pdf).toContain("José Cosigner - accepted - unsigned");
  });

  it("keeps signature metadata visibly clear of the signature box border", () => {
    const pdf = textOf(renderFormFilingPdf(payload, "en"));
    const clearances = [...pdf.matchAll(/\d+(?:\.\d+)? (\d+(?:\.\d+)?) \d+(?:\.\d+)? 52 re S[\s\S]*?BT \/F1 8 Tf \d+(?:\.\d+)? (\d+(?:\.\d+)?) Td \(Signed:/g)]
      .map((match) => Number(match[1]) - Number(match[2]));
    expect(clearances).toHaveLength(2);
    expect(Math.min(...clearances)).toBeGreaterThanOrEqual(12);
  });

  it("marks demo output and an absent filer signature explicitly", () => {
    const demo = structuredClone(payload);
    demo.demo = true;
    demo.filerSignature = null;
    const pdf = textOf(renderFormFilingPdf(demo, "en"));
    expect(pdf).toContain("DEMO PREVIEW - NOT AN OFFICIAL FILING");
    expect(pdf).toContain("Filer signature - unsigned");
    expect(pdf).not.toContain("Signed:     Artifact digest:");
  });

  it("includes the attachment manifest and frozen committee attestation", () => {
    const pdf = textOf(renderFormFilingPdf(payload, "en"));
    expect(pdf).toContain("staffing-note.pdf - application/pdf - 2 KB");
    expect(pdf).toContain("Attached files travel separately with this filing copy.");
    expect(pdf).toContain("Approved by Alex Steward");
    expect(pdf).toContain("abc123artifact");
    expect(pdf).toContain("Union Ground official filing copy");
  });

  it("escapes PDF string metacharacters and paginates bounded long content", () => {
    const long = structuredClone(payload);
    long.form.answers.summary = `Escaped (value) \\ ${"long narrative ".repeat(900)}`;
    const pdf = textOf(renderFormFilingPdf(long, "en"));
    expect(pdf).toContain("Escaped \\(value\\) \\\\ long narrative");
    const pageCount = Number(pdf.match(/\/Count (\d+)/)?.[1] || 0);
    expect(pageCount).toBeGreaterThan(1);
    expect(pageCount).toBeLessThan(30);
  });

  it("keeps the frozen approval attestation together when the first page is nearly full", () => {
    const crowded = structuredClone(payload);
    crowded.form.answers.notes = "Additional narrative ".repeat(63);
    crowded.approval.note = "approval-tail-marker";
    const pdf = textOf(renderFormFilingPdf(crowded, "es"));
    const pageStreams = [...pdf.matchAll(/stream\n([\s\S]*?)endstream/g)].map((match) => match[1]);
    const approvalPage = pageStreams.find((stream) => stream.includes("Constancia de aprobación del comité"));
    const approvalSection = approvalPage?.slice(approvalPage.indexOf("Constancia de aprobación del comité"));

    expect(approvalSection).toContain("approval-tail-marker");
    expect(approvalSection).toContain("abc123artifact");
  });

  it("renders bounded fallback values for sparse and malformed filing metadata", () => {
    const edge = {
      form: {
        id: "edge-form",
        template_key: "edge_template",
        template_version: 0,
        answers: {
          empty: "",
          selected: "missing-option",
          choices: [],
          approved: true,
          denied: false,
          structured: { safe: "value" },
          unlisted: "x".repeat(120),
        },
      },
      template: {
        label_en: "Edge – filing ☃",
        field_schema: {
          steps: [{
            title: "Fallback fields",
            fields: [
              { key: "empty", label: "Empty" },
              { key: "selected", type: "radio", label: "Selected", options: [] },
              { key: "choices", label: "Choices", options: [] },
              { key: "approved", label: "Approved flag" },
              { key: "denied", label: "Denied flag" },
              { key: "structured", label: "Structured" },
            ],
          }],
        },
      },
      filer: {},
      filerSignature: {
        signedAt: "not-a-date",
        signatureDigest: "edge-signature",
        strokes: [null, [{ x: -20, y: 2000 }], [{}, { x: 1200, y: -50 }]],
      },
      cosigners: [
        { id: "accepted-without-strokes", status: "accepted" },
        { id: "custom-state", status: "awaiting_review" },
      ],
      attachments: [
        { filename: "invalid.bin", size_bytes: -1 },
        { filename: "small.bin", size_bytes: 512 },
        { filename: "exact.bin", size_bytes: 1024 * 1024 },
        { filename: "fraction.bin", size_bytes: 1.5 * 1024 * 1024 },
      ],
      approval: { approvedBy: "reviewer-id", approvedAt: "not-a-date" },
    };

    const pdf = textOf(renderFormFilingPdf(edge, "fr"));
    // Without the embedded font a character WinAnsi lacks is written as its code, never "?" (#8716).
    expect(pdf).toContain("filing [U+2603]");
    expect(pdf).not.toContain("filing ?");
    expect(pdf).toContain("Empty: Not provided");
    expect(pdf).toContain("Selected: missing-option");
    expect(pdf).toContain("Choices: Not provided");
    expect(pdf).toContain("Approved flag: Yes");
    expect(pdf).toContain("Denied flag: No");
    expect(pdf).toContain('Structured: {"safe":"value"}');
    expect(pdf).toContain("invalid.bin - application/octet-stream - 0 B");
    expect(pdf).toContain("small.bin - application/octet-stream - 512 B");
    expect(pdf).toContain("exact.bin - application/octet-stream - 1 MB");
    expect(pdf).toContain("fraction.bin - application/octet-stream - 1.5 MB");
    expect(pdf).toContain("custom-state - awaiting_review - unsigned");
    expect(pdf).toContain("Signed: Not provided");

    const withoutAttachments = structuredClone(edge);
    withoutAttachments.attachments = [];
    expect(textOf(renderFormFilingPdf(withoutAttachments))).toContain("No supporting attachments were included.");
  });
});

describe("filing copy Eastern instants", () => {
  it.each(["en", "es"])("labels filer, co-signer and approval clocks in %s in winter and summer", (lang) => {
    for (const [month, hour] of [["01", "12"], ["07", "1"]]) {
      const filing = structuredClone(payload);
      filing.filerSignature.signedAt = `2026-${month}-15T17:05:00.123Z`;
      filing.cosigners[0].signedAt = `2026-${month}-15T17:06:00.456Z`;
      filing.approval.approvedAt = `2026-${month}-15T17:07:00.789Z`;
      filing.form.answers.dateOnly = "2026-07-06";
      filing.approval.note = "Keep this authored text: 2026-07-06T16:10:00.000Z";
      const pdf = textOf(renderFormFilingPdf(filing, lang));
      for (const minute of ["05", "06", "07"]) {
        expect(pdf).toContain(`${hour}:${minute} ${lang === "es" ? "p. m." : "PM"} ET`);
      }
      for (const instant of [filing.filerSignature.signedAt, filing.cosigners[0].signedAt, filing.approval.approvedAt]) {
        expect(pdf).toContain(`UTC: ${instant}`);
      }
      expect(pdf).toContain("dateOnly: 2026-07-06");
      expect(pdf).toContain("Keep this authored text: 2026-07-06T16:10:00.000Z");
    }
  });

  it.each(["en", "es"])("uses the previous Eastern calendar day and localized missing-time copy in %s", (lang) => {
    const filing = structuredClone(payload);
    filing.filerSignature.signedAt = "2026-01-01T01:05:00.000Z";
    filing.cosigners[0].signedAt = null;
    filing.approval.approvedAt = "not-a-date";
    const pdf = textOf(renderFormFilingPdf(filing, lang));
    expect(pdf).toContain(lang === "es" ? "31 dic 2025, 8:05 p. m. ET" : "Dec 31, 2025, 8:05 PM ET");
    const missing = lang === "es" ? "No proporcionado" : "Not provided";
    expect(pdf).toContain(`${lang === "es" ? "Firmado" : "Signed"}: ${missing}`);
    expect(pdf).toContain(`${lang === "es" ? "Aprobado el" : "Approved at"}: ${missing}`);
    expect(pdf).not.toContain("not-a-date");
  });
});

// BUG-UG-FILING-COPY-PRINTS-QUESTION-MARKS-IN-NAMES-AND-ANSWERS-20261114 (#8716):
// every text on the copy prints exactly as stored, or as a visible [U+XXXX] code.
describe("filing copy text outside WinAnsi", () => {
  const L = "Ł"; // Polish L with stroke, outside WinAnsi
  const unicode = () => {
    const copy = structuredClone(payload);
    copy.form.answers.summary = `Overtime at the ${L}ódź warehouse`;
    copy.filer.name = `${L}ukasz Kowalski`;
    copy.cosigners[0].name = "Ágnes Kőrösi";
    copy.attachments[0].filename = "zaświadczenie.pdf";
    copy.approval.reviewerName = "Zoë Đặng";
    copy.approval.note = "Zatwierdzone, dziękuję";
    copy.template.label_en = "Służba request";
    return copy;
  };
  // Every line drawn in the embedded font, read back through the copy's own
  // ToUnicode map; each glyph is checked against the font's glyph for that
  // character, so both what is drawn and what a reader extracts are exact.
  const fontLines = (pdf) => {
    const map = new Map([...pdf.matchAll(/<([0-9A-F]{4})> <([0-9A-F]+)>/g)].map(([, glyph, utf16]) => [
      parseInt(glyph, 16), String.fromCharCode(...utf16.match(/.{4}/g).map((unit) => parseInt(unit, 16)))]));
    const font = filingFont();
    return [...pdf.matchAll(/BT \/F3 ([\d.]+) Tf ([\d.]+) [\d.]+ Td <([0-9A-F]+)> Tj ET/g)].map(([, size, x, hex]) => {
      let width = 0;
      const text = hex.match(/.{4}/g).map((unit) => {
        const glyph = parseInt(unit, 16);
        const char = map.get(glyph);
        expect(font.glyph(char.codePointAt(0)), char).toBe(glyph);
        width += (font.advance(glyph) * Number(size)) / 1000;
        return char;
      }).join("");
      return { text, x: Number(x), width };
    });
  };

  it("draws names, answers, file names, the review note and the title exactly in the embedded font, in English and Spanish", () => {
    for (const lang of ["en", "es"]) {
      const pdf = textOf(renderFormFilingPdf(unicode(), lang, { font: filingFont() }));
      const lines = fontLines(pdf).map((row) => row.text);
      const filer = lang === "es" ? "Firma de la persona solicitante" : "Filer signature";
      const approved = lang === "es" ? "Aprobado por" : "Approved by";
      const note = lang === "es" ? "Nota de revisión" : "Review note";
      expect(lines).toEqual(expect.arrayContaining([
        `Summary: Overtime at the ${L}ódź warehouse`.replace("Summary", lang === "es" ? "Resumen" : "Summary"),
        `${filer} - ${L}ukasz Kowalski`,
        `Ágnes Kőrösi - ${lang === "es" ? "Firmado" : "Signed"}`,
        expect.stringMatching(/^zaświadczenie\.pdf - application\/pdf - 2 KB$/),
        `${approved} Zoë Đặng`,
        `${note}: Zatwierdzone, dziękuję`,
      ]));
      if (lang === "en") expect(lines).toContain("Służba request");
      expect(pdf).not.toMatch(/\?(?:ukasz|ód|\?ng)/);
      expect(pdf).not.toContain("[U+");
      // The filer title is bold: the same glyphs filled and stroked.
      expect(pdf).toMatch(/q 0 g 0 G 2 Tr [\d.]+ w BT \/F3 10 Tf [\d.]+ [\d.]+ Td <[0-9A-F]+> Tj ET Q/);
    }
  });

  it("writes codes instead of \"?\" without the embedded font, and says so on the copy", () => {
    const pdf = textOf(renderFormFilingPdf(unicode(), "en"));
    expect(pdf).toContain("(Summary: Overtime at the [U+0141]ód[U+017A] warehouse) Tj");
    expect(pdf).toContain("(Filer signature - [U+0141]ukasz Kowalski) Tj");
    expect(pdf).toContain("(Approved by Zoë [U+0110][U+1EB7]ng) Tj");
    expect(pdf).toContain("Characters this copy cannot draw are written as their Unicode code in brackets");
    expect(pdf).not.toMatch(/\?(?:ukasz|ód|\?ng)/);
    expect(pdf).not.toContain("/F3");
  });

  it("writes a script the font does not cover as codes, with the note, and never another character", () => {
    const copy = unicode();
    copy.form.answers.summary = "Hindi नमस्ते and 李";
    const pdf = textOf(renderFormFilingPdf(copy, "es", { font: filingFont() }));
    expect(fontLines(pdf).map((row) => row.text)).toContain("Resumen: Hindi [U+0928][U+092E][U+0938][U+094D][U+0924][U+0947] and [U+674E]");
    expect(pdf).toContain("se escriben con su código Unicode entre corchetes");
  });

  it("keeps a long answer outside WinAnsi inside the page width, wrapped by measured glyph widths", () => {
    const copy = unicode();
    copy.form.answers.summary = `${`${L}ódź overtime rota `.repeat(40)}${"Ż".repeat(150)}`;
    const pdf = textOf(renderFormFilingPdf(copy, "en", { font: filingFont() }));
    // The answer's lines (indent 8); the attachment line shares the indent.
    const answer = fontLines(pdf).filter((row) => row.x === 56 && !row.text.includes("application/pdf"));
    expect(answer.length).toBeGreaterThan(4);
    for (const row of answer) expect(row.x + row.width).toBeLessThanOrEqual(48 + 516 + 0.01);
    // Lines break at spaces, or between characters inside a word wider than a line.
    expect(answer.map((row) => row.text).join("").replaceAll(" ", ""))
      .toBe(`Summary: ${copy.form.answers.summary}`.replaceAll(" ", ""));
  });

  it("leaves a copy whose text all fits WinAnsi byte for byte as before, with no embedded font", () => {
    expect(Buffer.from(renderFormFilingPdf(payload, "en", { font: filingFont() })).equals(Buffer.from(renderFormFilingPdf(payload, "en")))).toBe(true);
    expect(textOf(renderFormFilingPdf(payload, "en", { font: filingFont() }))).not.toContain("/F3");
  });

  it("draws Unicode spaces such as U+202F with the embedded font, or as codes with the note without it (#8725, G7-8723 P2)", () => {
    const copy = unicode();
    copy.form.answers.summary = "Shift ends 5:30\u202fPM\ufeff, room\u3000B";
    const lines = fontLines(textOf(renderFormFilingPdf(copy, "en", { font: filingFont() }))).map((row) => row.text);
    // Noto Sans draws U+202F and U+FEFF; it has no U+3000, which becomes a code (and the note).
    expect(lines).toContain("Summary: Shift ends 5:30\u202fPM\ufeff, room[U+3000]B");
    const plain = textOf(renderFormFilingPdf({ ...copy, filer: { ...copy.filer, name: "Ann Lee" } }, "en"));
    expect(plain).toContain("(Summary: Shift ends 5:30[U+202F]PM[U+FEFF], room[U+3000]B) Tj");
    expect(plain).toContain("Characters this copy cannot draw are written as their Unicode code in brackets");
  });

  it("writes C1 control characters as codes, not as other WinAnsi characters, without the font (#8725, G7-8723 P3-a)", () => {
    const copy = structuredClone(payload);
    copy.form.answers.summary = "Item \u0080\u0081\u009f end";
    const pdf = textOf(renderFormFilingPdf(copy, "en"));
    expect(pdf).toContain("(Summary: Item [U+0080][U+0081][U+009F] end) Tj");
    expect(pdf).not.toMatch(/Item [\u20ac\u2022\u0178]/);
    expect(pdf).toContain("Characters this copy cannot draw are written as their Unicode code in brackets");
  });

  it("keeps WinAnsi punctuation (em dash, curly quotes, ellipsis) as WinAnsi bytes, never as codes (#8725)", () => {
    const copy = structuredClone(payload);
    copy.form.answers.summary = "Late \u2014 \u201cfinal\u201d \u2026 done";
    for (const font of [null, filingFont()]) {
      const pdf = textOf(renderFormFilingPdf(copy, "en", { font }));
      expect(pdf).toContain("(Summary: Late \u2014 \u201cfinal\u201d \u2026 done) Tj");
      expect(pdf).not.toContain("[U+");
    }
  });

  it("never splits a [U+XXXX] code across lines without the font (#8725, G7-8723 P3-b)", () => {
    const copy = structuredClone(payload);
    copy.form.answers.summary = "\u0928\u092e\u0938\u094d\u0924\u0947".repeat(8);
    const pdf = textOf(renderFormFilingPdf(copy, "en"));
    const shown = [...pdf.matchAll(/BT \/F1 10 Tf [\d.]+ [\d.]+ Td \(([^)]*)\) Tj ET/g)].map((match) => match[1]).filter((text) => text.includes("U+"));
    expect(shown.length).toBeGreaterThan(1);
    for (const text of shown) {
      expect(text.replace(/\[U\+[0-9A-F]{4,6}\]/g, "")).not.toMatch(/[[\]]|U\+/);
    }
    expect(shown.join("").replace(/^Summary: /, "")).toBe("[U+0928][U+092E][U+0938][U+094D][U+0924][U+0947]".repeat(8));
  });

  it("stores a document title outside WinAnsi as UTF-16 metadata", () => {
    const pdf = textOf(renderFormFilingPdf(unicode(), "en", { font: filingFont() }));
    const subject = /\/Subject <FEFF([0-9A-F]+)>/.exec(pdf)[1];
    expect(String.fromCharCode(...subject.match(/.{4}/g).map((unit) => parseInt(unit, 16)))).toBe("Approved Służba request, version 4");
  });
});
