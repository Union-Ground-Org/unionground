// Stand-in for src/lib/memberApi.js: the real module, with the member load
// answered from the fictional fixture for whichever persona is signed in,
// after a short network-like pause.
export * from "../../../src/lib/memberApi.js?real";

export async function loadMemberApp(_client, user) {
  await new Promise((resolve) => setTimeout(resolve, 200));
  // Imported here: the fixture data imports modules that import this one.
  const { fallbackData } = await import("../retired-pre-bot/src/data/fallback.js");
  const hat = String(user.id).replace(/^persona-/, "");
  const roles = hat === "member" ? [] : [hat];
  // The persona's saved language is the page's, so a Spanish case stays Spanish.
  const language = globalThis.localStorage?.getItem("sg-lang") === "es" ? "es" : "en";
  return { ...fallbackData, member: { ...fallbackData.member, id: user.id, email: user.email, chapterRoles: roles, language }, roles };
}
