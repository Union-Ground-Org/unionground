import { connectionDateMs as dateMs } from "./time.js";
import {
  CONNECTION_ISSUE_TOPICS,
  CONNECTION_SECTORS,
  CONNECTION_WEIGHT_KEYS,
  DEFAULT_CONNECTION_SETTINGS,
  DEFAULT_CONNECTION_WEIGHTS,
} from "./contract.js";

const compare = (a, b) => a < b ? -1 : a > b ? 1 : 0;
const dayMs = 86400000;
const isObject = (value) => value !== null && typeof value === "object" && !Array.isArray(value);

function text(value, limit = 160) {
  return typeof value === "string"
    ? value.normalize("NFKC").replace(/\p{Cf}/gu, "").replace(/\p{Cc}/gu, " ").replace(/\s+/g, " ").trim().slice(0, limit)
    : "";
}

function identifier(value) {
  return typeof value === "string" && /^[A-Za-z0-9:_-]{1,160}$/.test(value) ? value : null;
}

function knownKeys(values, allowed) {
  return [...new Set((Array.isArray(values) ? values : []).filter((key) => allowed.includes(key)))].sort(compare);
}

function priorities(values) {
  const byKey = new Map();
  for (const value of Array.isArray(values) ? values : []) {
    if (!CONNECTION_ISSUE_TOPICS.includes(value?.key)
      || !Number.isFinite(value.strength) || value.strength <= 0 || value.strength > 1) continue;
    byKey.set(value.key, Math.max(byKey.get(value.key) || 0, value.strength));
  }
  return [...byKey].sort(([a], [b]) => compare(a, b)).map(([key, strength]) => ({ key, strength }));
}


function location(value) {
  const countryText = text(value?.country);
  const country = /^[A-Za-z]{2}$/.test(countryText) ? countryText.toUpperCase() : null;
  const state = country ? text(value?.state, 64).toUpperCase() || null : null;
  const metro = country && state ? text(value?.metro, 120) || null : null;
  return { country, state, metro };
}

function profileFields(value) {
  if (!isObject(value) || !["chapter", "local"].includes(value.kind)) return null;
  const id = identifier(value.id);
  if (!id) return null;
  return {
    id,
    kind: value.kind === "local" ? "local" : "chapter",
    displayName: text(value.displayName),
    discoverable: value.discoverable === true,
    location: location(value.location),
    sectorKeys: knownKeys(value.sectorKeys, CONNECTION_SECTORS),
    issuePriorities: priorities(value.issuePriorities),
    expertiseOffered: knownKeys(value.expertiseOffered, CONNECTION_ISSUE_TOPICS),
    assistanceNeeds: priorities(value.assistanceNeeds),
    localKey: identifier(value.localKey),
    unionFamilyKey: identifier(value.unionFamilyKey),
    identityProvenance: Object.fromEntries(["localKey", "unionFamilyKey"].map((key) => [key,
      identifier(value[key]) && ["declared", "verified"].includes(value.identityProvenance?.[key])
        ? value.identityProvenance[key] : null,
    ])),
    handshake: {
      eligible: value.handshake?.eligible === true && Boolean(identifier(value.handshake?.partnerOrgId)),
      partnerOrgId: value.handshake?.eligible === true ? identifier(value.handshake?.partnerOrgId) : null,
    },
    publishedAt: dateMs(value.publishedAt) === null ? null : value.publishedAt,
    profileRevision: Number.isInteger(value.profileRevision) && value.profileRevision >= 1 ? value.profileRevision : null,
  };
}

// No arbitrary source properties (including text, identities and counts) survive.
export function normalizePublishedProfile(value) {
  if (value?.discoverable !== true || !["chapter", "local"].includes(value?.kind)) return null;
  const result = profileFields(value);
  return result?.displayName ? result : null;
}

