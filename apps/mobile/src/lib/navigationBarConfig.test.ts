import { fileURLToPath } from 'node:url';
import { readFileSync } from 'node:fs';
import { compileModsAsync, withAndroidStyles, withPlugins } from 'expo/config-plugins';
import { describe, expect, it } from 'vitest';

import appConfig from '../../app.config';

describe('Android navigation canvas', () => {
  it('emits a transparent three-button bar so the drawer canvas is not covered by a system scrim', async () => {
    const navigationPlugin = appConfig.plugins?.find((plugin) => (
      Array.isArray(plugin) ? plugin[0] : plugin
    ) === 'expo-navigation-bar');
    const projectRoot = fileURLToPath(new URL('../..', import.meta.url));
    // Introspection has no generated AppTheme; supply the native template's
    // theme boundary, then execute the actual registered Expo plugin on it.
    const registered = withPlugins({ name: appConfig.name, slug: appConfig.slug, _internal: { projectRoot } },
      typeof navigationPlugin === 'string' ? [navigationPlugin]
        : navigationPlugin?.[0] ? [[navigationPlugin[0], navigationPlugin[1]]] : []);
    const config = withAndroidStyles(registered, (config) => {
      config.modResults.resources.style = [{ $: { name: 'AppTheme', parent: 'Theme.AppCompat.DayNight.NoActionBar' }, item: [] }];
      return config;
    });
    const evaluated = await compileModsAsync(config, {
      projectRoot,
      platforms: ['android'],
      introspect: true,
      ignoreExistingNativeFiles: true,
    });
    const styles = evaluated._internal?.modResults?.android?.styles;
    const theme = styles?.resources?.style?.find((style: { $: { name: string } }) => style.$.name === 'AppTheme');
    const attribute = (name: string) => theme?.item?.find((item: { $: { name: string } }) => item.$.name === name)?._;
    expect(attribute('expoEnforceNavigationBarContrast')).toBe('false');
    expect(attribute('android:enforceNavigationBarContrast')).toBe('false');
    expect(attribute('android:windowLightNavigationBar')).toBe('true');
  });

  // Wiring contracts complement the executable native-plugin regression.
  it('matches runtime buttons to the active palette', () => {
    const layout = readFileSync(new URL('../../app/_layout.tsx', import.meta.url), 'utf8');
    expect(layout).toContain("<NavigationBar style={appearance === 'dark' ? 'light' : 'dark'} />");
  });

  it('paints the privacy cover beneath both system bars', () => {
    const layout = readFileSync(new URL('../../app/_layout.tsx', import.meta.url), 'utf8');
    const cover = layout.match(/<Modal\s+visible=\{!deletionOutcome && \(privacyCovered \|\| locked\) && pathname !== '\/offline'\}[^>]*>/)?.[0];
    expect(cover).toContain('statusBarTranslucent');
    expect(cover).toContain('navigationBarTranslucent');
  });
});
