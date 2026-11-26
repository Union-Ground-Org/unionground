import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { describe, expect, it } from 'vitest';

const require = createRequire(import.meta.url);
const { repairTabAccessibility } = require('../../plugins/with-ios-tab-accessibility.js') as {
  repairTabAccessibility: (source: string) => string;
};
const screensRoot = dirname(require.resolve('react-native-screens/package.json'));
const controller = readFileSync(join(screensRoot, 'ios/tabs/host/RNSTabBarController.mm'), 'utf8');

// These checks exercise the prebuild transform on the installed native source.
// They do not establish device/VoiceOver behavior; that remains a release proof.
describe('iOS native tab accessibility prebuild repair', () => {
  it('repairs the actual pinned controller once and preserves tab label assignment', () => {
    const repaired = repairTabAccessibility(controller);
    expect(repairTabAccessibility(repaired)).toBe(repaired);
    expect(repaired.match(/- \(void\)viewDidLayoutSubviews/g)).toHaveLength(1);
    expect(repaired).toContain('[super viewDidLayoutSubviews];');
    expect(repaired).toContain('if (@available(iOS 26.0, *))');
    expect(repaired).toContain('for (UIView *child in self.tabBar.subviews)');
    expect(repaired).toContain('UGRemoveDuplicateTabLabels(child, self.tabBar);');
    expect(repaired).toContain('tabViewController.tabBarItem.accessibilityLabel = screenView.tabItemAccessibilityLabel;');
    expect(repaired).toContain('tabViewController.tabBarItem.accessibilityIdentifier = screenView.tabItemTestID;');
  });

  it('only clears non-buttons whose label matches a real button anywhere in the tab bar', () => {
    const repaired = repairTabAccessibility(controller);
    expect(repaired).toContain('(child.accessibilityTraits & UIAccessibilityTraitButton) != 0');
    expect(repaired).toContain('[child.accessibilityLabel isEqualToString:label]');
    expect(repaired).toContain('label.length > 0 && (view.accessibilityTraits & UIAccessibilityTraitButton) == 0');
    expect(repaired).toContain('UGContainsTabButton(tabBar, label)');
    expect(repaired).toContain('view.isAccessibilityElement = NO;');
    expect(repaired).toContain('view.accessibilityLabel = @"";');
    // Hiding the whole subtree would also remove the actionable controls.
    expect(repaired).not.toContain('accessibilityElementsHidden =');
    expect(repaired).not.toContain('accessibilityTraits =');
  });

  it('refuses changed dependency anchors and incomplete prior patches', () => {
    expect(() => repairTabAccessibility(controller.replace('#define RNS_MORE_NAVIGATION_CONTROLLER_AVAILABLE !TARGET_OS_TV && !TARGET_OS_VISION', '')))
      .toThrow(/anchors changed/);
    expect(() => repairTabAccessibility(controller.replace('- (void)reactMountingTransactionWillMount', '- (void)changed')))
      .toThrow(/insertion anchor changed/);
    expect(() => repairTabAccessibility(controller + '\n- (void)viewDidLayoutSubviews {}'))
      .toThrow(/anchors changed/);
    const incomplete = repairTabAccessibility(controller).replace('view.isAccessibilityElement = NO;', '');
    expect(() => repairTabAccessibility(incomplete)).toThrow(/existing patch differs/);
  });

  it('registers the repair only as an iOS prebuild mod', () => {
    const config = readFileSync(join(import.meta.dirname, '../../app.config.ts'), 'utf8');
    const plugin = readFileSync(join(import.meta.dirname, '../../plugins/with-ios-tab-accessibility.js'), 'utf8');
    expect(config).toContain("'./plugins/with-ios-tab-accessibility.js'");
    expect(plugin).toContain("withDangerousMod(config, ['ios'");
    expect(plugin).toContain("paths: [modConfig.modRequest.projectRoot]");
    expect(plugin).not.toContain("['android'");
  });

  // Explicit offline proof on a Linux host with Clang and GNU libobjc. CI's
  // portable transform tests above do not claim this native algorithm run.
  it.runIf(process.env['UG_NATIVE_TAB_PROOF'] === '1')('executes the shipped native algorithm against ancestor and sibling duplicates', () => {
    const repaired = repairTabAccessibility(controller);
    const start = repaired.indexOf('static BOOL UGContainsTabButton');
    const end = repaired.indexOf('\n// https:', start);
    expect(start).toBeGreaterThan(0);
    expect(end).toBeGreaterThan(start);
    const native = repaired.slice(start, end);
    const fixture = readFileSync(join(import.meta.dirname, 'fixtures/ios-tab-accessibility-proof.mm'), 'utf8');
    const directory = mkdtempSync(join(tmpdir(), 'ios-tab-proof-'));
    try {
      const source = join(directory, 'proof.mm');
      const executable = join(directory, 'proof');
      writeFileSync(source, fixture.replace('// __UNION_GROUND_NATIVE_FIX__', native));
      const includes = execFileSync('gcc', ['-print-file-name=include'], { encoding: 'utf8' }).trim();
      execFileSync('clang++', ['-I' + includes, '-fconstant-string-class=NSString', source, '-l:libobjc.so.4', '-o', executable]);
      expect(execFileSync(executable, { encoding: 'utf8' })).toContain('PASS: native repair algorithm');
      // Reintroducing the descendant-only predicate must fail the sibling case.
      const mutant = native.replace('UGContainsTabButton(tabBar, label)', 'UGContainsTabButton(view, label)');
      expect(mutant).not.toBe(native);
      writeFileSync(source, fixture.replace('// __UNION_GROUND_NATIVE_FIX__', mutant));
      execFileSync('clang++', ['-I' + includes, '-fconstant-string-class=NSString', source, '-l:libobjc.so.4', '-o', executable]);
      expect(() => execFileSync(executable, { stdio: 'pipe' })).toThrow();
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
