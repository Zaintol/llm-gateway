import type { UserConfig } from 'vitest/config';

/**
 * Resolve workspace packages (`@gw/*`) to their TypeScript sources in tests, so no build step is
 * needed. Vite applies `resolve.conditions` to client code only; tests run in the SSR environment.
 */
const conditions = ['@gw/source', 'node', 'development|production'];

export const sharedConfig = {
  resolve: { conditions },
  ssr: { resolve: { conditions, externalConditions: ['@gw/source'] } },
} satisfies UserConfig;
