/**
 * Drizzle client — single shared pool for the API process.
 *
 * The pool is created once at module load; Hono routes import `db` directly.
 * Each request acquires a connection from the pool and returns it on response.
 */

import { drizzle } from 'drizzle-orm/node-postgres'
import { Pool } from 'pg'
import * as schema from './schema'

const url = process.env.DATABASE_URL
if (!url) {
  throw new Error('DATABASE_URL is required. Copy apps/api/.env.example to apps/api/.env.')
}

export const pool = new Pool({ connectionString: url })
export const db = drizzle(pool, { schema })
export { schema }