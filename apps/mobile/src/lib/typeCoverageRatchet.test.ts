import { spawn, spawnSync } from 'node:child_process';
import {
  copyFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  BASELINE_PATH,
  DEFAULT_NEW_FILE_FLOOR,
  EXCLUDED_PATTERNS,
  MINIMUM_NEW_FILE_FLOOR,
  MOBILE_ROOT,
  SUPPRESSION_KINDS,
  aggregateBaseCommit,
  compare,
  evaluate,
  isMeasured,
  loadBaseline,
  measure,
  measureAtCommit,
  parseArguments,
  perFileFailures,
  validateBaseline,
} from '../../scripts/type-coverage-ratchet.mjs';

const FIXTURE_ROOT = new URL('../../scripts/fixtures/type-coverage', import.meta.url).pathname;
const FIXTURE_ROOTS = ['safe', 'unsafe'] as const;
const REPOSITORY_ROOT = join(MOBILE_ROOT, '../..');

type NodeRun = { status: number | null; stdout: string; stderr: string };

function runNode(args: string[], cwd: string, env: NodeJS.ProcessEnv = process.env) {
  return new Promise<NodeRun>((resolveRun) => {
    const child = spawn(process.execPath, args, { cwd, env });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8').on('data', (chunk: string) => { stdout += chunk; });
    child.stderr.setEncoding('utf8').on('data', (chunk: string) => { stderr += chunk; });
    child.on('error', (error) => resolveRun({ status: null, stdout, stderr: `${stderr}${error.message}` }));
    child.on('close', (status) => resolveRun({ status, stdout, stderr }));
  });
}

// Each of the three measurements of the real application below rebuilds the
// whole TypeScript program, which takes seconds and grows with host load
// (OPS-UG-TESTS-HOLD-UNDER-HOST-LOAD-20261030). The two that need their own
// process start here, before the in-process measurement, so all three run at
// once; the tests that read them await the results.
const RATCHET_SCRIPT = join(MOBILE_ROOT, 'scripts/type-coverage-ratchet.mjs');
const HEAD = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: MOBILE_ROOT, encoding: 'utf8' }).stdout.trim();
// The enforce command CI runs, started from the repository root.
const rootRun = runNode(
  [RATCHET_SCRIPT, '--baseline', BASELINE_PATH],
  REPOSITORY_ROOT,
  { ...process.env, GITHUB_ACTIONS: 'false', TYPE_COVERAGE_BASE_SHA: 'none' },
);
// measureAtCommit(HEAD), the exported function itself, in a child process. The
// commit is argv[1], so the script's own command-line entry point stays idle.
const headRun = runNode([
  '--input-type=module',
  '-e',
  [
    "import { pathToFileURL } from 'node:url';",
    'const [commit, script] = process.argv.slice(1);',
    'const { measureAtCommit } = await import(pathToFileURL(script).href);',
    'const measured = measureAtCommit(commit);',
    'process.stdout.write(JSON.stringify(measured && { coveragePercent: measured.coveragePercent }));',
  ].join('\n'),
  HEAD,
  RATCHET_SCRIPT,
], MOBILE_ROOT);

const fixtureMeasurement = measure({ projectRoot: FIXTURE_ROOT, roots: FIXTURE_ROOTS });
// Measuring the maintained program builds a full TypeScript program, so it is
// done once and shared by every test that needs the real application numbers.
const applicationMeasurement = measure();

function fixtureFile(path: string) {
  const file = fixtureMeasurement.files.find((candidate) => candidate.path === path);
  if (file === undefined) throw new Error(`missing fixture measurement for ${path}`);
  return file;
}

describe('type-coverage measurement scope', () => {
  it.each([
    ['src/lib/appConfig.ts', true],
    ['app/(tabs)/campaign.tsx', true],
    ['scripts/type-coverage-ratchet.mjs', true],
    ['src/new.js', true],
    ['src/new.jsx', true],
    ['scripts/types.d.mts', false],
    ['expo-env.d.ts', false],
    ['.expo/types/router.d.ts', false],
    ['src/types/global.d.ts', false],
    ['node_modules/expo/index.ts', false],
    ['README.md', false],
  ])('classifies %s as measured=%s', (path, expected) => {
    expect(isMeasured(path)).toBe(expected);
  });

  it('excludes only generated and ambient declarations', () => {
    expect(EXCLUDED_PATTERNS.map(String)).toEqual([
      '/(^|\\/)node_modules\\//',
      '/(^|\\/)\\.expo\\//',
      '/(^|\\/)expo-env\\.d\\.ts$/',
      '/\\.d\\.[cm]?ts$/',
    ]);
  });
});

