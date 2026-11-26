// @vitest-environment node
import { afterEach, expect, it, vi } from 'vitest';
import configure from '../vite.config.mjs';

afterEach(() => vi.unstubAllEnvs());

it('root tests use an inline TypeScript config without the Expo config chain', () => {
  vi.stubEnv('VITEST', 'true');
  const config = configure({ mode: 'test' });
  expect(config.esbuild).toBeUndefined();
  expect(config.oxc.tsconfig).toEqual({
    compilerOptions: { jsx: 'react-jsx', useDefineForClassFields: true },
  });
  const resolver = config.plugins.find(plugin => plugin.name === 'root-native-test-imports');
  for (const id of ['@expo/vector-icons', 'expo-router', 'react-native', 'react-native-safe-area-context', 'react-native-url-polyfill/auto']) {
    expect(resolver.resolveId(id)).toBe(id);
  }
  expect(resolver.resolveId('../apps/mobile/src/services/supabase')).toBeUndefined();
  expect(resolver.resolveId('@supabase/supabase-js')).toBeUndefined();
});

it('ordinary web development and builds retain their original resolution', () => {
  vi.stubEnv('VITEST', '');
  for (const mode of ['development', 'production']) {
    const config = configure({ mode });
    expect(config.oxc).toBeUndefined();
    expect(config.plugins.some(plugin => plugin.name === 'root-native-test-imports')).toBe(false);
  }
});
