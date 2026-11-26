import { readdirSync, statSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import queryString from 'query-string';

export const MALFORMED_PERCENT_SEGMENT = '%FF'.repeat(128);
export const DEEP_LINK_CPU_BUDGET_MS = 25;
export const MALFORMED_DEEP_LINK_URL = `unionground://messages?returnTo=${MALFORMED_PERCENT_SEGMENT}`;
const PLATFORMS = new Set(['ios', 'android']);

export function isJavaScriptBundleFile(file) {
  return typeof file === 'string' && (file.endsWith('.js') || file.endsWith('.hbc'));
}

export function verifyMalformedDeepLinkBudget({ platform, bundleDir } = {}) {
  if (!PLATFORMS.has(platform)) throw new Error('platform must be ios or android');
  if (bundleDir) {
    if (!statSync(bundleDir).isDirectory()) throw new Error(`${platform} export path is not a directory`);
    const files = readdirSync(bundleDir, { recursive: true });
    if (!files.some(isJavaScriptBundleFile)) {
      throw new Error(`${platform} export contains no JavaScript or Hermes bundle`);
    }
  }

  const started = process.cpuUsage();
  const parsed = queryString.parseUrl(
    MALFORMED_DEEP_LINK_URL,
    { decode: true },
  );
  const usage = process.cpuUsage(started);
  const cpuMs = (usage.user + usage.system) / 1000;
  if (parsed.url !== 'unionground://messages' || typeof parsed.query.returnTo !== 'string') {
    throw new Error(`${platform} malformed deep link did not produce a bounded parsed route`);
  }
  if (cpuMs >= DEEP_LINK_CPU_BUDGET_MS) {
    throw new Error(`${platform} malformed-percent decode consumed ${cpuMs.toFixed(3)}ms CPU (budget ${DEEP_LINK_CPU_BUDGET_MS}ms)`);
  }
  return Object.freeze({ platform, cpuMs, budgetMs: DEEP_LINK_CPU_BUDGET_MS });
}

function argument(name) {
  const index = process.argv.indexOf(name);
  return index === -1 ? undefined : process.argv[index + 1];
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const result = verifyMalformedDeepLinkBudget({
    platform: argument('--platform'),
    bundleDir: argument('--bundle-dir'),
  });
  console.log(`PASS: ${result.platform} malformed-percent deep link used ${result.cpuMs.toFixed(3)}ms CPU (${result.budgetMs}ms budget).`);
}
