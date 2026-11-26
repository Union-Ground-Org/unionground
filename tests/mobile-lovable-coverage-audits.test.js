import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function runMobileAudit(script) {
  return execFileSync(process.execPath, [path.join(repositoryRoot, 'apps/mobile/scripts', script)], {
    cwd: repositoryRoot,
    encoding: 'utf8',
  });
}

describe('current mobile Lovable acceptance evidence', () => {
  it('keeps the route, feature, mode, hat, legal, theme, and access ledgers synchronized', () => {
    const output = runMobileAudit('lovable-coverage-audit.mjs');
    expect(output).toContain('PASS\troute module census\t32 entries');
    expect(output).toContain('PASS\tfeature-key registry\t41 entries');
    expect(output).toContain('PASS\tpreview hat roster\t7 entries');
    expect(output).toContain('PASS\tchapter-admin access group\t1 entries');
    expect(output).toContain('PASS\texact Committee-hat access group\t5 entries');
    expect(output).toContain('PASS\tCampaign tab keeps campaign work in the app\tno implicit browser hand-off from the Campaign tab');
    expect(output).not.toContain('My Union');
    expect(output).not.toContain('steward-hat');
    expect(output).toContain('SUMMARY\t23 passed\t0 failed');
  });

  it('keeps Night Shift icon roles objective without claiming a missing frame pass', () => {
    const output = runMobileAudit('dark-frame-icon-audit.mjs');
    expect(output).toContain('FRAME AUDIT\tNOT RUN');
    expect(output).toContain('PASS\taccentForeground/accent\t10.10:1');
    expect(output).toContain('PASS\tstatusAttention/muted\t8.07:1');
    expect(output).toContain('PASS\tNative tab roster follows the Union Ground dock\thome, work, compass, campaign, account');
    expect(output).toContain('PASS\tNative tabs retain shared semantic icon roles\tNo per-tab color overrides');
    expect(output).toContain('PASS\tAsk the Guide entry uses the semantic Compass button variant');
    expect(output).toContain('PASS\tPreview rights screen exposes Ask the Guide');
    expect(output).toContain('PASS\tLive rights screen exposes Ask the Guide');
    expect(output).toContain('PASS\tCompass panel signal uses its semantic foreground pair');
    expect(output).not.toContain('Ask Compass entry uses');
    expect(output).toContain('SUMMARY\t37 passed\t0 failed');
  });

  it.each([
    ['src/components/AskCompassButton.tsx', 'variant="compass"', 'variant="secondary"', 'Ask the Guide entry uses the semantic Compass button variant'],
    ['src/components/CompassPanel.tsx', 'backgroundColor: compassReady ? theme.compass : theme.secondary', 'backgroundColor: compassReady ? theme.primary : theme.secondary', 'Compass panel signal uses its semantic foreground pair'],
    ['app/(tabs)/_layout.tsx', 'name="campaign"', 'name="pulse"', 'Native tab roster follows the Union Ground dock'],
  ])('rejects a regressed Compass contract in %s', (file, before, after, contract) => {
    const fixture = mkdtempSync(path.join(tmpdir(), 'mobile-dark-audit-'));
    const sources = [
      'scripts/dark-frame-icon-audit.mjs', 'src/theme/palette.json', 'src/theme/tokens.ts',
      'app/notifications.tsx', 'app/(tabs)/_layout.tsx', 'app/(tabs)/compass.tsx',
      'src/components/AskCompassButton.tsx', 'src/components/ui.tsx', 'src/components/CompassPanel.tsx',
      'src/features/FeatureScreen.tsx', 'src/features/LiveLivedInScreens.tsx',
    ];
    try {
      for (const source of sources) {
        const destination = path.join(fixture, source);
        mkdirSync(path.dirname(destination), { recursive: true });
        copyFileSync(path.join(repositoryRoot, 'apps/mobile', source), destination);
      }
      const target = path.join(fixture, file);
      const original = readFileSync(target, 'utf8');
      expect(original).toContain(before);
      writeFileSync(target, original.replace(before, after));
      let failure;
      try {
        execFileSync(process.execPath, [path.join(fixture, 'scripts/dark-frame-icon-audit.mjs')], { encoding: 'utf8', stdio: 'pipe' });
      } catch (error) {
        failure = error;
      }
      expect(failure?.status).toBe(1);
      expect(failure?.stderr).toContain(`FAIL\t${contract}`);
    } finally {
      rmSync(fixture, { recursive: true, force: true });
    }
  });
});
