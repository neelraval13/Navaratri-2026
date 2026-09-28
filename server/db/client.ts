import { neon } from '@neondatabase/serverless'
import { drizzle } from 'drizzle-orm/neon-http'

import {
  DatabaseNotConfiguredError,
  readDatabaseEnvironment,
} from './environment.js'
import * as schema from './schema.js'

/**
 * The Neon HTTP driver, which is the right shape for Vercel Functions: each
 * query is a stateless request, so there is no pool to keep warm across
 * invocations and no socket to leak when an instance is frozen.
 */
type Database = ReturnType<typeof createDatabase>

const createDatabase = (databaseUrl: string) => {
  return drizzle(neon(databaseUrl), { schema })
}

let cached: Database | undefined

/**
 * The lazy server-only database handle.
 *
 * Nothing connects at module import. Importing this file validates nothing,
 * opens nothing and reads no environment — that matters because a module-load
 * connection would turn a missing `DATABASE_URL` into a deployment-wide crash
 * instead of a failure confined to the one call that needed a database.
 *
 * It throws `DatabaseNotConfiguredError` when invoked without configuration.
 * The error names the reason and never the URL.
 *
 * This runs NO migration and mutates NO schema. Migrations are a deliberate
 * operator action; see docs/DATABASE.md.
 */
export const getDatabase = (): Database => {
  if (cached !== undefined) {
    return cached
  }

  const environment = readDatabaseEnvironment()

  if (environment.ok === false) {
    throw new DatabaseNotConfiguredError(environment.reason)
  }

  cached = createDatabase(environment.databaseUrl)

  return cached
}

/**
 * Whether a database call would succeed configuration-wise, without making
 * one. Useful for a future endpoint that must degrade rather than throw.
 */
export const isDatabaseConfigured = (): boolean => {
  return readDatabaseEnvironment().ok
}

export { DatabaseNotConfiguredError }
export * as schema from './schema.js'
