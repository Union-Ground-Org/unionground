import { afterEach, describe, expect, it, vi } from 'vitest';
import { createElement, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

type SwitchProbe = {
  accessibilityLabel: string;
  style: { minWidth?: number; minHeight?: number };
  value: boolean;
  onValueChange: (value: boolean) => void;
};
const renderedSwitches = vi.hoisted(() => [] as SwitchProbe[]);
vi.mock('react-native', () => {
  const container = ({ children }: { children?: ReactNode }) => createElement('div', null, children);
  return {
    View: container, Text: container, Pressable: container, TextInput: container,
    StyleSheet: { create: <T,>(value: T) => value, hairlineWidth: 1 },
    Switch: (props: SwitchProbe) => { renderedSwitches.push(props); return null; },
  };
});
vi.mock('@expo/vector-icons', () => ({ Ionicons: () => null }));
vi.mock('../theme/ThemeProvider', () => ({ useTheme: () => ({}) }));
vi.mock('../components/ui', () => ({ Button: () => null }));
vi.mock('../services/haptics', () => ({ haptics: { select: vi.fn() } }));
import { LearningToggleRow } from '../features/learning/LearningControls';

const mobileRoot = fileURLToPath(new URL('../../', import.meta.url));
const temporary: string[] = [];
afterEach(() => {
  renderedSwitches.length = 0;
  for (const root of temporary.splice(0)) rmSync(root, { recursive: true, force: true });
});

function audit(control: string) {
  const root = mkdtempSync(join(tmpdir(), 'switch-target-audit-'));
  temporary.push(root);
  for (const file of ['scripts/touch-target-audit.mjs', 'src/theme/tokens.ts', 'src/lib/chromeGeometry.ts', 'src/components/HatSwitcher.tsx', 'src/components/PinnedHeader.tsx']) {
    mkdirSync(dirname(join(root, file)), { recursive: true });
    copyFileSync(join(mobileRoot, file), join(root, file));
  }
  mkdirSync(join(root, 'app'));
  writeFileSync(join(root, 'src/SwitchFixture.tsx'), control);
  return spawnSync(process.execPath, [join(root, 'scripts/touch-target-audit.mjs')], { encoding: 'utf8' });
}

// Source walks and audit subprocesses can exceed five seconds when the shared
// workstation is busy. Give each case headroom while keeping the live audit.
describe('touch-target audit includes native switches', { timeout: 30_000 }, () => {
  it('requires at least 48 by 48 dp at every shipped native Switch site', () => {
    const result = spawnSync(process.execPath, [join(mobileRoot, 'scripts/touch-target-audit.mjs')], { encoding: 'utf8' });
    expect(result.status, result.stdout + result.stderr).toBe(0);
    const switchTag = '<' + 'Switch>';
    for (const file of ['app/(tabs)/account.tsx', 'src/features/NotificationPreferencesCard.tsx', 'src/features/learning/LearningControls.tsx', 'src/features/CaseRowTopicCards.tsx', 'src/features/PulseScorePrivacyCard.tsx', 'src/features/OfflineAvailabilityScreen.tsx', 'src/features/AppointmentHoursCard.tsx', 'src/features/ScheduleMeetingCard.tsx']) {
      expect(result.stdout).toMatch(new RegExp(`PASS\\t${file.replace(/[.()]/g, '\\$&')}.*${switchTag}\\t(?:48 x 48|70 x 51) dp`));
    }
    expect(result.stdout).toContain('9 native Switch elements scanned');
  });

  it.each(['Quotes', 'Mini-lessons'])('mounts the %s learning control with 48 by 48 dp native bounds and a working toggle', (label) => {
    const change = vi.fn();
    for (const value of [false, true]) {
      renderToStaticMarkup(createElement(LearningToggleRow, { label, value, onValueChange: change }));
      const control = renderedSwitches.at(-1);
      expect(control?.accessibilityLabel).toBe(label);
      expect(control?.style.minWidth).toBeGreaterThanOrEqual(48);
      expect(control?.style.minHeight).toBeGreaterThanOrEqual(48);
      expect(control?.value).toBe(value);
      control?.onValueChange(!value);
      expect(change).toHaveBeenLastCalledWith(!value);
    }
  });

  it('rejects an unpadded native Switch, including a renamed import', () => {
    for (const name of ['Switch', 'PreferenceSwitch']) {
      const result = audit(`import { Switch as ${name} } from 'react-native'; export const Control = () => <${name} accessibilityLabel="Example" />;`);
      expect(result.status, result.stdout + result.stderr).toBe(1);
      expect(result.stdout).toContain('SwitchFixture.tsx');
      expect(result.stdout).toContain('under 48');
    }
  });

  it('accepts 48 dp layout bounds and the existing 12 dp hitSlop pattern', () => {
    for (const props of ['style={{ minWidth: minimumTouchTarget, minHeight: minimumTouchTarget }}', 'hitSlop={12}']) {
      const name = 'Switch';
      const result = audit(`import { Switch } from 'react-native'; export const Control = () => <${name} ${props} />;`);
      expect(result.status, result.stdout + result.stderr).toBe(0);
    }
  });

  it('rejects hitSlop that leaves the 27 dp native height below 48 dp', () => {
    const name = 'Switch';
    const result = audit(`import { Switch } from 'react-native'; export const Control = () => <${name} hitSlop={10} />;`);
    expect(result.status, result.stdout + result.stderr).toBe(1);
  });

  it('also audits a namespace import', () => {
    const result = audit('import * as Native from \'react-native\'; export const Control = () => <Native.Switch />;');
    expect(result.status, result.stdout + result.stderr).toBe(1);
    expect(result.stdout).toContain('<Native.Switch>');
  });

  it('does not count hitSlop outside a short parent', () => {
    const name = 'Switch';
    const result = audit(`import { Switch, View } from 'react-native'; export const Control = () => <View style={{ height: 27 }}><${name} hitSlop={12} /></View>;`);
    expect(result.status, result.stdout + result.stderr).toBe(1);
  });
});
