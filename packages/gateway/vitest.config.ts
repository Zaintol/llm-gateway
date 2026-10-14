import { defineConfig } from 'vitest/config';
import { sharedConfig } from '../../vitest.shared.js';

export default defineConfig({
  ...sharedConfig,
  test: {
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      // Process entrypoints and one-off scripts are exercised by the compose smoke tests, not here.
      exclude: ['src/server.ts', 'src/worker.ts', 'src/cli.ts', 'src/demo/**', 'src/docs/**'],
      reporter: ['text-summary', 'json-summary'],
      thresholds: { lines: 80 },
    },
    projects: [
      {
        extends: true,
        test: { name: 'unit', include: ['test/unit/**/*.test.ts'] },
      },
      {
        extends: true,
        test: {
          name: 'integration',
          include: ['test/integration/**/*.test.ts'],
          testTimeout: 60_000,
          hookTimeout: 120_000,
        },
      },
      {
        // Real provider APIs; run only by the manual live-contract workflow.
        extends: true,
        test: { name: 'live', include: ['test/live/**/*.test.ts'], testTimeout: 60_000 },
      },
    ],
  },
});
