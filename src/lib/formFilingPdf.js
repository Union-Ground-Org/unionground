import { formatEasternTimestamp } from "./easternTimestamp.js";

const PAGE_WIDTH = 612;
const PAGE_HEIGHT = 792;
const MARGIN = 48;
const TOP = PAGE_HEIGHT - MARGIN;
const BOTTOM = 48;
const TEXT_WIDTH = PAGE_WIDTH - (2 * MARGIN);

const copy = {
  en: {
    title: "Union Ground official filing copy",
    demo: "DEMO PREVIEW - NOT AN OFFICIAL FILING",
    form: "Form",
    version: "Version",
    status: "Status",
    approved: "Approved",
    answers: "Filed answers",
    signatures: "Signatures and co-signer record",
    filer: "Filer signature",
    signed: "Signed",
    unsigned: "unsigned",
    typed: "Typed signature",
    typedNote: "Signed by typing this name and ticking the consent box. Not a drawn signature.",
    typedCodes: "Characters this copy cannot draw are written as their Unicode code in brackets, such as [U+0915], never replaced by another character.",
    invited: "Invited",
    declined: "Declined",
    withdrawn: "Withdrawn",
    reaffirm_needed: "Re-affirmation required",
    attachments: "Supporting attachments",
    noAttachments: "No supporting attachments were included.",
    attachmentsSeparate: "Attached files travel separately with this filing copy.",
    approval: "Committee approval attestation",
    approvedBy: "Approved by",
    approvedAt: "Approved at",
    note: "Review note",
    digest: "Artifact digest",
    page: "Page",
    empty: "Not provided",
  },
  es: {
    title: "Copia oficial de presentación de Union Ground",
    demo: "VISTA PREVIA DE DEMOSTRACIÓN - NO ES UNA PRESENTACIÓN OFICIAL",
    form: "Formulario",
    version: "Versión",
    status: "Estado",
    approved: "Aprobado",
    answers: "Respuestas presentadas",
    signatures: "Firmas y registro de cofirmantes",
    filer: "Firma de la persona solicitante",
    signed: "Firmado",
    unsigned: "sin firma",
    typed: "Firma escrita",
    typedNote: "Firmado escribiendo este nombre y marcando la casilla de consentimiento. No es una firma dibujada.",
    typedCodes: "Los caracteres que esta copia no puede dibujar se escriben con su código Unicode entre corchetes, como [U+0915]; nunca se sustituyen por otro carácter.",
    invited: "Invitación pendiente",
    declined: "Rechazado",
    withdrawn: "Retirado",
    reaffirm_needed: "Se requiere reafirmación",
    attachments: "Archivos adjuntos",
    noAttachments: "No se incluyeron archivos adjuntos.",
    attachmentsSeparate: "Los archivos adjuntos viajan por separado con esta copia.",
    approval: "Constancia de aprobación del comité",
    approvedBy: "Aprobado por",
    approvedAt: "Aprobado el",
    note: "Nota de revisión",
    digest: "Resumen criptográfico del documento",
    page: "Página",
    empty: "No proporcionado",
  },
};

const winAnsiMap = new Map([
  [0x2013, 150], [0x2014, 151], [0x2018, 145], [0x2019, 146],
  [0x201c, 147], [0x201d, 148], [0x2022, 149], [0x2026, 133],
]);

function winAnsi(value) {
  let out = "";
  for (const char of String(value ?? "")) {
    const code = char.codePointAt(0);
    if (winAnsiMap.has(code)) out += String.fromCharCode(winAnsiMap.get(code));
    else if (winAnsiCovers(code)) out += char;
    else if (code === 10 || code === 13 || code === 9) out += " ";
    else out += unicodeCode(code);
  }
  return out.replace(/\s+/g, " ").trim();
}

// A character the copy cannot draw is written as its code, never as "?" or
// another character .
function unicodeCode(code) {
  return `[U+${code.toString(16).toUpperCase().padStart(4, "0")}]`;
}

function pdfString(value) {
  return pdfEscape(winAnsi(value));
}

