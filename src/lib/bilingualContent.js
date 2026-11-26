// Spanish versions of chapter spaces and channel posts
// (REQ-UG-SPANISH-SPACES-AND-POSTS-20261030). A space may carry
// name_es and description_es and a post body_es beside the original
// (supabase/migrations/20261030234500_spanish_spaces_and_posts.sql). A reader
// on the Spanish view sees the Spanish version where one exists and the
// original otherwise; every other reader sees the original.
const present = (value) => typeof value === "string" && value.trim() !== "";

export function inReaderLanguage(lang, original, spanish) {
  return lang === "es" && present(spanish) ? spanish : original;
}

export const spaceName = (space, lang) => inReaderLanguage(lang, space?.name, space?.name_es);
export const spaceDescription = (space, lang) => inReaderLanguage(lang, space?.description, space?.description_es);
export const postBody = (post, lang) => inReaderLanguage(lang, post?.body, post?.body_es);

// A typed Spanish version, or null when the field was left empty.
export function spanishValue(value) {
  return present(value) ? value.trim() : null;
}

// The space dialog always returns its Spanish fields. Keep them only when
// they change what the space holds, so an edit that leaves the Spanish
// version alone writes nothing extra.
export function spanishSpaceEdit(fields, space) {
  const { nameEs, descriptionEs, ...rest } = fields || {};
  const next = { nameEs: spanishValue(nameEs), descriptionEs: spanishValue(descriptionEs) };
  const unchanged = next.nameEs === (space?.name_es ?? null) && next.descriptionEs === (space?.description_es ?? null);
  return unchanged ? rest : { ...rest, ...next };
}

export const carriesSpanishEdit = (fields) => Boolean(fields) && ("nameEs" in fields || "descriptionEs" in fields);
