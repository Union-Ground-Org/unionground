// REQ-UG-SITE-GUIDE-FOR-REAL-ACCOUNTS-20261001.
//
// The logged-in "How to use this site" guide (old de7df4b57c^:lib/welcome-guide/
// config.ts, /dashboard/guide). Its sections come from the person's actual
// navigation: the member groups every account has, then one section for each
// staff desk the account holds. The copy is a product default that an
// organization admin may replace for the whole organization
// (public.get_site_guide / public.save_site_guide). The server enforces the
// organization switch; this module only builds and normalizes.

import { FEATURE_GROUPS } from "./mobileNav.js";
import { STAFF_PLANES } from "./staffPlanes.js";
import { STAFF_ROLE_NAVIGATION, visibleStaffNavigation } from "./staffNavigation.js";

export const SITE_GUIDE_SWITCH_KEY = "features.guidance_onboarding.site_guide";
export const SITE_GUIDE_PATH = "/m/guide";
export const SITE_GUIDE_MAX_STEPS = 6;
export const SITE_GUIDE_LIMITS = Object.freeze({ title: 120, intro: 1000, helpTitle: 120, helpBody: 800, body: 1200, step: 220 });

// Old 0612 seeded welcome_guide_enabled = 'true': absent or unknown is on.
export function siteGuideEnabled(configuration) {
  return configuration?.switches?.[SITE_GUIDE_SWITCH_KEY] !== false;
}

function text(value, max) {
  return typeof value === "string" && value.trim() ? value.trim().slice(0, max) : null;
}

function normalizeSections(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const sections = {};
  for (const [key, section] of Object.entries(value)) {
    if (!/^[a-z][a-z0-9_-]{1,39}$/.test(key) || !section || typeof section !== "object") continue;
    const body = text(section.body, SITE_GUIDE_LIMITS.body);
    const steps = Array.isArray(section.steps)
      ? section.steps.map((step) => text(step, SITE_GUIDE_LIMITS.step)).filter(Boolean).slice(0, SITE_GUIDE_MAX_STEPS)
      : [];
    if (body || steps.length) sections[key] = { ...(body ? { body } : {}), ...(steps.length ? { steps } : {}) };
  }
  return sections;
}

export function normalizeSiteGuide(payload) {
  if (!payload || typeof payload !== "object" || payload.state !== "ready") {
    return { state: payload?.state === "unavailable" ? "unavailable" : "defaults", enabled: true, canEdit: false, copy: null };
  }
  const copy = payload.copy && typeof payload.copy === "object" ? {
    title: text(payload.copy.title, SITE_GUIDE_LIMITS.title),
    intro: text(payload.copy.intro, SITE_GUIDE_LIMITS.intro),
    helpTitle: text(payload.copy.helpTitle, SITE_GUIDE_LIMITS.helpTitle),
    helpBody: text(payload.copy.helpBody, SITE_GUIDE_LIMITS.helpBody),
    sections: normalizeSections(payload.copy.sections),
    updatedAt: typeof payload.copy.updatedAt === "string" ? payload.copy.updatedAt : null,
  } : null;
  return { state: "ready", enabled: payload.enabled !== false, canEdit: payload.canEdit === true, copy };
}

function destination(item) {
  return item?.path && item.key !== "site-guide" ? { key: item.key, labelKey: item.labelKey, viewKey: item.viewKey ?? item.key, path: item.path, sectionId: item.sectionId ?? "" } : null;
}

// Section skeletons in navigation order: member groups first, then one per
// staff desk the account actually holds (never a desk it cannot open).
// REQ-UG-NAVIGATION-HELP-AND-SETUP-COPY-20261030 (finding 31): a role
// the staff two-step policy is holding back (`pausedRoles`, the loader's
// staffMfa.suspendedRoles) still gets its section, so an officer can read what
// the desk holds, but with no links: the desk fails closed until two-step
// sign-in is on, and the view says so.
export function siteGuideSectionSkeletons(roles = [], pausedRoles = [], demoNavigation = false) {
  const held = new Set(Array.isArray(roles) ? roles : []);
  const paused = new Set((Array.isArray(pausedRoles) ? pausedRoles : []).filter((role) => !held.has(role)));
  const member = FEATURE_GROUPS.map((group) => ({
    key: group.key,
    labelKey: group.labelKey,
    destinations: group.items.map(destination).filter(Boolean),
  }));
  const staff = STAFF_PLANES
    .filter((plane) => held.has(plane.key) && Array.isArray(STAFF_ROLE_NAVIGATION[plane.key]))
    .map((plane) => ({
      key: plane.key,
      labelKey: plane.labelKey,
      staff: true,
      destinations: visibleStaffNavigation(STAFF_ROLE_NAVIGATION[plane.key], demoNavigation).map(destination).filter(Boolean),
    }));
  const pausedStaff = STAFF_PLANES
    .filter((plane) => paused.has(plane.key) && Array.isArray(STAFF_ROLE_NAVIGATION[plane.key]))
    .map((plane) => ({ key: plane.key, labelKey: plane.labelKey, staff: true, paused: true, destinations: [] }));
  return [...member, ...staff, ...pausedStaff];
}