// Escapes text that is already WinAnsi-encoded (wrap() output); encoding it
// twice would turn a mapped character such as the em dash into a code.
function pdfEscape(encoded) {
  return encoded.replace(/\\/g, "\\\\").replace(/\(/g, "\\(").replace(/\)/g, "\\)");
}

function localized(value, lang) {
  if (typeof value === "string") return value;
  if (!value || typeof value !== "object") return "";
  return value[lang] || value.en || value.es || "";
}

function filingTimestamp(value, lang) {
  const timestamp = formatEasternTimestamp(value, lang);
  return timestamp ? `${timestamp.text} (UTC: ${timestamp.dateTime})` : copy[lang].empty;
}

function bytesLabel(value) {
  const bytes = Number(value);
  if (!Number.isFinite(bytes) || bytes < 0) return "0 B";
  if (bytes < 1024) return `${Math.round(bytes)} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(bytes % (1024 * 1024) ? 1 : 0)} MB`;
}

function answerText(field, answer, lang, labels) {
  if (answer === null || answer === undefined || answer === "") return labels.empty;
  const options = Array.isArray(field?.options) ? field.options : [];
  const optionLabel = (value) => localized(options.find((item) => item?.value === value)?.label, lang) || String(value);
  if (Array.isArray(answer)) return answer.length ? answer.map(optionLabel).join(", ") : labels.empty;
  if (["select", "radio"].includes(field?.type)) return optionLabel(answer);
  if (typeof answer === "object") return JSON.stringify(answer);
  if (typeof answer === "boolean") return answer ? (lang === "es" ? "Sí" : "Yes") : "No";
  return String(answer);
}

// The signed material a filing payload carries: the drawn strokes
// array, or exactly { kind: "typed", name } for a typed signature. Anything
// else is printed as unsigned, never guessed at.
export function signatureMaterial(strokes) {
  if (Array.isArray(strokes)) return strokes.length ? { kind: "drawn", strokes } : null;
  if (strokes && typeof strokes === "object" && Object.keys(strokes).length === 2
      && strokes.kind === "typed" && typeof strokes.name === "string" && strokes.name.trim()) {
    return { kind: "typed", name: strokes.name };
  }
  return null;
}

function winAnsiCovers(code) {
  return winAnsiMap.has(code) || (code >= 32 && code <= 126) || (code >= 160 && code <= 255);
}

// The whitespace the copy treats as a plain space: tab, newline, carriage
// return and space. Other Unicode spaces (U+202F, U+FEFF, U+3000 ...) are
// characters: drawn by the embedded font, or written as a code with the note.
const PLAIN_SPACE = /[\t\n\r ]+/g;

// True when Helvetica's WinAnsi encoding cannot carry `text` as stored.
function needsUnicode(text) {
  for (const char of String(text ?? "").replace(PLAIN_SPACE, " ")) {
    if (!winAnsiCovers(char.codePointAt(0))) return true;
  }
  return false;
}

// A PDF metadata string: literal when WinAnsi carries it, else UTF-16BE.
function infoString(value) {
  const clean = String(value ?? "").replace(/\s+/g, " ").trim();
  return needsUnicode(clean) ? `<FEFF${utf16Hex(clean)}>` : `(${pdfString(clean)})`;
}

// A typed name as the units it is drawn in: each character the font (or,
// without one, WinAnsi) can draw, or the whole "[U+XXXX]" code of one it cannot.
// Nothing is ever drawn as a different character ( gate r1s1).
function typedNameUnits(name, font) {
  const units = [];
  let uncovered = false;
  for (const char of String(name ?? "")) {
    const code = char.codePointAt(0);
    if (code === 32) { units.push({ space: true, text: " " }); continue; }
    const glyph = font ? font.glyph(code) : 0;
    if (font ? glyph : winAnsiCovers(code)) units.push({ text: char, glyphs: font ? [[glyph, char]] : null });
    else {
      uncovered = true;
      const text = unicodeCode(code);
      units.push({ text, glyphs: font ? [...text].map((digit) => [font.glyph(digit.codePointAt(0)), digit]) : null });
    }
  }
  return { units, uncovered };
}

