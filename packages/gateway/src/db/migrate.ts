import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { createDb, createPool } from './client.js';

/** Location of the SQL migrations, valid from both `src/db` and `dist/db`. */
export const migrationsFolder = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../drizzle',
);

export async function runMigrations(databaseUrl: string): Promise<void> {
  const pool = createPool(databaseUrl);
  try {
    await migrate(createDb(pool), { migrationsFolder });
  } finally {
    await pool.end();
  }
}

// Run as a one-off command (`pnpm migrate`), never on gateway boot in production.
if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    console.error('DATABASE_URL is required');
    process.exit(1);
  }
  try {
    await runMigrations(databaseUrl);
    console.log('migrations applied');
  } catch (err) {
    console.error('migration failed', err);
    process.exit(1);
  }
}
