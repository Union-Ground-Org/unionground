#!/usr/bin/env node
// Demo uptime, TLS and static-origin watch (.github/workflows/demo-uptime-watch.yml;
// docs/contracts/demo-deploy.md). Adapted from the sibling repository's
// uptime and TLS watch without its alert webhook, drills or DNS policy. For
// each hostname in config/demo-deploy.json: the landing page answers 200 with
// the demo's build marker; build-info.json names an exact commit;
// /api/runtime-config is the inert demo script; every path the product serves
// from a function or a cron (its api/ files and its root vercel.json) answers
// with the static single-page shell, so no function runs on the demo's origin;
// and the certificate is valid for at least certificateMinimumDays more days.
import { appendFileSync, readdirSync, readFileSync } from "node:fs";
import { connect } from "node:tls";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { DEMO_RUNTIME_CONFIG, readDemoDeployConfig } from "./lib/demo-site.mjs";

const BUILD_MARKER = /<meta name="union-ground-build-sha" content="[0-9a-f]{40}"/;

// The product's function and cron paths: one per api/ file (an underscore
// file or directory is a shared module, not a function) and every function
// and cron its root vercel.json names. /api/runtime-config is left out: the
// demo serves it as a static file, checked on its own.
export function productServerPaths(productVercelConfig, apiFileNames) {
  const functions = [
    ...apiFileNames.filter((name) => !name.startsWith("_")).map((name) => `api/${name}`),
    ...Object.keys(productVercelConfig.functions ?? {}),
  ].map((file) => `/${file.replace(/\.(?:m?js|ts)$/, "")}`);
  const crons = (productVercelConfig.crons ?? []).map((cron) => cron.path.split("?", 1)[0]);
  return [...new Set([...functions, ...crons])].filter((path) => path !== "/api/runtime-config").sort();
}

// response: { status, contentType, body } for one GET.
export function landingProblem(hostname, response) {
  if (response.status !== 200) return `${hostname}/ answered ${response.status}`;
  if (!BUILD_MARKER.test(response.body)) return `${hostname}/ has no demo build marker`;
  return null;
}

export function runtimeConfigProblem(hostname, response) {
  if (response.status !== 200) return `${hostname}/api/runtime-config answered ${response.status}`;
  if (response.body !== DEMO_RUNTIME_CONFIG) return `${hostname}/api/runtime-config is not the inert demo script: something other than the static package answers it`;
  return null;
}

// A static demo answers a product server path with its single-page shell;
// a function would answer with its own status or body.
export function serverPathProblem(hostname, path, response) {
  if (response.status === 200 && /^text\/html/i.test(response.contentType) && BUILD_MARKER.test(response.body)) return null;
  return `${hostname}${path} answered ${response.status} ${response.contentType || "with no content type"} instead of the static shell: a function may be running on the demo's origin`;
}

export function certificateProblem(hostname, { authorized, authorizationError, validTo }, { now, minimumDays }) {
  if (!authorized) return `${hostname} certificate is not trusted (${authorizationError})`;
  const days = Math.floor((Date.parse(validTo) - now) / 86400000);
  if (!(days >= minimumDays)) return `${hostname} certificate expires in ${days} days (${validTo}), under ${minimumDays}`;
  return null;
}

async function get(url) {
  const response = await fetch(url, { headers: { "cache-control": "no-cache" }, redirect: "manual", signal: AbortSignal.timeout(20000) });
  return { status: response.status, contentType: response.headers.get("content-type") ?? "", body: await response.text() };
}

function readCertificate(hostname) {
  return new Promise((resolvePromise, reject) => {
    // Verification stays on: an untrusted certificate fails the handshake and
    // the caller reports that error as the problem.
    const socket = connect({ host: hostname, port: 443, servername: hostname }, () => {
      const certificate = socket.getPeerCertificate();
      resolvePromise({ authorized: socket.authorized, authorizationError: socket.authorizationError, validTo: certificate.valid_to });
      socket.end();
    });
    socket.setTimeout(20000, () => socket.destroy(new Error(`${hostname}:443 timed out`)));
    socket.on("error", reject);
  });
}

async function watchHost(hostname, { serverPaths, minimumDays }) {
  const problems = [];
  const attempt = async (label, check) => {
    try {
      const problem = await check();
      if (problem) problems.push(problem);
    } catch (error) {
      problems.push(`${hostname} ${label}: ${error.message}`);
    }
  };
  await attempt("landing", async () => landingProblem(hostname, await get(`https://${hostname}/`)));
  await attempt("build-info.json", async () => {
    const response = await get(`https://${hostname}/build-info.json`);
    return response.status === 200 && /^[0-9a-f]{40}$/.test(JSON.parse(response.body).commitSha ?? "")
      ? null : `${hostname}/build-info.json names no exact commit (${response.status})`;
  });
  await attempt("runtime config", async () => runtimeConfigProblem(hostname, await get(`https://${hostname}/api/runtime-config`)));
  for (const path of serverPaths) {
    await attempt(path, async () => serverPathProblem(hostname, path, await get(`https://${hostname}${path}`)));
  }
  await attempt("certificate", async () => certificateProblem(hostname, await readCertificate(hostname), { now: Date.now(), minimumDays }));
  return problems;
}

if (resolve(process.argv[1] ?? "") === fileURLToPath(import.meta.url)) {
  const config = readDemoDeployConfig();
  const productConfig = JSON.parse(readFileSync(new URL("../vercel.json", import.meta.url), "utf8"));
  const serverPaths = productServerPaths(productConfig, readdirSync(new URL("../api/", import.meta.url)));
  const problems = [];
  for (const hostname of config.hostnames) {
    problems.push(...await watchHost(hostname, { serverPaths, minimumDays: config.certificateMinimumDays }));
  }
  const lines = problems.length
    ? problems.map((problem) => `- ${problem}`)
    : [`Up: ${config.hostnames.join(" and ")} serve the static demo, answer ${serverPaths.length} product server paths with the static shell, and hold certificates valid for at least ${config.certificateMinimumDays} more days.`];
  console.log(lines.join("\n"));
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${lines.join("\n")}\n`);
  process.exitCode = problems.length ? 1 : 0;
}