// The width of one non-space unit; spaces are measured by typedNameLines.
function unitWidth(unit, font, size) {
  if (!font) return unit.text.length * size * 0.56;
  return unit.glyphs.reduce((total, [glyph]) => total + ((font.advance(glyph) * size) / 1000), 0);
}

// Greedy lines no wider than `width`; a word wider than a line breaks between
// units, never inside a "[U+XXXX]" code.
function typedNameLines(units, font, size, width) {
  const words = [];
  let word = [];
  for (const unit of units) {
    if (unit.space) { if (word.length) words.push(word); word = []; }
    else word.push(unit);
  }
  if (word.length) words.push(word);
  const space = font ? (font.advance(font.glyph(32)) * size) / 1000 : size * 0.28;
  const lines = [];
  let current = [];
  let used = 0;
  for (const next of words) {
    const wordWidth = next.reduce((total, unit) => total + unitWidth(unit, font, size), 0);
    if (current.length && used + space + wordWidth <= width) {
      current.push({ space: true, text: " ", glyphs: font ? [[font.glyph(32), " "]] : null }, ...next);
      used += space + wordWidth;
      continue;
    }
    if (current.length) lines.push(current);
    current = [];
    used = 0;
    for (const unit of next) {
      const unitSize = unitWidth(unit, font, size);
      if (current.length && used + unitSize > width) { lines.push(current); current = []; used = 0; }
      current.push(unit);
      used += unitSize;
    }
  }
  if (current.length) lines.push(current);
  return lines;
}

function cosignerState(row, labels) {
  if (row?.status === "accepted" && signatureMaterial(row?.strokes)) return labels.signed;
  return labels[row?.status] || winAnsi(row?.status || labels.invited);
}

function wrap(text, maxChars) {
  const clean = winAnsi(text).slice(0, 24000);
  if (!clean) return [""];
  const words = clean.split(" ");
  const lines = [];
  let line = "";
  for (const raw of words) {
    let word = raw;
    while (word.length > maxChars) {
      if (line) { lines.push(line); line = ""; }
      // Cut at maxChars, or earlier when that would split a [U+XXXX] code.
      let cut = maxChars;
      const code = /\[U\+[0-9A-F]{4,6}\]/g;
      for (let match = code.exec(word); match && match.index < maxChars; match = code.exec(word)) {
        if (match.index + match[0].length > maxChars && match.index > 0) cut = match.index;
      }
      lines.push(word.slice(0, cut));
      word = word.slice(cut);
    }
    if (!word) continue;
    if (!line) line = word;
    else if (`${line} ${word}`.length <= maxChars) line += ` ${word}`;
    else { lines.push(line); line = word; }
  }
  if (line) lines.push(line);
  return lines.length ? lines : [""];
}

// Fonts a shaper (api/_lib/filingShaper.js) draws with, by PDF resource name.
const SHAPED_FONTS = ["latin", "arabic", "hebrew", "devanagari", "cjk"];

