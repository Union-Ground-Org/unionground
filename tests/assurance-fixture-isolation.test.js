// @vitest-environment node
import { resolve } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import config from '../vite.config.mjs';

afterEach(() => vi.unstubAllEnvs());

it('cannot enable archived fixtures in a production build, even with the browser harness flag', () => {
  vi.stubEnv('VITE_E2E_HARNESS', '1');
  vi.stubEnv('VITE_VISUAL_AUDIT', '1');
  expect(config({ mode: 'production' }).plugins.map((p) => p.name)).not.toContain('isolated-assurance-fixtures');
});

it('injects fixtures only into the explicit test browser build', () => {
  vi.stubEnv('VITE_E2E_HARNESS', '');
  vi.stubEnv('VITE_VISUAL_AUDIT', '');
  expect(config({ mode: 'test' }).plugins.map((p) => p.name)).not.toContain('isolated-assurance-fixtures');
  vi.stubEnv('VITE_E2E_HARNESS', '1');
  const plugin = config({ mode: 'test' }).plugins.find((p) => p.name === 'isolated-assurance-fixtures');
  expect(plugin.transformIndexHtml.handler('<script src="/src/main.jsx"></script>')).toContain('/e2e/assurance-entry.jsx');
  expect(plugin.resolveId('./lib/demoVoiceParity.js', resolve('src/App.jsx')))
    .toBe(resolve('tests/fixtures/retired-pre-bot/src/lib/demoVoiceParity.js'));
  expect(plugin.resolveId('./lib/memberApi.js', resolve('src/App.jsx'))).toBeUndefined();
});

it('uses isolated fixtures for credential-free visual previews without enabling E2E window seams', () => {
  vi.stubEnv('VITE_E2E_HARNESS', '');
  vi.stubEnv('VITE_VISUAL_AUDIT', '1');
  expect(config({ mode: 'test' }).plugins.map((p) => p.name)).toContain('isolated-assurance-fixtures');
  expect(config({ mode: 'development' }).plugins.map((p) => p.name)).not.toContain('isolated-assurance-fixtures');
  expect(config({ mode: 'test' }).test.coverage.exclude).toContain('**/tests/fixtures/**');
});
