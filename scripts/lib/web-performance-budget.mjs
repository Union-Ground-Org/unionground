export function median(values) {
  const sorted = values.filter(Number.isFinite).toSorted((left, right) => left - right);
  if (sorted.length === 0) return null;
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

export function relativeRange(values) {
  const finite = values.filter(Number.isFinite);
  if (finite.length < 2) return 0;
  const midpoint = median(finite);
  if (!midpoint) return Math.max(...finite) === Math.min(...finite) ? 0 : Infinity;
  return (Math.max(...finite) - Math.min(...finite)) / midpoint;
}

// appReadyMs is recorded, not enforced: the "ug:app-ready" mark
// (src/lib/appReadyMark.js) when the first route content commits. Lighthouse's
// LCP reads the static crawl fallback in index.html, which paints before the
// app does (BUG-UG-WEB-PERFORMANCE-BUDGET-DORMANT-BUNDLE-OVER-CEILING-20261109).
export function summarizeSamples(samples) {
  const metricNames = ["lcpMs", "fcpMs", "appReadyMs", "cls", "inpMs", "tbtMs", "transferBytes", "firstPaintRawBytes", "firstPaintGzipBytes"];
  return Object.fromEntries(metricNames.map((name) => {
    const values = samples.map((sample) => sample[name]).filter(Number.isFinite);
    return [name, {
      median: median(values),
      min: values.length ? Math.min(...values) : null,
      max: values.length ? Math.max(...values) : null,
      relativeRange: relativeRange(values),
      samples: values.length,
      attemptedSamples: samples.length,
    }];
  }));
}

const FIRST_PAINT_ASSET = /^\/assets\/[^/]+\.(?:css|js)$/;

// The built JavaScript and CSS paths among resource timing entries whose fetch
// started before the app-ready mark.
export function firstPaintAssetPaths(entries, readyAt) {
  return entries
    .filter((entry) => entry.startTime < readyAt)
    .map((entry) => new URL(entry.name).pathname)
    .filter((pathname) => FIRST_PAINT_ASSET.test(pathname));
}

// The union of every snapshot of first-paint paths (the one taken at the mark
// and the later one), priced by the build's own file sizes. A path seen once
// stays counted even if the page clears its resource timings later. It fails
// closed: a fetched asset missing from the build, an empty list, or a list
// that prices to zero bytes is an error, never a passing zero.
export function firstPaintBytes(snapshots, sizes, scenarioId) {
  const pathnames = new Set(snapshots.flat());
  if (pathnames.size === 0) throw new Error(`${scenarioId}: the cold load recorded no first-paint JavaScript or CSS`);
  let rawBytes = 0;
  let gzipBytes = 0;
  for (const pathname of pathnames) {
    const size = sizes.get(pathname);
    if (!size) throw new Error(`${scenarioId}: first-paint asset ${pathname} is not in the measured build`);
    rawBytes += size.rawBytes;
    gzipBytes += size.gzipBytes;
  }
  if (!(rawBytes > 0 && gzipBytes > 0)) throw new Error(`${scenarioId}: first-paint assets priced to zero bytes`);
  return { firstPaintRawBytes: rawBytes, firstPaintGzipBytes: gzipBytes, firstPaintAssetCount: pathnames.size };
}

const SAMPLE_BACKEND_ENV_KEYS = Object.freeze([
  "SAMPLE_SUPABASE_URL",
  "SAMPLE_SUPABASE_PUBLISHABLE_KEY",
  "SAMPLE_SUPABASE_SERVICE_ROLE_KEY",
  "SAMPLE_SUPABASE_SECRET_KEY",
  "VITE_SAMPLE_SUPABASE_URL",
  "VITE_SAMPLE_SUPABASE_PUBLISHABLE_KEY",
]);

export function isolatedWebPerformanceEnv(inheritedEnv, surface) {
  return {
    ...inheritedEnv,
    ...Object.fromEntries(SAMPLE_BACKEND_ENV_KEYS.map((name) => [name, ""])),
    VITE_E2E_HARNESS: "1",
    VITE_SUPABASE_URL: "http://127.0.0.1:65535",
    // The loopback development backend of api/_lib/providerBoundary.js. The
    // measurement serves a production build through `vite preview`
    // (NODE_ENV=production), so it opts in to that seam explicitly.
    UNIONGROUND_SUPABASE_PROJECT_REF: "local",
    UNIONGROUND_LOCAL_BACKEND: "1",
    VITE_SUPABASE_PUBLISHABLE_KEY: "web-performance-local-public-key",
    VITE_APP_SURFACE: surface,
    VITE_VISUAL_AUDIT: surface === "demo" ? "1" : "0",
    // A production build needs a product name of its own
    // (scripts/lib/brand-vite-plugin.mjs); keep the operator's when set.
    ...(String(inheritedEnv.VITE_BRAND_NAME || "").trim() || inheritedEnv.VITE_OFFICIAL_BRANDING === "1"
      ? {}
      : { VITE_BRAND_NAME: "Performance Workspace" }),
  };
}

export function assertLoopbackApplicationRequests(urls) {
  for (const value of urls) {
    const url = new URL(value);
    if (!["http:", "https:", "ws:", "wss:"].includes(url.protocol)) continue;
    if (!["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)) {
      throw new Error(`web performance measurement refused non-loopback application request: ${url.origin}`);
    }
  }
}

const PROFILE_CEILINGS = ["lcpMs", "cls", "inpMs", "tbtMs"];
const BUNDLE_CEILINGS = ["allJavaScriptAndCssRawBytes", "allJavaScriptAndCssGzipBytes"];
const FIRST_PAINT_CEILINGS = ["rawBytes", "gzipBytes"];

function isCeiling(value) {
  return Number.isFinite(value) && value >= 0;
}

// Config keys of every enforced ceiling that is missing or is not a finite
// number at or above zero, across every declared profile and the bundle.
export function missingBudgetCeilings(config) {
  const missing = [];
  for (const [name, profile] of Object.entries(config?.profiles || {})) {
    for (const metric of PROFILE_CEILINGS) {
      if (!isCeiling(profile?.budgets?.[metric])) missing.push(`profiles.${name}.budgets.${metric}`);
    }
  }
  for (const ceiling of BUNDLE_CEILINGS) {
    if (!isCeiling(config?.bundle?.[ceiling])) missing.push(`bundle.${ceiling}`);
  }
  // The INP probe clicks a named control, never "the first button it finds":
  // that guess clicked nothing on the demo routes from September 22 to
  // October 27 (run 40523288130, "INP probe found no safe enabled button").
  for (const [index, scenario] of (config?.scenarios || []).entries()) {
    if (typeof scenario?.inpTarget !== "string" || !scenario.inpTarget.trim()) missing.push(`scenarios[${index}].inpTarget`);
    for (const ceiling of FIRST_PAINT_CEILINGS) {
      if (!isCeiling(config?.firstPaint?.scenarios?.[scenario?.id]?.[ceiling])) missing.push(`firstPaint.scenarios.${scenario?.id}.${ceiling}`);
    }
  }
  return missing;
}

// Upstream decision 19 A (October 11, 2026): the configured budgets stay the
// targets; config.ratchet starts each failing ceiling at the size measured on
// ratchet.startsOn and lowers it by ratchet.monthlyReduction for every whole
// calendar month since, never below the target. A missing target still fails.
export function wholeMonthsSince(startsOn, today) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/;
  const a = match.exec(startsOn ?? "");
  const b = match.exec(today ?? "");
  if (!a || !b) throw new Error(`web performance ratchet needs exact dates (start ${startsOn}, today ${today})`);
  const months = (Number(b[1]) - Number(a[1])) * 12 + (Number(b[2]) - Number(a[2])) - (Number(b[3]) < Number(a[3]) ? 1 : 0);
  return Math.max(0, months);
}

// Bundle ceilings are whole bytes; scenario metrics keep their computed value
// (CLS is 0.1-scale and Lighthouse reports it unrounded).
export function ratchetedCeiling(target, start, ratchet, today, { wholeUnits = false } = {}) {
  if (!isCeiling(target) || start === undefined) return target;
  if (!isCeiling(start) || !(ratchet?.monthlyReduction > 0 && ratchet.monthlyReduction < 1)) {
    throw new Error("web performance ratchet start values and monthlyReduction must be finite and in range");
  }
  const exact = start * (1 - ratchet.monthlyReduction) ** wholeMonthsSince(ratchet.startsOn, today);
  const lowered = wholeUnits ? Math.floor(exact) : exact;
  return Math.max(target, lowered);
}

// The bundle start values were re-measured on ratchet.bundleStartsOn (owner
// ruling of November 10, 2026); the scenario start values keep ratchet.startsOn.
export function effectiveBundleCeilings(config, today) {
  const ratchet = config?.ratchet && { ...config.ratchet, startsOn: config.ratchet.bundleStartsOn ?? config.ratchet.startsOn };
  return Object.fromEntries(BUNDLE_CEILINGS.map((name) => [
    name, ratchetedCeiling(config?.bundle?.[name], config?.ratchet?.bundle?.[name], ratchet, today, { wholeUnits: true }),
  ]));
}

function checkCeiling(failures, label, actual, ceiling) {
  // A deleted or malformed ceiling must fail the gate. Comparing against
  // undefined/NaN is always false, which would silently pass every budget.
  if (!isCeiling(ceiling)) {
    failures.push(`${label} has no configured budget ceiling`);
    return;
  }
  if (!Number.isFinite(actual)) {
    failures.push(`${label} was not measured`);
  } else if (actual > ceiling) {
    failures.push(`${label} ${actual} exceeded ${ceiling}`);
  }
}

export function evaluateWebPerformanceBudget({ groups, bundles, config, today = new Date().toISOString().slice(0, 10) }) {
  const failures = [];
  const warnings = [];
  // A scenario start value is keyed by scenario and mode: it was measured in
  // one mode, so it relaxes only that mode's ceiling.
  const ceilings = {};
  const ceiling = (group, profile, metric) => {
    const value = ratchetedCeiling(
      profile.budgets?.[metric], config.ratchet?.scenarios?.[group.id]?.[group.mode]?.[metric], config.ratchet, today);
    (ceilings[`${group.id}/${group.mode}`] ??= {})[metric] = value;
    return value;
  };
  const bundleCeilings = effectiveBundleCeilings(config, today);

  const groupKeys = new Set();
  for (const group of groups) {
    const profile = config.profiles[group.profile];
    if (!profile) {
      failures.push(`${group.id}/${group.mode} used unknown profile ${group.profile}`);
      continue;
    }
    const label = `${group.id}/${group.mode}`;
    if (groupKeys.has(label)) failures.push(`${label} was measured more than once`);
    groupKeys.add(label);
    for (const metric of ["lcpMs", "cls", "inpMs", "tbtMs"]) {
      const summary = group.metrics?.[metric];
      if (summary?.attemptedSamples !== config.runsPerMode || summary?.samples !== config.runsPerMode) {
        failures.push(`${label} ${metric} requires ${config.runsPerMode} finite measurements (received ${summary?.samples ?? 0} finite from ${summary?.attemptedSamples ?? 0} attempts)`);
      }
    }
    checkCeiling(failures, `${label} LCP`, group.metrics.lcpMs.median, ceiling(group, profile, "lcpMs"));
    checkCeiling(failures, `${label} CLS`, group.metrics.cls.median, ceiling(group, profile, "cls"));
    checkCeiling(failures, `${label} INP`, group.metrics.inpMs.median, ceiling(group, profile, "inpMs"));
    checkCeiling(failures, `${label} TBT`, group.metrics.tbtMs.median, ceiling(group, profile, "tbtMs"));
    for (const metric of ["lcpMs", "cls", "inpMs", "tbtMs"]) {
      const spread = group.metrics[metric].relativeRange;
      if (Number.isFinite(spread) && spread > config.variance.maxRelativeRange) {
        warnings.push(`${label} ${metric} relative range ${spread.toFixed(3)} exceeded ${config.variance.maxRelativeRange}`);
      }
    }
  }

  const expectedModes = Array.isArray(config.modes) ? config.modes : ["cold", "warm"];
  for (const scenario of config.scenarios ?? []) {
    for (const mode of expectedModes) {
      if (!groupKeys.has(`${scenario.id}/${mode}`)) failures.push(`${scenario.id}/${mode} was not measured`);
    }
  }

  const expectedSurfaces = new Set((config.scenarios ?? []).map((scenario) => scenario.surface));
  const bundleSurfaces = new Set();
  for (const bundle of bundles) {
    if (bundleSurfaces.has(bundle.surface)) {
      failures.push(`${bundle.surface} bundle was measured more than once`);
    }
    bundleSurfaces.add(bundle.surface);
    checkCeiling(failures, `${bundle.surface} raw JS+CSS`, bundle.rawBytes, bundleCeilings.allJavaScriptAndCssRawBytes);
    checkCeiling(failures, `${bundle.surface} gzip JS+CSS`, bundle.gzipBytes, bundleCeilings.allJavaScriptAndCssGzipBytes);
  }
  for (const surface of expectedSurfaces) {
    if (!bundleSurfaces.has(surface)) failures.push(`${surface} bundle was not measured`);
  }

  // First-paint line (product decision of November 10, 2026): the JavaScript and
  // CSS a cold load of each scenario fetches before the app's first route
  // content paints, judged on the cold median against a fixed per-scenario
  // ceiling. Lazy chunks the scenario never loads do not count here.
  const firstPaintCeilings = {};
  for (const scenario of config.scenarios ?? []) {
    const group = groups.find((entry) => entry.id === scenario.id && entry.mode === "cold");
    if (!group) continue;
    const label = `${scenario.id}/cold first-paint`;
    const configured = config.firstPaint?.scenarios?.[scenario.id];
    firstPaintCeilings[scenario.id] = { rawBytes: configured?.rawBytes, gzipBytes: configured?.gzipBytes };
    for (const metric of ["firstPaintRawBytes", "firstPaintGzipBytes"]) {
      const summary = group.metrics?.[metric];
      if (summary?.attemptedSamples !== config.runsPerMode || summary?.samples !== config.runsPerMode) {
        failures.push(`${label} ${metric} requires ${config.runsPerMode} finite measurements (received ${summary?.samples ?? 0} finite from ${summary?.attemptedSamples ?? 0} attempts)`);
      }
    }
    checkCeiling(failures, `${label} raw JS+CSS`, group.metrics?.firstPaintRawBytes?.median, configured?.rawBytes);
    checkCeiling(failures, `${label} gzip JS+CSS`, group.metrics?.firstPaintGzipBytes?.median, configured?.gzipBytes);
  }

  // The ceilings this run was judged against, so a passing report records the
  // ratcheted values rather than only the configured targets.
  return { failures, passed: failures.length === 0, warnings, ceilings: { evaluatedOn: today, bundle: bundleCeilings, firstPaint: firstPaintCeilings, groups: ceilings } };
}

// A measured source label is valid only for a clean, unchanged checkout.
export function assertWebPerformanceSource({ expectedSha = null, actualSha, status }) {
  if (!/^[0-9a-f]{40}$/.test(actualSha) || /^0+$/.test(actualSha)) {
    throw new Error("web performance evidence requires an exact Git source SHA");
  }
  if (status.trim()) throw new Error("web performance measurement requires a clean worktree");
  if (expectedSha !== null && actualSha !== expectedSha) {
    throw new Error("web performance source changed during measurement");
  }
  return actualSha;
}

function rounded(value, digits = 0) {
  return Number.isFinite(value) ? Number(value.toFixed(digits)).toLocaleString("en-US") : "not measured";
}

// The short Markdown the workflow writes to its job summary, pass or fail, so
// a red run says why without opening the artifact.
export function budgetSummaryMarkdown(summary) {
  const { gate } = summary;
  const lines = [
    `## Web performance budgets: ${gate.passed ? "passed" : "FAILED"}`,
    "",
    `Source ${summary.sourceSha}, ${summary.recordedAt}. Medians of ${summary.measurement.runsPerMode} runs; app ready is the \`ug:app-ready\` mark (first route content), LCP reads the static fallback page.`,
    "",
  ];
  if (!gate.passed) lines.push("Failures:", "", ...gate.failures.map((failure) => `- ${failure}`), "");
  lines.push("| scenario | mode | app ready ms | LCP ms | TBT ms | INP ms | CLS |", "|---|---|---:|---:|---:|---:|---:|");
  for (const group of summary.groups) {
    const m = group.metrics;
    lines.push(`| ${group.id} | ${group.mode} | ${rounded(m.appReadyMs?.median)} | ${rounded(m.lcpMs.median)} | ${rounded(m.tbtMs.median)} | ${rounded(m.inpMs.median)} | ${rounded(m.cls.median, 3)} |`);
  }
  lines.push("", "| surface | raw JS+CSS | ceiling | gzip JS+CSS | ceiling |", "|---|---:|---:|---:|---:|");
  for (const bundle of summary.bundles) {
    lines.push(`| ${bundle.surface} | ${rounded(bundle.rawBytes)} | ${rounded(gate.ceilings.bundle.allJavaScriptAndCssRawBytes)} | ${rounded(bundle.gzipBytes)} | ${rounded(gate.ceilings.bundle.allJavaScriptAndCssGzipBytes)} |`);
  }
  const firstPaint = summary.groups.filter((group) => group.mode === "cold" && group.metrics.firstPaintRawBytes);
  if (firstPaint.length) {
    lines.push("", "| scenario (cold, before first paint) | raw JS+CSS | ceiling | gzip JS+CSS | ceiling |", "|---|---:|---:|---:|---:|");
    for (const group of firstPaint) {
      const limit = gate.ceilings.firstPaint?.[group.id] ?? {};
      lines.push(`| ${group.id} | ${rounded(group.metrics.firstPaintRawBytes.median)} | ${rounded(limit.rawBytes)} | ${rounded(group.metrics.firstPaintGzipBytes?.median)} | ${rounded(limit.gzipBytes)} |`);
    }
  }
  if (gate.warnings.length) lines.push("", "Variance warnings:", "", ...gate.warnings.map((warning) => `- ${warning}`));
  return `${lines.join("\n")}\n`;
}
