import pg from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import * as schema from './schema.js';

export function createPool(connectionString: string): pg.Pool {
  return new pg.Pool({ connectionString, connectionTimeoutMillis: 2000, max: 10 });
}

export function createDb(pool: pg.Pool) {
  return drizzle(pool, { schema });
}

export type Db = ReturnType<typeof createDb>;
