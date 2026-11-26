// Evidence a failed visual-audit surface records about the deployment it saw,
// so the Production supersession classifier can tell a newer Main deploy that
// landed mid-proof from a defect on the proof build. The runner records; it
// never decides. The classifier resolves every SHA here against Main before a
// failure can count as a tear, and a surface without this evidence stays a
// real failure.

const SHA_PATTERN = /^[0-9a-f]{40}$/;
const FAILED_DYNAMIC_IMPORT = /Failed to fetch dynamically imported module: (\S+)/;
const HTTP_FAILURE = /^HTTP (\d{3}) app: (\/\S+)$/;
const NETWORK_FAILURE = /^Network (\S+) app: (\/\S+)$/;

function assetPath(url) {
  try {
    return new URL(url).pathname;
  } catch {
    return null;
  }
}

/** The failed import URL a console message names, or null. */
export function failedDynamicImportUrl(text) {
  const match = FAILED_DYNAMIC_IMPORT.exec(String(text ?? ""));
  return match ? match[1] : null;
}

/**
 * The surface's own route modules that failed to load: each dynamic import the
 * page reported as failed (an unhandled rejection; the application swallows
 * its background imports, so those never reach the console), paired with the
 * HTTP or network failure the runner recorded for the same app asset. A 404
 * with no failed import behind it is a background asset and is not listed.
 */
export function routeModuleFailures({ failedImportUrls = [], runtimeFailures = [] } = {}) {
  const transport = new Map();
  for (const failure of runtimeFailures) {
    const message = String(failure?.message ?? "");
    if (failure?.rule === "http-error") {
      const http = HTTP_FAILURE.exec(message);
      if (http && !transport.has(http[2])) transport.set(http[2], { status: Number(http[1]) });
    } else if (failure?.rule === "network-error") {
      const network = NETWORK_FAILURE.exec(message);
      if (network && !transport.has(network[2])) transport.set(network[2], { errorText: network[1] });
    }
  }
  const seen = new Set();
  const modules = [];
  for (const url of failedImportUrls) {
    const path = assetPath(url);
    if (!path || seen.has(path) || !transport.has(path)) continue;
    seen.add(path);
    modules.push({ assetPath: path, ...transport.get(path) });
  }
  return modules;
}

const APP_ASSET = /^\/assets\/[A-Za-z0-9_.-]+\.(?:m?js|css)$/;

/** The app asset path a failed same-origin asset response names, or null. */
export function appAssetPath(responseUrl, baseUrl) {
  try {
    const url = new URL(responseUrl);
    return url.origin === new URL(baseUrl).origin && APP_ASSET.test(url.pathname) ? url.pathname : null;
  } catch {
    return null;
  }
}

/**
 * Observe which build the origin serves at the moment an app asset fails,
 * so a later classification can tell whether the asset was missing from the
 * proof build or from a deployment that had already replaced it. Unknown on
 * any error; nothing here is trusted.
 */
export async function observeAssetFailureBuild({ assetPath: path, fetchBuildInfo }) {
  try {
    const payload = await fetchBuildInfo();
    const sha = payload?.commitSha;
    return { assetPath: path, buildSha: SHA_PATTERN.test(sha ?? "") ? sha : null };
  } catch {
    return { assetPath: path, buildSha: null };
  }
}

/**
 * The payload of a build-info probe, read like the supersession classifier
 * reads it: a direct HTTP 200 JSON answer marked no-store. A redirect, an
 * error page or a cacheable copy says nothing about the build live at that
 * moment, so it throws and the observation stays unknown.
 */
export async function readBuildInfoResponse(response, url) {
  const status = response.status();
  if (status !== 200) throw new Error(`build-info returned HTTP ${status}`);
  if (response.url() !== url) throw new Error("build-info was redirected");
  const headers = response.headers();
  if (!String(headers["content-type"] ?? "").toLowerCase().startsWith("application/json")) {
    throw new Error("build-info did not return JSON");
  }
  if (!String(headers["cache-control"] ?? "").toLowerCase().includes("no-store")) {
    throw new Error("build-info was not marked no-store");
  }
  return response.json();
}

/**
 * Every failed app asset with the build observed at its failure, one entry
 * per asset path, so the classifier can demand that evidence for each 404 it
 * would otherwise waive on a torn surface: an asset observed on the proof
 * build, or never observed, was missing from the proof build itself. An
 * asset that failed more than once must have been observed on the same
 * build every time; disagreeing or unreadable observations leave it unknown
 * (: a rollback could show the newer build first and the
 * proof build second).
 */
export function assetFailureBuilds(observations = []) {
  const builds = new Map();
  for (const entry of observations) {
    const path = entry?.assetPath;
    if (typeof path !== "string") continue;
    const sha = SHA_PATTERN.test(entry.buildSha ?? "") ? entry.buildSha : null;
    builds.set(path, builds.has(path) && builds.get(path) !== sha ? null : sha);
  }
  return [...builds].map(([path, buildSha]) => ({ assetPath: path, buildSha }));
}

/**
 * The single build observed when every one of the surface's own route
 * modules failed, or null when any module lacks an observation or the
 * observations disagree. A build observed only later, after the route wait
 * timed out, is not evidence of what was live when the import failed.
 *
 * Residual, accepted: the Production audit runs against the alias, whose
 * asset responses carry no deployment identity, so the observation is a
 * separate request issued the moment the asset fails rather than a property
 * of the failed response. A deploy landing inside that gap would attribute a
 * 404 of the proof build to the newer build; the classifier then still
 * requires the newer build to be a Main descendant, the closing check to
 * have received it, and both origins to serve it at decision time, so the
 * misattributed build is one that is no longer live and whose successor is
 * proven by its own run.
 */
export function routeModuleBuildSha(modules, observations = []) {
  if (!Array.isArray(modules) || modules.length === 0) return null;
  const shas = new Set();
  for (const module of modules) {
    const observed = observations.find((entry) => entry?.assetPath === module.assetPath);
    if (!observed || !SHA_PATTERN.test(observed.buildSha ?? "")) return null;
    shas.add(observed.buildSha);
  }
  return shas.size === 1 ? [...shas][0] : null;
}

export function describeRouteModuleFailure({ assetPath: path, status, errorText }) {
  const cause = status !== undefined ? `HTTP ${status}` : `network ${errorText}`;
  return `Route module failed to load: ${path} (${cause})`;
}

/**
 * What the failed surface saw of the deployment: the build SHA its main
 * document carried even when that document was refused as unbound, and the
 * build the origin serves at the moment of failure. Either is null when
 * unknown. In fixture mode, or without an expected SHA, nothing is collected.
 */
export async function collectTearEvidence({ error, expectedSha, fixture = false, fetchBuildInfo } = {}) {
  const evidence = { receivedDocumentSha: null, liveBuildSha: null };
  if (fixture || !SHA_PATTERN.test(expectedSha ?? "")) return evidence;
  const received = error?.receivedDocumentSha;
  if (SHA_PATTERN.test(received ?? "")) evidence.receivedDocumentSha = received;
  if (typeof fetchBuildInfo !== "function") return evidence;
  try {
    const payload = await fetchBuildInfo();
    const live = payload?.commitSha;
    if (SHA_PATTERN.test(live ?? "")) evidence.liveBuildSha = live;
  } catch {
    // An unreadable build-info is recorded as unknown, never as a tear.
  }
  return evidence;
}
