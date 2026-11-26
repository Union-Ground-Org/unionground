import { createHash } from "node:crypto";
import { assertDisposableProofUrl } from "../run-required-db-proofs.mjs";

export function configuredApiSchemas(config) {
  let section = "";
  const declarations = [];
  for (const line of config.split("\n")) {
    const heading = line.match(/^\[([^\]]+)\]/);
    if (heading) section = heading[1];
    if (section === "api" && /^schemas\s*=/.test(line)) declarations.push(line.replace(/^schemas\s*=\s*/, ""));
  }
  if (declarations.length !== 1) throw new Error("Invalid configured API schemas");
  const schemas = JSON.parse(declarations[0]);
  if (!Array.isArray(schemas) || !schemas.length || schemas.some((name) => typeof name !== "string" || !/^[a-z_][a-z0-9_]*$/.test(name))
      || new Set(schemas).size !== schemas.length) throw new Error("Invalid configured API schemas");
  return schemas;
}

export function validateScanTarget(databaseUrl, status) {
  const fail = () => { throw new Error("Database assurance requires one owned disposable API/database target"); };
  try {
    assertDisposableProofUrl(databaseUrl);
    const db = new URL(databaseUrl);
    const api = new URL(status?.API_URL);
    if (status?.DB_URL !== databaseUrl || db.hostname !== "127.0.0.1"
        || db.search || db.hash || db.pathname !== "/postgres"
        || api.protocol !== "http:" || api.hostname !== db.hostname
        || Number(api.port) !== Number(db.port) - 1
        || api.username || api.password || api.search || api.hash || api.pathname !== "/"
        || !status.ANON_KEY || !status.SERVICE_ROLE_KEY) fail();
  } catch { fail(); }
}

function invalid() { throw new Error("Invalid database scanner result or baseline"); }
function text(value) {
  if (typeof value !== "string" || !value || value.length > 16000) invalid();
  return value;
}
function results(document) {
  const entries = Array.isArray(document) ? document : document?.results;
  if (!Array.isArray(entries)) invalid();
  return entries;
}
function identity(parts) {
  return createHash("sha256").update(JSON.stringify(parts)).digest("hex");
}
function aggregate(findings) {
  const grouped = new Map();
  for (const finding of findings) {
    const previous = grouped.get(finding.id);
    grouped.set(finding.id, { ...finding, count: (previous?.count ?? 0) + 1 });
  }
  return [...grouped.values()].sort((a, b) => a.id.localeCompare(b.id));
}

export function advisorFindings(document) {
  const findings = [];
  for (const entry of results(document)) {
    if (!entry || !["INFO", "WARN", "ERROR"].includes(entry.level)) invalid();
    const rule = text(entry.name);
    const key = text(entry.cacheKey ?? entry.cache_key);
    if (!/^[a-z0-9_]+$/.test(rule)) invalid();
    // Index usage depends on workload and empty disposable databases. Capture
    // INFO counts separately; warning/error schema findings are the ratchet.
    if (entry.level === "INFO") continue;
    findings.push({ id: identity(["advisor", rule, entry.level, key]), kind: "advisor", rule, level: entry.level });
  }
  return aggregate(findings);
}

export function lintFindings(document) {
  const findings = [];
  for (const entry of results(document)) {
    if (!entry || !Array.isArray(entry.issues)) invalid();
    const target = text(entry.function);
    for (const issue of entry.issues) {
      if (!issue || !["error", "warning", "warning extra"].includes(issue.level)
          || !/^[0-9A-Z]{5}$/.test(issue.sqlState ?? "")) invalid();
      const message = text(issue.message);
      findings.push({
        id: identity(["lint", target, issue.level, issue.sqlState, message]),
        kind: "lint", rule: issue.sqlState, level: issue.level,
      });
    }
  }
  return aggregate(findings);
}

function findingCounts(findings) {
  if (!Array.isArray(findings)) invalid();
  const counts = new Map();
  for (const row of findings) {
    if (!row || !/^[a-f0-9]{64}$/.test(row.id ?? "") || counts.has(row.id)
        || !["advisor", "lint"].includes(row.kind)
        || !Number.isSafeInteger(row.count) || row.count < 1
        || !["WARN", "ERROR", "error", "warning", "warning extra"].includes(row.level)) invalid();
    text(row.rule);
    counts.set(row.id, row.count);
  }
  return counts;
}

export function compareFindings(current, baseline) {
  const observed = findingCounts(current);
  const known = findingCounts(baseline);
  return {
    added: [...observed].filter(([id, count]) => count > (known.get(id) ?? 0)).map(([id]) => id),
    removed: [...known].filter(([id, count]) => count > (observed.get(id) ?? 0)).map(([id]) => id),
  };
}

export function rejectBaselineExpansion(candidate, trusted) {
  if (compareFindings(candidate, trusted).added.length) {
    throw new Error("Database assurance baseline may not expand over the trusted base");
  }
}
