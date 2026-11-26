// A minimal TrueType reader for the filing copy (#8701 gate r1s1): enough to
// embed one font as a PDF Type0/Identity-H font and draw text by glyph id.
// It reads the character map (formats 4 and 12), the advance widths and the
// metrics the font descriptor needs. It does no shaping: a character the font
// has no glyph for is reported as uncovered, never drawn as another glyph.

const u16 = (bytes, at) => (bytes[at] << 8) | bytes[at + 1];
const i16 = (bytes, at) => { const value = u16(bytes, at); return value & 0x8000 ? value - 0x10000 : value; };
const u32 = (bytes, at) => ((bytes[at] << 24) >>> 0) + (bytes[at + 1] << 16) + (bytes[at + 2] << 8) + bytes[at + 3];

function tables(bytes) {
  const count = u16(bytes, 4);
  const found = new Map();
  for (let index = 0; index < count; index += 1) {
    const at = 12 + (index * 16);
    const tag = String.fromCharCode(bytes[at], bytes[at + 1], bytes[at + 2], bytes[at + 3]);
    found.set(tag, { offset: u32(bytes, at + 8), length: u32(bytes, at + 12) });
  }
  for (const tag of ["cmap", "head", "hhea", "hmtx", "maxp"]) {
    if (!found.has(tag)) throw new Error(`filing font has no ${tag} table`);
  }
  return found;
}

function characterMap(bytes, cmap) {
  const subtables = [];
  for (let index = 0; index < u16(bytes, cmap + 2); index += 1) {
    const at = cmap + 4 + (index * 8);
    const platform = u16(bytes, at);
    const encoding = u16(bytes, at + 2);
    const offset = cmap + u32(bytes, at + 4);
    const format = u16(bytes, offset);
    if (platform === 3 && ((encoding === 10 && format === 12) || (encoding === 1 && format === 4))) {
      subtables.push({ format, offset });
    }
  }
  const chosen = subtables.find((table) => table.format === 12) || subtables.find((table) => table.format === 4);
  if (!chosen) throw new Error("filing font has no Unicode character map");
  const map = new Map();
  const { offset } = chosen;
  if (chosen.format === 12) {
    for (let group = 0; group < u32(bytes, offset + 12); group += 1) {
      const at = offset + 16 + (group * 12);
      const start = u32(bytes, at);
      const end = u32(bytes, at + 4);
      const glyph = u32(bytes, at + 8);
      for (let code = start; code <= end; code += 1) map.set(code, glyph + (code - start));
    }
    return map;
  }
  const segments = u16(bytes, offset + 6) / 2;
  const ends = offset + 14;
  const starts = ends + (segments * 2) + 2;
  const deltas = starts + (segments * 2);
  const ranges = deltas + (segments * 2);
  for (let segment = 0; segment < segments; segment += 1) {
    const end = u16(bytes, ends + (segment * 2));
    const start = u16(bytes, starts + (segment * 2));
    const delta = u16(bytes, deltas + (segment * 2));
    const rangeAt = ranges + (segment * 2);
    const range = u16(bytes, rangeAt);
    for (let code = start; code <= end && code !== 0xffff; code += 1) {
      let glyph;
      if (range === 0) glyph = (code + delta) & 0xffff;
      else {
        glyph = u16(bytes, rangeAt + range + ((code - start) * 2));
        if (glyph) glyph = (glyph + delta) & 0xffff;
      }
      if (glyph) map.set(code, glyph);
    }
  }
  return map;
}

export function readFilingFont(bytes) {
  const data = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  // TrueType outlines, or CFF ("OTTO": the CJK font, embedded as its CFF table).
  const cff = u32(data, 0) === 0x4f54544f;
  if (u32(data, 0) !== 0x00010000 && !cff) throw new Error("filing font must be a TrueType or OpenType CFF font");
  const found = tables(data);
  const head = found.get("head").offset;
  const hhea = found.get("hhea").offset;
  const hmtx = found.get("hmtx").offset;
  const unitsPerEm = u16(data, head + 18);
  const metrics = u16(data, hhea + 34);
  const glyphCount = u16(data, found.get("maxp").offset + 4);
  const scale = (value) => Math.round((value * 1000) / unitsPerEm);
  const os2 = found.get("OS/2")?.offset;
  const ascent = scale(i16(data, hhea + 4));
  const map = characterMap(data, found.get("cmap").offset);
  const name = found.get("name");
  return {
    bytes: data,
    cff,
    unitsPerEm,
    postScriptName: name ? postScriptName(data, name.offset) || "NotoSans-Regular" : "NotoSans-Regular",
    ascent,
    descent: scale(i16(data, hhea + 6)),
    capHeight: os2 && found.get("OS/2").length >= 90 ? scale(i16(data, os2 + 88)) : ascent,
    bbox: [i16(data, head + 36), i16(data, head + 38), i16(data, head + 40), i16(data, head + 42)].map(scale),
    glyph(codePoint) {
      const glyph = map.get(codePoint) || 0;
      return glyph > 0 && glyph < glyphCount ? glyph : 0;
    },
    // Advance width in 1/1000 em, the unit PDF glyph widths use.
    advance(glyph) {
      const index = Math.min(glyph, metrics - 1);
      return scale(u16(data, hmtx + (index * 4)));
    },
  };
}

function postScriptName(bytes, offset) {
  const count = u16(bytes, offset + 2);
  const strings = offset + u16(bytes, offset + 4);
  for (let index = 0; index < count; index += 1) {
    const at = offset + 6 + (index * 12);
    if (u16(bytes, at) === 3 && u16(bytes, at + 6) === 6) {
      const length = u16(bytes, at + 8);
      const start = strings + u16(bytes, at + 10);
      let text = "";
      for (let char = 0; char < length; char += 2) text += String.fromCharCode(u16(bytes, start + char));
      return /^[A-Za-z0-9-]{1,63}$/.test(text) ? text : "";
    }
  }
  return "";
}
