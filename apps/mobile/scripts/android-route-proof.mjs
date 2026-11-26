import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const adb = process.env.ADB_BIN || 'adb';
const outDir = process.env.ANDROID_ROUTE_PROOF_OUT
  || mkdtempSync(join(tmpdir(), 'union-ground-android-route-proof-'));
mkdirSync(outDir, { recursive: true });

// The installed app's id: MOBILE_APPLICATION_ID, else the source placeholder.
/** @type {string} */
const applicationIdOverride = String(process.env['MOBILE_APPLICATION_ID'] ?? '').trim();
/** @type {{ applicationId: string }} */
const releaseFoundation = JSON.parse(readFileSync(new URL('../../../config/mobile-release-foundation.json', import.meta.url), 'utf8'));
/** @type {string} */
const app = applicationIdOverride || releaseFoundation.applicationId;
const rows = [];
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const run = (...args) => execFileSync(adb, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
const runBuffer = (...args) => execFileSync(adb, args, { stdio: ['ignore', 'pipe', 'pipe'] });

function decode(value) {
  return value
    .replaceAll('&quot;', '"')
    .replaceAll('&apos;', "'")
    .replaceAll('&lt;', '<')
    .replaceAll('&gt;', '>')
    .replaceAll('&amp;', '&');
}

function screenSize() {
  const value = run('shell', 'wm', 'size');
  const match = value.match(/(?:Override|Physical) size:\s*(\d+)x(\d+)/g)?.at(-1)?.match(/(\d+)x(\d+)/);
  if (!match) throw new Error(`Could not read Android screen size: ${value.trim()}`);
  return { width: Number(match[1]), height: Number(match[2]) };
}

async function dump(name) {
  const remote = `/sdcard/ug-${process.pid}.xml`;
  const local = join(outDir, `${name}.xml`);
  let lastError = null;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      run('shell', 'uiautomator', 'dump', remote);
      run('pull', remote, local);
      run('shell', 'rm', remote);
      return readFileSync(local, 'utf8');
    } catch (error) {
      lastError = error;
      await sleep(350 * attempt);
    }
  }
  throw lastError;
}

function searchable(xml) {
  const values = [];
  for (const match of xml.matchAll(/(?:text|content-desc)="([^"]*)"/g)) {
    if (match[1]) values.push(decode(match[1]));
  }
  return values.join('\n');
}

function findBounds(xml, description) {
  for (const match of xml.matchAll(/<node\b[^>]*>/g)) {
    const node = match[0];
    const desc = node.match(/content-desc="([^"]*)"/)?.[1];
    if (decode(desc ?? '') !== description) continue;
    const bounds = node.match(/bounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"/);
    if (bounds) return bounds.slice(1).map(Number);
  }
  throw new Error(`Accessibility node not found: ${description}`);
}

async function tapDescription(description, name) {
  const xml = await dump(`${name}-before-tap`);
  const [x1, y1, x2, y2] = findBounds(xml, description);
  run('shell', 'input', 'tap', String(Math.floor((x1 + x2) / 2)), String(Math.floor((y1 + y2) / 2)));
  await sleep(450);
}

async function tapDescriptionAfterScroll(description, name) {
  const { width, height } = screenSize();
  let lastError = null;
  for (let attempt = 1; attempt <= 10; attempt += 1) {
    const xml = await dump(`${name}-attempt-${attempt}`);
    try {
      const [x1, y1, x2, y2] = findBounds(xml, description);
      run('shell', 'input', 'tap', String(Math.floor((x1 + x2) / 2)), String(Math.floor((y1 + y2) / 2)));
      await sleep(450);
      return;
    } catch (error) {
      lastError = error;
    }
    run('shell', 'input', 'swipe', String(Math.floor(width / 2)), String(Math.floor(height * 0.8)), String(Math.floor(width / 2)), String(Math.floor(height * 0.25)), '220');
    await sleep(250);
  }
  throw lastError;
}

async function tapDescriptionContaining(fragment, name) {
  const xml = await dump(`${name}-before-tap`);
  let matchDescription = null;
  for (const match of xml.matchAll(/<node\b[^>]*>/g)) {
    const desc = match[0].match(/content-desc="([^"]*)"/)?.[1];
    if (decode(desc ?? '').includes(fragment)) {
      matchDescription = decode(desc);
      break;
    }
  }
  if (!matchDescription) throw new Error(`Accessibility node containing text not found: ${fragment}`);
  await tapDescription(matchDescription, name);
}