describe('type-coverage fixtures', () => {
  it('reports the untyped API boundary', () => {
    expect(fixtureFile('unsafe/anyBoundary.ts').coveragePercent).toBeLessThan(50);
    expect(fixtureFile('unsafe/anyBoundary.ts').suppressions.explicitAny).toBeGreaterThan(0);
  });

  it('reports the native-module `as any` escape', () => {
    const file = fixtureFile('unsafe/asAny.ts');
    expect(file.suppressions.asAny).toBe(1);
    expect(file.coveragePercent).toBeLessThan(50);
  });

  it('reports the `as unknown as` double assertion', () => {
    expect(fixtureFile('unsafe/doubleAssertion.ts').suppressions.doubleAssertion).toBe(1);
  });

  it('reports the suppressed error', () => {
    expect(fixtureFile('unsafe/ignoredError.ts').suppressions.tsIgnore).toBe(1);
  });

  it('leaves the typed counterpart clean', () => {
    const file = fixtureFile('safe/typedBoundary.ts');
    expect(file.coveragePercent).toBeGreaterThanOrEqual(95);
    for (const kind of SUPPRESSION_KINDS) expect(file.suppressions[kind]).toBe(0);
  });

  it('fails the ratchet when the fixture project is measured against the app baseline', () => {
    const failures = compare(fixtureMeasurement, loadBaseline());
    expect(failures.length).toBeGreaterThan(0);
    expect(failures.join('\n')).toMatch(/aggregate type coverage fell/);
  });
});

describe('baseline contract', () => {
  const baseline = loadBaseline();

  it('is valid', () => {
    expect(validateBaseline(baseline)).toEqual([]);
  });

  it('records an honestly measured aggregate and per-file map', () => {
    expect(baseline.minimum_coverage_percent).toBeGreaterThan(90);
    expect(Object.keys(baseline.files).length).toBeGreaterThan(100);
    expect(baseline.new_file_minimum_percent).toBe(DEFAULT_NEW_FILE_FLOOR);
  });

  it.each([
    ['a dropped new-file floor', { new_file_minimum_percent: 0 }],
    ['a zero aggregate floor', { minimum_coverage_percent: 0 }],
    ['a missing per-file map', { files: undefined }],
    ['an undated measurement', { measured_on: 'today' }],
  ])('refuses a baseline with %s', (_label, patch) => {
    expect(validateBaseline({ ...baseline, ...patch }).length).toBeGreaterThan(0);
  });

  it('refuses a new-file floor below the reviewed minimum', () => {
    expect(
      validateBaseline({ ...baseline, new_file_minimum_percent: MINIMUM_NEW_FILE_FLOOR - 1 }).length,
    ).toBeGreaterThan(0);
  });

  it('refuses a suppression ceiling that is not a count', () => {
    expect(
      validateBaseline({
        ...baseline,
        maximum_suppressions: { ...baseline.maximum_suppressions, asAny: -1 },
      }).length,
    ).toBeGreaterThan(0);
  });
});

