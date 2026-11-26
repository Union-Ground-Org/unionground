import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const require = createRequire(import.meta.url);
type Project = {
  parseSync(): void;
  writeSync(): string;
  pbxNativeTargetSection(): Record<string, { name?: string }>;
  pbxFileReferenceSection(): Record<string, { path?: string }>;
};
const { project: openProject } = require('xcode') as { project(path: string): Project };
const { addWidgetTarget, writeWidgetFiles, extensionBundleIdFor, appGroupIdFor } = require('../../modules/home-widgets/app.plugin.js') as {
  addWidgetTarget(project: Project, version: string, build: string, bundle: string): void;
  writeWidgetFiles(root: string, version: string, build: string, group: string): void;
  extensionBundleIdFor(applicationId: string): string;
  appGroupIdFor(applicationId: string): string;
};
const widgetRoot = join(import.meta.dirname, '../../modules/home-widgets');

describe('native home-screen widget packaging', () => {
  it('adds one embedded iOS target with a resolvable Swift source, version and private app group', () => {
    const root = mkdtempSync(join(tmpdir(), 'home-widget-packaging-'));
    try {
      const source = execFileSync('tar', ['-xOf', require.resolve('expo/template.tgz'), 'package/ios/HelloWorld.xcodeproj/project.pbxproj']);
      const target = join(root, 'project.pbxproj');
      writeFileSync(target, source);
      const project = openProject(target);
      project.parseSync();
      // The extension and its app group derive from the app's own bundle identifier.
      const appId = 'org.example.unionground';
      addWidgetTarget(project, '0.1.1', '52', extensionBundleIdFor(appId));
      addWidgetTarget(project, '0.1.1', '52', extensionBundleIdFor(appId));
      writeWidgetFiles(root, '0.1.1', '52', appGroupIdFor(appId));
      expect(Object.values(project.pbxNativeTargetSection()).filter((entry) => entry.name === '"UnionGroundWidgets"')).toHaveLength(1);
      const files = Object.values(project.pbxFileReferenceSection());
      expect(files.filter((entry) => entry.path === '"UnionGroundWidgets.swift"')).toHaveLength(1);
      expect(files.filter((entry) => entry.path === '"UnionGroundWidgets/UnionGroundWidgets.swift"')).toHaveLength(0);
      const serialized = project.writeSync();
      expect(serialized).toContain('UnionGroundWidgets.appex in Copy Files');
      expect(serialized).toContain('APPLICATION_EXTENSION_API_ONLY = YES');
      expect(serialized).toContain('org.example.unionground.home-widgets');
      expect(readFileSync(join(root, 'UnionGroundWidgets/Info.plist'), 'utf8')).toContain('com.apple.widgetkit-extension');
      expect(readFileSync(join(root, 'UnionGroundWidgets/Info.plist'), 'utf8')).toContain('<string>52</string>');
      expect(readFileSync(join(root, 'UnionGroundWidgets/UnionGroundWidgets.entitlements'), 'utf8')).toContain('group.org.example.unionground.home-widgets');
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
  it('restricts both platforms to home-screen variants and keeps every tap generic', () => {
    const swift = readFileSync(join(widgetRoot, 'plugin/UnionGroundWidgets.swift'), 'utf8');
    expect(swift.match(/supportedFamilies\(\[\.systemSmall\]\)/g)).toHaveLength(2);
    expect(swift).not.toMatch(/accessory|ActivityConfiguration|URLSession/);
    const manifest = readFileSync(join(widgetRoot, 'android/src/main/AndroidManifest.xml'), 'utf8');
    expect(manifest.match(/android:exported="false"/g)).toHaveLength(3);
    expect(manifest).not.toMatch(/uses-permission|service /);
    for (const kind of ['today', 'unread']) {
      const xml = readFileSync(join(widgetRoot, `android/src/main/res/xml/ug_${kind}_widget.xml`), 'utf8');
      expect(xml).toContain('android:widgetCategory="home_screen"');
      expect(xml).toContain('android:updatePeriodMillis="0"');
    }
    const kotlin = readFileSync(join(widgetRoot, 'android/src/main/java/expo/modules/homewidgets/HomeWidgetsModule.kt'), 'utf8');
    for (const native of [swift, kotlin]) {
      expect(native).toContain('unionground://os-quick-action/work');
      expect(native).toContain('unionground://os-quick-action/messages');
      expect(native).not.toMatch(/access_token|refresh_token|supabase|https:\/\//);
    }
  });
  it('calculates AA contrast for both Android semantic canvas pairs', () => {
    const luminance = (hex: string) => {
      const channels = hex.match(/\w\w/g)!.map((value) => parseInt(value, 16) / 255)
        .map((value) => value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4);
      return channels[0]! * 0.2126 + channels[1]! * 0.7152 + channels[2]! * 0.0722;
    };
    for (const mode of ['values', 'values-night']) {
      const xml = readFileSync(join(widgetRoot, `android/src/main/res/${mode}/widgets.xml`), 'utf8');
      const colors = [...xml.matchAll(/<color[^>]*>#([\da-f]{6})<\/color>/gi)].map((match) => luminance(match[1]!));
      expect((Math.max(...colors) + 0.05) / (Math.min(...colors) + 0.05)).toBeGreaterThanOrEqual(4.5);
    }
  });
});
