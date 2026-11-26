// The web name a record gets from the words a person typed (an event's title,
// a chapter's name): accents removed, lowercase a-z and 0-9, runs of anything
// else as one hyphen, cut to `max` with no hyphen at either end. The server
// still refuses a name that is taken.
export function webNameFrom(text, max) {
  return String(text ?? "")
    .normalize("NFKD").replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+/, "")
    .slice(0, max)
    .replace(/-+$/, "");
}
