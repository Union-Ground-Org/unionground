// One-line previews of a note, update or message body
// (BUG-UG-CASE-NOTE-PREVIEWS-RUN-LIST-LINES-TOGETHER-20261110).
//
// HTML collapses a body's line breaks, so a note written as a list
// ("Next steps:\n- Demand sent Aug 14\n- Request the file") ran together as
// "Next steps: - Demand sent Aug 14 - Request the file" wherever a page shows
// it in a row, chip or clamped strip. The preview drops each line's list
// marker and joins the lines with " · ", except that a line ending in ":"
// introduces the next one and joins it with a space. The space before the
// dot does not break, so a wrapped preview never starts a line with "·".
// Full notes keep their line breaks; only previews go through here.

const LIST_MARKER = /^(?:[-*•]|\d{1,3}[.)])(?:\s+|$)/u;

export function notePreview(body) {
  if (typeof body !== "string") return "";
  let preview = "";
  for (const raw of body.split(/\r\n|\r|\n|\u2028|\u2029/u)) {
    const line = raw.replace(/\s+/gu, " ").trim().replace(LIST_MARKER, "");
    if (!line) continue;
    if (!preview) preview = line;
    else preview += preview.endsWith(":") ? ` ${line}` : `\u00a0· ${line}`;
  }
  return preview;
}
