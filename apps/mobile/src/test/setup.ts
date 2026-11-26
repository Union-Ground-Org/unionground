import { vi } from 'vitest';

import { TEST_BACKENDS } from './backends';

// The shipped trust table is empty (src/lib/trustedBackends.js at the
// repository root), which leaves every live code path unreachable. Suites
// exercise those paths against two fictional pairs instead. Suites that pin
// the shipped, empty table unmock '../../../../src/lib/trustedBackends.js'
// (relative to apps/mobile/src/lib).
vi.mock('../../../../src/lib/trustedBackends.js', () => {
  const table: Readonly<Record<string, string>> = Object.freeze({
    [TEST_BACKENDS.sample.supabaseUrl]: TEST_BACKENDS.sample.portal,
    [TEST_BACKENDS.live.supabaseUrl]: TEST_BACKENDS.live.portal,
  });
  return {
    TRUSTED_BACKEND_PORTALS: table,
    isTrustedPortalOrigin: (origin: unknown) => Object.values(table).includes(origin as string),
  };
});