describe('additive-only enforcement', () => {
  const baseline = loadBaseline();

  it('holds for the maintained application at this revision', () => {
    expect(evaluate(applicationMeasurement, baseline)).toEqual([]);
    expect(applicationMeasurement.fileCount).toBeGreaterThan(100);
  });

  it('applies the per-file rules to the whole measured program, needing no base ref', () => {
    expect(perFileFailures(applicationMeasurement, baseline)).toEqual([]);
    // The rule is only meaningful if it is actually reading recorded files, so
    // assert it compared a real population rather than passing vacuously.
    const recognised = applicationMeasurement.files.filter(
      (file) => file.identifiers > 0 && Object.hasOwn(baseline.files, file.path),
    );
    expect(recognised.length).toBeGreaterThan(100);
  });

  it('catches a single-file regression the aggregate floor would hide', () => {
    const [path, recorded] = Object.entries(baseline.files)[0] as [string, number];
    const regressed = {
      ...applicationMeasurement,
      files: applicationMeasurement.files.map((file) => (file.path === path
        ? { ...file, coveragePercent: recorded - 1 }
        : file)),
    };
    // One file sliding a point leaves the repository-wide number and every
    // suppression ceiling untouched...
    expect(compare(regressed, baseline)).toEqual([]);
    // ...so only the per-file rule stands between that slide and a green lane.
    // `evaluate` is exactly what the bare `npm run type-coverage` invocation
    // enforces, so this fails if the rule is ever dropped from that path.
    expect(evaluate(regressed, baseline).join('\n')).toContain(`${path} fell to`);
  });

  it('fails when a known file loses coverage', () => {
    const [path, recorded] = Object.entries(baseline.files)[0] as [string, number];
    const regressed = {
      ...fixtureMeasurement,
      files: [{
        path,
        identifiers: 100,
        any: 100,
        coveragePercent: recorded - 1,
        suppressions: { tsNoCheck: 0, tsIgnore: 0, tsExpectError: 0, explicitAny: 0, asAny: 0, doubleAssertion: 0 },
      }],
    };
    expect(perFileFailures(regressed, baseline).join('\n')).toMatch(/fell to/);
  });

  it('fails when a new file lands below the new-file floor', () => {
    const measurement = {
      ...fixtureMeasurement,
      files: [{
        path: 'src/lib/brandNew.ts',
        identifiers: 100,
        any: 40,
        coveragePercent: 60,
        suppressions: { tsNoCheck: 0, tsIgnore: 0, tsExpectError: 0, explicitAny: 0, asAny: 0, doubleAssertion: 0 },
      }],
    };
    expect(perFileFailures(measurement, baseline).join('\n'))
      .toMatch(/below the .* floor for new files/);
  });

  it('accepts a file that holds its recorded coverage', () => {
    const [path, recorded] = Object.entries(baseline.files)[0] as [string, number];
    const measurement = {
      ...fixtureMeasurement,
      files: [{
        path,
        identifiers: 100,
        any: 0,
        coveragePercent: recorded,
        suppressions: { tsNoCheck: 0, tsIgnore: 0, tsExpectError: 0, explicitAny: 0, asAny: 0, doubleAssertion: 0 },
      }],
    };
    expect(perFileFailures(measurement, baseline)).toEqual([]);
  });

  it('fails when a suppression ceiling is exceeded', () => {
    const measurement = {
      ...fixtureMeasurement,
      coveragePercent: baseline.minimum_coverage_percent,
      suppressions: {
        ...baseline.maximum_suppressions,
        asAny: baseline.maximum_suppressions.asAny + 1,
      },
    };
    expect(compare(measurement, baseline).join('\n')).toMatch(/asAny suppressions rose/);
  });
});

// (pipeline loosening, wave 5):
// the aggregate floor is the comparison base's measured coverage, and the
// committed number is only the backstop when no base can be measured.
describe('aggregate floor from the comparison base', () => {
  const baseline = loadBaseline();
  const SHA = 'a'.repeat(40);

  it('judges the aggregate against the measured base instead of the committed number', () => {
    const lower = { ...applicationMeasurement, coveragePercent: baseline.minimum_coverage_percent - 1 };
    expect(compare(lower, baseline).join('\n')).toContain('aggregate type coverage fell');
    const baseFloor = { percent: lower.coveragePercent, source: 'the comparison base aaaaaaaaaaaa' };
    expect(compare(lower, baseline, { aggregateFloor: baseFloor })).toEqual([]);
    expect(compare(lower, baseline, { aggregateFloor: { ...baseFloor, percent: lower.coveragePercent + 0.01 } }).join('\n'))
      .toContain('measured at the comparison base aaaaaaaaaaaa');
    // The per-file rules do not depend on the aggregate source.
    expect(evaluate(lower, baseline, { aggregateFloor: baseFloor })).toEqual(perFileFailures(lower, baseline));
  });

  it('chooses the base from the environment, the merge base locally, and nothing in CI unless named', () => {
    expect(aggregateBaseCommit({ env: { TYPE_COVERAGE_BASE_SHA: 'none' } })).toBeNull();
    expect(aggregateBaseCommit({ env: { TYPE_COVERAGE_BASE_SHA: SHA, GITHUB_ACTIONS: 'true' } })).toBe(SHA);
    expect(() => aggregateBaseCommit({ env: { TYPE_COVERAGE_BASE_SHA: 'Main' } })).toThrow(/exact commit or none/);
    expect(aggregateBaseCommit({ env: { GITHUB_ACTIONS: 'true' } })).toBeNull();
    expect(aggregateBaseCommit({ repositoryRoot: tmpdir(), env: {} })).toBeNull();
  });

  it('measures a commit from its own tree, and returns null for one it cannot read', async () => {
    const clean = spawnSync('git', ['status', '--porcelain', '--', '.'], { cwd: MOBILE_ROOT, encoding: 'utf8' }).stdout === '';
    const result = await headRun;
    expect(result.stderr).toBe('');
    expect(result.status).toBe(0);
    const atHead = JSON.parse(result.stdout) as { coveragePercent: number } | null;
    expect(atHead).not.toBeNull();
    if (clean) expect(atHead?.coveragePercent).toBe(applicationMeasurement.coveragePercent);
    expect(measureAtCommit('0'.repeat(40))).toBeNull();
  }, 180_000);
});

