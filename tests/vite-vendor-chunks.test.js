// @vitest-environment node
import { afterEach, expect, it, vi } from 'vitest';
import configure from '../vite.config.mjs';

afterEach(() => vi.unstubAllEnvs());

function vendorGroups() {
  vi.stubEnv('VITEST', '');
  const { groups } = configure({ mode: 'production' }).build.rolldownOptions.output.codeSplitting;
  return Object.fromEntries(groups.map(group => [group.name, group]));
}

it('assigns each vendor package to exactly one vendor chunk', () => {
  const groups = vendorGroups();
  const owners = id => Object.values(groups).filter(group => group.test(id)).map(group => group.name);
  expect(owners('/app/node_modules/react/index.js')).toEqual(['vendor-react']);
  expect(owners('/app/node_modules/react-dom/client.js')).toEqual(['vendor-react']);
  expect(owners('/app/node_modules/scheduler/index.js')).toEqual(['vendor-react']);
  expect(owners('/app/node_modules/@supabase/auth-js/dist/module/index.js')).toEqual(['vendor-supabase']);
  expect(owners('/app/node_modules/@sentry/react/build/esm/index.js')).toEqual(['vendor-observability']);
  expect(owners('/app/node_modules/@posthog/react/dist/esm/index.js')).toEqual(['vendor-observability']);
  expect(owners('/app/src/App.jsx').filter(name => typeof name === 'string')).toEqual([]);
});

it('lets React and Supabase claim their modules before observability pulls them in as dependencies', () => {
  // Rolldown groups capture their modules' dependencies by default, so
  // @sentry/react and @posthog/react would carry react into
  // vendor-observability unless vendor-react is placed first.
  const groups = vendorGroups();
  expect(groups['vendor-react'].priority).toBeGreaterThan(groups['vendor-observability'].priority);
  expect(groups['vendor-supabase'].priority).toBeGreaterThan(groups['vendor-observability'].priority);
});