export function normalizeConnectionSettings(input = {}) {
  if (!isObject(input) || (input.weights !== undefined && !isObject(input.weights))) {
    throw new TypeError("Invalid connection settings");
  }
  const weights = {};
  for (const key of CONNECTION_WEIGHT_KEYS) {
    const value = input.weights?.[key] === undefined ? DEFAULT_CONNECTION_WEIGHTS[key] : input.weights[key];
    if (!Number.isFinite(value) || value < 0 || value > 100) throw new RangeError(`Invalid ${key} weight`);
    weights[key] = value;
  }
  const locationScale = input.locationScale ?? DEFAULT_CONNECTION_SETTINGS.locationScale;
  const reach = input.reach ?? DEFAULT_CONNECTION_SETTINGS.reach;
  const diversity = input.diversity ?? DEFAULT_CONNECTION_SETTINGS.diversity;
  const freshnessDays = input.freshnessDays === undefined ? DEFAULT_CONNECTION_SETTINGS.freshnessDays : input.freshnessDays;
  if (!["metro", "state", "country"].includes(locationScale)) throw new RangeError("Invalid location scale");
  if (!["anywhere", "same-country", "same-state"].includes(reach)) throw new RangeError("Invalid geographic reach");
  if (!Number.isFinite(diversity) || diversity < 0 || diversity > 0.1) throw new RangeError("Invalid diversity strength");
  if (freshnessDays !== null && (!Number.isInteger(freshnessDays) || freshnessDays < 1 || freshnessDays > 3650)) {
    throw new RangeError("Invalid profile freshness");
  }
  return { weights, locationScale, reach, diversity, freshnessDays };
}

function hasSourceDimension(source, dimension) {
  switch (dimension) {
    case "location": return Boolean(source.location.country);
    case "sector": return source.sectorKeys.length > 0;
    case "issues": return source.issuePriorities.length > 0;
    case "expertise": return source.assistanceNeeds.length > 0;
    case "local": return Boolean(source.localKey);
    case "union": return Boolean(source.unionFamilyKey);
    default: return false;
  }
}

function jaccard(a, b) {
  if (!a.length || !b.length) return null;
  const other = new Set(b);
  const intersection = a.filter((key) => other.has(key)).length;
  return intersection / new Set([...a, ...b]).size;
}

function weightedJaccard(a, b) {
  if (!a.length || !b.length) return null;
  const first = new Map(a.map(({ key, strength }) => [key, strength]));
  const second = new Map(b.map(({ key, strength }) => [key, strength]));
  let intersection = 0;
  let union = 0;
  for (const key of new Set([...first.keys(), ...second.keys()])) {
    intersection += Math.min(first.get(key) || 0, second.get(key) || 0);
    union += Math.max(first.get(key) || 0, second.get(key) || 0);
  }
  return union ? intersection / union : null;
}

function locationSimilarity(a, b, scale) {
  if (!a.country || !b.country) return null;
  if (a.country !== b.country) return 0;
  if (scale === "country") return 1;
  if (a.state && b.state && a.state === b.state) {
    if (scale === "state") return 1;
    if (a.metro && b.metro && a.metro.toLowerCase() === b.metro.toLowerCase()) return 1;
    return 0.5;
  }
  return scale === "state" ? 0.25 : 0.2;
}

function similarity(a, b, dimension, settings, redundancy = false) {
  switch (dimension) {
    case "location": return locationSimilarity(a.location, b.location, settings.locationScale);
    case "sector": return jaccard(a.sectorKeys, b.sectorKeys);
    case "issues": return weightedJaccard(a.issuePriorities, b.issuePriorities);
    case "expertise": {
      if (redundancy) return jaccard(a.expertiseOffered, b.expertiseOffered);
      if (!a.assistanceNeeds.length || !b.expertiseOffered.length) return null;
      const offered = new Set(b.expertiseOffered);
      const total = a.assistanceNeeds.reduce((sum, item) => sum + item.strength, 0);
      return a.assistanceNeeds.reduce((sum, item) => sum + (offered.has(item.key) ? item.strength : 0), 0) / total;
    }
    case "local": return a.localKey && b.localKey ? Number(a.localKey === b.localKey) : null;
    case "union": return a.unionFamilyKey && b.unionFamilyKey ? Number(a.unionFamilyKey === b.unionFamilyKey) : null;
    default: return null;
  }
}

