#!/usr/bin/env node
// Fails when an Android manifest grants a permission the app blocks, declares a
// media-playback foreground service, or loses the microphone permission voice
// notes need. Google Play will not accept the FOREGROUND_SERVICE_MEDIA_PLAYBACK
// declaration without a background-playback demo video, and voice notes play
// only while their screen is open (October 18, 2026). CI runs this after
// Gradle assembles the app, on the merged and packaged manifests, so library
// manifests are covered as well as app.config.ts. Pass manifest paths to check
// other files, such as the prebuild source manifest.
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

export const BLOCKED_PERMISSIONS = [
  'android.permission.FOREGROUND_SERVICE',
  'android.permission.FOREGROUND_SERVICE_MEDIA_PLAYBACK',
];
export const REQUIRED_PERMISSIONS = ['android.permission.RECORD_AUDIO'];
const MANIFEST_OUTPUT_DIRECTORIES = new Set(['merged_manifest', 'merged_manifests', 'packaged_manifests']);

// Names are fixed prefixed literals such as android:name; none needs escaping.
/** @param {string} element @param {string} name */
function attribute(element, name) {
  const match = new RegExp(`\\s${name}\\s*=\\s*"([^"]*)"`, 'u').exec(element);
  return match ? match[1] : undefined;
}

/**
 * Permissions a manifest grants, the ones it removes with tools:node="remove",
 * and services whose foregroundServiceType includes mediaPlayback.
 * @param {string} xml
 */
export function readManifest(xml) {
  // -{2} rather than a literal double dash: parsers that honor HTML-like
  // comments (semgrep's) would otherwise read the pattern as a comment.
  const source = xml.replace(/<!-{2}[\s\S]*?-{2}>/gu, '');
  /** @type {string[]} */
  const granted = [];
  /** @type {string[]} */
  const removed = [];
  for (const [element] of source.matchAll(/<uses-permission(?:-sdk-23)?\b[^>]*>/gu)) {
    const name = attribute(element, 'android:name');
    if (!name) continue;
    (attribute(element, 'tools:node') === 'remove' ? removed : granted).push(name);
  }
  /** @type {string[]} */
  const mediaPlaybackServices = [];
  for (const [element] of source.matchAll(/<service\b[^>]*>/gu)) {
    const types = attribute(element, 'android:foregroundServiceType') ?? '';
    if (types.split('|').map((type) => type.trim()).includes('mediaPlayback')) {
      mediaPlaybackServices.push(attribute(element, 'android:name') ?? '(unnamed service)');
    }
  }
  return { granted, removed, mediaPlaybackServices };
}

/** @param {string} xml @returns {string[]} */
export function manifestFailures(xml) {
  const { granted, mediaPlaybackServices } = readManifest(xml);
  return [
    ...BLOCKED_PERMISSIONS.filter((name) => granted.includes(name)).map((name) => `grants blocked permission ${name}`),
    ...mediaPlaybackServices.map((name) => `declares media-playback foreground service ${name}`),
    ...REQUIRED_PERMISSIONS.filter((name) => !granted.includes(name)).map((name) => `is missing required permission ${name}`),
  ];
}

/**
 * Gradle's merged and packaged manifests for one variant under android/app/build.
 * @param {string} androidDirectory
 * @param {string} variant
 * @returns {string[]}
 */
export function builtManifestPaths(androidDirectory, variant = 'debug') {
  const intermediates = join(androidDirectory, 'app', 'build', 'intermediates');
  if (!existsSync(intermediates)) return [];
  return readdirSync(intermediates, { recursive: true, encoding: 'utf8' })
    .filter((path) => {
      const segments = path.split(sep);
      return segments.at(-1) === 'AndroidManifest.xml'
        && MANIFEST_OUTPUT_DIRECTORIES.has(segments[0] ?? '')
        && segments[1] === variant;
    })
    .map((path) => join(intermediates, path))
    .sort();
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const androidDirectory = fileURLToPath(new URL('../android', import.meta.url));
  const explicit = process.argv.slice(2);
  const paths = explicit.length > 0 ? explicit : builtManifestPaths(androidDirectory);
  if (paths.length === 0) {
    console.error(`android manifest: FAIL no merged or packaged debug manifest under ${androidDirectory}/app/build/intermediates; assemble the app first`);
    process.exit(1);
  }
  let failed = false;
  for (const path of paths) {
    const nearby = relative(process.cwd(), path);
    const label = nearby && !nearby.startsWith('..') ? nearby : path;
    const failures = manifestFailures(readFileSync(path, 'utf8'));
    for (const failure of failures) console.error(`android manifest: FAIL ${label} ${failure}`);
    if (failures.length === 0) console.log(`android manifest: ok ${label} (no ${BLOCKED_PERMISSIONS.join(', ')}; no mediaPlayback service; RECORD_AUDIO present)`);
    failed ||= failures.length > 0;
  }
  if (failed) process.exit(1);
}