function folded(value) {
  return String(value ?? "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
}

// The guide's search box. A section stays when any of its words match; inside
// it, the page links narrow to the matching ones unless the section's own
// title, description or tips matched (then every link stays, since the whole
// section is the answer). `labelOf` turns a destination into its shown name.
export function filterSiteGuideSections(sections, query, labelOf = (item) => item.labelKey) {
  const needle = folded(query).trim();
  if (!needle) return sections;
  const hit = (value) => folded(value).includes(needle);
  return sections.flatMap((section) => {
    const own = hit(section.label) || hit(section.body) || (section.steps ?? []).some(hit);
    const links = (section.destinations ?? []).filter((item) => hit(labelOf(item)));
    if (!own && links.length === 0) return [];
    return [own ? section : { ...section, destinations: links }];
  });
}

// BUG-UG-SITE-GUIDE-SEARCH-HINT-SUGGESTS-STAFF-TERMS-TO-MEMBERS-20261103:
// the search box's hint names only words that find a section this reader can
// see. Each section offers one word from its default text
// (siteGuide.section.<key>.searchWord), staff desks first so an officer sees
// desk words; a word the organization's own copy no longer contains drops out.
export function siteGuideSearchWords(sections, t, labelOf = (item) => item.labelKey, max = 3) {
  const ordered = [...sections.filter((section) => section.staff), ...sections.filter((section) => !section.staff)];
  return ordered
    .map((section) => t(`siteGuide.section.${section.key}.searchWord`))
    .filter((word) => filterSiteGuideSections(sections, word, labelOf).length > 0)
    .slice(0, max);
}

// A search that finds nothing in this reader's guide but would find a staff
// desk the account does not hold returns those desks' names, so the page can
// say the topic belongs to a staff role instead of only "nothing matches".
export function siteGuideStaffOnlyDesks({ t, copy = null, roles = [], pausedRoles = [], demoNavigation = false, query, labelOf = (item) => item.labelKey }) {
  const shown = new Set(siteGuideSectionSkeletons(roles, pausedRoles, demoNavigation).map((section) => section.key));
  const others = buildSiteGuide({ t, copy, demoNavigation, roles: STAFF_PLANES.map((plane) => plane.key) }).sections
    .filter((section) => section.staff && !shown.has(section.key));
  return filterSiteGuideSections(others, query, labelOf).map((section) => section.label);
}

// The rendered guide: organization copy where an admin saved it, product
// defaults (translated) everywhere else.
export function buildSiteGuide({ t, copy = null, roles = [], pausedRoles = [], demoNavigation = false }) {
  const sections = siteGuideSectionSkeletons(roles, pausedRoles, demoNavigation).map((section) => {
    const custom = copy?.sections?.[section.key] ?? {};
    const defaultSteps = [1, 2].map((n) => t(`siteGuide.section.${section.key}.step${n}`));
    return {
      ...section,
      label: t(section.labelKey),
      body: custom.body ?? t(`siteGuide.section.${section.key}.body`),
      steps: custom.steps ?? defaultSteps,
      customized: Boolean(custom.body || custom.steps),
    };
  });
  return {
    title: copy?.title ?? t("siteGuide.title"),
    intro: copy?.intro ?? t("siteGuide.intro"),
    helpTitle: copy?.helpTitle ?? t("siteGuide.helpTitle"),
    helpBody: copy?.helpBody ?? t("siteGuide.helpBody"),
    sections,
  };
}

export async function loadSiteGuide(client) {
  if (!client?.rpc) return normalizeSiteGuide(null);
  const { data, error } = await client.rpc("get_site_guide");
  if (error) throw error;
  return normalizeSiteGuide(data);
}

// Turns the editor's draft into the save RPC's arguments. Steps are one per
// line; blank lines drop; an empty field means "use the default".
export function siteGuideSaveArgs(draft, randomUUID = () => globalThis.crypto.randomUUID()) {
  const sections = {};
  for (const [key, section] of Object.entries(draft?.sections ?? {})) {
    const body = text(section?.body, SITE_GUIDE_LIMITS.body);
    const steps = String(section?.steps ?? "").split("\n").map((line) => line.trim()).filter(Boolean).slice(0, SITE_GUIDE_MAX_STEPS);
    if (body || steps.length) sections[key] = { ...(body ? { body } : {}), ...(steps.length ? { steps } : {}) };
  }
  return {
    p_title: text(draft?.title, SITE_GUIDE_LIMITS.title),
    p_intro: text(draft?.intro, SITE_GUIDE_LIMITS.intro),
    p_help_title: text(draft?.helpTitle, SITE_GUIDE_LIMITS.helpTitle),
    p_help_body: text(draft?.helpBody, SITE_GUIDE_LIMITS.helpBody),
    p_sections: sections,
    p_idempotency_key: randomUUID(),
  };
}

export async function saveSiteGuide(client, draft, randomUUID) {
  if (!client?.rpc) throw Object.assign(new Error("site guide unavailable"), { code: "PGRST202" });
  const { data, error } = await client.rpc("save_site_guide", siteGuideSaveArgs(draft, randomUUID));
  if (error) throw error;
  return data;
}

export const RESTORE_DEFAULTS_DRAFT = Object.freeze({ title: "", intro: "", helpTitle: "", helpBody: "", sections: {} });