function contextFor(source, settings, now) {
  const normalizedSource = profileFields(source);
  const normalizedSettings = normalizeConnectionSettings(settings);
  const effectiveWeights = {};
  const disabledDimensions = [];
  for (const dimension of CONNECTION_WEIGHT_KEYS) {
    const requested = normalizedSettings.weights[dimension];
    const available = normalizedSource && hasSourceDimension(normalizedSource, dimension);
    effectiveWeights[dimension] = requested > 0 && available ? requested : 0;
    if (requested > 0 && !available) disabledDimensions.push(dimension);
  }
  const total = Object.values(effectiveWeights).reduce((sum, weight) => sum + weight, 0);
  let reason = null;
  if (!normalizedSource) reason = "invalid_source";
  else if (!Object.values(normalizedSettings.weights).some((weight) => weight > 0)) reason = "needs_preferences";
  else if (!total) reason = "insufficient_source_data";
  else if (normalizedSettings.reach !== "anywhere" && !normalizedSource.location.country) reason = "reach_location_required";
  else if (normalizedSettings.reach === "same-state" && !normalizedSource.location.state) reason = "reach_location_required";
  const nowMs = typeof now === "number" && Number.isFinite(now) ? now : dateMs(now);
  if (normalizedSettings.freshnessDays !== null && nowMs === null) throw new TypeError("Profile freshness requires an explicit current time");
  return { source: normalizedSource, settings: normalizedSettings, effectiveWeights, disabledDimensions, total, nowMs, reason };
}

function scoreWithContext(context, input, blockedIds) {
  const candidate = normalizePublishedProfile(input);
  if (!candidate || candidate.id === context.source.id || blockedIds.has(candidate.id)) return null;
  const { source, settings, nowMs } = context;
  if (settings.reach !== "anywhere" && (!candidate.location.country || candidate.location.country !== source.location.country)) return null;
  if (settings.reach === "same-state" && (!candidate.location.state || candidate.location.state !== source.location.state)) return null;
  const publishedMs = dateMs(candidate.publishedAt);
  if (nowMs !== null && publishedMs !== null && publishedMs > nowMs) return null;
  if (settings.freshnessDays !== null && (publishedMs === null || nowMs - publishedMs > settings.freshnessDays * dayMs)) return null;
  const contributions = [];
  for (const dimension of CONNECTION_WEIGHT_KEYS) {
    const weight = context.effectiveWeights[dimension];
    if (!weight) continue;
    const value = similarity(source, candidate, dimension, settings);
    contributions.push({ dimension, weight, similarity: value, contribution: weight * (value ?? 0) / context.total, available: value !== null });
  }
  return {
    ...candidate,
    score: Math.min(1, contributions.reduce((sum, item) => sum + item.contribution, 0)),
    coverage: contributions.reduce((sum, item) => sum + (item.available ? item.weight : 0), 0) / context.total,
    contributions,
    missingDimensions: contributions.filter((item) => !item.available).map((item) => item.dimension),
    reasons: contributions.filter((item) => item.contribution > 0).map((item) => item.dimension),
    diversityPenalty: 0,
  };
}

function blockedSet(values) {
  if (!(values instanceof Set) && !Array.isArray(values)) throw new TypeError("Invalid blocked chapter list");
  if ([...values].some((value) => !identifier(value))) throw new TypeError("Invalid blocked chapter identifier");
  return new Set(values);
}

// Null means ineligible or no usable source preferences, never a zero-score match.
export function scoreConnection({ source, candidate, settings = {}, now, blockedIds = [] } = {}) {
  const context = contextFor(source, settings, now);
  return context.reason ? null : scoreWithContext(context, candidate, blockedSet(blockedIds));
}

function redundancy(a, b, context) {
  return CONNECTION_WEIGHT_KEYS.reduce((sum, dimension) => {
    const weight = context.effectiveWeights[dimension];
    return weight ? sum + weight * (similarity(a, b, dimension, context.settings, true) ?? 0) / context.total : sum;
  }, 0);
}