function buildPages(payload, lang, font = null, shaper = null) {
  // Glyph ids the embedded font draws, with the text each stands for.
  const usedGlyphs = new Map();
  // With a shaper: per font, the glyph ids drawn and the text each stands for.
  const shapedGlyphs = new Map();
  const labels = copy[lang] || copy.en;
  const pages = [[]];
  let pageIndex = 0;
  let y = TOP;
  const page = () => pages[pageIndex];
  const newPage = () => { pages.push([]); pageIndex += 1; y = TOP; };
  const need = (height) => { if (y - height < BOTTOM) newPage(); };
  // True once any text on the copy was written as a [U+XXXX] code.
  let codesWritten = false;
  const glyphHex = (parts) => parts.flatMap((unit) => unit.glyphs).map(([glyph, text]) => {
    if (!usedGlyphs.has(glyph)) usedGlyphs.set(glyph, text);
    return glyph.toString(16).toUpperCase().padStart(4, "0");
  }).join("");
  // One shaped line at (x, baseline): each run in its font, each glyph at its
  // shaped position, wrapped in ActualText so a reader extracts the line as
  // printed (codes included) in logical order whatever the drawing order.
  const drawShaped = (shaped, x, baseline, size, bold) => {
    const commands = [`/Span << /ActualText <FEFF${utf16Hex(shaped.actualText)}> >> BDC`];
    for (const run of shaped.runs) {
      if (!run.glyphs.length) continue;
      const used = shapedGlyphs.get(run.key) ?? new Map();
      shapedGlyphs.set(run.key, used);
      let previous = null;
      let show = `BT /S${SHAPED_FONTS.indexOf(run.key) + 1} ${size} Tf`;
      // Right-to-left glyphs are written in logical order (each at its shaped
      // position), so readers that ignore ActualText still read the text in order.
      for (const glyph of run.glyphs) {
        if (glyph.text && !used.has(glyph.g)) used.set(glyph.g, glyph.text);
        else if (!used.has(glyph.g)) used.set(glyph.g, "");
        const at = previous ? [glyph.x - previous.x, glyph.y - previous.y] : [x + glyph.x, baseline + glyph.y];
        show += ` ${at.map((value) => Number(value.toFixed(2))).join(" ")} Td <${glyph.g.toString(16).toUpperCase().padStart(4, "0")}> Tj`;
        previous = glyph;
      }
      // fixed-zone: ET here is the PDF end-text operator, not a time zone
      commands.push(`${show} ET`);
    }
    commands.push("EMC");
    const body = commands.join(" ");
    page().push(bold ? `q 0 g 0 G 2 Tr ${(size * 0.04).toFixed(2)} w ${body} Q` : body);
  };
  const line = (text, { size = 10, bold = false, indent = 0, gap = 3 } = {}) => {
    const lineHeight = size + gap;
    // The shaper is asked about the text this line draws, trimmed as below:
    // an ideographic space (U+3000) at either end is trimmed and never drawn,
    // so it alone does not make the line shaped.
    if (shaper?.needs(String(text).replace(PLAIN_SPACE, " ").trim())) {
      // Shaped, only for text Noto Sans alone cannot draw: right-to-left
      // text in visual order (a wholly right-to-left line is right-aligned).
      const { lines, uncovered } = shaper.layout(String(text).replace(PLAIN_SPACE, " ").trim(), { size, width: TEXT_WIDTH - indent });
      if (uncovered) codesWritten = true;
      for (const shaped of lines) {
        need(lineHeight);
        const offset = shaped.rtl ? Math.max(0, TEXT_WIDTH - indent - shaped.width) : 0;
        drawShaped(shaped, MARGIN + indent + offset, y, size, bold);
        y -= lineHeight;
      }
      return;
    }
    if (needsUnicode(text)) {
      if (!font) codesWritten = true;
      else {
        // Text WinAnsi cannot carry is drawn exactly in the embedded font,
        // wrapped by measured width; bold is the same glyphs stroked as well
        // as filled. Text that fits WinAnsi keeps Helvetica, byte for byte.
        const { units, uncovered } = typedNameUnits(String(text).replace(PLAIN_SPACE, " ").trim(), font);
        if (uncovered) codesWritten = true;
        for (const parts of typedNameLines(units, font, size, TEXT_WIDTH - indent)) {
          need(lineHeight);
          // fixed-zone: ET here is the PDF end-text operator, not a time zone
          const show = `BT /F3 ${size} Tf ${MARGIN + indent} ${y} Td <${glyphHex(parts)}> Tj ET`;
          page().push(bold ? `q 0 g 0 G 2 Tr ${(size * 0.04).toFixed(2)} w ${show} Q` : show);
          y -= lineHeight;
        }
        return;
      }
    }
    const maxChars = Math.max(20, Math.floor((TEXT_WIDTH - indent) / (size * 0.54)));
    for (const part of wrap(text, maxChars)) {
      need(lineHeight);
      // fixed-zone: ET here is the PDF end-text operator, not a time zone
      page().push(`BT /${bold ? "F2" : "F1"} ${size} Tf ${MARGIN + indent} ${y} Td (${pdfEscape(part)}) Tj ET`);
      y -= lineHeight;
    }
  };
  const spacer = (height = 8) => { need(height); y -= height; };
  const heading = (text, minAfter = 0) => {
    // Reserve the heading plus its first logical block so formal attestations
    // and signature labels never become orphaned at a page boundary.
    need(25 + minAfter);
    spacer(7);
    line(text, { size: 13, bold: true, gap: 5 });
  };
  const signature = (title, strokes) => {
    need(96);
    line(title, { bold: true });
    const left = MARGIN + 8;
    const bottom = y - 52;
    page().push(`0.12 0.27 0.21 RG 1.4 w ${left} ${bottom} ${TEXT_WIDTH - 16} 52 re S`);
    if (Array.isArray(strokes)) {
      for (const stroke of strokes.slice(0, 64)) {
        if (!Array.isArray(stroke) || stroke.length < 2) continue;
        const points = stroke.slice(0, 512).map((point) => ({
          x: left + 6 + (Math.max(0, Math.min(1000, Number(point?.x) || 0)) / 1000) * (TEXT_WIDTH - 28),
          y: bottom + 5 + ((1000 - Math.max(0, Math.min(1000, Number(point?.y) || 0))) / 1000) * 42,
        }));
        let command = `${points[0].x.toFixed(2)} ${points[0].y.toFixed(2)} m`;
        for (const point of points.slice(1)) command += ` ${point.x.toFixed(2)} ${point.y.toFixed(2)} l`;
        page().push(`${command} S`);
      }
    }
    y = bottom - 14;
  };
  const signed = (title, material) => {
    if (material.kind === "drawn") {
      signature(title, material.strokes);
      return;
    }
    // A typed name is printed exactly, as text in a frame sized to its
    // wrapped lines, and marked typed. With an embedded font it is drawn by
    // glyph id; a character no available font can draw is written as its code.
    const size = 13;
    const lineHeight = 17;
    const left = MARGIN + 8;
    const shapedName = shaper?.needs(material.name) ? shaper.layout(String(material.name).replace(PLAIN_SPACE, " ").trim(), { size, width: TEXT_WIDTH - 48, direction: "auto" }) : null;
    const { units, uncovered } = shapedName ? { units: [], uncovered: shapedName.uncovered } : typedNameUnits(material.name, font);
    const lines = shapedName ? shapedName.lines : typedNameLines(units, font, size, TEXT_WIDTH - 48);
    const frame = (lines.length * lineHeight) + 10;
    need(frame + 52 + (uncovered ? 24 : 0));
    line(`${title} - ${labels.typed}`, { bold: true });
    const bottom = y - frame;
    page().push(`0.12 0.27 0.21 RG 1.4 w ${left} ${bottom} ${TEXT_WIDTH - 16} ${frame} re S`);
    lines.forEach((parts, index) => {
      const baseline = y - 5 - size - (index * lineHeight) + 2;
      if (shapedName) {
        drawShaped(parts, MARGIN + 16 + (parts.rtl ? Math.max(0, TEXT_WIDTH - 48 - parts.width) : 0), baseline, size, false);
      } else if (font) {
        // fixed-zone: ET here is the PDF end-text operator, not a time zone
        page().push(`BT /F3 ${size} Tf ${MARGIN + 16} ${baseline} Td <${glyphHex(parts)}> Tj ET`);
      } else {
        // fixed-zone: ET here is the PDF end-text operator, not a time zone
        page().push(`BT /F1 ${size} Tf ${MARGIN + 16} ${baseline} Td (${pdfString(parts.map((unit) => unit.text).join(""))}) Tj ET`);
      }
    });
    y = bottom - 12;
    line(labels.typedNote, { size: 8, indent: 8 });
    if (uncovered) line(labels.typedCodes, { size: 8, indent: 8 });
  };

  const form = payload?.form || {};
  const template = payload?.template || {};
  const answers = form.answers && typeof form.answers === "object" ? form.answers : {};
  line(labels.title, { size: 18, bold: true, gap: 7 });
  if (payload?.demo) line(labels.demo, { size: 11, bold: true, gap: 7 });
  line(`${localized({ en: template.label_en, es: template.label_es }, lang) || form.template_key || labels.form}`,
    { size: 13, bold: true });
  line(`${labels.form}: ${form.id || ""}`);
  line(`${labels.version}: ${form.template_version ?? ""}    ${labels.status}: ${labels.approved}`);
  line(`${labels.digest}: ${payload?.approval?.artifactDigest || form.artifact_digest || ""}`, { size: 8 });

  heading(labels.answers);
  const fields = [];
  for (const step of template?.field_schema?.steps || []) {
    need(32);
    line(localized(step?.title, lang), { size: 11, bold: true });
    for (const field of step?.fields || []) {
      fields.push(field?.key);
      line(`${localized(field?.label, lang) || field?.key}: ${answerText(field, answers[field?.key], lang, labels)}`,
        { indent: 8 });
    }
    spacer(4);
  }
  for (const key of Object.keys(answers).filter((key) => !fields.includes(key)).sort()) {
    line(`${key}: ${answerText(null, answers[key], lang, labels)}`, { indent: 8 });
  }

  heading(labels.signatures, 96);
  const filerMaterial = signatureMaterial(payload?.filerSignature?.strokes);
  if (filerMaterial && payload.filerSignature.signatureDigest) {
    signed(`${labels.filer} - ${payload?.filer?.name || payload?.filer?.id || ""}`, filerMaterial);
    line(`${labels.signed}: ${filingTimestamp(payload.filerSignature.signedAt, lang)}    ${labels.digest}: ${payload.filerSignature.signatureDigest}`,
      { size: 8, indent: 8 });
  } else {
    line(`${labels.filer} - ${labels.unsigned}`, { indent: 8 });
  }
  for (const row of payload?.cosigners || []) {
    const name = row?.name || row?.email || row?.id || "Co-signer";
    const state = cosignerState(row, labels);
    if (state === labels.signed) {
      signed(`${name} - ${labels.signed}`, signatureMaterial(row.strokes));
      line(`${labels.signed}: ${filingTimestamp(row.signedAt, lang)}    ${labels.digest}: ${row.signatureDigest || ""}`,
        { size: 8, indent: 8 });
    } else {
      line(`${name} - ${state} - ${labels.unsigned}`, { indent: 8 });
    }
  }

  heading(labels.attachments, 32);
  const attachments = payload?.attachments || [];
  if (!attachments.length) line(labels.noAttachments, { indent: 8 });
  for (const file of attachments) {
    line(`${file?.filename || "file"} - ${file?.mime_type || file?.mimeType || "application/octet-stream"} - ${bytesLabel(file?.size_bytes ?? file?.sizeBytes)}`,
      { indent: 8 });
  }
  line(labels.attachmentsSeparate, { size: 9, indent: 8 });

  heading(labels.approval, 90);
  line(`${labels.approvedBy} ${payload?.approval?.reviewerName || payload?.approval?.approvedBy || ""}`);
  line(`${labels.approvedAt}: ${filingTimestamp(payload?.approval?.approvedAt, lang)}`);
  if (payload?.approval?.note) line(`${labels.note}: ${payload.approval.note}`);
  line(`${labels.digest}: ${payload?.approval?.artifactDigest || ""}`, { size: 8 });
  if (codesWritten) line(labels.typedCodes, { size: 8 });

  return { pages, labels, usedGlyphs, shapedGlyphs };
}

