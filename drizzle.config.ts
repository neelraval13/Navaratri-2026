import { defineConfig } from 'drizzle-kit'

/**
 * Drizzle Kit configuration.
 *
 * `generate` needs no database connection, so migrations are authored and
 * reviewed entirely offline. Only `migrate` requires `DATABASE_URL`, and it is
 * a deliberate operator action — never part of a build, a start command, a
 * Function invocation or `release:check`.
 *
 * There is no hard-coded URL and no production fallback. A missing
 * `DATABASE_URL` fails loudly at the moment a command actually needs it.
 */
export default defineConfig({
  dialect: 'postgresql',
  schema: './server/db/schema.ts',
  out: './drizzle',
  strict: true,
  verbose: true,
  dbCredentials: {
    url: process.env.DATABASE_URL ?? '',
  },
})
