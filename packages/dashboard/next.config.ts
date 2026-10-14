import path from 'node:path';
import type { NextConfig } from 'next';

const config: NextConfig = {
  // Self-contained server bundle for the Docker image, traced from the monorepo root.
  output: 'standalone',
  outputFileTracingRoot: path.join(import.meta.dirname, '../..'),
  poweredByHeader: false,
};

export default config;
