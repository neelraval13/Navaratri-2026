import Dexie, { type Table } from 'dexie'

import type { EventConfig, OutboxItem, RegistrationRecord } from '@/db/types'

export const DATABASE_NAME = 'navaratri-2026-registration'

export const DATABASE_VERSION = 1

/**
 * Durable local event store.
 *
 * IndexedDB is the operational source of truth during the event; Google Sheets
 * is synchronized from it later. Migrations must preserve existing event data
 * and must never clear or delete a table.
 */
export class NavaratriDatabase extends Dexie {
  /**
   * `declare` emits no class fields, so nothing shadows the table objects Dexie
   * assigns to the instance.
   */
  declare registrations: Table<RegistrationRecord, string>
  declare config: Table<EventConfig, string>
  declare outbox: Table<OutboxItem, string>

  constructor() {
    super(DATABASE_NAME)

    this.version(DATABASE_VERSION).stores({
      registrations:
        '&id, status, phone, normalizedName, [phone+normalizedName], &badgeNumber, createdAt, updatedAt',
      config: '&id',
      outbox: '&id, registrationId, createdAt, attemptCount',
    })
  }
}

/**
 * The single database instance for the application. Do not construct another.
 */
export const db = new NavaratriDatabase()
