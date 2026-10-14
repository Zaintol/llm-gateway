import { defineConfig } from 'vitest/config';
import { sharedConfig } from '../../vitest.shared.js';

export default defineConfig({
  ...sharedConfig,
  test: { include: ['test/**/*.test.ts'] },
});