function binaryString(bytes) {
  let text = "";
  for (let at = 0; at < bytes.length; at += 8192) {
    text += String.fromCharCode(...bytes.subarray(at, at + 8192));
  }
  return text;
}

function utf16Hex(text) {
  let hex = "";
  for (let index = 0; index < text.length; index += 1) hex += text.charCodeAt(index).toString(16).toUpperCase().padStart(4, "0");
  return hex;
}

// The embedded font as a Type0/Identity-H font: glyph widths for the glyphs
// drawn, and a ToUnicode map so the copy's text reads back exactly.
function embeddedFontObjects(font, usedGlyphs, firstId) {
  const [type0, cidFont, descriptor, file, toUnicode] = [0, 1, 2, 3, 4].map((offset) => firstId + offset);
  const glyphs = [...usedGlyphs.keys()].sort((a, b) => a - b);
  const widths = glyphs.map((glyph) => `${glyph} [${font.advance(glyph)}]`).join(" ");
  // A font read with `deflate` carries its FlateDecode stream (api/_lib/filingFont.js).
  const fontBytes = binaryString(font.deflated || font.bytes);
  const filter = font.deflated ? " /Filter /FlateDecode" : "";
  // A glyph with no text of its own (part of a cluster whose letters sit on
  // another glyph) maps to a zero-width space, so a reader neither repeats
  // the cluster nor guesses a letter for it.
  const pairs = glyphs.map((glyph) => `<${glyph.toString(16).toUpperCase().padStart(4, "0")}> <${utf16Hex(usedGlyphs.get(glyph) || "\u200b")}>`);
  const chunks = [];
  for (let at = 0; at < pairs.length; at += 100) chunks.push(`${pairs.slice(at, at + 100).length} beginbfchar\n${pairs.slice(at, at + 100).join("\n")}\nendbfchar`);
  const cmap = "/CIDInit /ProcSet findresource begin\n12 dict begin\nbegincmap\n"
    + "/CIDSystemInfo << /Registry (Adobe) /Ordering (UCS) /Supplement 0 >> def\n/CMapName /Adobe-Identity-UCS def\n/CMapType 2 def\n"
    + "1 begincodespacerange\n<0000> <FFFF>\nendcodespacerange\n"
    + `${chunks.join("\n")}\nendcmap\nCMapName currentdict /CMap defineresource pop\nend\nend\n`;
  // A CFF font (the CJK font) is a CIDFontType0 whose program is its bare
  // CFF table; its codes are CIDs, which for it equal the glyph ids drawn.
  const cff = Boolean(font.cff);
  return new Map([
    [type0, `<< /Type /Font /Subtype /Type0 /BaseFont /${font.postScriptName} /Encoding /Identity-H /DescendantFonts [${cidFont} 0 R] /ToUnicode ${toUnicode} 0 R >>`],
    [cidFont, `<< /Type /Font /Subtype /CIDFontType${cff ? "0" : "2"} /BaseFont /${font.postScriptName} /CIDSystemInfo << /Registry (Adobe) /Ordering (Identity) /Supplement 0 >> /FontDescriptor ${descriptor} 0 R${cff ? "" : " /CIDToGIDMap /Identity"} /DW 1000 /W [${widths}] >>`],
    [descriptor, `<< /Type /FontDescriptor /FontName /${font.postScriptName} /Flags 32 /FontBBox [${font.bbox.join(" ")}] /ItalicAngle 0 /Ascent ${font.ascent} /Descent ${font.descent} /CapHeight ${font.capHeight} /StemV 80 /FontFile${cff ? "3" : "2"} ${file} 0 R >>`],
    [file, `<< /Length ${fontBytes.length}${cff ? " /Subtype /CIDFontType0C" : ` /Length1 ${font.bytes.length}`}${filter} >>\nstream\n${fontBytes}\nendstream`],
    [toUnicode, `<< /Length ${cmap.length} >>\nstream\n${cmap}endstream`],
  ]);
}

