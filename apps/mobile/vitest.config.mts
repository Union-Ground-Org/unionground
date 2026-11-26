import { defineConfig } from 'vitest/config';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { legalPendingManifestPlugin } from '../../scripts/lib/legal-pending-manifest.mjs';

const require = createRequire(import.meta.url);

export default defineConfig({
  // Vitest resolves shared .js files; Metro selects .native.js and uses its
  // own directory context. Give the test graph the same actual declarations.
  plugins: [legalPendingManifestPlugin(fileURLToPath(new URL('../..', import.meta.url)))],
  // Mobile CI installs only this package. Cross-boundary JPEG regressions run
  // the real server inspector with this package's pinned test dependencies.
  resolve: {
    alias: [
      { find: 'saxes', replacement: require.resolve('saxes') },
      { find: 'sharp', replacement: require.resolve('sharp') },
      // Shared web hooks resolve the mobile renderer's React even when only
      // apps/mobile dependencies are installed, as in the CI mobile job.
      { find: /^react$/, replacement: require.resolve('react') },
    ],
  },
  test: {
    environment: 'node',
    // Screen tests (.test.tsx) execute the screen on the shared React Native
    // stand-in in src/testing (#8319).
    include: ['src/**/*.test.ts', 'src/**/*.test.tsx'],
    setupFiles: ['src/test/setup.ts'],
    server: {
      deps: { inline: [/\/api\/_lib\/privateFile(?:Safety|Raster)\.js$/] },
    },
  },
});
