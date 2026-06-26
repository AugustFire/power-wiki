// drizzle-kit auto-loads .env from the cwd of the drizzle-kit process,
// so running `pnpm -F api db:generate` from apps/api picks up apps/api/.env.
// No dotenv import needed here.
import { defineConfig } from 'drizzle-kit'

const url = process.env.DATABASE_URL
if (!url) {
  throw new Error('DATABASE_URL is required for drizzle-kit. Set it in apps/api/.env or your shell.')
}

export default defineConfig({
  schema: './src/db/schema.ts',
  out: './src/db/migrations',
  dialect: 'postgresql',
  dbCredentials: { url },
  verbose: true,
  strict: true,
})