function object(id, body) {
  return `${id} 0 obj\n${body}\nendobj\n`;
}

// `options.font` (readFilingFont) prints typed signature names exactly; the
// official copy (api/form-filing.js) always passes it. Without it a typed
// name's characters outside WinAnsi are written as their U+ codes.
// `options.shaper` (api/_lib/filingShaper.js, server only) shapes the lines
// and typed names that hold a character only its other fonts have (Arabic,
// Hebrew, Devanagari, Chinese, Japanese, Korean) and subsets those fonts to
// the glyphs drawn; every other line is drawn as without it. The official
// copy passes it when it loads.
export function renderFormFilingPdf(payload, requestedLang = "en", { font = null, shaper = null } = {}) {
  const lang = requestedLang === "es" ? "es" : "en";
  const { pages, labels, usedGlyphs, shapedGlyphs } = buildPages(payload, lang, font, shaper);
  const embedded = font && usedGlyphs.size > 0;
  const fontId = 5 + (pages.length * 2);
  // Shaped fonts follow the unshaped one, five objects each, in a fixed order.
  const shapedIds = new Map();
  let nextId = fontId + (embedded ? 5 : 0);
  for (const key of SHAPED_FONTS) {
    if (shapedGlyphs.has(key)) { shapedIds.set(key, nextId); nextId += 5; }
  }
  const objects = new Map();
  const pageIds = pages.map((_, index) => 5 + (index * 2));
  objects.set(1, "<< /Type /Catalog /Pages 2 0 R >>");
  objects.set(2, `<< /Type /Pages /Kids [${pageIds.map((id) => `${id} 0 R`).join(" ")}] /Count ${pages.length} >>`);
  objects.set(3, "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>");
  objects.set(4, "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>");
  pages.forEach((commands, index) => {
    const pageId = pageIds[index];
    const contentId = pageId + 1;
    // fixed-zone: ET here is the PDF end-text operator, not a time zone
    const footer = `BT /F1 8 Tf ${PAGE_WIDTH - 100} 24 Td (${pdfString(`${labels.page} ${index + 1}/${pages.length}`)}) Tj ET`;
    const stream = `${commands.join("\n")}\n${footer}\n`;
    const shapedResources = [...shapedIds].map(([key, id]) => ` /S${SHAPED_FONTS.indexOf(key) + 1} ${id} 0 R`).join("");
    const fonts = `/F1 3 0 R /F2 4 0 R${embedded ? ` /F3 ${fontId} 0 R` : ""}${shapedResources}`;
    objects.set(pageId, `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${PAGE_WIDTH} ${PAGE_HEIGHT}] /Resources << /Font << ${fonts} >> >> /Contents ${contentId} 0 R >>`);
    objects.set(contentId, `<< /Length ${stream.length} >>\nstream\n${stream}endstream`);
  });

  if (embedded) for (const [id, body] of embeddedFontObjects(font, usedGlyphs, fontId)) objects.set(id, body);
  for (const [key, id] of shapedIds) {
    const used = shapedGlyphs.get(key);
    for (const [objectId, body] of embeddedFontObjects(shaper.embed(key, [...used.keys()]), used, id)) objects.set(objectId, body);
  }

  const form = payload?.form || {};
  const template = payload?.template || {};
  const filingLabel = localized({ en: template.label_en, es: template.label_es }, lang)
    || form.template_key || labels.form;
  const infoId = Math.max(...objects.keys()) + 1;
  objects.set(infoId, `<< /Title ${infoString(`${labels.title} - ${form.id || ""}`)} /Author (Union Ground) /Subject ${infoString(`${labels.approved} ${filingLabel}, ${labels.version.toLowerCase()} ${form.template_version ?? ""}`)} /Creator (Union Ground filing renderer) >>`);

  const maxId = Math.max(...objects.keys());
  // ActualText (shaped lines) is PDF 1.5; every other copy stays 1.4.
  let binary = `%PDF-${shapedIds.size ? "1.5" : "1.4"}\n%\xE2\xE3\xCF\xD3\n`;
  const offsets = [0];
  for (let id = 1; id <= maxId; id += 1) {
    offsets[id] = binary.length;
    binary += object(id, objects.get(id));
  }
  const xref = binary.length;
  binary += `xref\n0 ${maxId + 1}\n0000000000 65535 f \n`;
  for (let id = 1; id <= maxId; id += 1) binary += `${String(offsets[id]).padStart(10, "0")} 00000 n \n`;
  binary += `trailer\n<< /Size ${maxId + 1} /Root 1 0 R /Info ${infoId} 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Uint8Array.from(binary, (char) => char.charCodeAt(0) & 0xff);
}
