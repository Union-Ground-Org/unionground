#!/usr/bin/env node
// Publishes an over-the-air update in a build profile's own environment
// (apps/mobile/AGENTS.md "Over-the-air update contract";
// REQ-UG-PHONE-APPS-OVER-THE-AIR-UPDATES-20261113).
//
// EAS Build lays a profile's eas.json `env` over the hosted EAS environment.
// `eas update --environment <name>` does the reverse: it lays the hosted values
// over the caller's. For unionground-production that reapplies the hosted
// SAMPLE backend, and app.config.ts refuses it. So run this inside
// `eas env:exec <environment>`, which puts the hosted values in the process
// environment; this lays the profile's env over them the way EAS Build does,
// and runs `eas update` without --environment:
//
//   cd apps/mobile && eas env:exec production --non-interactive \
//     'node scripts/update-profile-env.mjs unionground-production -- eas update --channel unionground-production --platform ios --message "..." --non-interactive'
//
// It refuses a channel other than the profile's own, --environment and
// --branch, and a missing or "all" platform. No Firebase client file is needed:
// fingerprint.config.js leaves that EAS secret file out of the runtime version.
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/** A profile as EAS resolves it: `extends` first, then its own keys, `env` merged key by key. */
export function resolveEasProfile(easConfig, name, seen = []) {
  const profile = easConfig?.build?.[name];
  if (!profile || typeof profile !== 'object' || seen.includes(name)) {
    throw new Error(`Unknown or cyclic EAS build profile: ${name}.`);
  }
  const parent = typeof profile.extends === 'string' ? resolveEasProfile(easConfig, profile.extends, [...seen, name]) : {};
  return { ...parent, ...profile, env: { ...parent.env, ...profile.env } };
}

/** The environment `eas update` runs in: hosted values, then the profile's env, then its marker. */
export function updateEnvironment(easConfig, profileName, hostedEnvironment) {
  const profile = resolveEasProfile(easConfig, profileName);
  if (profile.channel !== profileName) {
    throw new Error(`EAS build profile ${profileName} must read its own channel.`);
  }
  const environment = {
    ...hostedEnvironment,
    ...profile.env,
    MOBILE_BUILD_PROFILE: profileName,
    // The hosted values are already here; --environment would reapply them over the profile's.
    EAS_UPDATE_SKIP_ENVIRONMENT_CHECK: '1',
  };
  delete environment.EAS_BUILD_PROFILE;
  return environment;
}

function flagValues(args, flag) {
  const values = [];
  args.forEach((arg, index) => {
    if (arg === flag) values.push(args[index + 1] ?? '');
    else if (arg.startsWith(`${flag}=`)) values.push(arg.slice(flag.length + 1));
  });
  return values;
}

/** Problems with an `eas update` command for this profile; empty when it may run. */
export function updateCommandProblems(profileName, command) {
  const problems = [];
  const [program, subcommand, ...args] = command;
  if (!program || !/(?:^|\/)eas$/.test(program) || subcommand !== 'update') {
    problems.push('The command must be `eas update ...`.');
    return problems;
  }
  if (flagValues(args, '--environment').length > 0) {
    problems.push('Leave out --environment: run inside `eas env:exec <environment>` instead.');
  }
  if (flagValues(args, '--branch').length > 0 || args.includes('--auto')) {
    problems.push('Name the channel, not a branch: --channel ' + profileName + '.');
  }
  const channels = flagValues(args, '--channel');
  if (channels.length !== 1 || channels[0] !== profileName) {
    problems.push(`Publish only to this profile's own channel: --channel ${profileName}.`);
  }
  const platforms = [...flagValues(args, '--platform'), ...flagValues(args, '-p')];
  if (platforms.length !== 1 || !['ios', 'android'].includes(platforms[0])) {
    problems.push('Name one platform: --platform ios or --platform android.');
  }
  return problems;
}

function main(argv) {
  const separator = argv.indexOf('--');
  const profileName = argv[0];
  if (!profileName || separator !== 1 || argv.length < 4) {
    console.error('usage: node scripts/update-profile-env.mjs <profile> -- eas update --channel <profile> --platform <ios|android> ...');
    return 2;
  }
  const easConfig = JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), '../eas.json'), 'utf8'));
  const environment = updateEnvironment(easConfig, profileName, process.env);
  const command = argv.slice(separator + 1);
  const problems = updateCommandProblems(profileName, command);
  if (problems.length > 0) {
    for (const problem of problems) console.error(`update-profile-env: ${problem}`);
    return 1;
  }
  const result = spawnSync(command[0], command.slice(1), { stdio: 'inherit', env: environment });
  return result.status ?? 1;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  process.exitCode = main(process.argv.slice(2));
}