describe('reviewed bypass regressions', () => {
  it('TEST-UG-MOBILE-TYPE-COVERAGE-RATCHET-20260904 counts every compiler-recognized error directive and rejects zero ceilings', () => {
    const scratch = mkdtempSync(join(tmpdir(), 'type-coverage-directives-'));
    try {
      writeFileSync(join(scratch, 'tsconfig.json'), JSON.stringify({
        compilerOptions: { strict: true },
        include: ['src'],
      }));
      mkdirSync(join(scratch, 'src'));
      const directiveForms: ReadonlyArray<readonly [string, (kind: string) => string]> = [
        ['trailing-line', (kind: string) => `const anchor = 1; // @${kind}\n`],
        ['trailing-block', (kind: string) => `const anchor = 1; /* @${kind} */\n`],
        ['triple-slash', (kind: string) => `/// @${kind}\n`],
        ['multiline-block', (kind: string) => `/* explanatory prose\n * @${kind} */\n`],
      ];
      const directiveKinds: readonly string[] = ['ts-ignore', 'ts-expect-error'];
      for (const kind of directiveKinds) {
        for (const [form, prefix] of directiveForms) {
          writeFileSync(
            join(scratch, 'src', `${kind}-${form}.ts`),
            `${prefix(kind)}export const protectedValue: string = 42;\n`,
          );
        }
      }
      writeFileSync(join(scratch, 'src/inert.ts'), [
        '// Ordinary prose mentioning @ts-ignore and @ts-expect-error is inert.',
        'export const prose = "strings containing @ts-ignore and @ts-expect-error are inert";',
      ].join('\n'));

      const compiler = spawnSync(
        join(MOBILE_ROOT, 'node_modules/.bin/tsc'),
        ['--noEmit', '--project', scratch],
        { encoding: 'utf8' },
      );
      expect(compiler.stderr).toBe('');
      expect(compiler.status).toBe(0);

      const measured = measure({ projectRoot: scratch });
      expect(measured.suppressions.tsIgnore).toBe(4);
      expect(measured.suppressions.tsExpectError).toBe(4);
      expect(measured.files.find((file) => file.path === 'src/inert.ts')?.suppressions)
        .toMatchObject({ tsIgnore: 0, tsExpectError: 0 });

      const baseline = {
        ...loadBaseline(),
        minimum_coverage_percent: 0.01,
        files: {},
        new_file_minimum_percent: MINIMUM_NEW_FILE_FLOOR,
        maximum_suppressions: {
          tsNoCheck: 0,
          tsIgnore: 0,
          tsExpectError: 0,
          explicitAny: 0,
          asAny: 0,
          doubleAssertion: 0,
        },
      };
      for (const directiveKind of directiveKinds) {
        const countKind = directiveKind === 'ts-ignore' ? 'tsIgnore' : 'tsExpectError';
        for (const [form] of directiveForms) {
          const file = measured.files.find(
            (candidate) => candidate.path === `src/${directiveKind}-${form}.ts`,
          );
          expect(file?.suppressions[countKind]).toBe(1);
          expect(compare({ ...measured, suppressions: file!.suppressions }, baseline).join('\n'))
            .toContain(`${countKind} suppressions rose to 1, above the 0 ceiling`);
        }
      }
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
    // tsc plus a measured program: seconds under host load, past Vitest's 5 s default.
  }, 60_000);

  it('rejects removing an existing 100% file entry even when it still clears the new-file floor', () => {
    const baseline = loadBaseline();
    const path = Object.entries(baseline.files).find(([, percent]) => percent === 100)?.[0];
    expect(path).toBeDefined();
    const removed = { ...baseline, files: { ...baseline.files } };
    delete removed.files[path!];
    expect(evaluate(applicationMeasurement, removed).join('\n')).toContain(`${path} is missing`);
  });
  it('measures JavaScript and a file-wide suppression in a real fixture program', () => {
    const scratch = mkdtempSync(join(tmpdir(), 'type-coverage-js-'));
    try {
      writeFileSync(join(scratch, 'tsconfig.json'), JSON.stringify({ compilerOptions: { allowJs: true, strict: true }, include: ['src'] }));
      mkdirSync(join(scratch, 'src'));
      writeFileSync(join(scratch, 'src/untyped.js'), '// @ts-nocheck\nexport function boundary(value) { return value.record; }\n');
      const measured = measure({ projectRoot: scratch });
      expect(measured.files.map(file => file.path)).toContain('src/untyped.js');
      expect(measured.suppressions.tsNoCheck).toBe(1);
      expect(measured.anyIdentifiers).toBeGreaterThan(0);
    } finally { rmSync(scratch, { recursive: true, force: true }); }
  }, 60_000);
});

describe('argument parsing', () => {
  it('defaults to the committed baseline', () => {
    expect(parseArguments([]).baselinePath).toBe(BASELINE_PATH);
    expect(parseArguments([])).toMatchObject({ report: false, update: false, acceptRegression: false });
  });

  it('accepts an explicit baseline for diagnostics', () => {
    expect(parseArguments(['--baseline', '/tmp/other.json']).baselinePath).toBe('/tmp/other.json');
  });

  it('refuses a --baseline without a path', () => {
    expect(() => parseArguments(['--baseline'])).toThrow(/--baseline needs a path/);
    expect(() => parseArguments(['--baseline', '--report'])).toThrow(/--baseline needs a path/);
  });
});

describe('the command CI runs', () => {
  // These assertions execute `node scripts/type-coverage-ratchet.mjs` as a
  // process rather than calling the exported rule functions, because the
  // failure this record exists to prevent is the enforce path quietly calling a
  // narrower rule set than the exported one. Every run rebuilds its TypeScript
  // program, which costs seconds for the maintained application and grows with
  // host load (OPS-UG-TESTS-HOLD-UNDER-HOST-LOAD-20261030), so the
  // application is run once (`rootRun` above). The doctored-baseline runs drive
  // a byte-identical copy of the script inside a small Git repository that
  // mirrors the apps/mobile layout around the fixture program: the copy resolves
  // its project, default baseline and Git history from its own location, so
  // every rule and history read the real command performs runs unchanged, over
  // a program that builds in well under a second.
  const scratch = mkdtempSync(join(tmpdir(), 'type-coverage-ratchet-'));
  const mirror = realpathSync(mkdtempSync(join(tmpdir(), 'type-coverage-mirror-')));
  const mirrorMobile = join(mirror, 'apps/mobile');
  const mirrorBaselinePath = join(mirrorMobile, 'type-coverage-baseline.json');
  // Inherited GIT_* variables (a hook's GIT_DIR, for one) would point these Git
  // commands, and the copy's history reads, at the real repository.
  const isolatedEnv: NodeJS.ProcessEnv = { ...process.env, GITHUB_ACTIONS: 'false', TYPE_COVERAGE_BASE_SHA: 'none' };
  for (const name of Object.keys(isolatedEnv)) if (name.startsWith('GIT_')) delete isolatedEnv[name];
  afterAll(() => {
    rmSync(scratch, { recursive: true, force: true });
    rmSync(mirror, { recursive: true, force: true });
  });

  function git(...args: string[]) {
    const result = spawnSync('git', [
      '-c', 'user.name=Type coverage fixture', '-c', 'user.email=fixture@example.invalid',
      '-c', 'commit.gpgsign=false', '-c', 'core.hooksPath=/dev/null', ...args,
    ], { cwd: mirror, encoding: 'utf8', env: isolatedEnv });
    if (result.status !== 0) throw new Error(`git ${args[0]} failed in the mirror: ${result.stderr}`);
  }

  beforeAll(() => {
    mkdirSync(join(mirrorMobile, 'scripts'), { recursive: true });
    copyFileSync(join(MOBILE_ROOT, 'scripts/type-coverage-ratchet.mjs'), join(mirrorMobile, 'scripts/type-coverage-ratchet.mjs'));
    // The copy imports the shared history and pin readers through
    // ../../../scripts, and TypeScript through its own node_modules.
    symlinkSync(join(REPOSITORY_ROOT, 'scripts'), join(mirror, 'scripts'), 'junction');
    symlinkSync(join(MOBILE_ROOT, 'node_modules'), join(mirrorMobile, 'node_modules'), 'junction');
    const fixtureConfig = JSON.parse(readFileSync(join(FIXTURE_ROOT, 'tsconfig.json'), 'utf8')) as object;
    writeFileSync(join(mirrorMobile, 'tsconfig.json'), JSON.stringify({ ...fixtureConfig, include: ['src'] }));
    for (const root of FIXTURE_ROOTS) cpSync(join(FIXTURE_ROOT, root), join(mirrorMobile, 'src', root), { recursive: true });
    const measured = measure({ projectRoot: mirrorMobile });
    writeFileSync(mirrorBaselinePath, `${JSON.stringify({
      schema: 1,
      measured_on: '2026-10-30',
      minimum_coverage_percent: measured.coveragePercent,
      new_file_minimum_percent: DEFAULT_NEW_FILE_FLOOR,
      maximum_suppressions: measured.suppressions,
      measured_file_count: measured.fileCount,
      exclusions: EXCLUDED_PATTERNS.map(String),
      files: Object.fromEntries(measured.files.map((file) => [file.path, file.coveragePercent])),
    }, null, 2)}\n`);
    // The committed baseline is the history the copy guards.
    git('init', '-q');
    git('add', 'apps/mobile/tsconfig.json', 'apps/mobile/src', 'apps/mobile/type-coverage-baseline.json');
    git('commit', '-q', '-m', 'fixture baseline');
  });

  function runMirror(...args: string[]) {
    return spawnSync(process.execPath, ['scripts/type-coverage-ratchet.mjs', ...args], {
      cwd: mirrorMobile, encoding: 'utf8', env: isolatedEnv,
    });
  }

  it('holds against the committed baseline from the repository root, measuring the same ambient types as the mobile directory', async () => {
    const result = await rootRun;
    expect(result.stderr).toBe('');
    expect(result.status).toBe(0);
    // The in-process program is built from Vitest's working directory, which
    // `npm run test` sets to apps/mobile; the run above starts at the root.
    const measurement = applicationMeasurement;
    expect(result.stdout.split('\n')[0]).toBe(
      `type coverage: ${measurement.coveragePercent}% over ${measurement.fileCount} maintained files `
        + `(${measurement.anyIdentifiers} of ${measurement.totalIdentifiers} identifiers are any); `
        + `suppressions ${JSON.stringify(measurement.suppressions)}`,
    );
    expect(result.stdout).toContain('ratchet holds');
  }, 180_000);

  it('runs a byte-identical copy of the command over the fixture mirror, which holds against its committed baseline', () => {
    expect(readFileSync(join(mirrorMobile, 'scripts/type-coverage-ratchet.mjs'), 'utf8'))
      .toBe(readFileSync(join(MOBILE_ROOT, 'scripts/type-coverage-ratchet.mjs'), 'utf8'));
    const result = runMirror('--baseline', mirrorBaselinePath);
    expect(result.stderr).toBe('');
    expect(result.status).toBe(0);
    expect(result.stdout).toContain(`over ${fixtureMeasurement.fileCount} maintained files`);
    expect(result.stdout).toContain('ratchet holds');
  }, 60_000);

  it('refuses an update that deletes a historical entry, even with accept-regression', () => {
    const baseline = loadBaseline(mirrorBaselinePath);
    const path = Object.keys(baseline.files)[0];
    if (!path) throw new Error('fixture needs a historical file');
    const files = { ...baseline.files };
    delete files[path];
    const doctoredPath = join(scratch, 'deleted-history.json');
    const before = JSON.stringify({ ...baseline, files });
    writeFileSync(doctoredPath, before);
    const result = runMirror('--baseline', doctoredPath, '--update', '--accept-regression');
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(`${path} is missing its historical`);
    expect(readFileSync(doctoredPath, 'utf8')).toBe(before);
  }, 60_000);

  it.each<[string, boolean]>([
    ['.expo/types/router.d.ts', false],
    ['expo-env.d.ts', false],
    ['.expo/types/router.d.ts', true],
    ['expo-env.d.ts', true],
  ])('refuses an update with generated %s (accept-regression=%s)', (generatedPath, acceptRegression) => {
    const generated = join(mirrorMobile, generatedPath);
    const newSource = join(mirrorMobile, 'src/cleanUpdate.ts');
    const pins = join(mirrorMobile, 'type-coverage-ratchets');
    const before = readFileSync(mirrorBaselinePath, 'utf8');
    expect(existsSync(pins)).toBe(false);
    mkdirSync(join(generated, '..'), { recursive: true });
    writeFileSync(generated, '// Generated by Expo.\n');
    writeFileSync(newSource, 'export const cleanUpdate: string = "typed";\n');
    try {
      const result = runMirror('--update', ...(acceptRegression ? ['--accept-regression'] : []));
      expect(result.status).toBe(1);
      expect(result.stderr).toContain('TYPE_COVERAGE_FAIL');
      expect(result.stderr).toContain('apps/mobile/.expo/types/router.d.ts');
      expect(result.stderr).toContain('apps/mobile/expo-env.d.ts');
      expect(result.stderr).toContain('clean CI install');
      expect(readFileSync(mirrorBaselinePath, 'utf8')).toBe(before);
      expect(existsSync(pins)).toBe(false);
    } finally {
      rmSync(generated, { force: true });
      rmSync(newSource, { force: true });
      rmSync(pins, { recursive: true, force: true });
    }
  }, 60_000);

  it('records an update when neither generated Expo declaration exists', () => {
    const newSource = join(mirrorMobile, 'src/cleanUpdate.ts');
    const pins = join(mirrorMobile, 'type-coverage-ratchets');
    writeFileSync(newSource, 'export const cleanUpdate: string = "typed";\n');
    try {
      const result = runMirror('--update');
      expect(result.status).toBe(0);
      expect(result.stderr).toBe('');
      expect(loadBaseline(mirrorBaselinePath).files['src/cleanUpdate.ts']).toBe(100);
    } finally {
      rmSync(newSource, { force: true });
      rmSync(pins, { recursive: true, force: true });
    }
  }, 60_000);

  it('fails on a per-file slide and on a new file below the floor', () => {
    const baseline = JSON.parse(readFileSync(mirrorBaselinePath, 'utf8')) as {
      files: Record<string, number>;
      new_file_minimum_percent: number;
    };
    const belowPerfect = Object.entries(baseline.files).filter(([, percent]) => percent < 100);
    expect(belowPerfect.length).toBeGreaterThan(1);
    const [slidingFile] = belowPerfect[0] as [string, number];
    const [newFile] = belowPerfect[1] as [string, number];

    const doctored = {
      ...baseline,
      // Rule 3: this file's recorded value is one point above what it measures,
      // so a file that is exactly as typed as it was must now read as a slide.
      files: Object.fromEntries(
        Object.entries(baseline.files)
          // Rule 4: dropping a file's entry makes it new, and a 100% floor for
          // new files is one the chosen file cannot clear.
          .filter(([path]) => path !== newFile)
          .map(([path, percent]) => [
            path,
            path === slidingFile ? Math.min(100, percent + 1) : percent,
          ]),
      ),
      new_file_minimum_percent: 100,
    };
    const doctoredPath = join(scratch, 'doctored-baseline.json');
    writeFileSync(doctoredPath, `${JSON.stringify(doctored, null, 2)}\n`);

    const result = runMirror('--baseline', doctoredPath);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('TYPE_COVERAGE_FAIL');
    expect(result.stderr).toContain(`${slidingFile} fell to`);
    expect(result.stderr).toContain(`${newFile} is`);
    expect(result.stderr).toContain('floor for new files');
    // The aggregate floor and the suppression ceilings are untouched, so this
    // run proves the per-file rules carry the failure on their own.
    expect(result.stderr).not.toContain('aggregate type coverage fell');
    expect(result.stderr).not.toContain('suppressions rose');
  }, 60_000);
});

describe('CI wiring', () => {
  const manifest = JSON.parse(
    readFileSync(join(MOBILE_ROOT, 'package.json'), 'utf8'),
  ) as { scripts: { 'type-coverage': string; check: string } };

  it('runs the ratchet with no argument, so the committed baseline is enforced', () => {
    expect(manifest.scripts['type-coverage']).toBe('node scripts/type-coverage-ratchet.mjs');
  });

  it('runs the ratchet inside the check lane the mobile CI job executes', () => {
    expect(manifest.scripts.check.split('&&').map((part) => part.trim()))
      .toContain('npm run type-coverage');
  });
});