async function assertCurrent(name, expected, options = {}) {
  await sleep(options.wait ?? 400);
  const expectedValues = Array.isArray(expected) ? expected : [expected];
  const deadline = Date.now() + (options.timeout ?? 8_000);
  let text = '';
  let missing = expectedValues;
  let attempt = 0;
  let stableMatches = 0;
  while (Date.now() < deadline) {
    attempt += 1;
    text = searchable(await dump(`${name}-attempt-${attempt}`));
    missing = expectedValues.filter((value) => !text.includes(value));
    stableMatches = missing.length === 0 ? stableMatches + 1 : 0;
    if (stableMatches >= 2) break;
    await sleep(300);
  }
  if (missing.length) {
    writeFileSync(join(outDir, `${name}.txt`), text);
    throw new Error(`${name}: missing ${missing.map((value) => JSON.stringify(value)).join(', ')}`);
  }
  rows.push({ name, route: options.action ?? 'current native screen', expected: expectedValues, result: 'PASS' });
  process.stdout.write(`PASS\t${name}\t${expectedValues.join(' | ')}\n`);
  if (options.screenshot) writeFileSync(join(outDir, `${name}.png`), runBuffer('exec-out', 'screencap', '-p'));
}

async function route(name, url, expected, options = {}) {
  run('shell', 'am', 'start', '-W', '-a', 'android.intent.action.VIEW', '-d', url, app);
  await sleep(options.wait ?? 800);
  await assertCurrent(name, expected, { ...options, action: url, wait: 0 });
}

async function switchHat(_currentHat, nextLabel, expectedIdentity) {
  // Two-word hats (Campaign lead, Campaign chair) name files and rows as slugs.
  const slug = nextLabel.toLowerCase().replace(/\s+/g, '-');
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    const xml = await dump(`hat-${slug}-attempt-${attempt}`);
    const description = [...xml.matchAll(/content-desc="(PREVIEW demo, switch role, [^"]+)"/g)][0]?.[1];
    if (!description) throw new Error(`Current hat switcher not found before selecting ${nextLabel}.`);
    const currentHat = decode(description).replace('PREVIEW demo, switch role, ', '');
    if (currentHat !== nextLabel) {
      await tapDescription(decode(description), `hat-${slug}-switcher-${attempt}`);
      await tapDescription(nextLabel, `hat-${slug}-choice-${attempt}`);
    }
    const selectedXml = await dump(`hat-${slug}-selected-${attempt}`);
    const selectedText = searchable(selectedXml);
    const switcher = `PREVIEW demo, switch role, ${nextLabel}`;
    if (selectedText.includes(switcher) && selectedText.includes(expectedIdentity)) {
      rows.push({ name: `hat-${slug}`, route: 'native hat switcher', expected: [switcher, expectedIdentity], result: 'PASS' });
      process.stdout.write(`PASS\that-${slug}\t${switcher} | ${expectedIdentity}\n`);
      return;
    }
    await sleep(500);
  }
  throw new Error(`Hat selection did not settle on ${nextLabel} after three attempts.`);
}

async function ensureMemberStart() {
  if (process.env.ANDROID_ROUTE_PROOF_REUSE_ACTIVITY !== '1') {
    run('shell', 'am', 'force-stop', app);
    run('shell', 'am', 'start', '-W', '-a', 'android.intent.action.VIEW', '-d', 'unionground://home', app);
  }
  // A release build can resume its native Activity before the React tree is
  // idle enough for UI Automator, especially after a force-stop.
  await sleep(2_500);
  let xml = await dump('startup-identity');
  let description = [...xml.matchAll(/content-desc="(PREVIEW demo, switch role, [^"]+)"/g)][0]?.[1];
  if (description) {
    await route('startup-preview-account', 'unionground://account', 'Account');
    await tapDescriptionAfterScroll('Exit preview', 'startup-exit-preview');
    await tapDescriptionAfterScroll('Confirm exit preview', 'startup-confirm-exit-preview');
  }
  await assertCurrent('startup-signed-out', ['Sign in', 'Try the demo'], {
    action: 'require the signed-out choice before entering PREVIEW',
    screenshot: true,
  });
  await tapDescription('Try the demo', 'startup-preview-entry');
  await sleep(1_500);
  xml = await dump('startup-preview-ready');
  description = [...xml.matchAll(/content-desc="(PREVIEW demo, switch role, [^"]+)"/g)][0]?.[1];
  if (!description) throw new Error('The installed app did not reach the explicit PREVIEW surface.');
  const currentHat = decode(description).replace('PREVIEW demo, switch role, ', '');
  if (currentHat !== 'Worker') await switchHat(currentHat, 'Worker', 'Darnell');
}

