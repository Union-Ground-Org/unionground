import { spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import { auditCommand, buildToolPathProven, evaluateAudit, introducedAuditCommand, mergeBaseAudit, reachableInProduction, reportAdvisories, validatedAuditReport, type AuditException, type AuditReport, type BuildToolAdvisory, type MergeBaseAudit, type PackageLock } from '../../scripts/security-audit.mjs';

const forge = { source: 1240912, name: 'node-forge', dependency: 'node-forge', url: 'https://github.com/advisories/GHSA-86w9-cpqp-85rv', severity: 'high', range: '<=1.4.0' };
type Vulnerabilities = NonNullable<AuditReport['vulnerabilities']>;
const report = (extra: Vulnerabilities = {}): AuditReport => ({
  vulnerabilities: {
    'node-forge': { via: [forge] },
    '@expo/cli': { via: ['@expo/code-signing-certificates', 'node-forge'] },
    expo: { via: ['@expo/cli'] },
    ...extra,
  },
  metadata: { vulnerabilities: { total: 3 + Object.keys(extra).length } },
});
const exception: AuditException = { id: 'GHSA-86w9-cpqp-85rv', package: 'node-forge', severity: 'high', range: '<=1.4.0', reason: 'r', approved: 'owner', expires: '2026-10-15' };

describe('mobile security audit exceptions', () => {
  it('reduces the npm report to the advisories behind it', () => {
    expect(reportAdvisories(report())).toEqual([{ id: 'GHSA-86w9-cpqp-85rv', package: 'node-forge', severity: 'high', range: '<=1.4.0', url: forge.url }]);
  });

  it('tolerates only the excepted advisory in the excepted package before it expires', () => {
    const result = evaluateAudit(report(), [exception], '2026-10-01');
    expect(result.failures).toEqual([]);
    expect(result.tolerated.map((advisory) => advisory.id)).toEqual(['GHSA-86w9-cpqp-85rv']);
  });

  it('fails every other advisory, the same advisory in another package, and an expired exception', () => {
    const other = { source: 1, name: 'left-pad', url: 'https://github.com/advisories/GHSA-aaaa-bbbb-cccc', severity: 'moderate' };
    expect(evaluateAudit(report({ 'left-pad': { via: [other] } }), [exception], '2026-10-01').failures.map((advisory) => advisory.package)).toEqual(['left-pad']);
    expect(evaluateAudit(report(), [{ ...exception, package: 'node-forge-fork' }], '2026-10-01').failures).toHaveLength(1);
    const expired = evaluateAudit(report(), [exception], '2026-10-16');
    expect(expired.failures).toHaveLength(1);
    expect(expired.expired).toEqual([exception]);
  });

  it('fails the same advisory once its severity or affected range changes', () => {
    const raised = { ...forge, severity: 'critical' };
    const widened = { ...forge, range: '<=1.5.0' };
    expect(evaluateAudit(report({ 'node-forge': { via: [raised] } }), [exception], '2026-10-01').failures).toHaveLength(1);
    expect(evaluateAudit(report({ 'node-forge': { via: [widened] } }), [exception], '2026-10-01').failures).toHaveLength(1);
  });

  it('fails a vulnerable report it cannot attribute to an advisory', () => {
    expect(evaluateAudit({ vulnerabilities: { x: { via: ['y'] } }, metadata: { vulnerabilities: { total: 1 } } }, [exception], '2026-10-01').failures).toHaveLength(1);
  });

  it('reports an exception that is no longer needed', () => {
    expect(evaluateAudit({ vulnerabilities: {}, metadata: { vulnerabilities: { total: 0 } } }, [exception], '2026-10-01').unused).toEqual([exception]);
  });
});


describe('npm audit responses', () => {
  it('accepts a real report on exit 0 or 1', () => {
    expect(validatedAuditReport(report(), 1)).toEqual(report());
    expect(validatedAuditReport({ vulnerabilities: {}, metadata: { vulnerabilities: { total: 0 } } }, 0)).toBeTruthy();
  });
  it('refuses a registry error response, a missing report, or a failed run', () => {
    expect(() => validatedAuditReport({ error: { code: 'ENOAUDIT', summary: 'Your configured registry does not support audit requests' } }, 1)).toThrow('no audit report');
    expect(() => validatedAuditReport({}, 0)).toThrow('no audit report');
    expect(() => validatedAuditReport({ vulnerabilities: {} }, 0)).toThrow('no audit report');
    expect(() => validatedAuditReport(report(), 2)).toThrow('exit 2');
    expect(() => validatedAuditReport(report(), null)).toThrow('exit null');
  });
});

describe('build-tool advisories', () => {
  const buildTool: BuildToolAdvisory = { id: 'GHSA-86w9-cpqp-85rv', package: 'node-forge', severity: 'high', range: '<=1.4.0', reached_only_through: ['@expo/cli'], reason: 'r', approved: 'owner' };
  const lock = (extra: NonNullable<PackageLock['packages']> = {}): PackageLock => ({ packages: {
    '': { dependencies: { expo: '1' }, devDependencies: {} } as NonNullable<PackageLock['packages']>[string],
    'node_modules/expo': { dependencies: { '@expo/cli': '1' } },
    'node_modules/expo/node_modules/@expo/cli': { version: '57.0.28', resolved: 'https://registry.npmjs.org/@expo/cli/-/cli-57.0.28.tgz', dependencies: { 'node-forge': '1', '@expo/code-signing-certificates': '1' } },
    'node_modules/@expo/code-signing-certificates': { dependencies: { 'node-forge': '1' } },
    'node_modules/node-forge': {},
    ...extra,
  } });

  it('reports the advisory without blocking while only the build tool reaches it, with no expiry', () => {
    const result = evaluateAudit(report(), [], '2027-06-01', { buildTool: [buildTool], lock: lock() });
    expect(result.failures).toEqual([]);
    expect(result.buildTool.map((entry) => entry.package)).toEqual(['node-forge']);
    expect(result.unusedBuildTool).toEqual([]);
  });

  it('blocks again once a production package reaches it without the build tool', () => {
    const reached = lock({
      '': { dependencies: { expo: '1', signer: '1' } } as NonNullable<PackageLock['packages']>[string],
      'node_modules/signer': { dependencies: { 'node-forge': '1' } },
    });
    expect(reachableInProduction(reached, 'node-forge', ['@expo/cli'])).toBe(true);
    expect(evaluateAudit(report(), [], '2026-10-11', { buildTool: [buildTool], lock: reached }).failures.map((entry) => entry.package)).toEqual(['node-forge']);
  });

  it('follows root peers and linked packages to their targets', () => {
    const root = (extra: Record<string, unknown>) => ({ dependencies: { expo: '1' }, ...extra }) as NonNullable<PackageLock['packages']>[string];
    expect(reachableInProduction(lock({ '': root({ peerDependencies: { 'node-forge': '1' } }) }), 'node-forge', ['@expo/cli'])).toBe(true);
    const linked = lock({
      '': root({ dependencies: { expo: '1', signer: '1' } }),
      'node_modules/signer': { link: true, resolved: 'packages/signer' },
      'packages/signer': { dependencies: { 'node-forge': '1' } },
    });
    expect(reachableInProduction(linked, 'node-forge', ['@expo/cli'])).toBe(true);
    expect(evaluateAudit(report(), [], '2026-10-11', { buildTool: [buildTool], lock: linked }).failures.map((entry) => entry.package)).toEqual(['node-forge']);
    const dangling = lock({ '': root({ dependencies: { expo: '1', signer: '1' } }), 'node_modules/signer': { link: true, resolved: 'packages/missing' } });
    expect(() => reachableInProduction(dangling, 'node-forge', ['@expo/cli'])).toThrow('no target entry');
  });

  it('resolves through every ancestor node_modules and through npm aliases', () => {
    const root = (extra: Record<string, unknown>) => ({ dependencies: { expo: '1' }, ...extra }) as NonNullable<PackageLock['packages']>[string];
    const ancestor = lock({
      '': root({ dependencies: { expo: '1', signer: '1' } }),
      'node_modules/signer': { link: true, resolved: 'packages/signer' },
      'packages/signer': { dependencies: { helper: '1' } },
      'packages/node_modules/helper': { dependencies: { 'node-forge': '1' } },
    });
    expect(reachableInProduction(ancestor, 'node-forge', ['@expo/cli'])).toBe(true);
    const alias = lock({
      '': root({ dependencies: { expo: '1', 'runtime-forge': 'npm:node-forge@1.4.0' } }),
      'node_modules/runtime-forge': { name: 'node-forge', version: '1.4.0' } as NonNullable<PackageLock['packages']>[string],
    });
    expect(reachableInProduction(alias, 'node-forge', ['@expo/cli'])).toBe(true);
    const unresolved = lock({ '': root({ dependencies: { expo: '1', ghost: '1' } }) });
    expect(() => reachableInProduction(unresolved, 'node-forge', ['@expo/cli'])).toThrow('does not resolve');
    // A workspace is installed without a root dependency edge.
    expect(() => reachableInProduction(lock({ '': root({ workspaces: ['packages/*'] }) }), 'node-forge', ['@expo/cli'])).toThrow('declares workspaces');
  });

  // The cut must not follow a package's metadata name.
  type Entry = NonNullable<PackageLock['packages']>[string];
  const forged = (dependency: string, entries: Record<string, Entry>) => lock({
    '': { dependencies: { expo: '1', [dependency]: '1' } } as Entry,
    ...entries,
  });
  const runtime = { dependencies: { 'node-forge': '1' } };
  it.each([
    ['a vendored file: package named @expo/cli', forged('compat-cli', {
      'node_modules/compat-cli': { link: true, resolved: 'vendor/compat-cli' },
      'vendor/compat-cli': { name: '@expo/cli', version: '57.0.28', ...runtime },
    })],
    ['a file: link installed in the @expo/cli folder', forged('@expo/cli', {
      'node_modules/@expo/cli': { link: true, resolved: 'vendor/compat-cli' },
      'vendor/compat-cli': { name: '@expo/cli', version: '57.0.28', ...runtime },
    })],
    ['a local tarball in the @expo/cli folder', forged('@expo/cli', {
      'node_modules/@expo/cli': { version: '57.0.28', resolved: 'file:vendor/cli-57.0.28.tgz', ...runtime },
    })],
    ['a git install in the @expo/cli folder', forged('@expo/cli', {
      'node_modules/@expo/cli': { version: '57.0.28', resolved: 'git+ssh://git@github.com/example/cli.git#5b7ed5f', ...runtime },
    })],
    ['an alias installed as @expo/cli', forged('@expo/cli', {
      'node_modules/@expo/cli': { name: 'compat-cli', version: '1.0.0', resolved: 'https://registry.npmjs.org/compat-cli/-/compat-cli-1.0.0.tgz', ...runtime },
    })],
  ])('keeps node-forge reachable through %s and fails the classification', (_label, forgedLock) => {
    expect(reachableInProduction(forgedLock, 'node-forge', ['@expo/cli'])).toBe(true);
    const result = evaluateAudit(report(), [], '2026-10-11', { buildTool: [buildTool], lock: forgedLock });
    expect(result.failures.map((entry) => entry.package)).toEqual(['node-forge']);
    expect(result.buildTool).toEqual([]);
  });

  it('still cuts the registry @expo/cli at its top-level or nested path', () => {
    const topLevel = forged('@expo/cli', {
      'node_modules/@expo/cli': { version: '57.0.28', resolved: 'https://registry.npmjs.org/@expo/cli/-/cli-57.0.28.tgz', ...runtime },
    });
    for (const genuine of [lock(), topLevel]) {
      expect(reachableInProduction(genuine, 'node-forge', ['@expo/cli'])).toBe(false);
      const result = evaluateAudit(report(), [], '2026-10-11', { buildTool: [buildTool], lock: genuine });
      expect(result.failures).toEqual([]);
      expect(result.buildTool.map((entry) => entry.package)).toEqual(['node-forge']);
    }
  });

  // Only a positively proven route through the registry
  // build tool earns the classification. A package with any other route, dev or
  // production, or with no route at all, keeps its previous outcome.
  it.each([
    ['dev-only, with no Expo path', { packages: {
      '': { dependencies: {}, devDependencies: { 'dev-signer': '1' } } as Entry,
      'node_modules/dev-signer': { dependencies: { 'node-forge': '1' } },
      'node_modules/node-forge': {},
    } }],
    ['a direct devDependency, with no Expo path', { packages: {
      '': { dependencies: {}, devDependencies: { 'node-forge': '1' } } as Entry,
      'node_modules/node-forge': {},
    } }],
    ['the Expo path plus a dev-only route that avoids Expo', lock({
      '': { dependencies: { expo: '1' }, devDependencies: { 'dev-signer': '1' } } as Entry,
      'node_modules/dev-signer': { dependencies: { 'node-forge': '1' } },
    })],
    ['no route from the root at all', { packages: { '': { dependencies: {} } as Entry, 'node_modules/node-forge': {} } }],
  ])('never classifies node-forge reached through %s', (_label, negative: PackageLock) => {
    expect(buildToolPathProven(negative, 'node-forge', ['@expo/cli'])).toBe(false);
    const result = evaluateAudit(report(), [], '2027-06-01', { buildTool: [buildTool], lock: negative });
    expect(result.buildTool).toEqual([]);
    expect(result.failures.map((entry) => entry.package)).toEqual(['node-forge']);
    expect(result.unusedBuildTool).toEqual([buildTool]);
  });

  it('classifies node-forge reached only through a registry @expo/cli under a dev-only expo', () => {
    const devExpo = lock({ '': { dependencies: {}, devDependencies: { expo: '1' } } as Entry });
    const result = evaluateAudit(report(), [], '2027-06-01', { buildTool: [buildTool], lock: devExpo });
    expect(result.failures).toEqual([]);
    expect(result.buildTool.map((entry) => entry.package)).toEqual(['node-forge']);
    expect(result.unusedBuildTool).toEqual([]);
  });

  // The real exceptions file lists no build-tool advisory since node-forge
  // 1.4.2 (OPS-UG-MOBILE-AUDIT-NEW-ADVISORIES-20261030), so the
  // command runs in process with the entry injected.
  const command = (full: AuditReport, document: Parameters<typeof auditCommand>[0]['document']) => {
    const clean: AuditReport = { vulnerabilities: {}, metadata: { vulnerabilities: { total: 0 } } };
    const out: string[] = [], err: string[] = [];
    const code = auditCommand({ document, lock: lock(), today: '2026-10-30', runAudit: (args) => (args.includes('--omit=dev') ? clean : full),
      out: (line) => out.push(line), err: (line) => err.push(line) });
    return { code, out: out.join('\n'), err: err.join('\n') };
  };

  it('prints a build-tool advisory the full audit alone classifies in an ordinary pull-request run', () => {
    const run = command(report(), { schema: 1, exceptions: [], build_tool_advisories: [buildTool] });
    expect(run.code, run.out + run.err).toBe(0);
    expect(run.out).toContain('security audit (full): REPORT build-tool advisory, not blocking: GHSA-86w9-cpqp-85rv in node-forge high <=1.4.0');
  });

  //  (run 40422614256): the hosted runner got a registry error reply
  // from npm audit; the lane retries it a bounded number of times and still
  // fails closed when every attempt errors.
  it('retries a registry error reply before failing the audit', () => {
    const bin = mkdtempSync(join(tmpdir(), 'mobile-audit-'));
    try {
      // The stub reports whatever build-tool advisories are live (none since
      // picomatch's left,), so the real file's entries stay in use.
      const live = JSON.parse(readFileSync(new URL('../../security-audit-exceptions.json', import.meta.url), 'utf8')) as { build_tool_advisories: BuildToolAdvisory[] };
      const liveVulnerabilities: Vulnerabilities = Object.fromEntries(live.build_tool_advisories.map((entry) => [entry.package,
        { via: [{ source: 1, name: entry.package, url: `https://github.com/advisories/${entry.id}`, severity: entry.severity, range: entry.range }] }]));
      const clean = JSON.stringify({ vulnerabilities: liveVulnerabilities, metadata: { vulnerabilities: { total: Object.keys(liveVulnerabilities).length } } });
      const failure = JSON.stringify({ error: { code: 'ENOAUDIT', summary: 'registry unavailable' } });
      const counter = join(bin, 'calls');
      writeFileSync(counter, '0');
      // The production audit is clean; the full audit errors once, then reports.
      writeFileSync(join(bin, 'npm'), `#!/bin/sh\nn=$(cat '${counter}'); echo $((n+1)) > '${counter}'\ncase "$*" in *--omit=dev*) echo '${clean}' ;; *) if [ "$n" -lt 2 ]; then echo '${failure}'; exit 1; else echo '${JSON.stringify(report(liveVulnerabilities))}'; fi ;; esac\n`);
      chmodSync(join(bin, 'npm'), 0o755);
      const script = fileURLToPath(new URL('../../scripts/security-audit.mjs', import.meta.url));
      const env: NodeJS.ProcessEnv = { ...process.env, PATH: `${bin}:${String(process.env['PATH'] ?? '')}`, GITHUB_STEP_SUMMARY: '', SECURITY_AUDIT_RETRY_MS: '0' };
      delete env['SECURITY_AUDIT_BLOCK_FULL'];
      const run = spawnSync(process.execPath, [script], { encoding: 'utf8', env });
      expect(run.status, run.stdout + run.stderr).toBe(0);
      expect(run.stderr).toContain('returned no audit report; retry 1 of 2');
      expect(readFileSync(counter, 'utf8').trim()).toBe('3');
      writeFileSync(join(bin, 'npm'), `#!/bin/sh\necho '${failure}'\nexit 1\n`);
      const exhausted = spawnSync(process.execPath, [script], { encoding: 'utf8', env });
      expect(exhausted.status).toBe(1);
      expect(exhausted.stderr).toContain('retry 2 of 2');
      expect(exhausted.stderr).toContain('returned no audit report');
    } finally { rmSync(bin, { recursive: true, force: true }); }
  });

  it('blocks a raised severity, a widened range, or a missing lockfile', () => {
    expect(evaluateAudit(report({ 'node-forge': { via: [{ ...forge, severity: 'critical' }] } }), [], '2026-10-11', { buildTool: [buildTool], lock: lock() }).failures).toHaveLength(1);
    expect(evaluateAudit(report({ 'node-forge': { via: [{ ...forge, range: '<=1.5.0' }] } }), [], '2026-10-11', { buildTool: [buildTool], lock: lock() }).failures).toHaveLength(1);
    expect(evaluateAudit(report(), [], '2026-10-11', { buildTool: [buildTool], lock: null }).failures).toHaveLength(1);
  });

  it('fails the audit command when a build-tool entry is no longer reported, as Trivy fails an unused entry', () => {
    const run = command({ vulnerabilities: {}, metadata: { vulnerabilities: { total: 0 } } }, { schema: 1, exceptions: [], build_tool_advisories: [buildTool] });
    expect(run.code, run.out + run.err).toBe(1);
    expect(run.err).toContain('FAIL build-tool advisory GHSA-86w9-cpqp-85rv (node-forge) is no longer reported');
  });

  // OPS-UG-MOBILE-AUDIT-NEW-ADVISORIES-20261030: the October 30
  // advisories in glob, minimatch and node-forge (production graph, through
  // Expo's tooling) are fixed by pinned overrides, not excused. node-forge
  // moved to 1.4.3 for the four November 10 advisories (Dependabot #70-#73).
  it('keeps glob, minimatch and node-forge on patched releases with nothing excused', () => {
    const config = JSON.parse(readFileSync(new URL('../../security-audit-exceptions.json', import.meta.url), 'utf8')) as { exceptions: AuditException[]; build_tool_advisories: BuildToolAdvisory[] };
    const manifest = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')) as { overrides: Record<string, unknown> };
    const real = JSON.parse(readFileSync(new URL('../../package-lock.json', import.meta.url), 'utf8')) as { packages: Record<string, { version?: string }> };
    const patched: Array<[string, string, [number, number, number]]> = [['glob', '14.0.4', [14, 0, 2]], ['minimatch', '11.0.5', [11, 0, 1]], ['node-forge', '1.4.3', [1, 4, 3]]];
    for (const [name, pin, floor] of patched) {
      expect(manifest.overrides[name], name).toBe(pin);
      const copies = Object.entries(real.packages).filter(([path]) => path.endsWith(`node_modules/${name}`));
      expect(copies.length, name).toBeGreaterThan(0);
      for (const [path, entry] of copies) {
        const version = String(entry.version).split('.').map(Number);
        const atLeast = version[0]! !== floor[0] ? version[0]! > floor[0] : version[1]! !== floor[1] ? version[1]! > floor[1] : version[2]! >= floor[2];
        expect(atLeast, `${path}@${String(entry.version)}`).toBe(true);
      }
      expect(config.exceptions.filter((entry) => entry.package === name), name).toEqual([]);
      expect(config.build_tool_advisories.filter((entry) => entry.package === name), name).toEqual([]);
    }
  });
});

describe('braces stays out of the mobile dependency graph', () => {
  const config = JSON.parse(readFileSync(new URL('../../security-audit-exceptions.json', import.meta.url), 'utf8')) as { exceptions: AuditException[] };
  const lock = JSON.parse(readFileSync(new URL('../../package-lock.json', import.meta.url), 'utf8')) as { packages?: Record<string, { name?: string; version?: string; resolved?: string }> };
  const nodes = Object.entries(lock.packages ?? {});
  const advisory = { name: 'braces', url: 'https://github.com/advisories/GHSA-vfj7-8cjw-p6xm', severity: 'high', range: '<=3.0.3' };
  const fixture = (): AuditReport => ({ vulnerabilities: { braces: { via: [advisory] } }, metadata: { vulnerabilities: { total: 1 } } });

  it('carries no braces exception, because the pinned micromatch shim removed the dependency', () => {
    expect(config.exceptions.filter((entry) => entry.package === 'braces')).toEqual([]);
    expect(nodes.filter(([path]) => path.endsWith('node_modules/braces'))).toEqual([]);
    const micromatch = nodes.filter(([path]) => path.endsWith('node_modules/micromatch'));
    expect(micromatch).toHaveLength(1);
    // This edition vendors the shim, so the lock entry links to its folder.
    const entry = micromatch[0]?.[1] as { name?: string; resolved?: string; link?: boolean } | undefined;
    expect(entry?.link).toBe(true);
    const shim = JSON.parse(readFileSync(new URL(`../../${entry?.resolved ?? ''}/package.json`, import.meta.url), 'utf8')) as { name?: string };
    expect(shim.name).toBe('micromatch-picomatch');
  });

  it('fails the audit again if braces ever reappears, since nothing tolerates it now', () => {
    const result = evaluateAudit(fixture(), config.exceptions, '2026-10-28');
    expect(result.failures.map((entry) => entry.package)).toEqual(['braces']);
    expect(result.tolerated).toEqual([]);
  });
});

describe('audit command final line', () => {
  const clean: AuditReport = { vulnerabilities: {}, metadata: { vulnerabilities: { total: 0 } } };
  const devOnly = report();  // node-forge with no exception and no build-tool entry
  const run = (full: AuditReport, document: Parameters<typeof auditCommand>[0]['document'], today = '2026-10-20') => {
    const out: string[] = [], err: string[] = [], summary: string[] = [];
    const code = auditCommand({ document, lock: null, today, runAudit: (args) => (args.includes('--omit=dev') ? clean : full),
      out: (line) => out.push(line), err: (line) => err.push(line), summary: (text) => summary.push(text) });
    return { code, out, err, summary: summary.join(''), last: out.at(-1) };
  };

  it('prints the clean line only when both audits report zero findings', () => {
    const result = run(clean, { schema: 1, exceptions: [] });
    expect(result).toMatchObject({ code: 0, err: [], last: 'security audit: clean; both audits report zero findings' });
  });

  it('says no blocking advisories with the dev-only count when the full audit reports one', () => {
    const result = run(devOnly, { schema: 1, exceptions: [] });
    expect(result.code).toBe(0);
    expect(result.out).toContain(`security audit (full): REPORT dev-only, not blocking: GHSA-86w9-cpqp-85rv in node-forge high <=1.4.0 ${forge.url}`);
    expect(result.last).toBe('security audit: no blocking advisories; 1 reported finding not blocking (1 dev-only)');
    expect(result.out.join('\n')).not.toContain('clean');
  });

  it('fails an expired dev-only exception with a FAIL line, not a notice', () => {
    const result = run(devOnly, { schema: 1, exceptions: [exception] });
    expect(result.code).toBe(1);
    expect(result.err).toContain('security audit: FAIL exception GHSA-86w9-cpqp-85rv (node-forge) expired on 2026-10-15; renew it with a new review or remove it');
    expect(result.summary).toContain('FAIL exception GHSA-86w9-cpqp-85rv (node-forge) expired on 2026-10-15');
    expect(result.out.join('\n')).not.toMatch(/clean|no blocking advisories/u);
  });

  it('counts a live tolerated advisory once across both audits and never calls the run clean', () => {
    const both = auditCommand({ document: { schema: 1, exceptions: [exception] }, lock: null, today: '2026-10-01', runAudit: () => devOnly, out: () => {}, err: () => {} });
    expect(both).toBe(0);
    const lines: string[] = [];
    auditCommand({ document: { schema: 1, exceptions: [exception] }, lock: null, today: '2026-10-01', runAudit: () => devOnly, out: (line) => lines.push(line), err: () => {} });
    expect(lines.at(-1)).toBe('security audit: no blocking advisories; 1 reported finding not blocking (1 tolerated)');
  });

  it('reports a full-graph report it cannot attribute and counts it, without the clean line', () => {
    const unparsed: AuditReport = { vulnerabilities: { left: { via: ['right'] } }, metadata: { vulnerabilities: { total: 1 } } };
    const result = run(unparsed, { schema: 1, exceptions: [] });
    expect(result.code).toBe(0);
    expect(result.out.some((line) => line.startsWith('security audit (full): REPORT dev-only, not blocking: unparsed-report in *'))).toBe(true);
    expect(result.last).toBe('security audit: no blocking advisories; 1 reported finding not blocking (1 dev-only)');
  });

  it('still blocks the full audit when SECURITY_AUDIT_BLOCK_FULL is set', () => {
    const err: string[] = [];
    expect(auditCommand({ document: { schema: 1, exceptions: [] }, lock: null, today: '2026-10-20', blockFull: true,
      runAudit: (args) => (args.includes('--omit=dev') ? clean : devOnly), out: () => {}, err: (line) => err.push(line) })).toBe(1);
    expect(err[0]).toMatch(/^security audit \(full\): FAIL GHSA-86w9-cpqp-85rv/u);
  });
});

// A pull request fails only for blocking
// findings the merge base does not have too.
describe('introduced-only audit against the merge base', () => {
  const clean: AuditReport = { vulnerabilities: {}, metadata: { vulnerabilities: { total: 0 } } };
  const vulnerable = report();  // node-forge, production, no exception
  const document = { schema: 1, exceptions: [] as AuditException[] };
  const mergeBase = 'a'.repeat(40);
  const run = (head: AuditReport, loadBase: Parameters<typeof introducedAuditCommand>[0]['loadBase']) => {
    const out: string[] = [], err: string[] = [];
    const code = introducedAuditCommand({ document, lock: null, today: '2026-11-09', runAudit: () => head, loadBase,
      out: (line) => out.push(line), err: (line) => err.push(line) });
    return { code, out, err };
  };
  const baseWith = (baseReport: AuditReport, baseDocument = document) => (): MergeBaseAudit => ({ readable: true, mergeBase, document: baseDocument, lock: null, runAudit: () => baseReport });
  const failLine = `security audit (production): FAIL GHSA-86w9-cpqp-85rv in node-forge high <=1.4.0 ${forge.url}`;

  it('fails an advisory the change introduces', () => {
    const result = run(vulnerable, baseWith(clean));
    expect(result.code).toBe(1);
    expect(result.err).toEqual([failLine]);
  });

  it('passes with a warning for an advisory already on the merge base', () => {
    const result = run(vulnerable, baseWith(vulnerable));
    expect(result.code).toBe(0);
    expect(result.err).toEqual([]);
    expect(result.out).toContain(`security audit: WARN already on the merge base aaaaaaaaaaaa, not blocking, tracked by the daily Main audit: ${failLine}`);
    expect(result.out.at(-1)).toBe('security audit: no blocking finding introduced by this change; 1 already on the merge base aaaaaaaaaaaa');
  });

  it('passes a change that fixes the merge base advisory, without reading the base', () => {
    let loaded = false;
    const result = run(clean, () => { loaded = true; return baseWith(vulnerable)(); });
    expect(result.code).toBe(0);
    expect(loaded).toBe(false);
  });

  it('keeps the old behaviour when the merge base cannot be read', () => {
    const result = run(vulnerable, () => ({ readable: false, reason: 'package-lock.json on the merge base is not in this blob-filtered clone' }));
    expect(result.code).toBe(1);
    expect(result.out).toContain('security audit: no merge-base comparison (package-lock.json on the merge base is not in this blob-filtered clone); every blocking finding fails, as before');
    expect(result.err).toEqual([failLine]);
    expect(run(vulnerable, null).err).toEqual([failLine]);
  });

  it('fails when the change removes the exception the merge base relied on', () => {
    const live = { ...exception, expires: '2026-12-31' };
    const result = run(vulnerable, baseWith(vulnerable, { schema: 1, exceptions: [live] }));
    expect(result.code).toBe(1);
    expect(result.err).toEqual([failLine]);
  });

  it('treats an exception that expired on the merge base too as pre-existing', () => {
    const out: string[] = [], err: string[] = [];
    const expired = { schema: 1, exceptions: [exception] };
    const code = introducedAuditCommand({ document: expired, lock: null, today: '2026-11-09', runAudit: () => vulnerable, out: (line) => out.push(line), err: (line) => err.push(line),
      loadBase: baseWith(vulnerable, expired) });
    expect(code).toBe(0);
    expect(out.some((line) => line.includes('tracked by the daily Main audit: security audit: FAIL exception GHSA-86w9-cpqp-85rv'))).toBe(true);
  });

  it('falls back when the merge base audit itself fails', () => {
    const failing = (): MergeBaseAudit => ({ readable: true, mergeBase, document, lock: null, runAudit: () => { throw new Error('npm audit (--omit=dev) returned no audit report'); } });
    const result = run(vulnerable, failing);
    expect(result.code).toBe(1);
    expect(result.out[result.out.length - 1]).toMatch(/^security audit: no merge-base comparison \(the merge base aaaaaaaaaaaa audit failed: npm audit/u);
    expect(result.err).toEqual([failLine]);
  });

  it('reuses the head reports when the lockfile is unchanged and audits a scratch copy when it changed', () => {
    type BaseFiles = { readable: true; mergeBase: string; files: Record<string, { unchanged: boolean; text: string }> };
    const files = (changed: boolean) => (): BaseFiles => ({ readable: true, mergeBase, files: {
      'package.json': { unchanged: true, text: '{"name":"fixture"}' },
      'package-lock.json': { unchanged: !changed, text: '{"lockfileVersion":3,"packages":{"":{}}}' },
      'security-audit-exceptions.json': { unchanged: true, text: JSON.stringify(document) } } });
    const headAudit = () => clean;
    const same = mergeBaseAudit({ cwd: '.', base: mergeBase, headAudit, files: files(false) });
    expect(same.readable && same.runAudit).toBe(headAudit);
    const scratch = mkdtempSync(join(tmpdir(), 'mobile-audit-base-'));
    try {
      const changed = mergeBaseAudit({ cwd: '.', base: mergeBase, headAudit, scratch, files: files(true) });
      expect(changed.readable && changed.runAudit).not.toBe(headAudit);
      expect(changed.readable && changed.lock).toEqual({ lockfileVersion: 3, packages: { '': {} } });
      changed.readable && changed.cleanup?.();
    } finally { rmSync(scratch, { recursive: true, force: true }); }
    expect(mergeBaseAudit({ cwd: '.', base: undefined, headAudit, files: () => ({ readable: false, reason: 'no base' }) })).toEqual({ readable: false, reason: 'no base' });
    // A package.json edit beside an unchanged lockfile never needs the base package.json blob.
    const asked: string[][] = [];
    const strict = (options: { paths: string[] }) => { asked.push(options.paths); return files(false)(); };
    expect(mergeBaseAudit({ cwd: '.', base: mergeBase, headAudit, files: strict }).readable).toBe(true);
    expect(asked).toEqual([['package-lock.json', 'security-audit-exceptions.json']]);
  });
});