export function rankConnections({ source, candidates = [], settings = {}, now, blockedIds = [], limit = 20 } = {}) {
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new RangeError("Invalid connection result limit");
  const context = contextFor(source, settings, now);
  const input = Array.isArray(candidates) ? candidates : [];
  const result = {
    state: context.reason ? "empty" : "ready",
    reason: context.reason,
    results: [],
    scannedCount: input.length,
    eligibleCount: 0,
    effectiveWeights: context.effectiveWeights,
    disabledDimensions: context.disabledDimensions,
    settings: context.settings,
  };
  if (context.reason) return result;
  const blocked = blockedSet(blockedIds);
  // Conflicting publications cannot be resolved by whichever page arrived first.
  const unique = new Map();
  const conflicts = new Set();
  for (const value of input) {
    const candidate = normalizePublishedProfile(value);
    if (!candidate) continue;
    const prior = unique.get(candidate.id);
    if (prior && JSON.stringify(prior) !== JSON.stringify(candidate)) conflicts.add(candidate.id);
    else unique.set(candidate.id, candidate);
  }
  const eligible = [...unique.values()]
    .filter((candidate) => !conflicts.has(candidate.id))
    .map((candidate) => scoreWithContext(context, candidate, blocked))
    .filter(Boolean);
  const remaining = eligible.filter((candidate) => candidate.score > 0)
    .sort((a, b) => b.score - a.score || compare(a.id, b.id));
  result.eligibleCount = eligible.length;
  const maximumRedundancy = new Map();
  while (remaining.length && result.results.length < limit) {
    let bestIndex = 0;
    let bestAdjusted = -Infinity;
    let bestPenalty = 0;
    for (let index = 0; index < remaining.length; index += 1) {
      const candidate = remaining[index];
      const maximum = maximumRedundancy.get(candidate.id) || 0;
      const penalty = context.settings.diversity * maximum;
      const adjusted = candidate.score - penalty;
      if (adjusted > bestAdjusted) {
        bestIndex = index;
        bestAdjusted = adjusted;
        bestPenalty = penalty;
      }
    }
    const [selected] = remaining.splice(bestIndex, 1);
    result.results.push({ ...selected, diversityPenalty: bestPenalty });
    // Cache each candidate's running maximum: each selected/candidate pair is
    // evaluated once, making exact reranking O(N * K), without a top-pool cap.
    if (context.settings.diversity) {
      for (const candidate of remaining) {
        maximumRedundancy.set(candidate.id, Math.max(
          maximumRedundancy.get(candidate.id) || 0,
          redundancy(candidate, selected, context),
        ));
      }
    }
  }
  if (!result.eligibleCount) {
    result.state = "empty";
    result.reason = "no_eligible_profiles";
  } else if (!result.results.length) {
    result.state = "empty";
    result.reason = "no_positive_match";
  }
  return result;
}

// Exhaustive keyset traversal: no catalog search cap and no ranking until complete.
// The server pins snapshotToken and returns strictly increasing opaque IDs/cursors.
export async function collectPublishedProfiles(fetchPage, { signal, pageSize = 500 } = {}) {
  if (typeof fetchPage !== "function") throw new TypeError("A published-profile reader is required");
  if (!Number.isInteger(pageSize) || pageSize < 1 || pageSize > 1000) throw new RangeError("Invalid profile page size");
  let snapshotToken = null;
  let afterId = null;
  const cursors = new Set();
  const profiles = new Map();
  while (true) {
    signal?.throwIfAborted();
    const page = await fetchPage({ snapshotToken, afterId, limit: pageSize, signal });
    signal?.throwIfAborted();
    if (!isObject(page) || typeof page.snapshotToken !== "string" || !page.snapshotToken
      || !Array.isArray(page.rows) || page.rows.length > pageSize || typeof page.complete !== "boolean") {
      throw new Error("Invalid published-profile page");
    }
    if (snapshotToken !== null && page.snapshotToken !== snapshotToken) throw new Error("Published profiles changed during traversal");
    snapshotToken = page.snapshotToken;
    let previousId = afterId;
    for (const row of page.rows) {
      const normalized = normalizePublishedProfile(row);
      if (!normalized || (previousId !== null && compare(normalized.id, previousId) <= 0)) {
        throw new Error("Published-profile page is not a complete ordered publication");
      }
      if (profiles.has(normalized.id)) throw new Error("Duplicate published profile");
      profiles.set(normalized.id, normalized);
      previousId = normalized.id;
    }
    if (page.complete) {
      if (page.nextCursor !== null) throw new Error("Completed profile page retained a cursor");
      return { profiles: [...profiles.values()], snapshotToken, complete: true };
    }
    if (!page.rows.length || typeof page.nextCursor !== "string" || !page.nextCursor
      || page.nextCursor !== previousId || cursors.has(page.nextCursor)) {
      throw new Error("Published-profile traversal did not advance");
    }
    cursors.add(page.nextCursor);
    afterId = page.nextCursor;
  }
}