async function main() {
  run('get-state');
  const { width, height } = screenSize();
  await ensureMemberStart();

  await route('home-member', 'unionground://home', ['Darnell', 'PREVIEW demo, switch role, Worker'], { screenshot: true });
  await route('work-member', 'unionground://work', 'Work');
  await route('compass-member', 'unionground://compass', 'Guide');
  await route('campaign-member', 'unionground://campaign', 'Campaign');
  await route('account-member', 'unionground://account', 'Account');
  await route('messages-member', 'unionground://messages', 'Messages');
  await tapDescriptionContaining('# meeting-planning,', 'channel-member-open');
  await assertCurrent('channel-member-ready', ['Message #meeting-planning', 'September-open-meeting-flyer.pdf'], { action: 'tap authorized channel inbox row', screenshot: true });
  await route('notifications-member', 'unionground://notifications', 'Activity');

  const commonFeatures = [
    ['voting', 'Votes'], ['rewards', 'Contributions'], ['cases', 'My issues'], ['forms', 'Forms'],
    ['workload', 'Workplace log'], ['numbers', 'My reports'], ['appointments', 'One-on-ones'],
    ['rights', 'Organizing rights'], ['chapter', 'My campaign'], ['voice', 'Be heard'],
    ['events', 'Meetings'], ['search', 'Search'], ['chapters', 'Campaigns'],
    ['member-support', 'Worker support'], ['pay', 'Pay tools'],
    ['actions', 'Digital Picket Line'], ['qa', 'Worker questions'],
  ];
  for (const [key, title] of commonFeatures) {
    await route(`feature-${key}-member`, `unionground://feature/${key}`, title, { screenshot: key === 'voting' });
  }
  await route('search-empty-prep', 'unionground://feature/search', 'Search');
  await tapDescription('Search', 'search-empty-input');
  run('shell', 'input', 'text', 'zzzzproofnomatch');
  await assertCurrent('search-empty', 'No authorized matches', { action: 'enter non-matching authorized search query', screenshot: true });

  await route('staff-denied-member', 'unionground://feature/steward', ['Committee desk opens under another hat', 'The Committee hat opens it.'], { screenshot: true });
  await route('partners-denied-member', 'unionground://feature/partners', ['Campaign agreements is an organizing tool', 'Organizer, Committee, Campaign lead, Advisor, Admin, and Campaign chair hats open it.'], { screenshot: true });
  await route('analytics-denied-member', 'unionground://feature/analytics', ['Organization analytics is an organizing tool', 'Organizer, Committee, Campaign lead, Advisor, Admin, and Campaign chair hats open it.']);
  await route('organization-map-denied-member', 'unionground://feature/organization-map', ['Power map is an organizing tool', 'Organizer, Committee, Campaign lead, Advisor, Admin, and Campaign chair hats open it.']);
  await route('issue-member-ready', 'unionground://issue/b872b7c3-fdf2-497e-9d91-5b456724a1f0', ['HCU-104', 'What has happened']);
  await route('issue-member-missing', 'unionground://issue/33333333-3333-4333-8333-333333333333', 'Issue not available', { screenshot: true });
  await route('conversation-member-ready', 'unionground://conversation/bfd2c08d-384c-4fd1-85e1-5a746ccd63b7', ['Elena Cruz', 'Private conversation']);
  await route('conversation-member-missing', 'unionground://conversation/33333333-3333-4333-8333-333333333333', 'Conversation not available');
  await route('channel-member-missing', 'unionground://channel/33333333-3333-4333-8333-333333333333', 'Channel not available');

  const legal = [
    ['privacy', 'Privacy'], ['terms', 'Terms of use'], ['accessibility', 'Accessibility'],
    ['about', 'About Union Ground'], ['ai-disclosure', 'Guide disclosure'],
    ['retention', 'Data retention'],
  ];
  for (const [key, title] of legal) await route(`legal-${key}`, `unionground://legal/${key}`, title);
  for (let index = 0; index < 6; index += 1) {
    run('shell', 'input', 'swipe', String(Math.floor(width / 2)), String(Math.floor(height * 0.8)), String(Math.floor(width / 2)), String(Math.floor(height * 0.2)), '220');
    await sleep(100);
  }
  await assertCurrent('legal-retention-long-content', ['On this device', 'Before live accounts open'], { action: 'scroll retention page to its final section', screenshot: true });
  run('shell', 'input', 'keyevent', '4');
  await assertCurrent('android-hardware-back', 'Guide disclosure', { action: 'Android hardware Back from retention document' });

  await route('swipe-redirect', 'unionground://swipe', ['Darnell', 'PREVIEW demo, switch role, Worker']);
  await tapDescriptionContaining('Polls & surveys,', 'pulse-member-open');
  await assertCurrent('pulse-member', ['Campaign pulse', 'PARTICIPATION'], { action: 'tap Home Polls & surveys route', screenshot: true });

  await route('home-before-organizer-switch', 'unionground://home', ['Darnell', 'PREVIEW demo, switch role, Worker']);
  await switchHat('Worker', 'Organizer', 'Elena');
  await route('desk-organizer', 'unionground://feature/organizer', 'Organizing desk', { screenshot: true });

  await route('home-before-committee-switch', 'unionground://home', ['Elena', 'PREVIEW demo, switch role, Organizer']);
  await switchHat('Organizer', 'Committee', 'Maya');
  await route('desk-committee', 'unionground://feature/steward', 'Committee desk', { screenshot: true });
  await route('staff-tasks-committee', 'unionground://feature/tasks', 'Campaign work');
  await route('staff-events-committee', 'unionground://feature/events-desk', 'Meetings desk');
  await route('staff-campaigns-committee', 'unionground://feature/campaigns', 'Issue campaigns');
  await route('staff-partners-committee', 'unionground://feature/partners', 'Campaign agreements', { screenshot: true });
  await route('staff-analytics-committee', 'unionground://feature/analytics', 'Organization analytics');
  await route('staff-organization-map-committee', 'unionground://feature/organization-map', 'Power map');

  await route('home-before-campaign-lead-switch', 'unionground://home', ['Maya', 'PREVIEW demo, switch role, Committee']);
  await switchHat('Committee', 'Campaign lead', 'Andre');
  await route('desk-campaign-lead', 'unionground://feature/coordinator', 'Issue queue');

  await route('home-before-advisor-switch', 'unionground://home', ['Andre', 'PREVIEW demo, switch role, Campaign lead']);
  await switchHat('Campaign lead', 'Advisor', 'Priya');
  await route('desk-advisor', 'unionground://feature/advisor', 'Campaign health', { screenshot: true });
  await route('advisor-appointments-history', 'unionground://feature/appointments', ['Advisor follow-up', '2025', '2024', '2023']);

  await route('home-before-admin-switch', 'unionground://home', ['Priya', 'PREVIEW demo, switch role, Advisor']);
  await switchHat('Advisor', 'Admin', 'Rosa');
  await route('desk-admin', 'unionground://feature/admin', 'Workspace admin');
  await route('staff-health-admin', 'unionground://feature/chapter-health', ['Health portfolio', 'Score over time'], { screenshot: true });
  await route('chapters-catalog-admin', 'unionground://feature/chapters', ['Campaigns', 'North County Transit Workers'], { screenshot: true });
  await route('staff-integrations-admin', 'unionground://feature/integrations', 'Integration controls');
  await route('staff-operations-admin', 'unionground://feature/operations', 'Operations health');

  await route('home-before-campaign-chair-switch', 'unionground://home', ['Rosa', 'PREVIEW demo, switch role, Admin']);
  await switchHat('Admin', 'Campaign chair', 'Jordan');
  await route('desk-campaign-chair', 'unionground://feature/vp', 'Campaign overview', { screenshot: true });

  await route('home-before-worker-restore', 'unionground://home', ['Jordan', 'PREVIEW demo, switch role, Campaign chair']);
  await switchHat('Campaign chair', 'Worker', 'Darnell');
  await route('home-member-restored', 'unionground://home', ['Darnell', 'PREVIEW demo, switch role, Worker']);

  writeFileSync(join(outDir, 'route-matrix.json'), `${JSON.stringify(rows, null, 2)}\n`);
  writeFileSync(join(outDir, 'route-matrix.tsv'), `name\troute\texpected\tresult\n${rows.map((row) => `${row.name}\t${row.route}\t${row.expected.join(' | ')}\t${row.result}`).join('\n')}\n`);
  process.stdout.write(`SUMMARY\t${rows.length}\tPASS\nPROOF_DIR\t${outDir}\n`);
}

main().catch((error) => {
  process.stderr.write(`${error.stack ?? error}\nPROOF_DIR\t${outDir}\n`);
  process.exitCode = 1;
});
